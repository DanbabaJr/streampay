#![cfg(test)]

use soroban_sdk::{
    contractclient,
    testutils::{Address as _, Events as _, Ledger as _},
    token::StellarAssetClient,
    Address, Env, IntoVal, String as SdkString,
};
use streampay_contract::{
    test_client::StreamingPaymentsClient as CoreClient, StreamError, StreamStatus, StreamingPayments,
};

use crate::{Allowance, NftError, NftMinted, NftTransferred, NftBurned, StreamNft};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

#[contractclient(name = "StreamNftClient")]
pub trait StreamNftApi {
    fn initialize(
        env: Env,
        core_contract: Address,
        admin: Address,
        stream_id: u64,
    ) -> Result<(), NftError>;
    fn mint(env: Env, recipient: Address) -> Result<(), NftError>;
    fn stream_id(env: Env) -> Result<u64, NftError>;
    fn core_contract(env: Env) -> Result<Address, NftError>;
    fn owner(env: Env) -> Result<Address, NftError>;
    fn allowance(env: Env, from: Address, spender: Address) -> i128;
    fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        live_until_ledger: u32,
    ) -> Result<(), NftError>;
    fn balance(env: Env, id: Address) -> i128;
    fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), NftError>;
    fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), NftError>;
    fn burn(env: Env, from: Address, amount: i128) -> Result<(), NftError>;
    fn burn_from(
        env: Env,
        spender: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), NftError>;
    fn finalize_and_burn(env: Env) -> Result<(), NftError>;
    fn withdraw(env: Env, caller: Address, amount: i128) -> Result<(), NftError>;
    fn withdraw_max(env: Env, caller: Address) -> Result<i128, NftError>;
    fn decimals(env: Env) -> u32;
    fn name(env: Env) -> SdkString;
    fn symbol(env: Env) -> SdkString;
}

struct TestFixture {
    env: Env,
    token: Address,
    core_client: CoreClient<'static>,
    core_address: Address,
    sender: Address,
    recipient: Address,
    governor: Address,
}

impl TestFixture {
    fn setup() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let token = sac.address();

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        let governor = Address::generate(&env);

        StellarAssetClient::new(&env, &token).mint(&sender, &(2 * DEPOSIT));

        let core_address = env.register(StreamingPayments, (governor.clone(),));
        let core_client = CoreClient::new(&env, &core_address);

        StellarAssetClient::new(&env, &token).approve(
            &sender,
            &core_address,
            &(10 * DEPOSIT),
            &1_000_000u32,
        );

        TestFixture {
            env,
            token,
            core_client,
            core_address,
            sender,
            recipient,
            governor,
        }
    }

    fn create_stream(&self, duration: u64, cancelable: bool) -> u64 {
        let now = self.env.ledger().timestamp();
        self.core_client.create_stream(
            &self.sender,
            &self.recipient,
            &self.token,
            &DEPOSIT,
            &now,
            &(now + duration),
            &cancelable,
        )
    }

    fn deploy_nft(&self, stream_id: u64) -> (Address, StreamNftClient<'static>) {
        let nft_address = self.env.register(StreamNft, ());
        let nft_client = StreamNftClient::new(&self.env, &nft_address);
        nft_client.initialize(&self.core_address, &self.governor, &stream_id);
        (nft_address, nft_client)
    }

    fn advance_time(&self, seconds: u64) {
        self.env.ledger().with_mut(|li| li.timestamp += seconds);
    }

    fn advance_ledger(&self, ledgers: u32) {
        self.env.ledger().with_mut(|li| li.sequence += ledgers);
    }
}

// -----------------------------------------------------------------------------
// Initialization & Metadata Tests
// -----------------------------------------------------------------------------

#[test]
fn test_initialization_and_metadata() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, true);
    let (nft_addr, nft) = f.deploy_nft(stream_id);

    assert_eq!(nft.stream_id(), stream_id);
    assert_eq!(nft.core_contract(), f.core_address);
    assert_eq!(nft.decimals(), 0);
    assert_eq!(nft.name(), SdkString::from_str(&f.env, "StreamPay Stream NFT"));
    assert_eq!(nft.symbol(), SdkString::from_str(&f.env, "STRMNFT"));

    // Double initialization rejected
    let err = nft.try_initialize(&f.core_address, &f.governor, &stream_id).unwrap_err().unwrap();
    assert_eq!(err, NftError::AlreadyInitialized);
}

// -----------------------------------------------------------------------------
// Mint-on-Create Lifecycle Tests
// -----------------------------------------------------------------------------

