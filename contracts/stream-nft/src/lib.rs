#![no_std]

//! StreamNft: companion NFT contract for StreamPay.
//!
//! Implements a non-fungible token per stream via the Soroban token interface
//! (SEP-41) for a single unit (balance of 1, 0 decimals). Recipient rights map
//! directly to NFT token ownership.
//!
//! # Lifecycle
//!
//! - **Mint-on-create**: When a stream is created in StreamPay (or initialized for
//!   an existing active stream), exactly 1 unit of `StreamNft` is minted to the initial
//!   stream recipient.
//! - **Transferable**: The NFT holder can transfer the token (`transfer` or `transfer_from`),
//!   updating the recipient rights and indexing in StreamPay.
//! - **Delegated withdrawals**: The current NFT holder or an authorized operator
//!   with sufficient allowance can withdraw accrued funds to the recipient.
//! - **Burn-on-finalize**: When a stream reaches terminal status (depleted or cancelled),
//!   the NFT is burned, closing the token lifecycle.

#[cfg(test)]
extern crate std;

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, Address,
    Env, String as SdkString,
};
use streampay_contract::{Stream, StreamError, StreamStatus};

/// Contract client interface for calling the core StreamPay contract.
#[contractclient(name = "CoreStreamPayClient")]
pub trait CoreStreamPayApi {
    fn get_stream(env: Env, stream_id: u64) -> Result<Stream, StreamError>;
    fn withdraw(env: Env, stream_id: u64, amount: i128) -> Result<(), StreamError>;
    fn withdraw_max(env: Env, stream_id: u64) -> Result<i128, StreamError>;
}

/// Errors returned by the StreamNft companion contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum NftError {
    /// The NFT contract has already been initialized.
    AlreadyInitialized = 1,
    /// The NFT contract is not initialized.
    NotInitialized = 2,
    /// The caller is not authorized for this operation.
    NotAuthorized = 3,
    /// The NFT for this stream has already been minted.
    AlreadyMinted = 4,
    /// The NFT for this stream has not been minted.
    NotMinted = 5,
    /// The NFT for this stream has been burned.
    TokenBurned = 6,
    /// Invalid token amount: stream NFT only supports single-unit transfers (amount == 1).
    InvalidAmount = 7,
    /// Allowance for spender is insufficient or expired.
    InsufficientAllowance = 8,
    /// The stream is not in an active state.
    StreamNotActive = 9,
    /// Stream cannot be finalized/burned because it is still active with unwithdrawn funds.
    StreamNotFinalized = 10,
    /// Arithmetic overflow in checked computation.
    MathOverflow = 11,
}

/// Data keys stored by StreamNft in instance and persistent storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NftDataKey {
    /// Core streaming-payments contract address (instance).
    CoreContract,
    /// Admin address with permission to mint on stream creation (instance).
    Admin,
    /// Current owner/holder of the stream NFT token (persistent).
    Owner,
    /// Stream ID represented by this companion NFT (instance).
    StreamId,
    /// Flag indicating whether the token has been burned (instance).
    Burned,
    /// Spender allowance record: `(spender) -> Allowance` (persistent).
    Allowance(Address),
}

/// Allowance record for an authorized operator.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Allowance {
    pub amount: i128,
    pub live_until_ledger: u32,
}

/// Emitted when a new stream NFT is minted.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NftMinted {
    #[topic]
    pub stream_id: u64,
    #[topic]
    pub recipient: Address,
    pub nft_contract: Address,
}

/// Emitted when a stream NFT is transferred to a new owner.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NftTransferred {
    #[topic]
    pub stream_id: u64,
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
}

/// Emitted when a stream NFT is burned on finalization.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NftBurned {
    #[topic]
    pub stream_id: u64,
    #[topic]
    pub owner: Address,
}

const TTL_THRESHOLD_LEDGERS: u32 = 200_000;
const TTL_EXTEND_LEDGERS: u32 = 500_000;

/// Companion NFT Contract for a single StreamPay stream.
#[contract]
pub struct StreamNft;

