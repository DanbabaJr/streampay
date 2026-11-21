//! Tests for the two-key timelock (issue #119).
//!
//! Covers the bootstrap ceremony and its signer-set validation, the closure of
//! every governor-gated entry point once governance exists (and the deliberate
//! carve-outs that stay immediate), the propose → sign → mature → execute
//! lifecycle including its rejection surface, one-signer veto, execute-on-timeout
//! semantics, key rotation (longer window, single signature, and the revocation
//! of half-signed proposals), signature re-validation against the live signer
//! set, dispatch of every [`GovernanceAction`] arm through the same effect the
//! direct entry point used, the preserved legacy audit trail, and the fact that
//! collecting signatures consumes real authorization while executing does not.
#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Events as _, MockAuth, MockAuthInvoke},
    token::Client as TokenClient,
    Address, Env, Event as _, IntoVal, Vec,
};

use crate::test::{Fixture, UPGRADE_WASM};
use crate::{
    GovernanceAction, MigrationStatus, StreamError, StreamPolicy, MAX_FEE_BPS,
    MIN_VETO_WINDOW_SECONDS, REQUIRED_SIGNATURES, ROTATION_WINDOW_MULTIPLIER,
    TARGET_SCHEMA_VERSION,
};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;
/// The window the fixtures bootstrap with: the module default.
const WINDOW: u64 = crate::DEFAULT_VETO_WINDOW_SECONDS;

/// A fixture with governance bootstrapped over two distinct signers `a` and `b`.
///
/// The governor is a third key: bootstrap is the one act it performs directly,
/// and keeping it out of the signer set is what makes "the governor can no longer
/// act alone" observable in the tests.
struct Gov {
    f: Fixture,
    a: Address,
    b: Address,
}

impl Gov {
    fn setup() -> Self {
        let f = Fixture::setup_quiet();
        let a = Address::generate(&f.env);
        let b = Address::generate(&f.env);
        f.client.mock_all_auths().governance_bootstrap(
            &f.governor,
            &addrs(&f.env, &[a.clone(), b.clone()]),
            &WINDOW,
        );
        Gov { f, a, b }
    }

    /// Propose a fee change from `caller`.
    fn propose_fee(&self, caller: &Address, new_fee_bps: u32) -> u64 {
        self.propose(caller, GovernanceAction::SetFeeBps(new_fee_bps))
    }

    fn propose(&self, caller: &Address, action: GovernanceAction) -> u64 {
        self.f
            .client
            .mock_all_auths()
            .governance_propose(caller, &action)
    }

    fn sign(&self, caller: &Address, id: u64) -> u32 {
        self.f.client.mock_all_auths().governance_sign(caller, &id)
    }

    /// Collect both signatures.
    fn sign_both(&self, id: u64) {
        self.sign(&self.a, id);
        self.sign(&self.b, id);
    }

    /// Move past the end of a proposal's window.
    fn mature(&self) {
        self.f.advance_time(WINDOW + 1);
    }

    /// Mature a rotation (its window is `ROTATION_WINDOW_MULTIPLIER` longer).
    fn mature_rotation(&self) {
        self.f.advance_time(WINDOW * ROTATION_WINDOW_MULTIPLIER + 1);
    }

    /// Execute as a keyholder with no interest in the proposal.
    fn execute(&self, id: u64) {
        let executor = Address::generate(&self.f.env);
        self.f
            .client
            .mock_all_auths()
            .governance_execute(&executor, &id);
    }

    fn proposal(&self, id: u64) -> crate::Proposal {
        self.f
            .client
            .mock_all_auths()
            .governance_proposal(&id)
            .expect("proposal should exist")
    }

    /// The contract's own events, in emission order. Reading the log drains it,
    /// so a test that asserts a sequence can call this first to discard the
    /// bootstrap event.
    fn emitted(&self) -> std::vec::Vec<soroban_sdk::xdr::ContractEvent> {
        self.f
            .env
            .events()
            .all()
            .filter_by_contract(&self.f.client.address)
            .events()
            .to_vec()
    }
}

/// `soroban_sdk::Vec` of addresses.
fn addrs(env: &Env, set: &[Address]) -> Vec<Address> {
    let mut v = Vec::new(env);
    for a in set {
        v.push_back(a.clone());
    }
    v
}

// ------------------------------------------------------------- bootstrap ----

#[test]
fn bootstrap_binds_the_signer_set_and_window() {
    let g = Gov::setup();
    // Read the log before any further call: the test environment keeps only the
    // events of the most recent invocation.
    let emitted = g.emitted();
    let client = g.f.client.mock_all_auths();

    assert!(client.governance_is_initialized());
    assert_eq!(
        client.governance_signers(),
        addrs(&g.f.env, &[g.a.clone(), g.b.clone()])
    );
    assert_eq!(client.governance_veto_window(), WINDOW);
    assert_eq!(client.governance_proposal_count(), 0);
    assert_eq!(client.governance_proposal(&0), None);

    assert_eq!(
        emitted,
        std::vec![crate::GovernanceSignersSet {
            set_by: g.f.governor.clone(),
            signers: addrs(&g.f.env, &[g.a.clone(), g.b.clone()]),
            veto_window: WINDOW,
        }
        .to_xdr(&g.f.env, &g.f.client.address)],
    );
}

