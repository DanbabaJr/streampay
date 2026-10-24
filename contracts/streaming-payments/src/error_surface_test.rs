//! Error-surface matrix tests.
//!
//! Generated against [`Branch`](crate::surface::Branch): for every branch in the
//! registry this module runs a probe that triggers it and asserts that the
//! contract returned the branch's declared code *and* that this exact branch
//! (not merely some error sharing the code) was the one that fired. The
//! coverage tests then prove the reverse direction — no error code is dead —
//! with the retired codes explicitly exempted.
//!
//! The mapping is never hand-maintained: it lives in `surface.rs`, the probe
//! dispatch below is exhaustive over `Branch` (so a new branch is a compile
//! error until it has a probe), and `docs/ERROR_SURFACE.md` is generated from the same
//! table.

#![cfg(test)]

use std::vec::Vec;

use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, BytesN, String as SdkString};

use crate::sponsor;
use crate::stream::{streamed_at, DataKey};
use crate::surface::{trace, Branch, Reachability, RETIRED_CODES};
use crate::test::{Fixture, RefusingFixture};
use crate::{
    StreamError, MAX_ATTESTATIONS_PER_STREAM, MAX_DURATION_SECONDS, MAX_FEE_BPS, MAX_RATE_SEGMENTS,
    MAX_TAG_LEN, OWNERSHIP_PROPOSAL_TTL_SECONDS, RATE_PROPOSAL_TTL_SECONDS,
};

const DAY: u64 = 24 * 60 * 60;
const DEPOSIT: i128 = 10_000_000_000;

