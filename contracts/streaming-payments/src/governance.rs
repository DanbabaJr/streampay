//! Upgrade-safe governance: admin actions behind a two-key timelock
//! (issue #119).
//!
//! Every action that *expands* authority or *moves* money — the fee rate, treasury
//! withdrawals, policy floors, oracle configuration, the wasm upgrade, the signer
//! set itself — must be proposed, survive a public veto window, collect two
//! signatures from **distinct** governance keys, and only then execute.
//!
//! # Why a timelock and not just a multisig
//!
//! A multisig on the admin key protects against one stolen key being *used*, but it
//! does nothing for a stolen key being *held*: the holder can wait for a moment when
//! the second key is available (a ceremony, a holiday, a rotation) and then act with
//! no notice to anyone. A timelock adds the thing that actually buys safety — a
//! window in which the change is *visible on-chain and vetoable* — and the two
//! signatures make a single compromised key impotent for the immediate case.
//!
//! # The rules this module enforces
//!
//! - **Distinctness, not headcount.** Execution requires two signatures from two
//!   different addresses, and a signer set that contains the same address twice is
//!   *rejected* rather than silently deduplicated. A set of `[A, A]` is one key
//!   wearing two slots, and treating it as two signers would be exactly the mistake
//!   this module exists to prevent. Adding a fifth key buys nothing on its own, so
//!   `REQUIRED_SIGNATURES` stays at two and the set is capped by [`MAX_SIGNERS`] to
//!   keep the ceremony small and auditable.
//! - **Execute-on-timeout, never void-on-timeout.** When the veto window elapses
//!   without a veto the proposal becomes executable and *stays* executable; nobody
//!   has to be around at the right moment. Execution is permissionless — anyone may
//!   call it — because a matured proposal that only a specific keyholder can submit
//!   is a proposal that a compromised or offline keyholder can suppress. This is the
//!   same semantic the asset-policy queue already commits to in
//!   `docs/POLICY_GOVERNANCE.md`, and the reason it is chosen there applies here:
//!   voiding on timeout converts "one custodian goes quiet" into a governance outage,
//!   while executing on timeout converts it into nothing at all.
//!   The asymmetry is deliberate: *vetoing* is the risk-reducing action and so needs
//!   only one signer and an open window; *executing* is the risk-adding one and needs
//!   two distinct signatures plus elapsed time.
//! - **Key compromise containment.** Any single signer can veto any pending proposal,
//!   so a compromised key cannot push anything through while the other keyholder is
//!   watching. Losing a key must not strand governance either, so a rotation
//!   ([`GovernanceAction::SetSigners`]) gets a window
//!   [`ROTATION_WINDOW_MULTIPLIER`] times longer and may be executed on a single
//!   signature: one honest keyholder can replace a lost or stolen key, but only in
//!   the open, with days of public notice for the other side to veto. See
//!   `docs/rotation-runbook.md` for the ceremony.
//! - **Rotation is also revocation.** At execution time every recorded signature is
//!   re-checked against the *current* signer set, so rotating keys invalidates
//!   half-signed proposals that the removed key had already signed.
//! - **Risk-reducing actions stay immediate.** Freezing the contract and cancelling a
//!   pending upgrade remain directly callable by the governor. A timelock that delays
//!   the break-glass is worse than no break-glass.
//! - **A freeze does not stall governance.** `ContractFrozen` is a brake on *user*
//!   traffic, and the admin helpers the dispatcher calls were never freeze-gated on
//!   the direct path either (`set_fee_bps` and `withdraw_treasury` work while frozen
//!   today). Two of the gated entry points — `set_stream_policy` and
//!   `set_oracle_config` — do refuse while frozen when called directly, because there
//!   they sit behind the same brake as deposits and withdrawals. Through the timelock that brake is replaced
//!   by the veto window, and the asymmetry is kept on purpose: during an incident the
//!   operators need to retighten a policy floor or rotate oracle publishers *while*
//!   user traffic is frozen, and the alternative would be to unfreeze the contract —
//!   reopening exactly the traffic the freeze exists to stop — in order to change a
//!   config value. Governance still needs two distinct keys and an elapsed window; it
//!   is never gated by the freeze flag.
//! - **The audit trail is not split.** An executed proposal dispatches the same
//!   internal helper the direct entry point always used, so the legacy events
//!   (`FeeWithdrawn`, `UpgradeProposed`, `StreamPolicySet`, …) still fire exactly as
//!   before, and the governance lifecycle events wrap them. Indexers and clients keep
//!   working; the two-key trail is additive.