#[test]
fn before_bootstrap_the_reads_have_neutral_defaults() {
    let f = Fixture::setup_quiet();
    let client = f.client.mock_all_auths();

    assert!(!client.governance_is_initialized());
    assert_eq!(client.governance_signers(), Vec::new(&f.env));
    assert_eq!(client.governance_veto_window(), WINDOW);
    assert_eq!(client.governance_proposal_count(), 0);
    assert_eq!(client.governance_proposal(&1), None);
}

#[test]
fn bootstrap_is_governor_only() {
    let f = Fixture::setup_quiet();
    let stranger = Address::generate(&f.env);
    let err = f
        .client
        .mock_all_auths()
        .try_governance_bootstrap(
            &stranger,
            &addrs(
                &f.env,
                &[Address::generate(&f.env), Address::generate(&f.env)],
            ),
            &WINDOW,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::NotGovernor);
    assert!(!f.client.mock_all_auths().governance_is_initialized());
}

#[test]
fn bootstrap_refuses_a_signer_set_that_is_not_two_distinct_keys() {
    let f = Fixture::setup_quiet();
    let one = Address::generate(&f.env);
    let two = Address::generate(&f.env);

    // Empty.
    let err = f
        .client
        .mock_all_auths()
        .try_governance_bootstrap(&f.governor, &Vec::new(&f.env), &WINDOW)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::GovernanceSignerSetEmpty);

    // One key: below the two-signature requirement.
    let err = f
        .client
        .mock_all_auths()
        .try_governance_bootstrap(
            &f.governor,
            &addrs(&f.env, core::slice::from_ref(&one)),
            &WINDOW,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::GovernanceSignersNotDistinct);

    // One key in two slots: rejected rather than deduplicated.
    let err = f
        .client
        .mock_all_auths()
        .try_governance_bootstrap(
            &f.governor,
            &addrs(&f.env, &[one.clone(), one.clone()]),
            &WINDOW,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::GovernanceDuplicateSigner);

    // A duplicate anywhere in a larger set.
    let err = f
        .client
        .mock_all_auths()
        .try_governance_bootstrap(
            &f.governor,
            &addrs(&f.env, &[one.clone(), two.clone(), one.clone()]),
            &WINDOW,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::GovernanceDuplicateSigner);

    // More keys than the ceremony can hold.
    let mut too_many = std::vec::Vec::new();
    for _ in 0..crate::MAX_SIGNERS + 1 {
        too_many.push(Address::generate(&f.env));
    }
    let err = f
        .client
        .mock_all_auths()
        .try_governance_bootstrap(&f.governor, &addrs(&f.env, &too_many), &WINDOW)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::GovernanceTooManySigners);

    // Exactly MAX_SIGNERS is fine.
    let maxed: std::vec::Vec<Address> = too_many[..crate::MAX_SIGNERS as usize].to_vec();
    f.client
        .mock_all_auths()
        .governance_bootstrap(&f.governor, &addrs(&f.env, &maxed), &WINDOW);
    assert_eq!(
        f.client.mock_all_auths().governance_signers().len(),
        crate::MAX_SIGNERS
    );

    // Every rejection above left governance uninitialized until that last call.
    assert!(f.client.mock_all_auths().governance_is_initialized());
}

#[test]
fn bootstrap_refuses_a_window_shorter_than_the_floor() {
    let f = Fixture::setup_quiet();
    let err = f
        .client
        .mock_all_auths()
        .try_governance_bootstrap(
            &f.governor,
            &addrs(
                &f.env,
                &[Address::generate(&f.env), Address::generate(&f.env)],
            ),
            &(MIN_VETO_WINDOW_SECONDS - 1),
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::GovernanceVetoWindowTooShort);

    // The floor itself is allowed.
    f.client.mock_all_auths().governance_bootstrap(
        &f.governor,
        &addrs(
            &f.env,
            &[Address::generate(&f.env), Address::generate(&f.env)],
        ),
        &MIN_VETO_WINDOW_SECONDS,
    );
    assert_eq!(
        f.client.mock_all_auths().governance_veto_window(),
        MIN_VETO_WINDOW_SECONDS
    );
}

#[test]
fn bootstrap_is_one_time() {
    let g = Gov::setup();
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_bootstrap(
                &g.f.governor,
                &addrs(
                    &g.f.env,
                    &[Address::generate(&g.f.env), Address::generate(&g.f.env)],
                ),
                &WINDOW,
            )
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::GovernanceAlreadyInitialized);
    // The original set survives the attempt.
    assert_eq!(
        g.f.client.mock_all_auths().governance_signers(),
        addrs(&g.f.env, &[g.a.clone(), g.b.clone()])
    );
}