/// A 32-byte attestation hash filled with `byte`.
fn attestation_hash(env: &soroban_sdk::Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

/// A short attestation tag.
fn attestation_tag(env: &soroban_sdk::Env, s: &str) -> SdkString {
    SdkString::from_str(env, s)
}

/// `DEPOSIT` streamed evenly over ten days, floored to whole tokens. The rate a
/// renegotiation repeats, so accepting it only ever frees a few tokens of escrow
/// (the rounding residue of the floor) instead of demanding a fresh pull.
const RATE_PER_SECOND: i128 = DEPOSIT / (10 * DAY) as i128;

/// Applies `count` accepted rate changes, one per second, so the stream's
/// schedule holds exactly `count + 1` windows.
fn fill_rate_segments(f: &Fixture, id: u64, count: u32) {
    for _ in 0..count {
        f.advance_time(1);
        f.client
            .mock_all_auths()
            .propose_rate_change(&f.sender, &id, &RATE_PER_SECOND);
        f.client
            .mock_all_auths()
            .accept_rate_change(&f.recipient, &id);
    }
}

/// Pins the governance rate bounds for the stream's token.
fn set_rate_policy(f: &Fixture, min_rate: i128, max_rate: i128) {
    f.client.mock_all_auths().set_stream_policy(
        &f.governor,
        &Some(f.token.clone()),
        &crate::StreamPolicy {
            min_deposit: 0,
            min_duration: 0,
            max_duration: 0,
            min_rate,
            max_rate,
        },
    );
}

fn schedule_intent(f: &Fixture, execute_after: u64, expires_at: u64) -> u64 {
    let now = f.env.ledger().timestamp();
    f.client.mock_all_auths().schedule_stream(
        &f.sender,
        &f.recipient,
        &f.token,
        &DEPOSIT,
        &(now + 2 * DAY),
        &(now + 3 * DAY),
        &false,
        &0,
        &1,
        &0,
        &execute_after,
        &expires_at,
    )
}

/// Unwraps the contract's rejection into its `StreamError`.
macro_rules! rejected {
    ($call:expr) => {
        $call
            .expect_err("expected the contract to reject the call")
            .unwrap()
    };
}

// ------------------------------------------- sponsorship probe scaffolding ---
//
// The rejectable sponsorship branches all fire *before* signature verification
// (see `sponsor.rs`), so these helpers need only arrange budget/stream state —
// dummy signatures never reach verification. A valid-signature happy path is
// exercised separately in `test.rs`.

/// Registers an active sponsor against `f.token` with generous caps.
fn register_sponsor(f: &Fixture, sponsor: &Address, period: i128, beneficiary: i128) {
    let op_key = BytesN::from_array(&f.env, &[1u8; 32]);
    f.client.mock_all_auths().register_sponsor(
        sponsor,
        &f.token,
        &period,
        &beneficiary,
        &DAY,
        &op_key,
    );
}

/// Enrolls `b` as a beneficiary with a dummy consent key.
fn enroll(f: &Fixture, b: &Address) {
    let key = BytesN::from_array(&f.env, &[2u8; 32]);
    f.client.mock_all_auths().enroll_beneficiary(b, &key);
}

/// Builds a claim relayed against `sponsor`/`f.recipient` on `id`.
///
/// Returns the generated client's nested result verbatim: `Ok(...)` when the
/// call succeeded, `Err(Ok(StreamError))` when the contract rejected it.
fn sponsored_claim(
    f: &Fixture,
    sponsor: &Address,
    id: u64,
    amount: i128,
    nonce: u64,
    deadline: u64,
) -> Result<Result<(), soroban_sdk::ConversionError>, Result<StreamError, soroban_sdk::InvokeError>>
{
    let sig = BytesN::from_array(&f.env, &[0u8; 64]);
    f.client.mock_all_auths().try_sponsored_withdraw(
        sponsor,
        &f.recipient,
        &id,
        &amount,
        &nonce,
        &deadline,
        &sig,
        &sig,
    )
}

// ------------------------------------------------------- governance probes ---
//
// Every governance branch except the bootstrap-time validation errors fires on a
// contract whose signer set already exists, so the probes share one scaffolding
// type rather than repeating the bootstrap ceremony 16 times.

/// A quiet fixture with governance bootstrapped over two distinct signers.
struct Governed {
    f: Fixture,
    a: Address,
    b: Address,
}

impl Governed {
    fn new() -> Self {
        Self::with_window(crate::DEFAULT_VETO_WINDOW_SECONDS)
    }

    /// Bootstrap a quiet fixture over the two default distinct signers.
    fn with_window(window: u64) -> Self {
        let f = Fixture::setup_quiet();
        let a = Address::generate(&f.env);
        let b = Address::generate(&f.env);
        let mut set = soroban_sdk::Vec::new(&f.env);
        set.push_back(a.clone());
        set.push_back(b.clone());
        f.client
            .mock_all_auths()
            .governance_bootstrap(&f.governor, &set, &window);
        Governed { f, a, b }
    }

    /// Propose a fee change from `caller` and return the proposal id.
    fn propose_fee(&self, caller: &Address, new_fee_bps: u32) -> u64 {
        self.f
            .client
            .mock_all_auths()
            .governance_propose(caller, &crate::GovernanceAction::SetFeeBps(new_fee_bps))
    }

    /// Advance past the veto window.
    fn mature(&self) {
        self.f.advance_time(crate::DEFAULT_VETO_WINDOW_SECONDS + 1);
    }
}

/// Triggers `branch` and returns the error the contract produced, or `None` for
/// a branch classified [`Reachability::Defensive`] (no reachable trigger).
fn probe(branch: Branch) -> Option<StreamError> {
    match branch {
        // ----------------------------------------------------- create_stream
        Branch::CreateDepositNonPositive => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &0,
                &(now + DAY),
                &(now + 2 * DAY),
                &false,
            )))
        }
        Branch::CreateStartTimeInPast => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            f.advance_time(DAY);
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &now,
                &(now + 2 * DAY),
                &false,
            )))
        }
        Branch::CreateInvalidTimeRange => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &(now + DAY),
                &(now + DAY),
                &false,
            )))
        }
        Branch::CreateDurationTooLong => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &now,
                &(now + MAX_DURATION_SECONDS + 1),
                &false,
            )))
        }
        Branch::CapacityOverflow => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &i128::MAX,
                &now,
                &(now + 2 * 365 * DAY),
                &false,
            )))
        }
        // ---------------------------------------------------------- withdraw
        Branch::WithdrawAmountNonPositive => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.advance_time(2 * DAY);
            Some(rejected!(f.client.mock_all_auths().try_withdraw(&id, &0)))
        }
        Branch::WithdrawAmountExceedsAvailable => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.advance_time(2 * DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_withdraw(&id, &(DEPOSIT / 10 + 1))))
        }
        // ------------------------------------------------------ withdraw_max
        Branch::WithdrawMaxNothingToWithdraw => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f.client.mock_all_auths().try_withdraw_max(&id)))
        }
        // ----------------------------------------------------- cancel_stream
        Branch::CancelStreamNotCancellable => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_stream(&f.recipient, &id)))
        }
        Branch::CancelStreamNotAuthorized => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
            let stranger = Address::generate(&f.env);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_stream(&stranger, &id)))
        }
        // ----------------------------------------------------------- top_up
        Branch::TopUpAmountNonPositive => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f.client.mock_all_auths().try_top_up(&id, &0)))
        }
        Branch::TopUpDepositOverflow => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            // DEPOSIT + i128::MAX overflows i128.
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_top_up(&id, &i128::MAX)))
        }
        // --------------------------------------------------- attach_metadata
        Branch::AttachMetadataNotAuthorized => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            let stranger = Address::generate(&f.env);
            Some(rejected!(f.client.mock_all_auths().try_attach_metadata(
                &stranger,
                &id,
                &attestation_hash(&f.env, 0x01),
                &attestation_tag(&f.env, "invoice-0042"),
            )))
        }
        Branch::AttachMetadataTagTooLong => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            let too_long: std::string::String =
                "a".repeat(usize::try_from(MAX_TAG_LEN).unwrap() + 1);
            Some(rejected!(f.client.mock_all_auths().try_attach_metadata(
                &f.sender,
                &id,
                &attestation_hash(&f.env, 0x02),
                &SdkString::from_str(&f.env, &too_long),
            )))
        }
        Branch::AttachMetadataLimitReached => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            // Fill the stream's append-only list to its cap, then attach once more.
            for _ in 0..MAX_ATTESTATIONS_PER_STREAM {
                f.client.mock_all_auths().attach_metadata(
                    &f.sender,
                    &id,
                    &attestation_hash(&f.env, 0x0F),
                    &attestation_tag(&f.env, "label"),
                );
            }
            Some(rejected!(f.client.mock_all_auths().try_attach_metadata(
                &f.sender,
                &id,
                &attestation_hash(&f.env, 0xFF),
                &attestation_tag(&f.env, "one-too-many"),
            )))
        }
        // ------------------------------------------------------------ disputes
        Branch::CancelDuringDispute => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
            f.raise_dispute(id);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_stream(&f.sender, &id)))
        }
        Branch::TopUpDuringDispute => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.raise_dispute(id);
            Some(rejected!(f.client.mock_all_auths().try_top_up(&id, &1)))
        }
        Branch::RaiseDisputeAlreadyActive => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.raise_dispute(id);
            Some(rejected!(f.client.mock_all_auths().try_raise_dispute(&id)))
        }
        Branch::DisputeNotOpen => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f.client.mock_all_auths().try_get_dispute(&id)))
        }
        Branch::ExpireDisputeTooEarly => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.raise_dispute(id);
            Some(rejected!(f.client.mock_all_auths().try_expire_dispute(&id)))
        }
        Branch::ResolveCallerNotSender => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.raise_dispute(id);
            // The recipient is not the sender: only senders resolve.
            Some(rejected!(f.client.mock_all_auths().try_resolve_dispute(
                &f.recipient,
                &id,
                &false
            )))
        }
        // --------------------------------------------- shared storage / math
        Branch::StreamNotFound => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_get_stream(&999)))
        }
        Branch::StreamNotActive => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.client.mock_all_auths().cancel_stream(&f.sender, &id);
            Some(rejected!(f.client.mock_all_auths().try_withdraw(&id, &1)))
        }
        Branch::RateProductOverflow => {
            // The pure rate function's overflow guard, reachable directly
            // (its error is a bare `StreamError`, not a host error wrapper).
            Some(streamed_at(i128::MAX, 3, 3).unwrap_err())
        }
        // ---------------------------------------------------------- treasury
        Branch::SetFeeRateTooHigh => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_set_fee_bps(&f.governor, &(MAX_FEE_BPS + 1),)))
        }
        Branch::GovernorNotAllowed => {
            let f = Fixture::setup_quiet();
            let stranger = Address::generate(&f.env);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_set_fee_bps(&stranger, &0)))
        }
        Branch::AcceptGovernorNoPending => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_governor(&f.sender)))
        }
        Branch::AcceptGovernorNotNominee => {
            let f = Fixture::setup_quiet();
            f.client
                .mock_all_auths()
                .nominate_governor(&f.governor, &f.recipient);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_governor(&f.sender)))
        }
        Branch::WithdrawTreasuryAmountNonPositive => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_withdraw_treasury(
                &f.governor,
                &f.token,
                &f.recipient,
                &0,
            )))
        }
        Branch::WithdrawTreasuryExceedsBalance => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_withdraw_treasury(
                &f.governor,
                &f.token,
                &f.recipient,
                &1,
            )))
        }
        // ------------------------------------------------------- sponsorship
        Branch::RegisterLimitNonPositive => {
            let f = Fixture::setup_quiet();
            let sponsor = Address::generate(&f.env);
            let op_key = BytesN::from_array(&f.env, &[1u8; 32]);
            Some(rejected!(f.client.mock_all_auths().try_register_sponsor(
                &sponsor, &f.token, &0, &100, &DAY, &op_key,
            )))
        }
        Branch::SponsoredWithdrawAmountNonPositive => {
            let f = Fixture::setup_quiet();
            let sponsor = Address::generate(&f.env);
            register_sponsor(&f, &sponsor, 10_000, 10_000);
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(sponsored_claim(&f, &sponsor, id, 0, 1, {
                f.env.ledger().timestamp() + DAY
            })))
        }
        Branch::SponsoredWithdrawAmountExceedsAvailable => {
            let f = Fixture::setup_quiet();
            let sponsor = Address::generate(&f.env);
            register_sponsor(&f, &sponsor, 10_000, 10_000);
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            // Stream has not started, so nothing is accrued: any positive
            // amount exceeds the (zero) available balance.
            Some(rejected!(sponsored_claim(&f, &sponsor, id, 1, 1, {
                f.env.ledger().timestamp() + DAY
            })))
        }
        Branch::SponsorNotFound => {
            let f = Fixture::setup_quiet();
            let sponsor = Address::generate(&f.env);
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(sponsored_claim(&f, &sponsor, id, 1, 1, {
                f.env.ledger().timestamp() + DAY
            })))
        }
        Branch::SponsorInactive => {
            let f = Fixture::setup_quiet();
            let sponsor = Address::generate(&f.env);
            register_sponsor(&f, &sponsor, 10_000, 10_000);
            f.client
                .mock_all_auths()
                .set_sponsor_active(&sponsor, &false);
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(sponsored_claim(&f, &sponsor, id, 1, 1, {
                f.env.ledger().timestamp() + DAY
            })))
        }
        Branch::BeneficiaryNotEnrolled => {
            let f = Fixture::setup_quiet();
            let sponsor = Address::generate(&f.env);
            register_sponsor(&f, &sponsor, 10_000, 10_000);
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.advance_time(2 * DAY); // accrue so the amount checks pass
                                     // Deliberately skip `enroll_beneficiary`.
            Some(rejected!(sponsored_claim(&f, &sponsor, id, 1, 1, {
                f.env.ledger().timestamp() + DAY
            })))
        }
        Branch::ClaimExpired => {
            let f = Fixture::setup_quiet();
            let sponsor = Address::generate(&f.env);
            register_sponsor(&f, &sponsor, 10_000, 10_000);
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.advance_time(2 * DAY);
            enroll(&f, &f.recipient);
            // deadline is far in the past relative to the advanced clock.
            Some(rejected!(sponsored_claim(&f, &sponsor, id, 1, 1, 0)))
        }
        Branch::ClaimNonceReplay => {
            let f = Fixture::setup_quiet();
            let sponsor = Address::generate(&f.env);
            register_sponsor(&f, &sponsor, 10_000, 10_000);
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.advance_time(2 * DAY);
            enroll(&f, &f.recipient);
            // Seed the nonce directly (a real spend would need valid sigs),
            // then the replay check fires before signature verification.
            f.env.as_contract(&f.client.address, || {
                sponsor::mark_nonce(&f.env, &sponsor, &f.recipient, 5);
            });
            Some(rejected!(sponsored_claim(&f, &sponsor, id, 1, 5, {
                f.env.ledger().timestamp() + DAY
            })))
        }
        Branch::SponsorBudgetPeriodExceeded => {
            let f = Fixture::setup_quiet();
            let sponsor = Address::generate(&f.env);
            register_sponsor(&f, &sponsor, 1, 1_000_000);
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.advance_time(2 * DAY);
            enroll(&f, &f.recipient);
            Some(rejected!(sponsored_claim(&f, &sponsor, id, 100, 1, {
                f.env.ledger().timestamp() + DAY
            })))
        }
        Branch::SponsorBudgetBeneficiaryExceeded => {
            let f = Fixture::setup_quiet();
            let sponsor = Address::generate(&f.env);
            register_sponsor(&f, &sponsor, 1_000_000, 1);
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.advance_time(2 * DAY);
            enroll(&f, &f.recipient);
            Some(rejected!(sponsored_claim(&f, &sponsor, id, 100, 1, {
                f.env.ledger().timestamp() + DAY
            })))
        }
        // ------------------------------------------------ scheduled intents
        Branch::IntentNotFound => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.try_get_intent(&999)))
        }
        Branch::IntentNotPending => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now, now + DAY);
            let _ = f
                .client
                .mock_all_auths()
                .execute_scheduled(&id, &f.recipient);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_execute_scheduled(&id, &f.recipient,)))
        }
        Branch::IntentNotYetExecutable => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now + DAY, now + 3 * DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_execute_scheduled(&id, &f.recipient,)))
        }
        Branch::IntentExpired => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now, now + DAY);
            f.advance_time(DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_execute_scheduled(&id, &f.recipient,)))
        }
        Branch::IntentNotCancellable => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now, now + DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_scheduled(&f.sender, &id,)))
        }
        Branch::ScheduleInvalidParameters => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_schedule_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &(now + 2 * DAY),
                &(now + 3 * DAY),
                &false,
                &0,
                &0,
                &0,
                &now,
                &(now + DAY),
            )))
        }
        Branch::IntentParamsMismatch => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now, now + DAY);
            let contract = f.client.address.clone();
            f.env.as_contract(&contract, || {
                let mut intent: crate::ScheduledIntent = f
                    .env
                    .storage()
                    .persistent()
                    .get(&DataKey::Intent(id))
                    .unwrap();
                intent.deposit += 1;
                f.env
                    .storage()
                    .persistent()
                    .set(&DataKey::Intent(id), &intent);
            });
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_execute_scheduled(&id, &f.recipient,)))
        }
        Branch::IntentNotExpired => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let id = schedule_intent(&f, now, now + DAY);
            Some(rejected!(f.client.try_reclaim_expired(&id)))
        }
        // ---------------------------------------------- token interactions
        //
        // These branches fire when the *token* refuses a movement. The probes
        // use [`RefusingFixture`]: a minimal SEP-41 contract whose error code
        // deliberately equals 13 (`NothingToWithdraw`), so receiving StreamPay's
        // own code proves the raw token error did not leak.
        Branch::CreateDepositTransferFailed => {
            let f = RefusingFixture::setup_quiet();
            f.refuse(false, true); // refuses the incoming pull
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &now,
                &(now + 2 * DAY),
                &false,
            )))
        }
        Branch::TopUpTransferFailed => {
            let f = RefusingFixture::setup_quiet();
            let id = f.create(DEPOSIT, 0, 10 * DAY);
            f.refuse(false, true); // stops accepting incoming transfers
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_top_up(&id, &DEPOSIT)))
        }
        Branch::RecipientPayoutFailed => {
            let f = RefusingFixture::setup_quiet();
            let id = f.create(DEPOSIT, 0, 10 * DAY);
            f.advance_time(DAY); // 1 of 10 days accrued
            f.refuse(true, false); // asset stops paying out
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_withdraw(&id, &(DEPOSIT / 10))))
        }
        Branch::SenderRefundFailed => {
            let f = RefusingFixture::setup_quiet();
            // Not started: recipient_amount is 0, so only the refund leg runs.
            let id = f.create(DEPOSIT, DAY, 10 * DAY);
            f.refuse(true, false);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_stream(&f.sender, &id)))
        }
        Branch::TreasuryPayoutFailed => {
            let f = RefusingFixture::setup_quiet();
            f.client.mock_all_auths().set_fee_bps(&f.governor, &100);
            // Charges a fee into the treasury ledger (1 % of the deposit).
            let _id = f.create(DEPOSIT, 0, 10 * DAY);
            f.refuse(true, false);
            Some(rejected!(f.client.mock_all_auths().try_withdraw_treasury(
                &f.governor,
                &f.token,
                &f.recipient,
                &1,
            )))
        }
        // ------------------------------------------------------------ policy
        Branch::PolicyAssetNotAllowed => {
            let f = Fixture::setup_quiet();
            let admin = soroban_sdk::Address::generate(&f.env);
            f.client.mock_all_auths().policy_init(&admin);
            f.client.mock_all_auths().policy_set_timelock_delay(&0);
            f.client
                .mock_all_auths()
                .policy_propose_asset(&f.token, &false);
            f.client.mock_all_auths().policy_execute_asset(&f.token);
            let now = f.env.ledger().timestamp();
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &(now + DAY),
                &(now + 2 * DAY),
                &false,
            )))
        }
        Branch::PolicyTimelockNotElapsed => {
            let f = Fixture::setup_quiet();
            let admin = soroban_sdk::Address::generate(&f.env);
            f.client.mock_all_auths().policy_init(&admin);
            f.client
                .mock_all_auths()
                .policy_propose_asset(&f.token, &false);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_policy_execute_asset(&f.token)))
        }
        Branch::PolicyNoQueuedChange => {
            let f = Fixture::setup_quiet();
            let admin = soroban_sdk::Address::generate(&f.env);
            f.client.mock_all_auths().policy_init(&admin);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_policy_execute_asset(&f.token)))
        }
        Branch::PolicyNotInitialized => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_policy_execute_asset(&f.token)))
        }
        Branch::PolicyNoPendingHandoff => {
            let f = Fixture::setup_quiet();
            let admin = soroban_sdk::Address::generate(&f.env);
            f.client.mock_all_auths().policy_init(&admin);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_policy_accept_handoff()))
        }
        // ------------------------------------------------ create_streams_batch
        Branch::CreateBatchEmpty => {
            let f = Fixture::setup_quiet();
            let entries = soroban_sdk::Vec::new(&f.env);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_create_streams_batch(&entries)))
        }
        Branch::CreateBatchTooLarge => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            let mut entries = soroban_sdk::Vec::new(&f.env);
            for _ in 0..=(crate::stream::MAX_BATCH) {
                entries.push_back(crate::stream::BatchEntry {
                    sender: f.sender.clone(),
                    recipient: f.recipient.clone(),
                    token: f.token.clone(),
                    deposit: DEPOSIT,
                    start_time: now + DAY,
                    end_time: now + 2 * DAY,
                    cancelable: false,
                });
            }
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_create_streams_batch(&entries)))
        }
        Branch::ContractFrozen => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            f.client.mock_all_auths().set_frozen(&f.governor, &true);
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &(now + DAY),
                &(now + 2 * DAY),
                &false,
            )))
        }
        Branch::MigrationNotFrozen => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f.client.mock_all_auths().try_migrate_storage(
                &f.governor,
                &0,
                &50
            )))
        }
        Branch::ExecuteUpgradeNoPending => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_execute_upgrade(&f.governor)))
        }
        Branch::CancelUpgradeNoPending => {
            let f = Fixture::setup_quiet();
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_upgrade(&f.governor)))
        }
        Branch::TimelockNotExpired => {
            let f = Fixture::setup_quiet();
            let dummy_wasm_hash = soroban_sdk::BytesN::from_array(&f.env, &[0x42; 32]);
            f.client.mock_all_auths().propose_upgrade(
                &f.governor,
                &dummy_wasm_hash,
                &crate::MIN_UPGRADE_DELAY_SECONDS,
            );
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_execute_upgrade(&f.governor)))
        }
        Branch::UpgradeDelayTooShort => {
            let f = Fixture::setup_quiet();
            let dummy_wasm_hash = soroban_sdk::BytesN::from_array(&f.env, &[0x42; 32]);
            Some(rejected!(f.client.mock_all_auths().try_propose_upgrade(
                &f.governor,
                &dummy_wasm_hash,
                &0,
            )))
        }
        Branch::AlreadyMigrated => {
            let f = Fixture::setup_quiet();
            f.client.mock_all_auths().set_frozen(&f.governor, &true);
            f.client
                .mock_all_auths()
                .migrate_storage(&f.governor, &0, &50);
            Some(rejected!(f.client.mock_all_auths().try_migrate_storage(
                &f.governor,
                &0,
                &50
            )))
        }
        Branch::PolicyDepositBelowFloor => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            f.client.mock_all_auths().set_stream_policy(
                &f.governor,
                &Some(f.token.clone()),
                &crate::StreamPolicy {
                    min_deposit: 1_000,
                    min_duration: 0,
                    max_duration: 0,
                    min_rate: 0,
                    max_rate: 0,
                },
            );
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &500,
                &(now + DAY),
                &(now + 2 * DAY),
                &false,
            )))
        }
        Branch::PolicyDurationBelowFloor => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            f.client.mock_all_auths().set_stream_policy(
                &f.governor,
                &Some(f.token.clone()),
                &crate::StreamPolicy {
                    min_deposit: 0,
                    min_duration: 2 * DAY,
                    max_duration: 0,
                    min_rate: 0,
                    max_rate: 0,
                },
            );
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &(now + DAY),
                &(now + DAY + 3600),
                &false,
            )))
        }
        Branch::PolicyDurationAboveCeiling => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            f.client.mock_all_auths().set_stream_policy(
                &f.governor,
                &Some(f.token.clone()),
                &crate::StreamPolicy {
                    min_deposit: 0,
                    min_duration: 0,
                    max_duration: DAY,
                    min_rate: 0,
                    max_rate: 0,
                },
            );
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &(now + DAY),
                &(now + 3 * DAY),
                &false,
            )))
        }
        Branch::PolicyRateBelowFloor => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            f.client.mock_all_auths().set_stream_policy(
                &f.governor,
                &Some(f.token.clone()),
                &crate::StreamPolicy {
                    min_deposit: 0,
                    min_duration: 0,
                    max_duration: 0,
                    min_rate: 1_000,
                    max_rate: 0,
                },
            );
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &100,
                &(now + DAY),
                &(now + 2 * DAY),
                &false,
            )))
        }
        Branch::PolicyRateAboveCeiling => {
            let f = Fixture::setup_quiet();
            let now = f.env.ledger().timestamp();
            f.client.mock_all_auths().set_stream_policy(
                &f.governor,
                &Some(f.token.clone()),
                &crate::StreamPolicy {
                    min_deposit: 0,
                    min_duration: 0,
                    max_duration: 0,
                    min_rate: 0,
                    max_rate: 10,
                },
            );
            Some(rejected!(f.client.mock_all_auths().try_create_stream(
                &f.sender,
                &f.recipient,
                &f.token,
                &DEPOSIT,
                &(now + DAY),
                &(now + 2 * DAY),
                &false,
            )))
        }
        Branch::InvalidOracleThreshold => {
            let f = Fixture::setup_quiet();
            let pub1 = soroban_sdk::Address::generate(&f.env);
            let mut pubs = soroban_sdk::Vec::new(&f.env);
            pubs.push_back(pub1);
            Some(rejected!(f.client.mock_all_auths().try_set_oracle_config(
                &f.governor,
                &pubs,
                &2, // threshold 2 > 1 publisher
                &3600,
            )))
        }
        Branch::OraclePublishersNotConfigured => {
            let f = Fixture::setup_quiet();
            let pub1 = soroban_sdk::Address::generate(&f.env);
            let now = f.env.ledger().timestamp();
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_submit_oracle_time(&pub1, &now)))
        }
        Branch::NotOraclePublisher => {
            let f = Fixture::setup_quiet();
            let pub1 = soroban_sdk::Address::generate(&f.env);
            let unauthorized = soroban_sdk::Address::generate(&f.env);
            let mut pubs = soroban_sdk::Vec::new(&f.env);
            pubs.push_back(pub1);
            f.client
                .mock_all_auths()
                .set_oracle_config(&f.governor, &pubs, &1, &3600);
            let now = f.env.ledger().timestamp();
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_submit_oracle_time(&unauthorized, &now)))
        }
        Branch::OracleReportTooOld => {
            let f = Fixture::setup_quiet();
            let pub1 = soroban_sdk::Address::generate(&f.env);
            let mut pubs = soroban_sdk::Vec::new(&f.env);
            pubs.push_back(pub1.clone());
            f.client
                .mock_all_auths()
                .set_oracle_config(&f.governor, &pubs, &1, &3600);
            let now = f.env.ledger().timestamp();
            // Future timestamp exceeding now + max_stale_seconds triggers OracleReportTooOld
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_submit_oracle_time(&pub1, &(now + 4000))))
        }
        // --------------------------------------------- ownership transfer
        Branch::ProposeNotAuthorized => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            let stranger = Address::generate(&f.env);
            let target = soroban_sdk::Address::generate(&f.env);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_propose_ownership_transfer(&stranger, &id, &target)))
        }
        Branch::ProposeInvalidTarget => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_propose_ownership_transfer(&f.sender, &id, &f.sender)))
        }
        Branch::ProposeAlreadyPending => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            let first = soroban_sdk::Address::generate(&f.env);
            let second = soroban_sdk::Address::generate(&f.env);
            f.client
                .mock_all_auths()
                .propose_ownership_transfer(&f.sender, &id, &first);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_propose_ownership_transfer(&f.sender, &id, &second)))
        }
        Branch::AcceptNotTarget => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            let target = soroban_sdk::Address::generate(&f.env);
            let stranger = Address::generate(&f.env);
            f.client
                .mock_all_auths()
                .propose_ownership_transfer(&f.sender, &id, &target);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_ownership_transfer(&stranger, &id)))
        }
        Branch::OwnershipProposalExpired => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            let target = soroban_sdk::Address::generate(&f.env);
            f.client
                .mock_all_auths()
                .propose_ownership_transfer(&f.sender, &id, &target);
            f.advance_time(OWNERSHIP_PROPOSAL_TTL_SECONDS);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_ownership_transfer(&target, &id)))
        }
        Branch::NoPendingOwnership => {
            let f = Fixture::setup_quiet();
            let target = soroban_sdk::Address::generate(&f.env);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_ownership_transfer(&target, &999)))
        }
        Branch::CancelProposalNotProposer => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
            let target = soroban_sdk::Address::generate(&f.env);
            f.client
                .mock_all_auths()
                .propose_ownership_transfer(&f.sender, &id, &target);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_ownership_transfer(&f.recipient, &id)))
        }
        // --------------------------------------------- rate renegotiation
        Branch::RateProposeNotAuthorized => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            let stranger = Address::generate(&f.env);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_propose_rate_change(
                    &stranger,
                    &id,
                    &(DEPOSIT / (10 * DAY) as i128)
                )))
        }
        Branch::RateProposalAmountNonPositive => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_propose_rate_change(&f.sender, &id, &0)))
        }
        Branch::RateProposalWindowElapsed => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, 0, DAY, false);
            // The window closed while the stream stayed Active (nothing was
            // withdrawn), so there is no remaining window to re-rate.
            f.advance_time(2 * DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_propose_rate_change(&f.sender, &id, &1)))
        }
        Branch::RateProposalPending => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            let rate = (DEPOSIT / (10 * DAY) as i128) + 1;
            f.client
                .mock_all_auths()
                .propose_rate_change(&f.sender, &id, &rate);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_propose_rate_change(&f.recipient, &id, &rate)))
        }
        Branch::RateAcceptNotTarget => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            let stranger = Address::generate(&f.env);
            f.client
                .mock_all_auths()
                .propose_rate_change(&f.sender, &id, &1);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_rate_change(&stranger, &id)))
        }
        Branch::RateAcceptStaleParties => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.client
                .mock_all_auths()
                .propose_rate_change(&f.sender, &id, &1);
            // The accepting recipient hands their role over before accepting:
            // the offer was negotiated with them, not with their successor.
            let heir = soroban_sdk::Address::generate(&f.env);
            f.client
                .mock_all_auths()
                .propose_ownership_transfer(&f.recipient, &id, &heir);
            f.client
                .mock_all_auths()
                .accept_ownership_transfer(&heir, &id);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_rate_change(&f.recipient, &id)))
        }
        Branch::RateProposalExpired => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.client
                .mock_all_auths()
                .propose_rate_change(&f.sender, &id, &1);
            f.advance_time(RATE_PROPOSAL_TTL_SECONDS);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_rate_change(&f.recipient, &id)))
        }
        Branch::NoPendingRateChange => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_rate_change(&f.recipient, &id)))
        }
        Branch::RateCancelNotProposer => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);
            f.client
                .mock_all_auths()
                .propose_rate_change(&f.sender, &id, &1);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_cancel_rate_change(&f.recipient, &id)))
        }
        Branch::RateReserveOverflow => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            // The proposal itself only stores a rate; the overflow shows when
            // acceptance prices it over the remaining window.
            f.client
                .mock_all_auths()
                .propose_rate_change(&f.sender, &id, &i128::MAX);
            f.advance_time(2 * DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_rate_change(&f.recipient, &id)))
        }
        Branch::RateSegmentLimitReached => {
            let f = Fixture::setup_quiet();
            let id = f.create_stream(DEPOSIT, 0, 10 * DAY, false);
            // One accepted change adds one window; the cap refuses the next.
            fill_rate_segments(&f, id, MAX_RATE_SEGMENTS - 1);
            f.advance_time(1);
            f.client
                .mock_all_auths()
                .propose_rate_change(&f.sender, &id, &RATE_PER_SECOND);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_rate_change(&f.recipient, &id)))
        }
        Branch::RatePolicyBelowFloor => {
            let f = Fixture::setup_quiet();
            set_rate_policy(&f, 1_000, 0);
            let id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);
            f.client
                .mock_all_auths()
                .propose_rate_change(&f.sender, &id, &5);
            f.advance_time(2 * DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_rate_change(&f.recipient, &id)))
        }
        Branch::RatePolicyAboveCeiling => {
            let f = Fixture::setup_quiet();
            set_rate_policy(&f, 0, 10);
            // Deposited below the ceiling (its derived rate is 0 tokens/s), so
            // the stream exists and the ceiling is what the *proposal* breaks.
            let id = f.create_stream(100, DAY, 10 * DAY, false);
            f.client
                .mock_all_auths()
                .propose_rate_change(&f.sender, &id, &20);
            f.advance_time(2 * DAY);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_rate_change(&f.recipient, &id)))
        }
        Branch::RateTopUpTransferFailed => {
            let f = RefusingFixture::setup_quiet();
            let id = f.create(DEPOSIT, 0, 10 * DAY);
            f.client
                .mock_all_auths()
                .propose_rate_change(&f.sender, &id, &(RATE_PER_SECOND * 2));
            f.advance_time(DAY);
            f.refuse(false, true); // the asset stops accepting the shortfall pull
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_rate_change(&f.recipient, &id)))
        }
        Branch::RateRefundFailed => {
            let f = RefusingFixture::setup_quiet();
            let id = f.create(DEPOSIT, 0, 10 * DAY);
            f.client
                .mock_all_auths()
                .propose_rate_change(&f.sender, &id, &1);
            f.advance_time(DAY);
            f.refuse(true, false); // the asset stops paying out the freed escrow
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_accept_rate_change(&f.recipient, &id)))
        }
        // Invariant-protected: a stored stream always satisfies
        // `0 <= withdrawn <= streamed <= deposit <= i128::MAX`, so these
        // checked subtractions/addition can never cross an i128 boundary —
        // not even for a corrupt entry, because `streamed - withdrawn` is
        // bounded below by `-i128::MAX`.
        Branch::AvailableBalanceOverflow
        | Branch::CancelSplitOverflow
        | Branch::PayoutOverflow
        | Branch::RateSegmentSumOverflow
        | Branch::RateHeadroomUnderflow => None,

        // ------------------------------------------------------- governance
        Branch::GovernanceNotInitialized => {
            let f = Fixture::setup_quiet();
            let stranger = Address::generate(&f.env);
            Some(rejected!(f.client.mock_all_auths().try_governance_propose(
                &stranger,
                &crate::GovernanceAction::SetFeeBps(100)
            )))
        }
        Branch::GovernanceAlreadyInitialized => {
            let g = Governed::new();
            let mut set = soroban_sdk::Vec::new(&g.f.env);
            set.push_back(g.a.clone());
            set.push_back(g.b.clone());
            Some(rejected!(g
                .f
                .client
                .mock_all_auths()
                .try_governance_bootstrap(
                    &g.f.governor,
                    &set,
                    &crate::DEFAULT_VETO_WINDOW_SECONDS
                )))
        }
        Branch::NotGovernanceSigner => {
            let g = Governed::new();
            let stranger = Address::generate(&g.f.env);
            Some(rejected!(g
                .f
                .client
                .mock_all_auths()
                .try_governance_propose(
                    &stranger,
                    &crate::GovernanceAction::SetFeeBps(100)
                )))
        }
        Branch::GovernanceDuplicateSigner => {
            let f = Fixture::setup_quiet();
            let a = Address::generate(&f.env);
            let mut set = soroban_sdk::Vec::new(&f.env);
            set.push_back(a.clone());
            set.push_back(a.clone());
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_governance_bootstrap(
                    &f.governor,
                    &set,
                    &crate::DEFAULT_VETO_WINDOW_SECONDS,
                )))
        }
        Branch::GovernanceSignerSetEmpty => {
            let f = Fixture::setup_quiet();
            let set = soroban_sdk::Vec::new(&f.env);
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_governance_bootstrap(
                    &f.governor,
                    &set,
                    &crate::DEFAULT_VETO_WINDOW_SECONDS,
                )))
        }
        Branch::GovernanceTooManySigners => {
            let f = Fixture::setup_quiet();
            let mut set = soroban_sdk::Vec::new(&f.env);
            for _ in 0..crate::MAX_SIGNERS + 1 {
                set.push_back(Address::generate(&f.env));
            }
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_governance_bootstrap(
                    &f.governor,
                    &set,
                    &crate::DEFAULT_VETO_WINDOW_SECONDS,
                )))
        }
        Branch::GovernanceSignersNotDistinct => {
            let f = Fixture::setup_quiet();
            let mut set = soroban_sdk::Vec::new(&f.env);
            set.push_back(Address::generate(&f.env));
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_governance_bootstrap(
                    &f.governor,
                    &set,
                    &crate::DEFAULT_VETO_WINDOW_SECONDS,
                )))
        }
        Branch::GovernanceProposalNotFound => {
            let g = Governed::new();
            let id = g.propose_fee(&g.a, 100);
            assert_eq!(id, 1);
            Some(rejected!(g
                .f
                .client
                .mock_all_auths()
                .try_governance_sign(&g.b, &(id + 999))))
        }
        Branch::GovernanceVetoWindowOpen => {
            let g = Governed::new();
            let id = g.propose_fee(&g.a, 100);
            g.f.client.mock_all_auths().governance_sign(&g.a, &id);
            g.f.client.mock_all_auths().governance_sign(&g.b, &id);
            Some(rejected!(g
                .f
                .client
                .mock_all_auths()
                .try_governance_execute(&Address::generate(&g.f.env), &id)))
        }
        Branch::GovernanceVetoWindowClosed => {
            let g = Governed::new();
            let id = g.propose_fee(&g.a, 100);
            g.mature();
            Some(rejected!(g
                .f
                .client
                .mock_all_auths()
                .try_governance_veto(&g.b, &id)))
        }
        Branch::GovernanceVetoWindowTooShort => {
            let f = Fixture::setup_quiet();
            let mut set = soroban_sdk::Vec::new(&f.env);
            set.push_back(Address::generate(&f.env));
            set.push_back(Address::generate(&f.env));
            Some(rejected!(f
                .client
                .mock_all_auths()
                .try_governance_bootstrap(
                    &f.governor,
                    &set,
                    &(crate::MIN_VETO_WINDOW_SECONDS - 1),
                )))
        }
        Branch::GovernanceAlreadyVetoed => {
            let g = Governed::new();
            let id = g.propose_fee(&g.a, 100);
            g.f.client.mock_all_auths().governance_veto(&g.b, &id);
            Some(rejected!(g
                .f
                .client
                .mock_all_auths()
                .try_governance_execute(&Address::generate(&g.f.env), &id)))
        }
        Branch::GovernanceAlreadyExecuted => {
            let g = Governed::new();
            let id = g.propose_fee(&g.a, 100);
            g.f.client.mock_all_auths().governance_sign(&g.a, &id);
            g.f.client.mock_all_auths().governance_sign(&g.b, &id);
            g.mature();
            let executor = Address::generate(&g.f.env);
            g.f.client
                .mock_all_auths()
                .governance_execute(&executor, &id);
            Some(rejected!(g
                .f
                .client
                .mock_all_auths()
                .try_governance_execute(&executor, &id)))
        }
        Branch::GovernanceDuplicateSignature => {
            let g = Governed::new();
            let id = g.propose_fee(&g.a, 100);
            g.f.client.mock_all_auths().governance_sign(&g.a, &id);
            Some(rejected!(g
                .f
                .client
                .mock_all_auths()
                .try_governance_sign(&g.a, &id)))
        }
        Branch::GovernanceSignaturesInsufficient => {
            let g = Governed::new();
            let id = g.propose_fee(&g.a, 100);
            g.f.client.mock_all_auths().governance_sign(&g.a, &id);
            g.mature();
            Some(rejected!(g
                .f
                .client
                .mock_all_auths()
                .try_governance_execute(&Address::generate(&g.f.env), &id)))
        }
        Branch::GovernanceTimelockRequired => {
            let g = Governed::new();
            Some(rejected!(g
                .f
                .client
                .mock_all_auths()
                .try_set_fee_bps(&g.f.governor, &100)))
        }
    }
}