use soroban_sdk::{contracttype, Address, Env, Vec};

use crate::errors::StreamError;
use crate::events::{
    GovernanceActionExecuted, GovernanceActionProposed, GovernanceActionSigned,
    GovernanceActionVetoed, GovernanceSignersSet,
};
use crate::policy::StreamPolicy;
use crate::stream::{TTL_EXTEND_LEDGERS, TTL_THRESHOLD_LEDGERS};
use crate::surface::{self, Branch};
use soroban_sdk::BytesN;

/// Default veto window: 2 days, matching the asset-policy timelock so operators
/// learn one number.
pub const DEFAULT_VETO_WINDOW_SECONDS: u64 = 172_800;

/// Shortest veto window governance may configure. Anything a reasonable
/// reviewer cannot be expected to notice in less than a day is not a veto
/// window.
pub const MIN_VETO_WINDOW_SECONDS: u64 = 86_400;

/// Distinct signatures required to execute. Two, always — the point is a second
/// key, not a quorum.
pub const REQUIRED_SIGNATURES: u32 = 2;

/// Upper bound on the signer set. More keys means more ceremony and more
/// surface; the security property comes from distinctness, not from headcount.
pub const MAX_SIGNERS: u32 = 10;

/// A signer-set rotation waits this many times the configured veto window.
/// It is the one action allowed through on a single signature, and the longer
/// window is what makes that tolerable: the other keyholder gets
/// [`ROTATION_WINDOW_MULTIPLIER`] x [`MIN_VETO_WINDOW_SECONDS`] (at minimum four
/// days) of public notice to veto it.
pub const ROTATION_WINDOW_MULTIPLIER: u64 = 4;

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Storage keys for the governance module. A dedicated enum keeps these from"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " colliding with `DataKey` or `PolicyDataKey`."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GovernanceDataKey {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The signer set (instance storage)."
    )]
    Signers,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Configured veto window in seconds (instance storage)."
    )]
    VetoWindow,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Last issued proposal id (instance storage)."
    )]
    ProposalCount,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A proposal record (persistent storage)."
    )]
    Proposal(u64),
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " One admin action that may be proposed, timelocked and executed."
)]
#[cfg_attr(not(target_family = "wasm"), doc = "")]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " The payloads mirror the direct entry points exactly, so dispatch is a"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " one-to-one call into the same internal helper rather than a second"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " implementation of the same authority."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GovernanceAction {
    #[cfg_attr(not(target_family = "wasm"), doc = " `set_fee_bps`")]
    SetFeeBps(u32),
    #[cfg_attr(not(target_family = "wasm"), doc = " `set_stream_policy`")]
    SetStreamPolicy(Option<Address>, StreamPolicy),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `set_frozen` — unfreezing goes through the timelock; freezing does not."
    )]
    SetFrozen(bool),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `withdraw_treasury(token, recipient, amount)`"
    )]
    WithdrawTreasury(Address, Address, i128),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `nominate_governor` — step one of the two-step rotation."
    )]
    NominateGovernor(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `propose_upgrade(new_wasm_hash, delay_seconds)`"
    )]
    ProposeUpgrade(BytesN<32>, u64),
    #[cfg_attr(not(target_family = "wasm"), doc = " `execute_upgrade`")]
    ExecuteUpgrade,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `migrate_storage(start_id, count)`"
    )]
    MigrateStorage(u64, u32),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " `set_oracle_config(publishers, threshold, max_stale_seconds)`"
    )]
    SetOracleConfig(Vec<Address>, u32, u64),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Replace the signer set. A rotation of the keys that govern this contract."
    )]
    SetSigners(Vec<Address>),
    #[cfg_attr(not(target_family = "wasm"), doc = " Replace the veto window.")]
    SetVetoWindow(u64),
}