// ------------------------------------------- the direct path and its closure --

#[test]
fn admin_entry_points_are_unchanged_until_bootstrap() {
    let f = Fixture::setup();
    let client = f.client.mock_all_auths();

    client.set_fee_bps(&f.governor, &100);
    client.set_frozen(&f.governor, &true);
    let status = client.migrate_storage(&f.governor, &0, &50);
    assert_eq!(status.current_version, TARGET_SCHEMA_VERSION);
    client.set_frozen(&f.governor, &false);
    client.set_oracle_config(
        &f.governor,
        &addrs(&f.env, &[Address::generate(&f.env)]),
        &1,
        &3600,
    );
    assert_eq!(client.treasury_status(&f.token).fee_bps, 100);
    assert!(!client.is_frozen());
}

#[test]
fn every_gated_entry_point_closes_after_bootstrap() {
    /// Assert the call is refused because the timelock is now the only path.
    macro_rules! gated {
        ($call:expr) => {
            assert_eq!(
                $call.unwrap_err().unwrap(),
                StreamError::GovernanceTimelockRequired
            );
        };
    }

    let g = Gov::setup();
    let client = g.f.client.mock_all_auths();
    let hash = g.f.env.deployer().upload_contract_wasm(UPGRADE_WASM);
    let no_token: Option<Address> = None;
    let publishers = Vec::new(&g.f.env);

    gated!(client.try_set_fee_bps(&g.f.governor, &100));
    gated!(client.try_nominate_governor(&g.f.governor, &g.f.recipient));
    gated!(client.try_withdraw_treasury(&g.f.governor, &g.f.token, &g.f.recipient, &1));
    gated!(client.try_set_stream_policy(&g.f.governor, &no_token, &StreamPolicy::default()));
    gated!(client.try_set_frozen(&g.f.governor, &false));
    gated!(client.try_propose_upgrade(&g.f.governor, &hash, &crate::MIN_UPGRADE_DELAY_SECONDS));
    gated!(client.try_execute_upgrade(&g.f.governor));
    gated!(client.try_migrate_storage(&g.f.governor, &0, &50));
    gated!(client.try_set_oracle_config(&g.f.governor, &publishers, &0, &3600));

    // Nothing above changed state: the timelock check precedes every effect.
    assert_eq!(client.treasury_status(&g.f.token).fee_bps, 0);
    assert!(!client.is_frozen());
    assert_eq!(client.pending_upgrade(), None);
    assert_eq!(client.schema_version(), crate::INITIAL_SCHEMA_VERSION);
    assert_eq!(client.oracle_config(), None);
    assert_eq!(client.governance_proposal_count(), 0);
}

#[test]
fn freezing_stays_immediate_but_unfreezing_needs_a_proposal() {
    let g = Gov::setup();
    let client = g.f.client.mock_all_auths();

    // Break-glass is not timelocked.
    client.set_frozen(&g.f.governor, &true);
    assert!(client.is_frozen());

    // Reopening is: it re-enables activity.
    let err = client
        .try_set_frozen(&g.f.governor, &false)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::GovernanceTimelockRequired);
}

#[test]
fn cancelling_a_pending_upgrade_stays_immediate() {
    let f = Fixture::setup();
    let hash = f.env.deployer().upload_contract_wasm(UPGRADE_WASM);
    f.client.mock_all_auths().propose_upgrade(
        &f.governor,
        &hash,
        &crate::MIN_UPGRADE_DELAY_SECONDS,
    );

    // Bootstrap governance *after* the upgrade was queued.
    let a = Address::generate(&f.env);
    let b = Address::generate(&f.env);
    f.client
        .mock_all_auths()
        .governance_bootstrap(&f.governor, &addrs(&f.env, &[a, b]), &WINDOW);

    // Cancelling it is still directly callable: withdrawal of a risk needs no window.
    f.client.mock_all_auths().cancel_upgrade(&f.governor);
    assert_eq!(f.client.mock_all_auths().pending_upgrade(), None);
}

#[test]
fn the_governor_alone_cannot_do_anything_after_bootstrap() {
    let g = Gov::setup();
    // The governor still governs the things that stayed immediate, and can still
    // bootstrap nothing else; only two signatures move money or authority.
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_propose(&g.f.governor, &GovernanceAction::SetFeeBps(100))
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::NotGovernanceSigner);
}

// --------------------------------------------------------------- lifecycle --

