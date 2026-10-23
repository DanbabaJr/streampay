//! Gas sponsorship: relaying recipients' claims so they pay no transaction fee.
//!
//! Soroban has no built-in mempool relayer and a contract cannot meter another
//! account's XLM fee, so sponsorship is built from **inner authorization**: the
//! two parties who *would* sign the transaction sign an off-chain, domain-
//! separated intent instead, and an operator submits the transaction on their
//! behalf. This module implements the contract half of that pattern.
//!
//! # Roles
//!
//! * **Sponsor** — funds gas and caps its own exposure. Identified by an
//!   `Address`; owns a budget ([`SponsorConfig`]) and a single authorized
//!   *operator* ed25519 key ([`SponsorKey::OperatorKey`]) that signs relay
//!   requests. The sponsor's owner key stays cold; it signs budget changes and
//!   rotations, never per-claim relay messages.
//! * **Operator** — the relayer. Pays the Soroban transaction fee and proves it
//!   was authorized by the sponsor by signing the claim intent with the
//!   sponsor's registered operator key.
//! * **Beneficiary** — the stream's recipient. Enrolls one ed25519 consent key
//!   ([`SponsorKey::BeneficiaryKey`]) and signs the same claim intent, so a
//!   relayer can never move funds the beneficiary did not request.
//!
//! # Inner-authorization mechanism (the exact mechanism chosen)
//!
//! A plain account's `require_auth` cannot be satisfied by a third-party
//! relayer, and smart-account (`authorize_as_current_contract`) callbacks would
//! force every beneficiary to deploy and fund a contract wallet — the opposite
//! of "claim for free". Instead both authorizations are carried as **ed25519
//! signatures over a canonical message** that the contract rebuilds itself and
//! verifies with [`soroban_sdk::Crypto::ed25519_verify`] over its own SHA-256
//! digest (the same hash-first form the SDK recommends for auth payloads). The
//! message is bound to the contract id, both parties, the token, the stream,
//! the amount, a nonce and a deadline, so a signature cannot be replayed across
//! streams, sponsors, networks, or time.
//!
//! # Replay & budget
//!
//! Each `(sponsor, beneficiary, nonce)` is spent exactly once
//! ([`SponsorKey::ClaimNonce`]); the sponsor's `per_period_limit` and each
//! beneficiary's `per_beneficiary_limit` reset on a `window_seconds` cadence
//! ([`PeriodSpend`]). Budget exhaustion is the intended brake on a compromised
//! or over-eager relayer, not a bug.
//!
//! # Signature failures panic — a deliberate exception
//!
//! `ed25519_verify` traps rather than returning a value, so an invalid
//! signature aborts the host call instead of mapping to a `StreamError`. It
//! runs after every check that *does* return a code, so a well-formed business
//! rejection is always explainable and a forged signature simply never lands.
//! This is the only non-`Result` failure path in the contract.

use soroban_sdk::{
    contracttype, token::TokenClient, xdr::ToXdr, Address, Bytes, BytesN, Env, IntoVal, String,
    Symbol, Val, Vec,
};

