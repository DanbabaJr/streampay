//! Property suite: allowance conservation under random sponsored-claim
//! sequences.
//!
//! One sponsor serves several recipients, each with their own enrolled ed25519
//! consent key and their own accrued stream. A seeded proptest sequence mixes
//! partial claims, full-cap claims, over-cap claims, allowance top-ups,
//! pause/resume and nonce replays. After *every* action the contract is re-read
//! and reconciled with an independent model of the allowance ledger:
//!
//! * `sponsor_period_spend.spend` equals the sum of the verified `SponsorClaim`
//!   events for the current registration window;
//! * `claimed + (per_period_limit - spend) == per_period_limit`, and the same
//!   conservation identity holds for each beneficiary's cap;
//! * no claim can push either counter past its cap, and a rejected claim moves
//!   nothing;
//! * each recipient's token balance equals the claims booked for it, and the
//!   contract still holds `deposits - all-time claims`.
//!
//! `register_sponsor` deliberately resets the *sponsor* window counter but not
//! the per-beneficiary counters, so the model tracks both per-epoch and
//! cumulative beneficiary spend. The window is longer than the run so the
//! period never rolls over here; rollover is covered deterministically by
//! `budget_exhaustion_mid_relay_rejects_the_second_claim_until_window_rolls`.
//!
//! Test-only: no deployed-Wasm behavior is touched.
#![cfg(test)]

extern crate std;

use std::format;
use std::vec::Vec;

use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseError, TestRunner};
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::{token::Client as TokenClient, Address, Event as _};

use crate::sponsor_test::{register_op, relay_claim_for, test_signer, RelayResult, TestSigner};
use crate::test::Fixture;
use crate::{SponsorClaim, StreamError};

const DAY: u64 = 24 * 60 * 60;
/// Per-recipient stream deposit; small enough that several fit the fixture's
/// pre-minted sender balance.
const STREAM_DEPOSIT: i128 = 1_000_000_000;
/// Longer than any ledger timestamp the suite reaches: the budget window never
/// rolls over, so "registered allowance" stays a single checkable number.
const PROP_WINDOW: u64 = 10_000_000;
/// A deadline that no step can cross.
const DEADLINE_HORIZON: u64 = 1_000_000_000;
const RECIPIENTS: usize = 3;

/// Independent model of one sponsor's allowance ledger.
struct AllowanceModel {
    per_period_limit: i128,
    per_beneficiary_limit: i128,
    active: bool,
    /// Successful claims since the most recent (re)registration.
    sponsor_spend_epoch: i128,
    /// Per-recipient successful claims since the most recent registration.
    ben_spend_epoch: [i128; RECIPIENTS],
    /// Per-recipient successful claims over the whole run. Unlike the sponsor
    /// counter, `register_sponsor` does not reset these.
    ben_spend_total: [i128; RECIPIENTS],
    /// Mirrors `sponsor_spend_epoch`, advanced only from verified events.
    claimed_events_epoch: i128,
    claimed_events_total: i128,
    next_nonce: u64,
    last_success: Option<(usize, i128, u64)>,
}

/// One sponsor, several recipients, each with a distinct consent key and a
/// fully accrued stream.
struct AllowanceHarness {
    f: Fixture,
    sponsor: Address,
    op: TestSigner,
    /// `(recipient, consent signer, stream id)` per recipient.
    parties: Vec<(Address, TestSigner, u64)>,
    model: AllowanceModel,
}