/// The matrix: every reachable branch fires its declared code, and every
/// defensive branch is never reached.
#[test]
fn error_surface_matrix_proves_every_branch_is_reachable() {
    for &branch in Branch::ALL.iter() {
        trace::clear();
        let got = probe(branch);
        let hits = trace::drain();

        match branch.reachability() {
            Reachability::Reachable => {
                let error = got.unwrap_or_else(|| {
                    panic!("branch {branch:?} produced no rejection but is marked Reachable")
                });
                assert_eq!(
                    error,
                    branch.error(),
                    "branch {branch:?} returned the wrong code"
                );
                assert!(
                    hits.contains(&branch),
                    "branch {branch:?} was classified reachable but never fired (trace: {hits:?})"
                );
            }
            Reachability::Defensive => {
                assert!(
                    got.is_none() && hits.is_empty(),
                    "defensive branch {branch:?} unexpectedly fired"
                );
            }
        }
    }
}

/// No error code is dead: every variant is either produced by a reachable
/// branch or explicitly retired. A new, uncovered code fails this test.
#[test]
fn every_error_code_is_produced_or_retired() {
    for &code in StreamError::ALL.iter() {
        let produced = Branch::ALL
            .iter()
            .any(|b| b.error() == code && b.reachability() == Reachability::Reachable);
        let retired = RETIRED_CODES.contains(&code);
        assert!(
            produced || retired,
            "dead error code {code:?} (#{}): no reachable branch produces it and it is not retired",
            code.code()
        );
        assert!(
            !(produced && retired),
            "code {code:?} is both reachable and retired — remove it from RETIRED_CODES"
        );
    }
}