#[test]
fn a_proposal_matures_then_executes_on_two_signatures() {
    let g = Gov::setup();
    let client = g.f.client.mock_all_auths();
    let now = g.f.env.ledger().timestamp();

    let id = g.propose_fee(&g.a, 100);
    assert_eq!(id, 1);
    assert_eq!(g.proposal(id).executable_at, now + WINDOW);

    assert_eq!(g.sign(&g.a, id), 1);
    assert_eq!(g.sign(&g.b, id), 2);

    // Window still open.
    let err = client
        .try_governance_execute(&Address::generate(&g.f.env), &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::GovernanceVetoWindowOpen);
    assert_eq!(client.treasury_status(&g.f.token).fee_bps, 0);

    g.mature();
    // The executor need not be a signer, or even known to the contract.
    g.execute(id);
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .treasury_status(&g.f.token)
            .fee_bps,
        100
    );

    let record = g.proposal(id);
    assert!(record.executed);
    assert!(!record.vetoed);
    assert_eq!(record.signers.len(), REQUIRED_SIGNATURES);
    assert_eq!(record.proposed_by, g.a);
}

#[test]
fn lifecycle_events_are_published_in_order() {
    let g = Gov::setup();
    let now = g.f.env.ledger().timestamp();
    let action = GovernanceAction::SetFeeBps(50);

    // The test environment reports the events of the most recent invocation, so
    // each lifecycle step is asserted right after it runs.
    let id = g.propose_fee(&g.a, 50);
    assert_eq!(
        g.emitted(),
        std::vec![crate::GovernanceActionProposed {
            proposal_id: id,
            proposed_by: g.a.clone(),
            executable_at: now + WINDOW,
            action: action.clone(),
        }
        .to_xdr(&g.f.env, &g.f.client.address)],
    );

    g.sign(&g.a, id);
    assert_eq!(
        g.emitted(),
        std::vec![crate::GovernanceActionSigned {
            proposal_id: id,
            signer: g.a.clone(),
            signature_count: 1,
        }
        .to_xdr(&g.f.env, &g.f.client.address)],
    );

    g.sign(&g.b, id);
    assert_eq!(
        g.emitted(),
        std::vec![crate::GovernanceActionSigned {
            proposal_id: id,
            signer: g.b.clone(),
            signature_count: 2,
        }
        .to_xdr(&g.f.env, &g.f.client.address)],
    );

    g.mature();
    let executor = Address::generate(&g.f.env);
    g.f.client
        .mock_all_auths()
        .governance_execute(&executor, &id);
    // `set_fee_bps` has no legacy event of its own, so the governance trail is
    // the whole record of this invocation.
    assert_eq!(
        g.emitted(),
        std::vec![crate::GovernanceActionExecuted {
            proposal_id: id,
            action,
            signers: addrs(&g.f.env, &[g.a.clone(), g.b.clone()]),
            executed_by: executor,
        }
        .to_xdr(&g.f.env, &g.f.client.address)],
    );
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .treasury_status(&g.f.token)
            .fee_bps,
        50
    );
}

#[test]
fn proposal_ids_are_sequential() {
    let g = Gov::setup();
    assert_eq!(g.propose_fee(&g.a, 1), 1);
    assert_eq!(g.propose_fee(&g.b, 2), 2);
    assert_eq!(g.f.client.mock_all_auths().governance_proposal_count(), 2);

    // A proposal that is refused at propose time consumes no id.
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_propose(&g.a, &GovernanceAction::SetVetoWindow(1))
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::GovernanceVetoWindowTooShort);
    assert_eq!(g.f.client.mock_all_auths().governance_proposal_count(), 2);
    assert_eq!(g.f.client.mock_all_auths().governance_proposal(&3), None);
}

#[test]
fn an_unknown_proposal_is_not_there() {
    let g = Gov::setup();
    let client = g.f.client.mock_all_auths();
    assert_eq!(
        client.try_governance_sign(&g.a, &777).unwrap_err().unwrap(),
        StreamError::GovernanceProposalNotFound
    );
    assert_eq!(
        client.try_governance_veto(&g.a, &777).unwrap_err().unwrap(),
        StreamError::GovernanceProposalNotFound
    );
    assert_eq!(
        client
            .try_governance_execute(&Address::generate(&g.f.env), &777)
            .unwrap_err()
            .unwrap(),
        StreamError::GovernanceProposalNotFound
    );
}

#[test]
fn one_signature_is_not_enough_but_time_alone_does_not_void_it() {
    let g = Gov::setup();
    let id = g.propose_fee(&g.a, 100);
    g.sign(&g.a, id);
    g.mature();

    // Way past the window, still executable once the second key shows up:
    // nobody had to be online at the deadline.
    g.f.advance_time(365 * DAY);
    g.sign(&g.b, id);
    g.f.client
        .mock_all_auths()
        .governance_execute(&Address::generate(&g.f.env), &id);
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .treasury_status(&g.f.token)
            .fee_bps,
        100
    );
}

#[test]
fn a_second_signature_from_the_same_key_is_one_signature() {
    let g = Gov::setup();
    let id = g.propose_fee(&g.a, 100);
    assert_eq!(g.sign(&g.a, id), 1);
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_sign(&g.a, &id)
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::GovernanceDuplicateSignature);
    assert_eq!(g.proposal(id).signers.len(), 1);
}