impl AllowanceHarness {
    fn new() -> Self {
        let f = Fixture::setup_quiet();
        let sponsor = Address::generate(&f.env);
        let op = test_signer(&f.env, 11);
        let per_period = 1_500_000_000i128;
        let per_beneficiary = 600_000_000i128;
        register_op(&f, &sponsor, &op, per_period, per_beneficiary, PROP_WINDOW);

        let mut parties = Vec::new();
        for i in 0..RECIPIENTS {
            let recipient = if i == 0 {
                f.recipient.clone()
            } else {
                Address::generate(&f.env)
            };
            let ben = test_signer(&f.env, 40 + i as u8);
            f.client
                .mock_all_auths()
                .enroll_beneficiary(&recipient, &ben.public_key);
            let id = create_stream_for(&f, &recipient);
            parties.push((recipient, ben, id));
        }
        // Fully accrue every stream, so its whole deposit is available.
        f.advance_time(DAY);

        AllowanceHarness {
            f,
            sponsor,
            op,
            parties,
            model: AllowanceModel {
                per_period_limit: per_period,
                per_beneficiary_limit: per_beneficiary,
                active: true,
                sponsor_spend_epoch: 0,
                ben_spend_epoch: [0; RECIPIENTS],
                ben_spend_total: [0; RECIPIENTS],
                claimed_events_epoch: 0,
                claimed_events_total: 0,
                next_nonce: 1,
                last_success: None,
            },
        }
    }

    fn remaining_sponsor(&self) -> i128 {
        self.model.per_period_limit - self.model.sponsor_spend_epoch
    }

    fn remaining_beneficiary(&self, index: usize) -> i128 {
        self.model.per_beneficiary_limit - self.model.ben_spend_total[index]
    }

    fn available(&self, index: usize) -> i128 {
        STREAM_DEPOSIT - self.model.ben_spend_total[index]
    }

    /// The rejection the contract must return for a claim, in the contract's
    /// own check order; `None` means the claim must succeed.
    fn expected(&self, index: usize, amount: i128, nonce_used: bool) -> Option<StreamError> {
        let m = &self.model;
        if !m.active {
            return Some(StreamError::SponsorInactive);
        }
        if m.ben_spend_total[index] >= STREAM_DEPOSIT {
            return Some(StreamError::StreamNotActive);
        }
        if amount <= 0 {
            return Some(StreamError::ZeroAmount);
        }
        if amount > self.available(index) {
            return Some(StreamError::AmountExceedsAvailable);
        }
        if nonce_used {
            return Some(StreamError::ClaimNonceReplay);
        }
        if m.sponsor_spend_epoch + amount > m.per_period_limit {
            return Some(StreamError::SponsorBudgetExceeded);
        }
        if m.ben_spend_total[index] + amount > m.per_beneficiary_limit {
            return Some(StreamError::BeneficiaryBudgetExceeded);
        }
        None
    }

    /// Relays a claim, asserts the coded outcome, and books a success in the
    /// model from the emitted `SponsorClaim` event rather than the relay result.
    fn relay(
        &mut self,
        index: usize,
        amount: i128,
        nonce: u64,
        nonce_used: bool,
        context: &str,
    ) -> Result<(), TestCaseError> {
        let expected = self.expected(index, amount, nonce_used);
        let deadline = self.f.ledger_time() + DEADLINE_HORIZON;
        let (recipient, id) = {
            let (recipient, _, id) = &self.parties[index];
            (recipient.clone(), *id)
        };

        // `events().all()` reports the last invocation's events; drain first so
        // the claim under test is the only thing it can return.
        let _ = self.f.env.events().all();
        let res = {
            let (_, ben, _) = &self.parties[index];
            relay_claim_for(
                &self.f,
                &self.sponsor,
                &recipient,
                &self.op,
                ben,
                id,
                amount,
                nonce,
                deadline,
            )
        };

        match expected {
            Some(error) => {
                let actual = match res {
                    Err(Ok(code)) => code,
                    other => {
                        return Err(TestCaseError::fail(format!(
                            "{context}: expected {error:?}, got {other:?}"
                        )))
                    }
                };
                prop_assert_eq!(actual, error, "{}", context);
            }
            None => {
                prop_assert!(
                    matches!(res, Ok(Ok(()))),
                    "{}: claim {} of {} for recipient {} must succeed, got {:?}",
                    context,
                    nonce,
                    amount,
                    index,
                    res
                );

                // The ledger's own record of the claim: exactly one event,
                // carrying the amount that was booked.
                let claim = SponsorClaim {
                    sponsor: self.sponsor.clone(),
                    kind: soroban_sdk::Symbol::new(&self.f.env, "claim"),
                    stream_id: id,
                    beneficiary: recipient,
                    amount,
                    nonce,
                };
                let events = self
                    .f
                    .env
                    .events()
                    .all()
                    .filter_by_contract(&self.f.client.address);
                prop_assert_eq!(
                    events,
                    [claim.to_xdr(&self.f.env, &self.f.client.address)],
                    "{}",
                    context
                );

                let m = &mut self.model;
                m.sponsor_spend_epoch += amount;
                m.ben_spend_epoch[index] += amount;
                m.ben_spend_total[index] += amount;
                m.claimed_events_epoch += amount;
                m.claimed_events_total += amount;
                m.last_success = Some((index, amount, nonce));
            }
        }
        Ok(())
    }