use crate::errors::StreamError;
use crate::events::{
    BeneficiaryEnrolled, OperatorKeyRotated, SponsorActiveSet, SponsorClaim, SponsorRegistered,
};
use crate::stream;
use crate::surface::{self, Branch};
use crate::StreamStatus;
/// Smallest budget window we accept, in seconds. A zero window would reset the
/// spend counter on every call and defeat the cap, so we require a real
/// interval.
pub const MIN_WINDOW_SECONDS: u64 = 1;

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Storage keys for the sponsorship subsystem, kept separate from the stream"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " index so budget state and stream state evolve independently."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SponsorKey {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A sponsor's budget configuration."
    )]
    SponsorConfig(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The single ed25519 key the sponsor authorizes to sign relay requests."
    )]
    OperatorKey(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The sponsor's spend within the current budget window."
    )]
    SponsorPeriod(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A beneficiary's enrolled ed25519 consent key."
    )]
    BeneficiaryKey(Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A beneficiary's spend within the sponsor's current budget window."
    )]
    BeneficiarySpend(Address, Address),
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " A spent claim nonce, keyed by `(sponsor, beneficiary, nonce)`."
    )]
    ClaimNonce(Address, Address, u64),
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " A sponsor's budget policy. The sponsor address is the map key, so it is not"
)]
#[cfg_attr(not(target_family = "wasm"), doc = " repeated here.")]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SponsorConfig {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " The single token this sponsor will fund claims against. A claim whose"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " stream uses any other token is rejected: caps are per-token, otherwise a"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " sponsor capping cheap tokens could be drained on expensive ones."
    )]
    pub token: Address,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Maximum total payout the sponsor will absorb per `window_seconds`."
    )]
    pub per_period_limit: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Maximum payout to a single beneficiary per `window_seconds`."
    )]
    pub per_beneficiary_limit: i128,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Budget period length in seconds. Spend counters reset when the ledger"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " timestamp crosses `period_start + window_seconds`."
    )]
    pub window_seconds: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " When false, all claims against this sponsor are rejected. Lets a sponsor"
    )]
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " stop the bleeding without deleting (or losing) its budget state."
    )]
    pub active: bool,
}

#[cfg_attr(
    not(target_family = "wasm"),
    doc = " Spend accumulated within one budget window. Reused for both the"
)]
#[cfg_attr(
    not(target_family = "wasm"),
    doc = " sponsor-global and the per-beneficiary counters."
)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeriodSpend {
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Ledger timestamp at which the current window began."
    )]
    pub period_start: u64,
    #[cfg_attr(
        not(target_family = "wasm"),
        doc = " Total payout absorbed in the current window."
    )]
    pub spend: i128,
}

impl PeriodSpend {
    /// Spend counted against the *current* window at `now`: an elapsed window
    /// has effectively zero spend (it rolls over before the next claim).
    pub fn effective(&self, window_seconds: u64, now: u64) -> i128 {
        if now.saturating_sub(self.period_start) < window_seconds {
            self.spend
        } else {
            0
        }
    }

    /// Records `amount` spent, rolling the window forward first if it elapsed.
    /// Returns [`StreamError::MathOverflow`] if `spend + amount` would overflow
    /// `i128` (defensive: caps are validated `> 0` and a passing cap check
    /// already keeps the sum well inside `i128`).
    fn spend_more(&mut self, amount: i128, now: u64, window: u64) -> Result<(), StreamError> {
        if now.saturating_sub(self.period_start) >= window {
            self.period_start = now;
            self.spend = 0;
        }
        self.spend = self
            .spend
            .checked_add(amount)
            .ok_or_else(|| surface::reject(Branch::PayoutOverflow))?;
        Ok(())
    }
}

// ------------------------------------------------------------- storage ------

/// TTL maintenance mirrors `stream.rs`: budget and nonce entries extend on
/// every touch so an active sponsor never goes cold.
const TTL_THRESHOLD_LEDGERS: u32 = 200_000;
const TTL_EXTEND_LEDGERS: u32 = 500_000;

pub fn put_config(env: &Env, sponsor: &Address, cfg: &SponsorConfig) {
    let key = SponsorKey::SponsorConfig(sponsor.clone());
    env.storage().persistent().set(&key, cfg);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn get_config(env: &Env, sponsor: &Address) -> Option<SponsorConfig> {
    env.storage()
        .persistent()
        .get(&SponsorKey::SponsorConfig(sponsor.clone()))
}

pub fn get_operator_key(env: &Env, sponsor: &Address) -> Option<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&SponsorKey::OperatorKey(sponsor.clone()))
}

pub fn put_operator_key(env: &Env, sponsor: &Address, key: &BytesN<32>) {
    let sk = SponsorKey::OperatorKey(sponsor.clone());
    env.storage().persistent().set(&sk, key);
    env.storage()
        .persistent()
        .extend_ttl(&sk, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn get_beneficiary_key(env: &Env, beneficiary: &Address) -> Option<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&SponsorKey::BeneficiaryKey(beneficiary.clone()))
}