#[test]
fn a_non_signer_cannot_sign_veto_or_propose() {
    let g = Gov::setup();
    let stranger = Address::generate(&g.f.env);
    let client = g.f.client.mock_all_auths();
    let id = g.propose_fee(&g.a, 100);

    assert_eq!(
        client
            .try_governance_sign(&stranger, &id)
            .unwrap_err()
            .unwrap(),
        StreamError::NotGovernanceSigner
    );
    assert_eq!(
        client
            .try_governance_veto(&stranger, &id)
            .unwrap_err()
            .unwrap(),
        StreamError::NotGovernanceSigner
    );
    assert_eq!(
        client
            .try_governance_propose(&stranger, &GovernanceAction::SetFeeBps(200))
            .unwrap_err()
            .unwrap(),
        StreamError::NotGovernanceSigner
    );
    assert_eq!(client.governance_proposal_count(), 1);
}

#[test]
fn signing_consumes_the_signers_authorization() {
    let g = Gov::setup();
    let id = g.propose_fee(&g.a, 100);

    // Proposing consumed `a`'s auth; signing must consume it again, by name.
    let stranger = Address::generate(&g.f.env);
    g.f.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &g.f.client.address,
            fn_name: "governance_sign",
            args: (g.a.clone(), id).into_val(&g.f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(g.f.client.try_governance_sign(&g.a, &id).is_err());

    // With the right key's authorization it succeeds.
    g.f.env.mock_auths(&[MockAuth {
        address: &g.a,
        invoke: &MockAuthInvoke {
            contract: &g.f.client.address,
            fn_name: "governance_sign",
            args: (g.a.clone(), id).into_val(&g.f.env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(g.f.client.governance_sign(&g.a, &id), 1);

    // Executing needs no authorization at all: it is permissionless.
    g.f.env.mock_auths(&[MockAuth {
        address: &g.b,
        invoke: &MockAuthInvoke {
            contract: &g.f.client.address,
            fn_name: "governance_sign",
            args: (g.b.clone(), id).into_val(&g.f.env),
            sub_invokes: &[],
        },
    }]);
    g.f.client.governance_sign(&g.b, &id);
    g.mature();
    let executor = Address::generate(&g.f.env);
    g.f.env.mock_auths(&[]);
    g.f.client.governance_execute(&executor, &id);
    assert_eq!(g.f.client.treasury_status(&g.f.token).fee_bps, 100);
}

// ------------------------------------------------------------------- veto ---

#[test]
fn one_signer_can_veto_and_that_kills_the_proposal() {
    let g = Gov::setup();
    let id = g.propose_fee(&g.a, 100);
    g.sign(&g.a, id);

    // The *other* key vetoes alone — no quorum needed to remove risk.
    g.f.client.mock_all_auths().governance_veto(&g.b, &id);

    let client = g.f.client.mock_all_auths();
    assert!(client.governance_proposal(&id).unwrap().vetoed);
    g.mature();
    let err = client
        .try_governance_execute(&Address::generate(&g.f.env), &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::GovernanceAlreadyVetoed);
    assert_eq!(client.treasury_status(&g.f.token).fee_bps, 0);

    // Dead proposals accept neither more signatures nor a second veto.
    let err = client.try_governance_sign(&g.b, &id).unwrap_err().unwrap();
    assert_eq!(err, StreamError::GovernanceAlreadyVetoed);
    let err = client.try_governance_veto(&g.b, &id).unwrap_err().unwrap();
    assert_eq!(err, StreamError::GovernanceAlreadyVetoed);
}

#[test]
fn the_veto_window_shuts_at_the_execution_instant() {
    let g = Gov::setup();
    let now = g.f.env.ledger().timestamp();
    let id = g.propose_fee(&g.a, 100);
    assert_eq!(g.proposal(id).executable_at, now + WINDOW);

    // One second before the deadline: still vetoable.
    g.f.advance_time(WINDOW - 1);
    g.f.client.mock_all_auths().governance_veto(&g.b, &id);

    // A fresh proposal, vetoed exactly at `executable_at`, is refused: the
    // window is [proposed_at, executable_at).
    let g = Gov::setup();
    let now = g.f.env.ledger().timestamp();
    let id = g.propose_fee(&g.a, 100);
    g.f.advance_time(WINDOW);
    assert_eq!(g.f.env.ledger().timestamp(), now + WINDOW);
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_veto(&g.b, &id)
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::GovernanceVetoWindowClosed);
    // And it is executable at exactly that instant.
    g.f.client.mock_all_auths().governance_sign(&g.a, &id);
    g.f.client.mock_all_auths().governance_sign(&g.b, &id);
    g.f.client
        .mock_all_auths()
        .governance_execute(&Address::generate(&g.f.env), &id);
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .treasury_status(&g.f.token)
            .fee_bps,
        100
    );
}

// --------------------------------------------------------------- rotation ---

#[test]
fn a_rotation_waits_longer_and_needs_only_one_signature() {
    let g = Gov::setup();
    let c = Address::generate(&g.f.env);
    let now = g.f.env.ledger().timestamp();

    let id = g.propose(
        &g.a,
        GovernanceAction::SetSigners(addrs(&g.f.env, &[g.b.clone(), c.clone()])),
    );
    assert_eq!(
        g.proposal(id).executable_at,
        now + WINDOW * ROTATION_WINDOW_MULTIPLIER
    );

    // One signature is the whole point: it is the containment path for a lost key.
    assert_eq!(g.sign(&g.a, id), 1);

    // An ordinary window is not enough.
    g.mature();
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_execute(&Address::generate(&g.f.env), &id)
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::GovernanceVetoWindowOpen);

    g.f.advance_time(WINDOW * (ROTATION_WINDOW_MULTIPLIER - 1));
    g.f.client
        .mock_all_auths()
        .governance_execute(&Address::generate(&g.f.env), &id);
    assert_eq!(
        g.f.client.mock_all_auths().governance_signers(),
        addrs(&g.f.env, &[g.b.clone(), c.clone()])
    );
    // The window itself is untouched by a rotation.
    assert_eq!(g.f.client.mock_all_auths().governance_veto_window(), WINDOW);
}

#[test]
fn a_rotation_revokes_what_the_removed_key_half_signed() {
    let g = Gov::setup();
    let c = Address::generate(&g.f.env);

    // A ordinary proposal, signed only by `a`.
    let fee_id = g.propose_fee(&g.a, 100);
    g.sign(&g.a, fee_id);

    // `b` rotates `a` out. `b` signs alone, the long window passes, it executes.
    let rotation = g.propose(
        &g.b,
        GovernanceAction::SetSigners(addrs(&g.f.env, &[g.b.clone(), c.clone()])),
    );
    g.sign(&g.b, rotation);
    g.mature_rotation();
    g.f.client
        .mock_all_auths()
        .governance_execute(&Address::generate(&g.f.env), &rotation);

    // Now `a` is gone. The fee proposal is mature and still carries two slots of
    // history, but only one signature from a *current* signer.
    g.mature();
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_execute(&Address::generate(&g.f.env), &fee_id)
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::GovernanceSignaturesInsufficient);
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .treasury_status(&g.f.token)
            .fee_bps,
        0
    );

    // A fresh signature from a surviving key does not rescue it: `a`'s slot is
    // dead weight that can never become live again, so the proposal stays
    // unexecutable rather than silently counting a revoked key.
    g.f.client.mock_all_auths().governance_sign(&c, &fee_id);
    assert_eq!(g.proposal(fee_id).signers.len(), 2);
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_execute(&Address::generate(&g.f.env), &fee_id)
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::GovernanceSignaturesInsufficient);

    // The remedy is to propose again under the new set, which does execute.
    let fresh = g.propose_fee(&g.b, 100);
    g.f.client.mock_all_auths().governance_sign(&g.b, &fresh);
    g.f.client.mock_all_auths().governance_sign(&c, &fresh);
    g.mature();
    g.f.client
        .mock_all_auths()
        .governance_execute(&Address::generate(&g.f.env), &fresh);
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .treasury_status(&g.f.token)
            .fee_bps,
        100
    );
}