    /// Re-reads the contract and reconciles it with the model. Run after every
    /// action, so a rejected claim can never move the ledger either.
    fn assert_conserved(&self, context: &str) -> Result<(), TestCaseError> {
        let m = &self.model;
        let cfg = self
            .f
            .client
            .get_sponsor(&self.sponsor)
            .expect("sponsor config must exist");
        prop_assert_eq!(cfg.per_period_limit, m.per_period_limit, "{}", context);
        prop_assert_eq!(
            cfg.per_beneficiary_limit,
            m.per_beneficiary_limit,
            "{}",
            context
        );
        prop_assert_eq!(cfg.active, m.active, "{}", context);

        // Sponsor ledger: what the contract booked is exactly what the verified
        // claim events recorded, and it sits inside the registered allowance.
        let spend = self.f.client.sponsor_period_spend(&self.sponsor);
        prop_assert_eq!(spend.spend, m.sponsor_spend_epoch, "{}", context);
        prop_assert_eq!(m.claimed_events_epoch, spend.spend, "{}", context);
        prop_assert!(spend.spend >= 0, "{}: negative sponsor spend", context);
        prop_assert!(
            spend.spend <= m.per_period_limit,
            "{}: sponsor spend {} exceeds registered allowance {}",
            context,
            spend.spend,
            m.per_period_limit
        );
        // claimed + remaining == registered
        prop_assert_eq!(
            m.claimed_events_epoch + (m.per_period_limit - spend.spend),
            m.per_period_limit,
            "{}",
            context
        );

        // Beneficiary ledgers, their caps, and the payouts they booked.
        let mut epoch_total = 0i128;
        for (index, (recipient, _, _)) in self.parties.iter().enumerate() {
            let bspend = self.f.client.beneficiary_spend(&self.sponsor, recipient);
            prop_assert_eq!(bspend.spend, m.ben_spend_total[index], "{}", context);
            prop_assert!(bspend.spend >= 0, "{}: negative beneficiary spend", context);
            prop_assert!(
                bspend.spend <= m.per_beneficiary_limit,
                "{}: beneficiary {} spend {} exceeds its cap {}",
                context,
                index,
                bspend.spend,
                m.per_beneficiary_limit
            );
            prop_assert_eq!(
                m.ben_spend_total[index] + (m.per_beneficiary_limit - bspend.spend),
                m.per_beneficiary_limit,
                "{}",
                context
            );
            prop_assert_eq!(
                TokenClient::new(&self.f.env, &self.f.token).balance(recipient),
                m.ben_spend_total[index],
                "{}: recipient {} was paid something other than its booked claims",
                context,
                index
            );
            epoch_total += m.ben_spend_epoch[index];
        }
        prop_assert_eq!(epoch_total, spend.spend, "{}", context);

        // The contract still holds every deposit that has not been claimed.
        let deposits = STREAM_DEPOSIT * RECIPIENTS as i128;
        prop_assert_eq!(
            TokenClient::new(&self.f.env, &self.f.token).balance(&self.f.client.address),
            deposits - m.claimed_events_total,
            "{}",
            context
        );
        Ok(())
    }
}