/// Retired codes must not be produced by any branch (otherwise they are not
/// retired).
#[test]
fn retired_codes_are_not_produced() {
    for &code in RETIRED_CODES.iter() {
        assert!(
            !Branch::ALL.iter().any(|b| b.error() == code),
            "retired code {code:?} is still produced by a branch"
        );
    }
}

/// Every branch is unique in the registry.
#[test]
fn branch_registry_has_no_duplicates() {
    for (i, &a) in Branch::ALL.iter().enumerate() {
        for &b in &Branch::ALL[i + 1..] {
            assert_ne!(a, b, "branch {a:?} appears more than once in Branch::ALL");
        }
    }
}

/// The defensive set is exactly the invariant-protected guards; every other
/// branch is probed by the matrix.
#[test]
fn defensive_branches_are_exactly_documented() {
    let defensive: Vec<Branch> = Branch::ALL
        .iter()
        .copied()
        .filter(|b| b.reachability() == Reachability::Defensive)
        .collect();
    assert_eq!(
        defensive,
        std::vec![
            Branch::AvailableBalanceOverflow,
            Branch::CancelSplitOverflow,
            Branch::PayoutOverflow,
            Branch::RateSegmentSumOverflow,
            Branch::RateHeadroomUnderflow,
        ],
        "the defensive set changed; update the matrix test and docs/ERROR_SURFACE.md"
    );
}