#[contractimpl]
impl StreamNft {
    /// Initializes the companion NFT contract for a specific stream.
    ///
    /// - `core_contract`: The address of the StreamPay streaming-payments contract.
    /// - `admin`: The address authorized to trigger mint (e.g. governor or creator).
    /// - `stream_id`: The ID of the stream this NFT companion binds to.
    pub fn initialize(
        env: Env,
        core_contract: Address,
        admin: Address,
        stream_id: u64,
    ) -> Result<(), NftError> {
        if env.storage().instance().has(&NftDataKey::CoreContract) {
            return Err(NftError::AlreadyInitialized);
        }

        env.storage()
            .instance()
            .set(&NftDataKey::CoreContract, &core_contract);
        env.storage().instance().set(&NftDataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&NftDataKey::StreamId, &stream_id);
        env.storage().instance().set(&NftDataKey::Burned, &false);

        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

        Ok(())
    }

    /// Mint-on-create: mints the 1-unit NFT for this stream to the stream recipient.
    /// Can only be called once, by the authorized admin or initial recipient.
    pub fn mint(env: Env, recipient: Address) -> Result<(), NftError> {
        Self::require_initialized(&env)?;
        if Self::is_burned(&env) {
            return Err(NftError::TokenBurned);
        }
        if env.storage().persistent().has(&NftDataKey::Owner) {
            return Err(NftError::AlreadyMinted);
        }

        let admin: Address = env
            .storage()
            .instance()
            .get(&NftDataKey::Admin)
            .ok_or(NftError::NotInitialized)?;
        admin.require_auth();

        let stream_id = Self::get_stream_id(&env)?;

        // Verify with the core contract that the stream exists and matches recipient
        let core: Address = env
            .storage()
            .instance()
            .get(&NftDataKey::CoreContract)
            .ok_or(NftError::NotInitialized)?;
        let core_client = CoreStreamPayClient::new(&env, &core);
        let stream = core_client
            .get_stream(&stream_id)
            .map_err(|_| NftError::StreamNotActive)?;

        if stream.status != StreamStatus::Active {
            return Err(NftError::StreamNotActive);
        }
        if stream.recipient != recipient {
            return Err(NftError::NotAuthorized);
        }

        // Store owner
        env.storage()
            .persistent()
            .set(&NftDataKey::Owner, &recipient);
        env.storage()
            .persistent()
            .extend_ttl(&NftDataKey::Owner, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

        NftMinted {
            stream_id,
            recipient,
            nft_contract: env.current_contract_address(),
        }
        .publish(&env);

        Ok(())
    }

    /// Returns the stream ID bound to this companion NFT.
    pub fn stream_id(env: Env) -> Result<u64, NftError> {
        Self::get_stream_id(&env)
    }

    /// Returns the core StreamPay contract address.
    pub fn core_contract(env: Env) -> Result<Address, NftError> {
        env.storage()
            .instance()
            .get(&NftDataKey::CoreContract)
            .ok_or(NftError::NotInitialized)
    }

    /// Returns the current NFT owner for the stream, if minted and not burned.
    pub fn owner(env: Env) -> Result<Address, NftError> {
        Self::require_initialized(&env)?;
        if Self::is_burned(&env) {
            return Err(NftError::TokenBurned);
        }
        env.storage()
            .persistent()
            .get(&NftDataKey::Owner)
            .ok_or(NftError::NotMinted)
    }

    // -------------------------------------------------------------------------
    // SEP-41 Soroban Token Interface implementation (Single-unit NFT)
    // -------------------------------------------------------------------------

    /// Allowance query for an authorized operator.
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        if let Some(owner) = Self::get_owner_opt(&env) {
            if owner != from {
                return 0;
            }
            if let Some(allowance) = env
                .storage()
                .persistent()
                .get::<_, Allowance>(&NftDataKey::Allowance(spender))
            {
                if allowance.live_until_ledger >= env.ledger().sequence() {
                    return allowance.amount;
                }
            }
        }
        0
    }