pub fn put_beneficiary_key(env: &Env, beneficiary: &Address, key: &BytesN<32>) {
    let bk = SponsorKey::BeneficiaryKey(beneficiary.clone());
    env.storage().persistent().set(&bk, key);
    env.storage()
        .persistent()
        .extend_ttl(&bk, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn get_period(env: &Env, key: &SponsorKey) -> PeriodSpend {
    env.storage().persistent().get(key).unwrap_or(PeriodSpend {
        period_start: 0,
        spend: 0,
    })
}

pub fn put_period(env: &Env, key: &SponsorKey, period: &PeriodSpend) {
    env.storage().persistent().set(key, period);
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

pub fn nonce_used(env: &Env, sponsor: &Address, beneficiary: &Address, nonce: u64) -> bool {
    env.storage().persistent().has(&SponsorKey::ClaimNonce(
        sponsor.clone(),
        beneficiary.clone(),
        nonce,
    ))
}

pub fn mark_nonce(env: &Env, sponsor: &Address, beneficiary: &Address, nonce: u64) {
    let key = SponsorKey::ClaimNonce(sponsor.clone(), beneficiary.clone(), nonce);
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS);
}

// ------------------------------------------------ canonical message ---------

#[allow(clippy::too_many_arguments)] // the full signed-payload surface is intentional
/// Builds the canonical signed payload as a heterogeneous `Vec<Val>`: a fixed
/// domain tag, then the four strkeys (contract, sponsor, beneficiary, token)
/// and the four numeric fields (stream id, amount, nonce, deadline), in that
/// order. Serializing this vector with [`ToXdr`] is deterministic and the
/// single source of truth for both signer and verifier — every field is a
/// self-delimiting ScVal, so the encoding is injective and no field boundary
/// can shift into another.
pub fn message(
    env: &Env,
    contract_id: &Address,
    sponsor: &Address,
    beneficiary: &Address,
    token: &Address,
    stream_id: u64,
    amount: i128,
    nonce: u64,
    deadline: u64,
) -> Vec<Val> {
    let mut parts: Vec<Val> = Vec::new(env);
    parts.push_back(String::from_str(env, "StreamPay/sponsored-withdraw/v1").into_val(env));
    parts.push_back(contract_id.to_string().into_val(env));
    parts.push_back(sponsor.to_string().into_val(env));
    parts.push_back(beneficiary.to_string().into_val(env));
    parts.push_back(token.to_string().into_val(env));
    parts.push_back(stream_id.into_val(env));
    parts.push_back(amount.into_val(env));
    parts.push_back(nonce.into_val(env));
    parts.push_back(deadline.into_val(env));
    parts
}

/// The SHA-256 digest both ed25519 signatures are verified against (signing the
/// hash, not the raw message, is the SDK's recommended domain-separation
/// posture for auth payloads).
pub fn signature_digest(env: &Env, parts: &Vec<Val>) -> BytesN<32> {
    let msg: Bytes = parts.clone().to_xdr(env);
    env.crypto().sha256(&msg).to_bytes()
}

/// Verifies an ed25519 `signature` from `public_key` over the SHA-256 digest of
/// the canonical message. Panics (host trap) on an invalid signature — see the
/// module doc.
fn verify_sig(env: &Env, public_key: &BytesN<32>, parts: &Vec<Val>, signature: &BytesN<64>) {
    let digest = signature_digest(env, parts);
    env.crypto()
        .ed25519_verify(public_key, &digest.into(), signature);
}

// ------------------------------------------------------- entry points -------
//
// These are plain module functions (not a second `#[contractimpl]`): the
// contract's single `#[contractimpl] impl StreamingPayments` block in `lib.rs`
// delegates to them, so the generated client/args types stay in one module.

#[allow(clippy::too_many_arguments)] // mirrors the contract's 6-arg register surface
pub fn register_sponsor(
    env: Env,
    sponsor: Address,
    token: Address,
    per_period_limit: i128,
    per_beneficiary_limit: i128,
    window_seconds: u64,
    operator_key: BytesN<32>,
) -> Result<(), StreamError> {
    sponsor.require_auth();
    if per_period_limit <= 0 || per_beneficiary_limit <= 0 {
        return Err(surface::reject(Branch::RegisterLimitNonPositive));
    }
    if window_seconds < MIN_WINDOW_SECONDS {
        return Err(surface::reject(Branch::RegisterLimitNonPositive));
    }

    let cfg = SponsorConfig {
        token: token.clone(),
        per_period_limit,
        per_beneficiary_limit,
        window_seconds,
        active: true,
    };
    put_config(&env, &sponsor, &cfg);
    put_operator_key(&env, &sponsor, &operator_key);
    // Fresh budget window for a (re)registration.
    put_period(
        &env,
        &SponsorKey::SponsorPeriod(sponsor.clone()),
        &PeriodSpend {
            period_start: env.ledger().timestamp(),
            spend: 0,
        },
    );

    SponsorRegistered {
        sponsor,
        kind: Symbol::new(&env, "registered"),
        token,
        per_period_limit,
        per_beneficiary_limit,
        window_seconds,
    }
    .publish(&env);
    Ok(())
}

/// Pauses or resumes a sponsor's budget. Requires the sponsor's own
/// authorization. Pausing keeps all budget state; resuming reuses it.
pub fn set_sponsor_active(env: Env, sponsor: Address, active: bool) -> Result<(), StreamError> {
    sponsor.require_auth();
    let mut cfg =
        get_config(&env, &sponsor).ok_or_else(|| surface::reject(Branch::SponsorNotFound))?;
    cfg.active = active;
    put_config(&env, &sponsor, &cfg);

    SponsorActiveSet {
        sponsor,
        kind: Symbol::new(&env, "active"),
        active,
    }
    .publish(&env);
    Ok(())
}

/// Rotates the sponsor's authorized operator (relayer) key. Requires the
/// sponsor's own authorization. From this call onward, relay signatures must
/// come from `new_operator_key`; the previous key stops validating
/// immediately. This is the sponsor's recovery path if an operator key is
/// compromised (see the threat model in `docs/ARCHITECTURE.md`).
pub fn rotate_operator_key(
    env: Env,
    sponsor: Address,
    new_operator_key: BytesN<32>,
) -> Result<(), StreamError> {
    sponsor.require_auth();
    // A rotation is only meaningful for an existing budget.
    get_config(&env, &sponsor).ok_or_else(|| surface::reject(Branch::SponsorNotFound))?;
    put_operator_key(&env, &sponsor, &new_operator_key);

    OperatorKeyRotated {
        sponsor,
        kind: Symbol::new(&env, "rotate"),
        new_operator_key,
    }
    .publish(&env);
    Ok(())
}

/// Binds (or rotates) a beneficiary's ed25519 consent key. Requires the
/// beneficiary's own authorization, so a relayer cannot pre-register a key
/// it controls and later forge "consent". One-time setup; afterwards the
/// beneficiary claims for free until they rotate.
pub fn enroll_beneficiary(
    env: Env,
    beneficiary: Address,
    public_key: BytesN<32>,
) -> Result<(), StreamError> {
    beneficiary.require_auth();
    put_beneficiary_key(&env, &beneficiary, &public_key);

    BeneficiaryEnrolled {
        beneficiary,
        kind: Symbol::new(&env, "enroll"),
        public_key,
    }
    .publish(&env);
    Ok(())
}

#[allow(clippy::too_many_arguments)] // the full relay surface is the intended client API
/// The sponsored claim path: pays `amount` of a stream's accrued balance to
/// its recipient, funded with the *operator's* gas rather than the
/// beneficiary's. Any account can submit this — no `require_auth` — because
/// both parties' consent is carried in the two ed25519 signatures.
///
/// Ordering is deliberate: every check with a `StreamError` code runs
/// before the (panic-on-invalid) signature verification, so callers always
/// get an explainable rejection for malformed business inputs, and effects
/// (nonce, budget, stream) are recorded before the payout (checks-effects-
/// interactions) so a reentrant token callback cannot over-withdraw.
pub fn sponsored_withdraw(
    env: Env,
    sponsor: Address,
    beneficiary: Address,
    stream_id: u64,
    amount: i128,
    nonce: u64,
    deadline: u64,
    operator_sig: BytesN<64>,
    beneficiary_sig: BytesN<64>,
) -> Result<(), StreamError> {
    // --- sponsor budget --------------------------------------------------
    let cfg = get_config(&env, &sponsor).ok_or_else(|| surface::reject(Branch::SponsorNotFound))?;
    if !cfg.active {
        return Err(surface::reject(Branch::SponsorInactive));
    }
    let operator_key =
        get_operator_key(&env, &sponsor).ok_or_else(|| surface::reject(Branch::SponsorNotFound))?;

    // --- stream: live, matches the sponsor's token, pays this beneficiary --
    let mut s = stream::get_stream(&env, stream_id)?;
    if s.status != StreamStatus::Active || s.token != cfg.token || beneficiary != s.recipient {
        return Err(surface::reject(Branch::StreamNotActive));
    }

    // --- amount mirrors the unsponsored `withdraw` contract --------------
    if amount <= 0 {
        return Err(surface::reject(Branch::SponsoredWithdrawAmountNonPositive));
    }
    let resolved = crate::oracle::resolve_stream_time(&env, stream_id, s.use_oracle);
    let available = stream::available_amount_with_plan(&env, &s, resolved.timestamp)?;
    if amount > available {
        return Err(surface::reject(
            Branch::SponsoredWithdrawAmountExceedsAvailable,
        ));
    }

    // --- consent / replay / expiry ---------------------------------------
    let beneficiary_key = get_beneficiary_key(&env, &beneficiary)
        .ok_or_else(|| surface::reject(Branch::BeneficiaryNotEnrolled))?;
    if env.ledger().timestamp() > deadline {
        return Err(surface::reject(Branch::ClaimExpired));
    }
    if nonce_used(&env, &sponsor, &beneficiary, nonce) {
        return Err(surface::reject(Branch::ClaimNonceReplay));
    }

    // --- budget caps (period, then beneficiary) --------------------------
    let now = env.ledger().timestamp();
    let mut sper = get_period(&env, &SponsorKey::SponsorPeriod(sponsor.clone()));
    if sper.effective(cfg.window_seconds, now) + amount > cfg.per_period_limit {
        return Err(surface::reject(Branch::SponsorBudgetPeriodExceeded));
    }
    let bkey = SponsorKey::BeneficiarySpend(sponsor.clone(), beneficiary.clone());
    let mut bper = get_period(&env, &bkey);
    if bper.effective(cfg.window_seconds, now) + amount > cfg.per_beneficiary_limit {
        return Err(surface::reject(Branch::SponsorBudgetBeneficiaryExceeded));
    }

    // --- inner authorization (PANICS on an invalid signature) ------------
    // Rebuilt here, after the checks that return codes, so those rejections
    // never require a signature the matrix probes cannot produce.
    let parts = message(
        &env,
        &env.current_contract_address(),
        &sponsor,
        &beneficiary,
        &cfg.token,
        stream_id,
        amount,
        nonce,
        deadline,
    );
    verify_sig(&env, &operator_key, &parts, &operator_sig);
    verify_sig(&env, &beneficiary_key, &parts, &beneficiary_sig);

    // --- effects (CEI): consume the nonce, spend the budget, mark payout --
    mark_nonce(&env, &sponsor, &beneficiary, nonce);
    sper.spend_more(amount, now, cfg.window_seconds)?;
    put_period(&env, &SponsorKey::SponsorPeriod(sponsor.clone()), &sper);
    bper.spend_more(amount, now, cfg.window_seconds)?;
    put_period(&env, &bkey, &bper);

    s.withdrawn = s
        .withdrawn
        .checked_add(amount)
        .ok_or_else(|| surface::reject(Branch::PayoutOverflow))?;
    if s.withdrawn == s.deposit {
        s.status = StreamStatus::Depleted;
    }
    stream::put_stream(&env, &s);

    SponsorClaim {
        sponsor,
        kind: Symbol::new(&env, "claim"),
        stream_id,
        beneficiary,
        amount,
        nonce,
    }
    .publish(&env);

    // --- interaction last: pay the beneficiary from the stream -----------
    TokenClient::new(&env, &cfg.token).transfer(
        &env.current_contract_address(),
        stream::muxed(&s.recipient),
        &amount,
    );

    Ok(())
}