/// A stream paying `recipient` that accrues linearly over one day.
fn create_stream_for(f: &Fixture, recipient: &Address) -> u64 {
    let now = f.env.ledger().timestamp();
    f.client.mock_all_auths().create_stream(
        &f.sender,
        recipient,
        &f.token,
        &STREAM_DEPOSIT,
        &now,
        &(now + DAY),
        &false,
    )
}

/// Draws a claim amount aimed at the edges of the allowance: the remaining
/// budget, one over it, a partial claim, and the stream's balance.
fn draw_claim_amount(h: &AllowanceHarness, index: usize, selector: u16) -> i128 {
    let sponsor_room = h.remaining_sponsor().min(h.available(index)).max(1);
    let beneficiary_room = h
        .remaining_beneficiary(index)
        .min(h.available(index))
        .max(1);
    let avail = h.available(index);
    let amount = match selector % 9 {
        0 => 1,
        1 => sponsor_room / 2,
        2 => sponsor_room,         // exactly what is left
        3 => sponsor_room + 1,     // one over the sponsor's remaining allowance
        4 => beneficiary_room,     // exactly the beneficiary's remaining allowance
        5 => avail + 1,            // one over the stream's available balance
        6 => avail.max(1),         // drains the stream
        7 => sponsor_room / 3 + 1, // a partial claim
        _ => STREAM_DEPOSIT,
    };
    amount.max(1)
}

/// Unwraps the contract-level rejection from a relay, failing loudly on a
/// signature trap (unreachable for the well-formed claims here).
fn coded_rejection(res: RelayResult) -> StreamError {
    match res {
        Err(Ok(error)) => error,
        other => panic!("expected a coded rejection, got {other:?}"),
    }
}

fn run_allowance_sequence(seed: u64, steps: &[(u8, u16, u16)]) -> Result<(), TestCaseError> {
    let mut h = AllowanceHarness::new();
    h.assert_conserved(&format!("seed {seed:#x}, initial state"))?;

    for (step_index, &(op, selector, selector2)) in steps.iter().enumerate() {
        let index = selector as usize % RECIPIENTS;
        let context = format!("seed {seed:#x}, step {step_index}, op {op}/{selector}/{selector2}");
        match op % 5 {
            // Partial / exact-cap / over-cap claim by one of the recipients.
            0 | 1 => {
                let amount = draw_claim_amount(&h, index, selector2);
                let nonce = h.model.next_nonce;
                h.model.next_nonce += 1;
                h.relay(index, amount, nonce, false, &context)?;
            }
            // Allowance top-up: re-register with larger caps. This resets the
            // sponsor's window counter and re-activates the budget; the
            // per-beneficiary counters deliberately survive.
            2 => {
                let delta = (1 + selector2 as i128) * 10_000_000;
                let per_period = h.model.per_period_limit + delta;
                let per_beneficiary = h.model.per_beneficiary_limit + delta;
                register_op(
                    &h.f,
                    &h.sponsor,
                    &h.op,
                    per_period,
                    per_beneficiary,
                    PROP_WINDOW,
                );
                let m = &mut h.model;
                m.per_period_limit = per_period;
                m.per_beneficiary_limit = per_beneficiary;
                m.sponsor_spend_epoch = 0;
                m.ben_spend_epoch = [0; RECIPIENTS];
                m.claimed_events_epoch = 0;
                m.active = true;
            }
            // Pause or resume the budget mid-sequence.
            3 => {
                let active = selector2 % 2 == 0;
                h.f.client
                    .mock_all_auths()
                    .set_sponsor_active(&h.sponsor, &active);
                h.model.active = active;
            }
            // Replay an already-consumed nonce: it must never double-spend.
            _ => {
                if let Some((last_index, amount, nonce)) = h.model.last_success {
                    h.relay(last_index, amount, nonce, true, &context)?;
                }
            }
        }

        h.assert_conserved(&context).map_err(|e| {
            TestCaseError::fail(format!("{context}: allowance ledger not conserved: {e:?}"))
        })?;
    }
    Ok(())
}