    /// Approves an operator to transfer the NFT on behalf of `from`.
    /// `amount` must be 0 or 1.
    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        live_until_ledger: u32,
    ) -> Result<(), NftError> {
        from.require_auth();
        Self::require_not_burned(&env)?;
        let owner = Self::require_owner(&env)?;
        if from != owner {
            return Err(NftError::NotAuthorized);
        }
        if amount < 0 || amount > 1 {
            return Err(NftError::InvalidAmount);
        }

        let key = NftDataKey::Allowance(spender);
        if amount == 0 {
            env.storage().persistent().remove(&key);
        } else {
            let record = Allowance {
                amount: 1,
                live_until_ledger,
            };
            env.storage().persistent().set(&key, &record);
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
        }

        Ok(())
    }

    /// Balance query: returns 1 if `id` is the current owner, else 0.
    pub fn balance(env: Env, id: Address) -> i128 {
        if Self::is_burned(&env) {
            return 0;
        }
        if let Some(owner) = Self::get_owner_opt(&env) {
            if owner == id {
                return 1;
            }
        }
        0
    }

    /// Transfers the stream NFT from `from` to `to`.
    /// Requires authorization from `from`. `amount` must be exactly 1.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), NftError> {
        from.require_auth();
        Self::transfer_internal(&env, from, to, amount)
    }

    /// Transfers the stream NFT using an operator allowance.
    /// Requires authorization from `spender`. `amount` must be exactly 1.
    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), NftError> {
        spender.require_auth();
        if amount != 1 {
            return Err(NftError::InvalidAmount);
        }

        let current_allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
        if current_allowance < 1 {
            return Err(NftError::InsufficientAllowance);
        }

        // Consume allowance (single use for 1-unit token)
        env.storage()
            .persistent()
            .remove(&NftDataKey::Allowance(spender));

        Self::transfer_internal(&env, from, to, amount)
    }

    /// Burn-on-finalize: burns the NFT when the underlying stream has reached
    /// terminal status (Depleted or Cancelled).
    /// Callable by anyone once the stream is finalized, or by the owner.
    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), NftError> {
        from.require_auth();
        Self::require_not_burned(&env)?;
        let owner = Self::require_owner(&env)?;
        if from != owner {
            return Err(NftError::NotAuthorized);
        }
        if amount != 1 {
            return Err(NftError::InvalidAmount);
        }

        Self::burn_internal(&env, owner)
    }

    /// Burn with operator approval.
    pub fn burn_from(
        env: Env,
        spender: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), NftError> {
        spender.require_auth();
        Self::require_not_burned(&env)?;
        let owner = Self::require_owner(&env)?;
        if from != owner {
            return Err(NftError::NotAuthorized);
        }
        if amount != 1 {
            return Err(NftError::InvalidAmount);
        }

        let current_allowance = Self::allowance(env.clone(), from.clone(), spender.clone());
        if current_allowance < 1 {
            return Err(NftError::InsufficientAllowance);
        }

        env.storage()
            .persistent()
            .remove(&NftDataKey::Allowance(spender));

        Self::burn_internal(&env, owner)
    }

    /// Finalize and burn the NFT if the core stream is in a terminal status
    /// (Depleted or Cancelled). Can be called by any party without owner auth.
    pub fn finalize_and_burn(env: Env) -> Result<(), NftError> {
        Self::require_not_burned(&env)?;
        let owner = Self::require_owner(&env)?;
        let stream_id = Self::get_stream_id(&env)?;
        let core: Address = env
            .storage()
            .instance()
            .get(&NftDataKey::CoreContract)
            .ok_or(NftError::NotInitialized)?;

        let core_client = CoreStreamPayClient::new(&env, &core);
        let stream = core_client
            .get_stream(&stream_id)
            .map_err(|_| NftError::StreamNotActive)?;

        if stream.status == StreamStatus::Active {
            return Err(NftError::StreamNotFinalized);
        }

        Self::burn_internal(&env, owner)
    }

    // -------------------------------------------------------------------------
    // Delegated / Holder-routed Withdrawals
    // -------------------------------------------------------------------------

    /// Withdraws `amount` from the core stream contract.
    /// Callable by the current NFT holder (with their auth) or by an authorized
    /// operator who has an allowance on the NFT.
    pub fn withdraw(
        env: Env,
        caller: Address,
        amount: i128,
    ) -> Result<(), NftError> {
        caller.require_auth();
        Self::require_not_burned(&env)?;
        let owner = Self::require_owner(&env)?;

        if caller != owner {
            // Check if caller is an authorized operator
            let current_allowance = Self::allowance(env.clone(), owner.clone(), caller.clone());
            if current_allowance < 1 {
                return Err(NftError::NotAuthorized);
            }
        }

        let stream_id = Self::get_stream_id(&env)?;
        let core: Address = env
            .storage()
            .instance()
            .get(&NftDataKey::CoreContract)
            .ok_or(NftError::NotInitialized)?;

        let core_client = CoreStreamPayClient::new(&env, &core);
        core_client
            .withdraw(&stream_id, &amount)
            .map_err(|_| NftError::StreamNotActive)?;

        // Auto-burn if stream depleted
        let stream = core_client
            .get_stream(&stream_id)
            .map_err(|_| NftError::StreamNotActive)?;
        if stream.status == StreamStatus::Depleted {
            let _ = Self::burn_internal(&env, owner);
        }

        Ok(())
    }

    /// Withdraws all accrued funds (`withdraw_max`) from the core stream contract.
    /// Callable by the NFT holder or an authorized operator.
    pub fn withdraw_max(env: Env, caller: Address) -> Result<i128, NftError> {
        caller.require_auth();
        Self::require_not_burned(&env)?;
        let owner = Self::require_owner(&env)?;

        if caller != owner {
            let current_allowance = Self::allowance(env.clone(), owner.clone(), caller.clone());
            if current_allowance < 1 {
                return Err(NftError::NotAuthorized);
            }
        }

        let stream_id = Self::get_stream_id(&env)?;
        let core: Address = env
            .storage()
            .instance()
            .get(&NftDataKey::CoreContract)
            .ok_or(NftError::NotInitialized)?;

        let core_client = CoreStreamPayClient::new(&env, &core);
        let withdrawn = core_client
            .withdraw_max(&stream_id)
            .map_err(|_| NftError::StreamNotActive)?;

        let stream = core_client
            .get_stream(&stream_id)
            .map_err(|_| NftError::StreamNotActive)?;
        if stream.status == StreamStatus::Depleted {
            let _ = Self::burn_internal(&env, owner);
        }

        Ok(withdrawn)
    }

    // -------------------------------------------------------------------------
    // Metadata (SEP-41 descriptive methods)
    // -------------------------------------------------------------------------

    pub fn decimals(_env: Env) -> u32 {
        0
    }

    pub fn name(env: Env) -> SdkString {
        SdkString::from_str(&env, "StreamPay Stream NFT")
    }

    pub fn symbol(env: Env) -> SdkString {
        SdkString::from_str(&env, "STRMNFT")
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    fn transfer_internal(
        env: &Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), NftError> {
        Self::require_not_burned(env)?;
        let owner = Self::require_owner(env)?;
        if from != owner {
            return Err(NftError::NotAuthorized);
        }
        if amount != 1 {
            return Err(NftError::InvalidAmount);
        }

        let stream_id = Self::get_stream_id(env)?;

        // Update owner
        env.storage().persistent().set(&NftDataKey::Owner, &to);
        env.storage()
            .persistent()
            .extend_ttl(&NftDataKey::Owner, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

        NftTransferred {
            stream_id,
            from,
            to,
        }
        .publish(env);

        Ok(())
    }

    fn burn_internal(env: &Env, owner: Address) -> Result<(), NftError> {
        let stream_id = Self::get_stream_id(env)?;

        env.storage().persistent().remove(&NftDataKey::Owner);
        env.storage().instance().set(&NftDataKey::Burned, &true);

        NftBurned { stream_id, owner }.publish(env);
        Ok(())
    }

    fn require_initialized(env: &Env) -> Result<(), NftError> {
        if !env.storage().instance().has(&NftDataKey::CoreContract) {
            return Err(NftError::NotInitialized);
        }
        Ok(())
    }

    fn is_burned(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&NftDataKey::Burned)
            .unwrap_or(false)
    }

    fn require_not_burned(env: &Env) -> Result<(), NftError> {
        Self::require_initialized(env)?;
        if Self::is_burned(env) {
            return Err(NftError::TokenBurned);
        }
        Ok(())
    }

    fn require_owner(env: &Env) -> Result<Address, NftError> {
        env.storage()
            .persistent()
            .get(&NftDataKey::Owner)
            .ok_or(NftError::NotMinted)
    }

    fn get_owner_opt(env: &Env) -> Option<Address> {
        env.storage().persistent().get(&NftDataKey::Owner)
    }

    fn get_stream_id(env: &Env) -> Result<u64, NftError> {
        env.storage()
            .instance()
            .get(&NftDataKey::StreamId)
            .ok_or(NftError::NotInitialized)
    }
}

#[cfg(test)]
mod test;