impl GovernanceAction {
    /// Actions that change who may govern. These are the only ones that may be
    /// executed on a single signature, and they pay for it with a longer window.
    pub fn is_rotation(&self) -> bool {
        matches!(self, GovernanceAction::SetSigners(_))
    }
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " A proposed admin action awaiting its veto window and signatures."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub action: GovernanceAction,
    pub proposed_by: Address,
    pub proposed_at: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " First ledger timestamp at which the proposal may execute."
    )]
    pub executable_at: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Distinct signatures recorded so far, in signing order."
    )]
    pub signers: Vec<Address>,
    pub vetoed: bool,
    pub executed: bool,
}

/// Whether governance has taken over the admin entry points.
///
/// `false` on a database deployed before this module existed: the direct
/// entry points keep working until an operator bootstraps the signer set, so
/// adopting the timelock is an explicit, auditable act rather than something a
/// wasm upgrade does underneath an operator.
pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&GovernanceDataKey::Signers)
}

/// The current signer set (empty before bootstrap).
pub fn signers(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&GovernanceDataKey::Signers)
        .unwrap_or_else(|| Vec::new(env))
}

/// The configured veto window (the default before bootstrap).
pub fn veto_window(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&GovernanceDataKey::VetoWindow)
        .unwrap_or(DEFAULT_VETO_WINDOW_SECONDS)
}

/// Loads a proposal, extending its TTL so a long veto window cannot expire out
/// from under an open proposal.
pub fn proposal(env: &Env, id: u64) -> Option<Proposal> {
    let key = GovernanceDataKey::Proposal(id);
    let found: Option<Proposal> = env.storage().persistent().get(&key);
    if found.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    }
    found
}