/// Fixed-seed random sequences: every action's booked accounting must match the
/// model, and the allowance must conserve value after each one.
#[test]
fn property_sponsor_allowance_is_conserved_under_random_claim_sequences() {
    const SEEDS: [u64; 3] = [0x5A0B_5001, 0x5A0B_5002, 0x5A0B_5003];
    const CASES_PER_SEED: u32 = 24;

    let sequence = proptest::collection::vec(any::<(u8, u16, u16)>(), 1..33);
    for seed in SEEDS {
        let mut runner = TestRunner::new(ProptestConfig {
            cases: CASES_PER_SEED,
            rng_seed: RngSeed::Fixed(seed),
            ..ProptestConfig::default()
        });
        if let Err(error) = runner.run(&sequence, |steps| run_allowance_sequence(seed, &steps)) {
            panic!("sponsor-allowance property failed with seed {seed:#x}: {error}");
        }
    }
}

// ------------------------------------------------- race-shaped negatives ----

/// Two claims relayed in the same ledger that together exceed the cap: the
/// second is rejected and only the first is booked. Both the sponsor-wide cap
/// and the per-beneficiary cap are exercised, since the contract checks the
/// period cap first.
#[test]
fn two_same_ledger_claims_together_exceeding_the_cap_reject_the_second() {
    let f = Fixture::setup_quiet();
    let sponsor = Address::generate(&f.env);
    let op = test_signer(&f.env, 11);
    let cap = 1_000_000_000i128;

    // --- sponsor-wide cap: two recipients, same ledger -------------------
    register_op(&f, &sponsor, &op, cap, cap, PROP_WINDOW);
    let mut parties = Vec::new();
    for i in 0..2u8 {
        let recipient = Address::generate(&f.env);
        let ben = test_signer(&f.env, 50 + i);
        f.client
            .mock_all_auths()
            .enroll_beneficiary(&recipient, &ben.public_key);
        let id = create_stream_for(&f, &recipient);
        parties.push((recipient, ben, id));
    }
    f.advance_time(DAY);
    let deadline = f.env.ledger().timestamp() + DAY;

    let (r0, b0, id0) = &parties[0];
    assert!(matches!(
        relay_claim_for(&f, &sponsor, r0, &op, b0, *id0, 600_000_000, 1, deadline),
        Ok(Ok(()))
    ));

    let (r1, b1, id1) = &parties[1];
    let second = relay_claim_for(&f, &sponsor, r1, &op, b1, *id1, 600_000_000, 2, deadline);
    assert_eq!(coded_rejection(second), StreamError::SponsorBudgetExceeded);

    assert_eq!(f.client.sponsor_period_spend(&sponsor).spend, 600_000_000);
    assert_eq!(f.client.beneficiary_spend(&sponsor, r1).spend, 0);
    assert_eq!(f.client.get_stream(id1).withdrawn, 0);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(r1),
        0,
        "the rejected claim must not pay out"
    );
    // claimed + remaining == registered
    assert_eq!(
        f.client.sponsor_period_spend(&sponsor).spend + (cap - 600_000_000),
        cap
    );

    // --- per-beneficiary cap: ample sponsor budget, same ledger ----------
    // Fresh env, so every address and key must be built against it too.
    let f = Fixture::setup_quiet();
    let sponsor = Address::generate(&f.env);
    let op = test_signer(&f.env, 12);
    let ben_cap = 600_000_000i128;
    register_op(&f, &sponsor, &op, 10 * cap, ben_cap, PROP_WINDOW);
    let recipient = Address::generate(&f.env);
    let ben = test_signer(&f.env, 60);
    f.client
        .mock_all_auths()
        .enroll_beneficiary(&recipient, &ben.public_key);
    let id = create_stream_for(&f, &recipient);
    f.advance_time(DAY);
    let deadline = f.env.ledger().timestamp() + DAY;

    assert!(matches!(
        relay_claim_for(
            &f,
            &sponsor,
            &recipient,
            &op,
            &ben,
            id,
            400_000_000,
            1,
            deadline
        ),
        Ok(Ok(()))
    ));
    // Same ledger, same beneficiary: each claim fits the stream and the
    // beneficiary's remaining cap, but the pair crosses the cap.
    let second = relay_claim_for(
        &f,
        &sponsor,
        &recipient,
        &op,
        &ben,
        id,
        400_000_000,
        2,
        deadline,
    );
    assert_eq!(
        coded_rejection(second),
        StreamError::BeneficiaryBudgetExceeded
    );
    assert_eq!(
        f.client.beneficiary_spend(&sponsor, &recipient).spend,
        400_000_000
    );
    assert_eq!(f.client.get_stream(&id).withdrawn, 400_000_000);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&recipient),
        400_000_000
    );
}