#[test]
fn test_mint_lifecycle_and_events() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, true);
    let (nft_addr, nft) = f.deploy_nft(stream_id);

    // Initial state before mint: balance 0, owner reverts NotMinted
    assert_eq!(nft.balance(&f.recipient), 0);
    assert_eq!(nft.try_owner().unwrap_err().unwrap(), NftError::NotMinted);

    // Drain previous events
    let _ = f.env.events().all();

    // Mint to recipient
    nft.mint(&f.recipient);

    // Now recipient is owner and has balance 1
    assert_eq!(nft.owner(), f.recipient);
    assert_eq!(nft.balance(&f.recipient), 1);
    assert_eq!(nft.balance(&f.sender), 0);

    // Mint event emitted
    let minted_event = NftMinted {
        stream_id,
        recipient: f.recipient.clone(),
        nft_contract: nft_addr,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&nft.address),
        [minted_event.to_xdr(&f.env, &nft.address)],
    );

    // Double mint reverts AlreadyMinted
    let err = nft.try_mint(&f.recipient).unwrap_err().unwrap();
    assert_eq!(err, NftError::AlreadyMinted);
}

#[test]
fn test_mint_rejects_non_matching_recipient() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, true);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);

    let stranger = Address::generate(&f.env);
    let err = nft.try_mint(&stranger).unwrap_err().unwrap();
    assert_eq!(err, NftError::NotAuthorized);
}

// -----------------------------------------------------------------------------
// Transfer Semantics & SEP-41 Tests
// -----------------------------------------------------------------------------

#[test]
fn test_transfer_then_withdraw() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, false);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);
    nft.mint(&f.recipient);

    let new_recipient = Address::generate(&f.env);

    // Drain events
    let _ = f.env.events().all();

    // Recipient transfers NFT to new_recipient
    nft.transfer(&f.recipient, &new_recipient, &1);

    assert_eq!(nft.owner(), new_recipient);
    assert_eq!(nft.balance(&f.recipient), 0);
    assert_eq!(nft.balance(&new_recipient), 1);

    // Check NftTransferred event
    let transfer_event = NftTransferred {
        stream_id,
        from: f.recipient.clone(),
        to: new_recipient.clone(),
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&nft.address),
        [transfer_event.to_xdr(&f.env, &nft.address)],
    );

    // Advance time by 2 days (2/10 of deposit accrued = 2_000_000_000)
    f.advance_time(2 * DAY);

    // Previous recipient cannot withdraw anymore via NFT
    let err = nft.try_withdraw(&f.recipient, &1_000_000).unwrap_err().unwrap();
    assert_eq!(err, NftError::NotAuthorized);

    // New holder can withdraw
    nft.withdraw(&new_recipient, &1_000_000_000);
    let stream = f.core_client.get_stream(&stream_id);
    assert_eq!(stream.withdrawn, 1_000_000_000);
}

#[test]
fn test_transfer_invalid_amount() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, false);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);
    nft.mint(&f.recipient);

    let new_recipient = Address::generate(&f.env);
    // Amount != 1 rejected
    assert_eq!(
        nft.try_transfer(&f.recipient, &new_recipient, &0).unwrap_err().unwrap(),
        NftError::InvalidAmount
    );
    assert_eq!(
        nft.try_transfer(&f.recipient, &new_recipient, &2).unwrap_err().unwrap(),
        NftError::InvalidAmount
    );
}

// -----------------------------------------------------------------------------
// Operator Approval & Transfer_From Tests
// -----------------------------------------------------------------------------

#[test]
fn test_operator_approval_and_transfer_from() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, false);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);
    nft.mint(&f.recipient);

    let operator = Address::generate(&f.env);
    let buyer = Address::generate(&f.env);

    // Approve operator
    let live_until = f.env.ledger().sequence() + 100;
    nft.approve(&f.recipient, &operator, &1, &live_until);
    assert_eq!(nft.allowance(&f.recipient, &operator), 1);

    // Operator executes transfer_from
    nft.transfer_from(&operator, &f.recipient, &buyer, &1);
    assert_eq!(nft.owner(), buyer);
    assert_eq!(nft.balance(&buyer), 1);
    // Allowance consumed
    assert_eq!(nft.allowance(&f.recipient, &operator), 0);
}

#[test]
fn test_double_spend_attempts_via_stale_operator_keys() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, false);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);
    nft.mint(&f.recipient);

    let operator = Address::generate(&f.env);
    let buyer1 = Address::generate(&f.env);
    let buyer2 = Address::generate(&f.env);

    // Approve operator
    let live_until = f.env.ledger().sequence() + 100;
    nft.approve(&f.recipient, &operator, &1, &live_until);

    // Operator transfers to buyer1
    nft.transfer_from(&operator, &f.recipient, &buyer1, &1);

    // Stale operator tries to transfer again (double-spend attempt)
    let err = nft
        .try_transfer_from(&operator, &f.recipient, &buyer2, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, NftError::InsufficientAllowance);

    // Stale operator tries to withdraw via operator rights
    let err2 = nft.try_withdraw(&operator, &1_000).unwrap_err().unwrap();
    assert_eq!(err2, NftError::NotAuthorized);
}