fn put_proposal(env: &Env, proposal: &Proposal) {
    let key = GovernanceDataKey::Proposal(proposal.id);
    env.storage().persistent().set(&key, proposal);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

/// Rejects a signer set that would not actually deliver two independent keys.
///
/// Duplicates are an error rather than something to normalise away: a set of
/// `[A, A]` satisfies a headcount check and defeats the whole design, so the
/// only safe reading of "distinct" here is "refuse to configure it at all".
pub fn validate_signer_set(candidate: &Vec<Address>) -> Result<(), StreamError> {
    let len = candidate.len();
    if len == 0 {
        return Err(surface::reject(Branch::GovernanceSignerSetEmpty));
    }
    if len > MAX_SIGNERS {
        return Err(surface::reject(Branch::GovernanceTooManySigners));
    }
    let mut index = 0u32;
    while index < len {
        let this = candidate
            .get(index)
            .ok_or_else(|| surface::reject(Branch::GovernanceTooManySigners))?;
        let mut other = index + 1;
        while other < len {
            if candidate.get(other) == Some(this.clone()) {
                return Err(surface::reject(Branch::GovernanceDuplicateSigner));
            }
            other += 1;
        }
        index += 1;
    }
    if len < REQUIRED_SIGNATURES {
        return Err(surface::reject(Branch::GovernanceSignersNotDistinct));
    }
    Ok(())
}

/// Establishes the signer set and veto window. One-time, governor-only.
///
/// Afterwards every rotated set goes through the proposal path, so no single
/// key can ever move governance authority again without either a second
/// signature or a long, public rotation window.
pub fn bootstrap(
    env: &Env,
    caller: &Address,
    candidate: &Vec<Address>,
    window: u64,
) -> Result<(), StreamError> {
    if is_initialized(env) {
        return Err(surface::reject(Branch::GovernanceAlreadyInitialized));
    }
    if window < MIN_VETO_WINDOW_SECONDS {
        return Err(surface::reject(Branch::GovernanceVetoWindowTooShort));
    }
    validate_signer_set(candidate)?;

    env.storage()
        .instance()
        .set(&GovernanceDataKey::Signers, candidate);
    env.storage()
        .instance()
        .set(&GovernanceDataKey::VetoWindow, &window);
    env.storage()
        .instance()
        .set(&GovernanceDataKey::ProposalCount, &0u64);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    GovernanceSignersSet {
        set_by: caller.clone(),
        signers: candidate.clone(),
        veto_window: window,
    }
    .publish(env);

    Ok(())
}

/// Applies a rotation proposed and executed through the timelock.
pub fn apply_signer_set(
    env: &Env,
    candidate: &Vec<Address>,
    actor: &Address,
) -> Result<(), StreamError> {
    validate_signer_set(candidate)?;
    env.storage()
        .instance()
        .set(&GovernanceDataKey::Signers, candidate);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    GovernanceSignersSet {
        set_by: actor.clone(),
        signers: candidate.clone(),
        veto_window: veto_window(env),
    }
    .publish(env);
    Ok(())
}

/// Applies a veto-window change proposed and executed through the timelock.
pub fn apply_veto_window(env: &Env, window: u64, actor: &Address) -> Result<(), StreamError> {
    if window < MIN_VETO_WINDOW_SECONDS {
        return Err(surface::reject(Branch::GovernanceVetoWindowTooShort));
    }
    env.storage()
        .instance()
        .set(&GovernanceDataKey::VetoWindow, &window);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
    GovernanceSignersSet {
        set_by: actor.clone(),
        signers: signers(env),
        veto_window: window,
    }
    .publish(env);
    Ok(())
}

/// The guard the migrated direct entry points call.
///
/// Before bootstrap it is a no-op, so a deployed contract keeps working; after
/// bootstrap the direct path is closed and the action must come from an
/// executed proposal.
pub fn require_direct_call(env: &Env) -> Result<(), StreamError> {
    if is_initialized(env) {
        return Err(surface::reject(Branch::GovernanceTimelockRequired));
    }
    Ok(())
}

/// Returns `Ok(())` when `caller` is in the signer set, and consumes their
/// authorization.
pub fn require_signer(env: &Env, caller: &Address) -> Result<(), StreamError> {
    if !is_initialized(env) {
        return Err(surface::reject(Branch::GovernanceNotInitialized));
    }
    if !signers(env).contains(caller) {
        return Err(surface::reject(Branch::NotGovernanceSigner));
    }
    caller.require_auth();
    Ok(())
}

/// Records a new proposal and returns its id.
pub fn propose(env: &Env, caller: &Address, action: &GovernanceAction) -> Result<u64, StreamError> {
    require_signer(env, caller)?;

    // Validate a re-composition of the signer set when it is proposed, not when
    // it is finally executed: an unbuildable proposal should never sit in the
    // queue looking like something that can be signed.
    match action {
        GovernanceAction::SetSigners(candidate) => validate_signer_set(candidate)?,
        GovernanceAction::SetVetoWindow(window) if *window < MIN_VETO_WINDOW_SECONDS => {
            return Err(surface::reject(Branch::GovernanceVetoWindowTooShort));
        }
        _ => {}
    }

    let now = env.ledger().timestamp();
    let window = veto_window(env);
    let wait = if action.is_rotation() {
        window.saturating_mul(ROTATION_WINDOW_MULTIPLIER)
    } else {
        window
    };
    let count: u64 = env
        .storage()
        .instance()
        .get(&GovernanceDataKey::ProposalCount)
        .unwrap_or(0);
    let id = count.saturating_add(1);

    put_proposal(
        env,
        &Proposal {
            id,
            action: action.clone(),
            proposed_by: caller.clone(),
            proposed_at: now,
            executable_at: now.saturating_add(wait),
            signers: Vec::new(env),
            vetoed: false,
            executed: false,
        },
    );
    env.storage()
        .instance()
        .set(&GovernanceDataKey::ProposalCount, &id);
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);

    GovernanceActionProposed {
        proposal_id: id,
        proposed_by: caller.clone(),
        executable_at: now.saturating_add(wait),
        action: action.clone(),
    }
    .publish(env);

    Ok(id)
}