#[test]
fn a_rotation_with_a_broken_candidate_never_enters_the_queue() {
    let g = Gov::setup();

    // Duplicate keys.
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_propose(
                &g.a,
                &GovernanceAction::SetSigners(addrs(&g.f.env, &[g.a.clone(), g.a.clone()])),
            )
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::GovernanceDuplicateSigner);

    // A single key: would leave governance with nobody able to execute.
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_propose(
                &g.a,
                &GovernanceAction::SetSigners(addrs(&g.f.env, core::slice::from_ref(&g.b))),
            )
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::GovernanceSignersNotDistinct);

    assert_eq!(g.f.client.mock_all_auths().governance_proposal_count(), 0);
    assert_eq!(
        g.f.client.mock_all_auths().governance_signers(),
        addrs(&g.f.env, &[g.a.clone(), g.b.clone()])
    );
}

#[test]
fn the_veto_window_changes_through_the_timelock() {
    let g = Gov::setup();
    let id = g.propose(&g.a, GovernanceAction::SetVetoWindow(3 * DAY));
    g.sign_both(id);
    g.mature();
    g.execute(id);
    assert_eq!(
        g.f.client.mock_all_auths().governance_veto_window(),
        3 * DAY
    );
    // And the *next* proposal is timed against the new window.
    let fee = g.propose_fee(&g.a, 100);
    let now = g.f.env.ledger().timestamp();
    assert_eq!(g.proposal(fee).executable_at, now + 3 * DAY);
}

