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
        self.create_stream_for(&self.recipient, duration, cancelable)
    }

    fn create_stream_for(&self, recipient: &Address, duration: u64, cancelable: bool) -> u64 {
        let now = self.env.ledger().timestamp();
        self.core_client.create_stream(
            &self.sender,
            recipient,
            &self.token,
            &DEPOSIT,
            &now,
            &(now + duration),
            &cancelable,
        )
    }

    fn fund_sender(&self, extra_amount: i128) {
        StellarAssetClient::new(&self.env, &self.token).mint(&self.sender, &extra_amount);
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

// -----------------------------------------------------------------------------
// Property Tests: Token Supply & Stream-Linkage Invariants
// -----------------------------------------------------------------------------

mod proptest_invariants {
    use super::*;
    use proptest::prelude::*;
    use std::collections::BTreeSet;
    use std::vec::Vec;

    const NUM_ACTORS: usize = 4;
    const MAX_STREAMS: usize = 4;

    #[derive(Clone, Debug)]
    enum Op {
        Mint { slot: usize, actor: usize },
        Transfer { slot: usize, from: usize, to: usize },
        Burn { slot: usize, actor: usize },
        CancelAndFinalize { slot: usize },
        FinalizeWhileActive { slot: usize },
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum TokenState {
        Unminted,
        Minted(usize),
        Burned,
    }

    struct Slot {
        stream_id: u64,
        initial_recipient: usize,
        nft: StreamNftClient<'static>,
        state: TokenState,
        stream_cancelled: bool,
    }

    fn op_strategy() -> impl Strategy<Value = Op> {
        prop_oneof![
            3 => (0..MAX_STREAMS, 0..NUM_ACTORS)
                .prop_map(|(slot, actor)| Op::Mint { slot, actor }),
            4 => (0..MAX_STREAMS, 0..NUM_ACTORS, 0..NUM_ACTORS)
                .prop_map(|(slot, from, to)| Op::Transfer { slot, from, to }),
            2 => (0..MAX_STREAMS, 0..NUM_ACTORS)
                .prop_map(|(slot, actor)| Op::Burn { slot, actor }),
            1 => (0..MAX_STREAMS)
                .prop_map(|slot| Op::CancelAndFinalize { slot }),
            1 => (0..MAX_STREAMS)
                .prop_map(|slot| Op::FinalizeWhileActive { slot }),
        ]
    }

    fn assert_invariants(f: &TestFixture, slots: &[Slot], actors: &[Address]) {
        let mut total_supply: i128 = 0;
        let mut live_linked_tokens: usize = 0;
        let mut seen_live_stream_ids: BTreeSet<u64> = BTreeSet::new();

        for slot in slots {
            // Every companion NFT remains bound to its exact stream and core contract.
            assert_eq!(slot.nft.stream_id(), slot.stream_id);
            assert_eq!(slot.nft.core_contract(), f.core_address);

            // Underlying stream reference in core is never orphaned or corrupted.
            let stream = f.core_client.get_stream(&slot.stream_id);
            assert_eq!(stream.recipient, actors[slot.initial_recipient]);

            let mut slot_supply: i128 = 0;
            for (idx, actor) in actors.iter().enumerate() {
                let bal = slot.nft.balance(actor);
                match slot.state {
                    TokenState::Minted(owner) if owner == idx => {
                        assert_eq!(bal, 1, "owner must hold balance 1");
                    }
                    _ => {
                        assert_eq!(bal, 0, "non-owner or non-live token must hold balance 0");
                    }
                }
                slot_supply += bal;
            }

            match slot.state {
                TokenState::Minted(owner) => {
                    assert_eq!(slot.nft.owner(), actors[owner]);
                    assert_eq!(slot_supply, 1);
                    assert!(
                        seen_live_stream_ids.insert(slot.stream_id),
                        "each minted token must map to a unique stream"
                    );
                    live_linked_tokens += 1;
                }
                TokenState::Unminted => {
                    assert_eq!(
                        slot.nft.try_owner().unwrap_err().unwrap(),
                        NftError::NotMinted
                    );
                    assert_eq!(slot_supply, 0);
                }
                TokenState::Burned => {
                    assert_eq!(
                        slot.nft.try_owner().unwrap_err().unwrap(),
                        NftError::TokenBurned
                    );
                    assert_eq!(slot_supply, 0);
                }
            }

            total_supply += slot_supply;
        }

        // Total supply across all actors and tokens always equals the count of live linked tokens.
        assert_eq!(total_supply, live_linked_tokens as i128);
        assert_eq!(seen_live_stream_ids.len(), live_linked_tokens);
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 32,
            ..ProptestConfig::default()
        })]

        #[test]
        fn prop_supply_and_linkage_invariants_under_random_ops(
            num_streams in 1usize..=MAX_STREAMS,
            ops in prop::collection::vec(op_strategy(), 1..=30),
        ) {
            let f = TestFixture::setup();
            f.fund_sender((MAX_STREAMS as i128) * DEPOSIT);

            let mut actors = Vec::with_capacity(NUM_ACTORS);
            actors.push(f.recipient.clone());
            for _ in 1..NUM_ACTORS {
                actors.push(Address::generate(&f.env));
            }

            let mut slots = Vec::with_capacity(num_streams);
            for i in 0..num_streams {
                let initial_recipient = i % NUM_ACTORS;
                let stream_id = f.create_stream_for(&actors[initial_recipient], 10 * DAY, true);
                let (_nft_addr, nft) = f.deploy_nft(stream_id);
                slots.push(Slot {
                    stream_id,
                    initial_recipient,
                    nft,
                    state: TokenState::Unminted,
                    stream_cancelled: false,
                });
            }

            assert_invariants(&f, &slots, &actors);

            for op in ops {
                match op {
                    Op::Mint { slot, actor } => {
                        let s = &mut slots[slot % num_streams];
                        let res = s.nft.try_mint(&actors[actor]);
                        match s.state {
                            TokenState::Burned => {
                                prop_assert_eq!(res.unwrap_err().unwrap(), NftError::TokenBurned);
                            }
                            TokenState::Minted(_) => {
                                // Double-mint for the same stream must return AlreadyMinted.
                                prop_assert_eq!(res.unwrap_err().unwrap(), NftError::AlreadyMinted);
                            }
                            TokenState::Unminted => {
                                if s.stream_cancelled {
                                    prop_assert_eq!(
                                        res.unwrap_err().unwrap(),
                                        NftError::StreamNotActive
                                    );
                                } else if actor != s.initial_recipient {
                                    prop_assert_eq!(
                                        res.unwrap_err().unwrap(),
                                        NftError::NotAuthorized
                                    );
                                } else {
                                    prop_assert!(res.is_ok());
                                    s.state = TokenState::Minted(actor);
                                }
                            }
                        }
                    }
                    Op::Transfer { slot, from, to } => {
                        let s = &mut slots[slot % num_streams];
                        let res = s.nft.try_transfer(&actors[from], &actors[to], &1);
                        match s.state {
                            TokenState::Burned => {
                                prop_assert_eq!(res.unwrap_err().unwrap(), NftError::TokenBurned);
                            }
                            TokenState::Unminted => {
                                prop_assert_eq!(res.unwrap_err().unwrap(), NftError::NotMinted);
                            }
                            TokenState::Minted(owner) => {
                                if from != owner {
                                    // Transfer by non-owner must return NotAuthorized.
                                    prop_assert_eq!(
                                        res.unwrap_err().unwrap(),
                                        NftError::NotAuthorized
                                    );
                                } else {
                                    prop_assert!(res.is_ok());
                                    s.state = TokenState::Minted(to);
                                }
                            }
                        }
                    }
                    Op::Burn { slot, actor } => {
                        let s = &mut slots[slot % num_streams];
                        let res = s.nft.try_burn(&actors[actor], &1);
                        match s.state {
                            TokenState::Burned => {
                                // Burn of an already-burned (non-existent) token returns TokenBurned.
                                prop_assert_eq!(res.unwrap_err().unwrap(), NftError::TokenBurned);
                            }
                            TokenState::Unminted => {
                                // Burn of an unminted (non-existent) token returns NotMinted.
                                prop_assert_eq!(res.unwrap_err().unwrap(), NftError::NotMinted);
                            }
                            TokenState::Minted(owner) => {
                                if actor != owner {
                                    prop_assert_eq!(
                                        res.unwrap_err().unwrap(),
                                        NftError::NotAuthorized
                                    );
                                } else {
                                    prop_assert!(res.is_ok());
                                    s.state = TokenState::Burned;
                                }
                            }
                        }
                    }
                    Op::CancelAndFinalize { slot } => {
                        let s = &mut slots[slot % num_streams];
                        if !s.stream_cancelled {
                            f.core_client.cancel_stream(&f.sender, &s.stream_id);
                            s.stream_cancelled = true;
                        }
                        let res = s.nft.try_finalize_and_burn();
                        match s.state {
                            TokenState::Burned => {
                                prop_assert_eq!(res.unwrap_err().unwrap(), NftError::TokenBurned);
                            }
                            TokenState::Unminted => {
                                prop_assert_eq!(res.unwrap_err().unwrap(), NftError::NotMinted);
                            }
                            TokenState::Minted(_) => {
                                prop_assert!(res.is_ok());
                                s.state = TokenState::Burned;
                            }
                        }
                    }
                    Op::FinalizeWhileActive { slot } => {
                        let s = &mut slots[slot % num_streams];
                        if !s.stream_cancelled {
                            let res = s.nft.try_finalize_and_burn();
                            match s.state {
                                TokenState::Burned => {
                                    prop_assert_eq!(
                                        res.unwrap_err().unwrap(),
                                        NftError::TokenBurned
                                    );
                                }
                                TokenState::Unminted => {
                                    prop_assert_eq!(
                                        res.unwrap_err().unwrap(),
                                        NftError::NotMinted
                                    );
                                }
                                TokenState::Minted(_) => {
                                    prop_assert_eq!(
                                        res.unwrap_err().unwrap(),
                                        NftError::StreamNotFinalized
                                    );
                                }
                            }
                        }
                    }
                }

                assert_invariants(&f, &slots, &actors);
            }
        }

        #[test]
        fn prop_negative_paths_return_registered_errors(
            non_owner_offset in 1usize..NUM_ACTORS,
            target_idx in 0usize..NUM_ACTORS,
        ) {
            let f = TestFixture::setup();
            let mut actors = Vec::with_capacity(NUM_ACTORS);
            actors.push(f.recipient.clone());
            for _ in 1..NUM_ACTORS {
                actors.push(Address::generate(&f.env));
            }

            let stream_id = f.create_stream(10 * DAY, true);
            let (_nft_addr, nft) = f.deploy_nft(stream_id);

            let owner = &actors[0];
            let non_owner = &actors[non_owner_offset];
            let target = &actors[target_idx];

            // Burn of a non-existent (unminted) token must return NotMinted.
            prop_assert_eq!(
                nft.try_burn(owner, &1).unwrap_err().unwrap(),
                NftError::NotMinted
            );
            // Transfer of an unminted token must return NotMinted.
            prop_assert_eq!(
                nft.try_transfer(owner, target, &1).unwrap_err().unwrap(),
                NftError::NotMinted
            );

            // Mint once to the stream recipient.
            nft.mint(owner);

            // Double-mint for the same stream must return AlreadyMinted.
            prop_assert_eq!(
                nft.try_mint(owner).unwrap_err().unwrap(),
                NftError::AlreadyMinted
            );
            prop_assert_eq!(
                nft.try_mint(non_owner).unwrap_err().unwrap(),
                NftError::AlreadyMinted
            );

            // Transfer by non-owner must return NotAuthorized and preserve owner/link.
            prop_assert_eq!(
                nft.try_transfer(non_owner, target, &1).unwrap_err().unwrap(),
                NftError::NotAuthorized
            );
            prop_assert_eq!(nft.owner(), owner.clone());
            prop_assert_eq!(nft.stream_id(), stream_id);

            // Burn by non-owner must return NotAuthorized.
            prop_assert_eq!(
                nft.try_burn(non_owner, &1).unwrap_err().unwrap(),
                NftError::NotAuthorized
            );

            // Owner burns the token.
            nft.burn(owner, &1);

            // Burn of a now non-existent (burned) token must return TokenBurned.
            prop_assert_eq!(
                nft.try_burn(owner, &1).unwrap_err().unwrap(),
                NftError::TokenBurned
            );
            // Re-mint after burn must return TokenBurned.
            prop_assert_eq!(
                nft.try_mint(owner).unwrap_err().unwrap(),
                NftError::TokenBurned
            );
            // Transfer after burn must return TokenBurned.
            prop_assert_eq!(
                nft.try_transfer(owner, target, &1).unwrap_err().unwrap(),
                NftError::TokenBurned
            );
            // Underlying stream reference remains intact.
            prop_assert_eq!(f.core_client.get_stream(&stream_id).recipient, owner.clone());
        }
    }
}