/// Adds `caller`'s signature. Repeating a signer is refused: two slots held by
/// one key are still one key.
pub fn sign(env: &Env, caller: &Address, id: u64) -> Result<u32, StreamError> {
    require_signer(env, caller)?;
    let mut record =
        proposal(env, id).ok_or_else(|| surface::reject(Branch::GovernanceProposalNotFound))?;
    if record.executed {
        return Err(surface::reject(Branch::GovernanceAlreadyExecuted));
    }
    if record.vetoed {
        return Err(surface::reject(Branch::GovernanceAlreadyVetoed));
    }
    if record.signers.contains(caller) {
        return Err(surface::reject(Branch::GovernanceDuplicateSignature));
    }

    record.signers.push_back(caller.clone());
    let count = record.signers.len();
    put_proposal(env, &record);

    GovernanceActionSigned {
        proposal_id: id,
        signer: caller.clone(),
        signature_count: count,
    }
    .publish(env);

    Ok(count)
}

/// Vetoes a proposal while its window is still open.
pub fn veto(env: &Env, caller: &Address, id: u64) -> Result<(), StreamError> {
    require_signer(env, caller)?;
    let mut record =
        proposal(env, id).ok_or_else(|| surface::reject(Branch::GovernanceProposalNotFound))?;
    if record.executed {
        return Err(surface::reject(Branch::GovernanceAlreadyExecuted));
    }
    if record.vetoed {
        return Err(surface::reject(Branch::GovernanceAlreadyVetoed));
    }
    if env.ledger().timestamp() >= record.executable_at {
        return Err(surface::reject(Branch::GovernanceVetoWindowClosed));
    }

    record.vetoed = true;
    put_proposal(env, &record);

    GovernanceActionVetoed {
        proposal_id: id,
        vetoed_by: caller.clone(),
    }
    .publish(env);

    Ok(())
}

/// Everything that must hold before an action is applied: not vetoed, not
/// already executed, window elapsed, and at least [`REQUIRED_SIGNATURES`]
/// signatures that are still members of the current signer set.
///
/// The re-check against the live set is what makes a rotation also a revocation
/// — a proposal the old key half-signed cannot finish after that key is gone.
/// A rotation itself is the exception it has to be: it may mature on one
/// signature, because that is the containment path for a lost or stolen key.
pub fn ready(env: &Env, id: u64) -> Result<Proposal, StreamError> {
    if !is_initialized(env) {
        return Err(surface::reject(Branch::GovernanceNotInitialized));
    }
    let record =
        proposal(env, id).ok_or_else(|| surface::reject(Branch::GovernanceProposalNotFound))?;
    if record.vetoed {
        return Err(surface::reject(Branch::GovernanceAlreadyVetoed));
    }
    if record.executed {
        return Err(surface::reject(Branch::GovernanceAlreadyExecuted));
    }
    if env.ledger().timestamp() < record.executable_at {
        return Err(surface::reject(Branch::GovernanceVetoWindowOpen));
    }

    let required = if record.action.is_rotation() {
        1
    } else {
        REQUIRED_SIGNATURES
    };
    if record.signers.len() < required {
        return Err(surface::reject(Branch::GovernanceSignaturesInsufficient));
    }
    let current = signers(env);
    let mut index = 0u32;
    let mut live = 0u32;
    while index < record.signers.len() {
        if let Some(signer) = record.signers.get(index) {
            if current.contains(&signer) {
                live += 1;
            }
        }
        index += 1;
    }
    if live < required {
        return Err(surface::reject(Branch::GovernanceSignaturesInsufficient));
    }

    Ok(record)
}

/// Marks the proposal consumed. Called *before* the action's effects so a
/// dispatch that fails partway cannot be replayed: the whole invocation rolls
/// back together, including this flag.
pub fn mark_executed(env: &Env, record: &Proposal) {
    let mut consumed = record.clone();
    consumed.executed = true;
    put_proposal(env, &consumed);
}

/// Publishes the execution half of the audit trail.
pub fn record_execution(env: &Env, record: &Proposal, executor: &Address) {
    GovernanceActionExecuted {
        proposal_id: record.id,
        action: record.action.clone(),
        signers: record.signers.clone(),
        executed_by: executor.clone(),
    }
    .publish(env);
}