// ------------------------------------------------------------- dispatch ----

/// Run one action through the timelock and return nothing: each test below
/// asserts the effect it produced.
fn through_timelock(g: &Gov, caller: &Address, action: GovernanceAction) -> u64 {
    let id = g.propose(caller, action);
    g.sign_both(id);
    g.mature();
    g.execute(id);
    id
}

#[test]
fn treasury_withdrawal_through_the_timelock_moves_the_same_amount() {
    let f = Fixture::setup();
    f.client.mock_all_auths().set_fee_bps(&f.governor, &100);
    f.create_stream(DEPOSIT, 0, DAY, true);
    let fee = DEPOSIT / 100;

    let a = Address::generate(&f.env);
    let b = Address::generate(&f.env);
    f.client.mock_all_auths().governance_bootstrap(
        &f.governor,
        &addrs(&f.env, &[a.clone(), b.clone()]),
        &WINDOW,
    );
    let g = Gov { f, a, b };

    through_timelock(
        &g,
        &g.a,
        GovernanceAction::WithdrawTreasury(g.f.token.clone(), g.f.recipient.clone(), fee),
    );
    // Captured immediately: the environment reports only the latest invocation,
    // and the balance reads below are separate invocations.
    let emitted = g.emitted();

    let status = g.f.client.mock_all_auths().treasury_status(&g.f.token);
    assert_eq!(status.charged_total, fee);
    assert_eq!(status.withdrawn_total, fee);
    assert_eq!(status.collectible, 0);
    // The money actually moved to the proposal's recipient.
    assert_eq!(
        TokenClient::new(&g.f.env, &g.f.token).balance(&g.f.recipient),
        fee
    );

    // The legacy audit trail is intact: `FeeWithdrawn` names the proposer (a
    // signer), not the anonymous executor.
    let withdrawn = crate::FeeWithdrawn {
        token: g.f.token.clone(),
        governor: g.a.clone(),
        recipient: g.f.recipient.clone(),
        amount: fee,
        withdrawn_total: fee,
    }
    .to_xdr(&g.f.env, &g.f.client.address);
    assert!(
        emitted.contains(&withdrawn),
        "FeeWithdrawn should still fire, with the proposer as governor"
    );
}

#[test]
fn governor_nomination_through_the_timelock_still_needs_the_nominee_to_accept() {
    let g = Gov::setup();
    let nominee = Address::generate(&g.f.env);

    through_timelock(
        &g,
        &g.a,
        GovernanceAction::NominateGovernor(nominee.clone()),
    );
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .treasury_status(&g.f.token)
            .pending_governor,
        Some(nominee.clone())
    );

    // Step two is unchanged: the nominee proves control.
    let err =
        g.f.client
            .mock_all_auths()
            .try_accept_governor(&g.f.governor)
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::NotGovernor);
    g.f.client.mock_all_auths().accept_governor(&nominee);
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .treasury_status(&g.f.token)
            .governor,
        nominee
    );
}

#[test]
fn an_upgrade_proposed_and_executed_through_the_timelock() {
    let g = Gov::setup();
    let hash = g.f.env.deployer().upload_contract_wasm(UPGRADE_WASM);
    let now = g.f.env.ledger().timestamp();

    let id = through_timelock(
        &g,
        &g.a,
        GovernanceAction::ProposeUpgrade(hash.clone(), crate::MIN_UPGRADE_DELAY_SECONDS),
    );
    let pending =
        g.f.client
            .mock_all_auths()
            .pending_upgrade()
            .expect("upgrade should be pending");
    assert_eq!(pending.new_wasm_hash, hash);
    // The upgrade timelock starts when the governance proposal executes, which
    // is already a veto window after it was proposed.
    assert_eq!(
        pending.unlock_time,
        now + WINDOW + 1 + crate::MIN_UPGRADE_DELAY_SECONDS
    );
    assert!(g.proposal(id).executed);

    // Executing the upgrade is itself a timelocked action.
    g.f.advance_time(crate::MIN_UPGRADE_DELAY_SECONDS + 1);
    let exec = g.propose(&g.b, GovernanceAction::ExecuteUpgrade);
    g.sign(&g.a, exec);
    g.sign(&g.b, exec);
    g.mature();
    let executor = Address::generate(&g.f.env);
    g.f.client
        .mock_all_auths()
        .governance_execute(&executor, &exec);
    let emitted = g.emitted();

    // The wasm really was swapped, and the legacy event still names a signer as
    // the actor. Asserted through the event log because the contract instance is
    // now the upgraded wasm, which answers none of the old entry points.
    let upgraded = crate::ContractUpgraded {
        new_wasm_hash: hash,
        executed_by: g.b.clone(),
    }
    .to_xdr(&g.f.env, &g.f.client.address);
    assert!(emitted.contains(&upgraded));
}