#[test]
fn test_expired_operator_allowance() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, false);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);
    nft.mint(&f.recipient);

    let operator = Address::generate(&f.env);
    let buyer = Address::generate(&f.env);

    // Approve operator for 5 ledgers
    let live_until = f.env.ledger().sequence() + 5;
    nft.approve(&f.recipient, &operator, &1, &live_until);
    assert_eq!(nft.allowance(&f.recipient, &operator), 1);

    // Advance 10 ledgers past expiration
    f.advance_ledger(10);
    assert_eq!(nft.allowance(&f.recipient, &operator), 0);

    let err = nft
        .try_transfer_from(&operator, &f.recipient, &buyer, &1)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, NftError::InsufficientAllowance);
}

// -----------------------------------------------------------------------------
// Delegated Withdraw & Withdraw_Max Tests
// -----------------------------------------------------------------------------

#[test]
fn test_authorized_operator_can_withdraw() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, false);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);
    nft.mint(&f.recipient);

    let operator = Address::generate(&f.env);
    let live_until = f.env.ledger().sequence() + 100;
    nft.approve(&f.recipient, &operator, &1, &live_until);

    f.advance_time(3 * DAY); // 30% available

    // Operator withdraws on behalf of stream recipient
    nft.withdraw(&operator, &1_000_000_000);
    assert_eq!(f.core_client.get_stream(&stream_id).withdrawn, 1_000_000_000);

    // Operator calls withdraw_max
    let rest = nft.withdraw_max(&operator);
    assert_eq!(rest, 2_000_000_000);
    assert_eq!(f.core_client.get_stream(&stream_id).withdrawn, 3_000_000_000);
}

// -----------------------------------------------------------------------------
// Burn Semantics & Finalization Tests
// -----------------------------------------------------------------------------

#[test]
fn test_burn_on_finalize_depleted() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, false);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);
    nft.mint(&f.recipient);

    f.advance_time(15 * DAY); // past stream end

    // Drain all funds via withdraw_max
    let withdrawn = nft.withdraw_max(&f.recipient);
    assert_eq!(withdrawn, DEPOSIT);

    // Stream is now depleted: NFT should auto-burn
    assert_eq!(f.core_client.get_stream(&stream_id).status, StreamStatus::Depleted);
    assert_eq!(nft.balance(&f.recipient), 0);
    assert_eq!(nft.try_owner().unwrap_err().unwrap(), NftError::TokenBurned);

    // Mutations on burned token revert
    assert_eq!(
        nft.try_transfer(&f.recipient, &Address::generate(&f.env), &1).unwrap_err().unwrap(),
        NftError::TokenBurned
    );
    assert_eq!(
        nft.try_withdraw(&f.recipient, &100).unwrap_err().unwrap(),
        NftError::TokenBurned
    );
}

#[test]
fn test_burn_on_finalize_cancelled() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, true);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);
    nft.mint(&f.recipient);

    f.advance_time(2 * DAY);
    // Sender cancels stream directly on core
    f.core_client.cancel_stream(&f.sender, &stream_id);
    assert_eq!(f.core_client.get_stream(&stream_id).status, StreamStatus::Cancelled);

    // Any party can call finalize_and_burn
    nft.finalize_and_burn();

    assert_eq!(nft.balance(&f.recipient), 0);
    assert_eq!(nft.try_owner().unwrap_err().unwrap(), NftError::TokenBurned);
}

#[test]
fn test_manual_burn_by_owner_and_operator() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, true);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);
    nft.mint(&f.recipient);

    // Non-owner cannot burn
    let stranger = Address::generate(&f.env);
    assert_eq!(
        nft.try_burn(&stranger, &1).unwrap_err().unwrap(),
        NftError::NotAuthorized
    );

    // Invalid amount cannot burn
    assert_eq!(
        nft.try_burn(&f.recipient, &0).unwrap_err().unwrap(),
        NftError::InvalidAmount
    );

    // Owner can burn
    nft.burn(&f.recipient, &1);
    assert_eq!(nft.try_owner().unwrap_err().unwrap(), NftError::TokenBurned);
}

#[test]
fn test_finalize_and_burn_reverts_if_still_active() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, true);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);
    nft.mint(&f.recipient);

    // Stream is active, cannot finalize_and_burn
    let err = nft.try_finalize_and_burn().unwrap_err().unwrap();
    assert_eq!(err, NftError::StreamNotFinalized);
}

#[test]
fn test_burn_from_with_operator_allowance() {
    let f = TestFixture::setup();
    let stream_id = f.create_stream(10 * DAY, true);
    let (_nft_addr, nft) = f.deploy_nft(stream_id);
    nft.mint(&f.recipient);

    let operator = Address::generate(&f.env);
    let live_until = f.env.ledger().sequence() + 100;
    nft.approve(&f.recipient, &operator, &1, &live_until);

    // Operator burns NFT via burn_from
    nft.burn_from(&operator, &f.recipient, &1);
    assert_eq!(nft.try_owner().unwrap_err().unwrap(), NftError::TokenBurned);
}