/// A deactivated sponsor cannot be claimed against at any size, and the failed
/// attempts leave the allowance and the token balances untouched.
#[test]
fn deactivated_sponsor_cannot_be_claimed_against() {
    let f = Fixture::setup_quiet();
    let sponsor = Address::generate(&f.env);
    let op = test_signer(&f.env, 11);
    let ben = test_signer(&f.env, 22);
    let cap = 1_000_000_000i128;
    register_op(&f, &sponsor, &op, cap, cap, PROP_WINDOW);
    f.client
        .mock_all_auths()
        .enroll_beneficiary(&f.recipient, &ben.public_key);
    let id = create_stream_for(&f, &f.recipient.clone());
    f.advance_time(DAY);
    let deadline = f.env.ledger().timestamp() + DAY;

    f.client
        .mock_all_auths()
        .set_sponsor_active(&sponsor, &false);

    // Every size is refused while inactive, including one that fits the cap.
    for (nonce, amount) in [(1u64, 1i128), (2, 400_000_000), (3, cap)] {
        let res = relay_claim_for(
            &f,
            &sponsor,
            &f.recipient,
            &op,
            &ben,
            id,
            amount,
            nonce,
            deadline,
        );
        assert_eq!(coded_rejection(res), StreamError::SponsorInactive);
        assert_eq!(f.client.sponsor_period_spend(&sponsor).spend, 0);
        assert_eq!(f.client.get_stream(&id).withdrawn, 0);
        assert_eq!(TokenClient::new(&f.env, &f.token).balance(&f.recipient), 0);
    }
    // The full allowance is still available: nothing was burned by refusals.
    assert_eq!(f.client.sponsor_period_spend(&sponsor).spend + cap, cap);

    // Resuming lets the same claim through, and the ledger books it.
    f.client
        .mock_all_auths()
        .set_sponsor_active(&sponsor, &true);
    assert!(matches!(
        relay_claim_for(
            &f,
            &sponsor,
            &f.recipient,
            &op,
            &ben,
            id,
            400_000_000,
            4,
            deadline
        ),
        Ok(Ok(()))
    ));
    assert_eq!(f.client.sponsor_period_spend(&sponsor).spend, 400_000_000);
    assert_eq!(
        TokenClient::new(&f.env, &f.token).balance(&f.recipient),
        400_000_000
    );
    assert_eq!(
        f.client.sponsor_period_spend(&sponsor).spend + (cap - 400_000_000),
        cap
    );
}