#[test]
fn stream_policy_and_oracle_config_and_migration_all_dispatch() {
    let g = Gov::setup();

    // Stream policy.
    let policy = StreamPolicy {
        min_rate: 1,
        max_rate: i128::MAX,
        min_duration: DAY,
        max_duration: 30 * DAY,
        min_deposit: 1,
    };
    through_timelock(
        &g,
        &g.a,
        GovernanceAction::SetStreamPolicy(Some(g.f.token.clone()), policy.clone()),
    );
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .get_stream_policy(&Some(g.f.token.clone())),
        Some(policy)
    );

    // Oracle configuration.
    let publisher = Address::generate(&g.f.env);
    through_timelock(
        &g,
        &g.a,
        GovernanceAction::SetOracleConfig(
            addrs(&g.f.env, core::slice::from_ref(&publisher)),
            1,
            3600,
        ),
    );
    let config =
        g.f.client
            .mock_all_auths()
            .oracle_config()
            .expect("oracle config should be set");
    assert_eq!(config.publishers.len(), 1);
    assert_eq!(config.threshold, 1);

    // Unfreeze through governance, then migrate through governance.
    g.f.client.mock_all_auths().set_frozen(&g.f.governor, &true);
    through_timelock(&g, &g.a, GovernanceAction::SetFrozen(false));
    assert!(!g.f.client.mock_all_auths().is_frozen());

    // Migration requires the freeze, and that precondition belongs to the
    // action: a proposal whose action fails rolls back unscored and stays
    // executable once the state allows it.
    let migrate = g.propose(&g.a, GovernanceAction::MigrateStorage(0, 50));
    g.sign_both(migrate);
    g.mature();
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_execute(&Address::generate(&g.f.env), &migrate)
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::ContractNotFrozen);
    // Not consumed: the flag rolled back with the failed action.
    assert!(!g.proposal(migrate).executed);

    g.f.client.mock_all_auths().set_frozen(&g.f.governor, &true);
    g.f.client
        .mock_all_auths()
        .governance_execute(&Address::generate(&g.f.env), &migrate);
    let status: MigrationStatus = g.f.client.mock_all_auths().migration_progress();
    assert_eq!(status.current_version, TARGET_SCHEMA_VERSION);
    assert!(status.is_complete);
    assert!(g.proposal(migrate).executed);

    // …and a second execution is refused.
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_execute(&Address::generate(&g.f.env), &migrate)
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::GovernanceAlreadyExecuted);
}

#[test]
fn a_failing_action_rolls_back_its_executed_flag() {
    let g = Gov::setup();
    // Above the protocol cap: the action's own validation rejects it at dispatch.
    let id = g.propose(&g.a, GovernanceAction::SetFeeBps(MAX_FEE_BPS + 1));
    g.sign_both(id);
    g.mature();
    let err =
        g.f.client
            .mock_all_auths()
            .try_governance_execute(&Address::generate(&g.f.env), &id)
            .unwrap_err()
            .unwrap();
    assert_eq!(err, StreamError::FeeRateTooHigh);
    assert!(!g.proposal(id).executed);
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .treasury_status(&g.f.token)
            .fee_bps,
        0
    );
}

#[test]
fn executing_a_consumed_proposal_is_refused() {
    let g = Gov::setup();
    let id = through_timelock(&g, &g.a, GovernanceAction::SetFeeBps(25));
    let executor = Address::generate(&g.f.env);
    let client = g.f.client.mock_all_auths();

    let err = client
        .try_governance_execute(&executor, &id)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, StreamError::GovernanceAlreadyExecuted);
    // Signing a consumed proposal is refused too, rather than resurrecting it.
    let err = client.try_governance_sign(&g.a, &id).unwrap_err().unwrap();
    assert_eq!(err, StreamError::GovernanceAlreadyExecuted);
    let err = client.try_governance_veto(&g.a, &id).unwrap_err().unwrap();
    assert_eq!(err, StreamError::GovernanceAlreadyExecuted);
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .treasury_status(&g.f.token)
            .fee_bps,
        25
    );
}

#[test]
fn governance_is_usable_before_the_first_stream_exists() {
    // The timelock is orthogonal to stream lifecycle: a stream created while a
    // proposal is in flight is unaffected, and its funds still move normally.
    let g = Gov::setup();
    let id = g.propose_fee(&g.a, 100);
    let stream = g.f.create_stream(DEPOSIT, 0, DAY, true);
    g.f.advance_time(DAY / 2);
    let half = g.f.client.mock_all_auths().withdraw_max(&stream);
    assert!(half > 0);

    g.sign_both(id);
    g.mature();
    g.execute(id);
    assert_eq!(
        g.f.client
            .mock_all_auths()
            .treasury_status(&g.f.token)
            .fee_bps,
        100
    );
    // The earlier stream keeps its original (fee-less) economics.
    assert_eq!(g.f.client.mock_all_auths().stream_fee(&stream), 0);
}