/// Compile-time guard: adding a [`StreamError`] variant breaks this exhaustive
/// match, forcing the author to acknowledge it. It also checks every listed
/// variant really is in [`StreamError::ALL`].
#[test]
fn stream_error_variant_list_is_exhaustive() {
    fn listed(e: StreamError) -> bool {
        match e {
            StreamError::StreamNotFound
            | StreamError::NotStreamSender
            | StreamError::NotStreamRecipient
            | StreamError::StreamNotCancellable
            | StreamError::StreamNotActive
            | StreamError::StartTimeInPast
            | StreamError::InvalidTimeRange
            | StreamError::DurationTooLong
            | StreamError::ZeroAmount
            | StreamError::AmountExceedsAvailable
            | StreamError::MathOverflow
            | StreamError::NotAuthorized
            | StreamError::NothingToWithdraw
            | StreamError::MetadataTagTooLong
            | StreamError::MetadataLimitReached => StreamError::ALL.contains(&e),
            StreamError::FeeRateTooHigh
            | StreamError::NotGovernor
            | StreamError::NoPendingGovernor
            | StreamError::InsufficientTreasuryBalance
            | StreamError::DisputeActive
            | StreamError::DisputeNotFound
            | StreamError::DisputeNotExpired
            | StreamError::SponsorNotFound
            | StreamError::SponsorInactive
            | StreamError::BeneficiaryNotEnrolled
            | StreamError::ClaimExpired
            | StreamError::ClaimNonceReplay
            | StreamError::SponsorBudgetExceeded
            | StreamError::BeneficiaryBudgetExceeded
            | StreamError::IntentNotFound
            | StreamError::IntentNotPending
            | StreamError::IntentNotYetExecutable
            | StreamError::IntentExpired
            | StreamError::IntentNotCancellable
            | StreamError::InvalidScheduleParameters
            | StreamError::IntentParamsMismatch
            | StreamError::IntentNotExpired
            | StreamError::DepositTransferFailed
            | StreamError::TopUpTransferFailed
            | StreamError::RecipientPayoutFailed
            | StreamError::SenderRefundFailed
            | StreamError::TreasuryPayoutFailed
            | StreamError::PolicyAssetNotAllowed
            | StreamError::PolicyTimelockNotElapsed
            | StreamError::PolicyNoQueuedChange
            | StreamError::PolicyNotInitialized
            | StreamError::PolicyNoPendingHandoff
            | StreamError::BatchEmpty
            | StreamError::BatchTooLarge => StreamError::ALL.contains(&e),
            StreamError::ContractFrozen
            | StreamError::ContractNotFrozen
            | StreamError::NoPendingUpgrade
            | StreamError::TimelockNotExpired
            | StreamError::UpgradeDelayTooShort
            | StreamError::AlreadyMigrated
            | StreamError::PolicyRateBelowFloor
            | StreamError::PolicyRateAboveCeiling
            | StreamError::PolicyDurationBelowFloor
            | StreamError::PolicyDurationAboveCeiling
            | StreamError::PolicyDepositBelowFloor
            | StreamError::InvalidOracleThreshold
            | StreamError::OraclePublishersNotConfigured
            | StreamError::OracleReportTooOld
            | StreamError::NotOraclePublisher
            | StreamError::NoPendingOwnership
            | StreamError::OwnershipProposalExpired
            | StreamError::InvalidTransferTarget
            | StreamError::OwnershipProposalPending
            | StreamError::NoPendingRateChange
            | StreamError::RateProposalExpired
            | StreamError::RateProposalPending
            | StreamError::TooManyRateSegments
            | StreamError::GovernanceNotInitialized
            | StreamError::GovernanceAlreadyInitialized
            | StreamError::NotGovernanceSigner
            | StreamError::GovernanceDuplicateSigner
            | StreamError::GovernanceSignerSetEmpty
            | StreamError::GovernanceTooManySigners
            | StreamError::GovernanceSignersNotDistinct
            | StreamError::GovernanceProposalNotFound
            | StreamError::GovernanceVetoWindowOpen
            | StreamError::GovernanceVetoWindowClosed
            | StreamError::GovernanceVetoWindowTooShort
            | StreamError::GovernanceAlreadyVetoed
            | StreamError::GovernanceAlreadyExecuted
            | StreamError::GovernanceDuplicateSignature
            | StreamError::GovernanceSignaturesInsufficient
            | StreamError::GovernanceTimelockRequired => StreamError::ALL.contains(&e),
        }
    }

    for &e in StreamError::ALL.iter() {
        assert!(listed(e), "variant {e:?} missing from StreamError::ALL");
    }
}
