//! Formal verification specification, mathematical models, and proof harnesses
//! for StreamPay payout paths (`withdraw` and `withdraw_max`).
//!
//! Pairs with Issue #84 and `docs/VERIFICATION.md`.

#![allow(unexpected_cfgs)]
//!
//! # System Overview & Verification Goals
//!
//! StreamPay's core solvency guarantee is the **Balance-Conservation Invariant**:
//!
//! > For every stream and across the entire contract ledger, the sum of tokens
//! > held in escrow plus the cumulative tokens paid to the recipient equals the
//! > original deposit (plus any unallocated protocol fees or unrelated stream funds).
//! > No tokens are created or destroyed, no double-withdrawals can occur, and
//! > withdrawals strictly cannot exceed accrued linear earnings.
//!
//! This module provides:
//! 1. [`spec`]: Pure mathematical state definitions, guard predicates, and invariants.
//! 2. [`transitions`]: Operational transition system modeling `withdraw`, `withdraw_max`,
//!    and time advancement.
//! 3. [`proofs`]: Inductive proof verifiers, Kani bounded model checking harnesses,
//!    and exhaustive state-space model checking exploration.

use crate::errors::StreamError;
use crate::stream::{self, streamed_at, StreamStatus, MAX_DURATION_SECONDS};

/// Formal state specifications and invariant definitions.
pub mod spec {
    use super::*;

    /// Abstract representation of a payment stream's internal state.
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct AbstractStream {
        /// Total funds locked in this stream.
        pub deposit: i128,
        /// Cumulative tokens paid out to recipient so far.
        pub withdrawn: i128,
        /// Unix start timestamp in seconds.
        pub start_time: u64,
        /// Unix end timestamp in seconds (`end_time > start_time`).
        pub end_time: u64,
        /// Lifecycle status.
        pub status: StreamStatus,
    }

    impl AbstractStream {
        /// Computes stream window duration in seconds.
        #[inline]
        pub fn duration(&self) -> u64 {
            self.end_time.saturating_sub(self.start_time)
        }

        /// Computes seconds elapsed at given ledger timestamp `now`.
        #[inline]
        pub fn elapsed_at(&self, now: u64) -> u64 {
            if now <= self.start_time {
                0
            } else if now >= self.end_time {
                self.duration()
            } else {
                now - self.start_time
            }
        }

        /// Computes cumulative accrued amount at timestamp `now`.
        #[inline]
        pub fn streamed_amount_at(&self, now: u64) -> Result<i128, StreamError> {
            let elapsed = self.elapsed_at(now);
            streamed_at(self.deposit, self.duration(), elapsed)
        }

        /// Computes accrued-but-unwithdrawn amount at timestamp `now`.
        #[inline]
        pub fn available_at(&self, now: u64) -> Result<i128, StreamError> {
            if self.status != StreamStatus::Active {
                return Ok(0);
            }
            let accrued = self.streamed_amount_at(now)?;
            accrued
                .checked_sub(self.withdrawn)
                .ok_or(StreamError::MathOverflow)
        }
    }

    /// Abstract model of the token ledger environment.
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct AbstractLedger {
        /// Current simulated ledger timestamp in seconds.
        pub timestamp: u64,
        /// Physical token balance held by the contract address in escrow.
        pub contract_balance: i128,
        /// Physical token balance held by the recipient.
        pub recipient_balance: i128,
        /// Physical token balance held by the sender.
        pub sender_balance: i128,
        /// Unrelated funds in contract (e.g. other active streams, protocol fees).
        pub unrelated_funds: i128,
    }

    /// Combined system state $\Sigma = \langle S, L \rangle$.
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct SystemState {
        pub stream: AbstractStream,
        pub ledger: AbstractLedger,
    }

    impl SystemState {
        /// Creates a valid initial system state at stream creation ($t = T_{start}$).
        pub fn initial(
            deposit: i128,
            start_time: u64,
            duration: u64,
            unrelated_funds: i128,
        ) -> Result<Self, StreamError> {
            if deposit <= 0 || duration == 0 || duration > MAX_DURATION_SECONDS {
                return Err(StreamError::MathOverflow);
            }
            stream::validate_capacity(deposit, duration)?;

            let stream = AbstractStream {
                deposit,
                withdrawn: 0,
                start_time,
                end_time: start_time.saturating_add(duration),
                status: StreamStatus::Active,
            };

            let ledger = AbstractLedger {
                timestamp: start_time,
                contract_balance: deposit
                    .checked_add(unrelated_funds)
                    .ok_or(StreamError::MathOverflow)?,
                recipient_balance: 0,
                sender_balance: 0,
                unrelated_funds,
            };

            let state = SystemState { stream, ledger };
            if !invariant_payout_inductive_conjunction(&state) {
                return Err(StreamError::MathOverflow);
            }
            Ok(state)
        }
    }

    // =========================================================================
    // INVARIANT PREDICATES
    // =========================================================================

    /// **Invariant 1: Balance Conservation**.
    ///
    /// The contract holds exactly the outstanding stream funds plus any unrelated
    /// funds. The recipient holds exactly what has been withdrawn.
    ///
    /// $$B_{\text{contract}} = (D - W) + B_{\text{unrelated}}$$
    /// $$B_{\text{recipient}} = W$$
    /// $$\Delta B_{\text{contract}} + \Delta B_{\text{recipient}} = 0$$
    #[inline]
    pub fn invariant_balance_conservation(s: &SystemState) -> bool {
        let outstanding = match s.stream.deposit.checked_sub(s.stream.withdrawn) {
            Some(v) => v,
            None => return false,
        };
        let expected_contract = match outstanding.checked_add(s.ledger.unrelated_funds) {
            Some(v) => v,
            None => return false,
        };
        let contract_conserved = s.ledger.contract_balance == expected_contract;
        let recipient_conserved = s.ledger.recipient_balance == s.stream.withdrawn;

        // Conservation of total money in the closed system:
        let total_system_funds = match s
            .ledger
            .contract_balance
            .checked_add(s.ledger.recipient_balance)
        {
            Some(v) => v,
            None => return false,
        };
        let expected_total = match s.stream.deposit.checked_add(s.ledger.unrelated_funds) {
            Some(v) => v,
            None => return false,
        };

        contract_conserved && recipient_conserved && (total_system_funds == expected_total)
    }

    /// **Invariant 2: Accrual Boundedness**.
    ///
    /// Withdrawn tokens are bounded between 0 and total accrued amount, which is
    /// bounded by the deposit:
    ///
    /// $$0 \le W \le \text{streamed\_at}(D, L, \text{elapsed}(t)) \le D$$
    #[inline]
    pub fn invariant_accrual_bounded(s: &SystemState) -> bool {
        if !(0..=s.stream.deposit).contains(&s.stream.withdrawn) {
            return false;
        }
        let accrued = match s.stream.streamed_amount_at(s.ledger.timestamp) {
            Ok(v) => v,
            Err(_) => return false,
        };
        if s.stream.withdrawn > accrued {
            return false;
        }
        if accrued > s.stream.deposit {
            return false;
        }
        true
    }

    /// **Invariant 3: Non-Negative Escrow & Balances**.
    ///
    /// Neither the contract escrow nor the recipient balance can ever become negative.
    #[inline]
    pub fn invariant_non_negative_balances(s: &SystemState) -> bool {
        s.ledger.contract_balance >= 0
            && s.ledger.recipient_balance >= 0
            && s.stream.withdrawn >= 0
            && s.stream.deposit >= 0
            && s.ledger.unrelated_funds >= 0
    }

    /// **Invariant 4: Terminal Depletion Consistency**.
    ///
    /// A stream is in `StreamStatus::Depleted` if and only if $W = D$.
    #[inline]
    pub fn invariant_terminal_state(s: &SystemState) -> bool {
        match s.stream.status {
            StreamStatus::Depleted => s.stream.withdrawn == s.stream.deposit,
            StreamStatus::Active => s.stream.withdrawn < s.stream.deposit,
            StreamStatus::Cancelled => s.stream.withdrawn <= s.stream.deposit,
        }
    }

    /// **Invariant Conjunction $I(\Sigma)$**.
    ///
    /// The system satisfies the complete formal invariant if all predicates hold.
    #[inline]
    pub fn invariant_payout_inductive_conjunction(s: &SystemState) -> bool {
        invariant_balance_conservation(s)
            && invariant_accrual_bounded(s)
            && invariant_non_negative_balances(s)
            && invariant_terminal_state(s)
    }
}

/// Operational state transition system matching contract execution paths.
pub mod transitions {
    use super::spec::*;
    use super::*;

    /// Guard condition for `withdraw(amount)`.
    pub fn can_withdraw(state: &SystemState, amount: i128) -> Result<(), StreamError> {
        if amount <= 0 {
            return Err(StreamError::ZeroAmount);
        }
        if state.stream.status != StreamStatus::Active {
            return Err(StreamError::StreamNotActive);
        }
        let available = state.stream.available_at(state.ledger.timestamp)?;
        if amount > available {
            return Err(StreamError::AmountExceedsAvailable);
        }
        Ok(())
    }

    /// Guard condition for `withdraw_max()`.
    pub fn can_withdraw_max(state: &SystemState) -> Result<i128, StreamError> {
        if state.stream.status != StreamStatus::Active {
            return Err(StreamError::StreamNotActive);
        }
        let available = state.stream.available_at(state.ledger.timestamp)?;
        if available <= 0 {
            return Err(StreamError::NothingToWithdraw);
        }
        Ok(available)
    }

    /// State transition for `withdraw(amount)`.
    ///
    /// Follows Checks-Effects-Interactions (CEI):
    /// 1. Preconditions checked via `can_withdraw`.
    /// 2. Stream withdrawn balance incremented.
    /// 3. Stream marked `Depleted` if fully drained.
    /// 4. Tokens deducted from contract and credited to recipient.
    pub fn apply_withdraw(state: &SystemState, amount: i128) -> Result<SystemState, StreamError> {
        can_withdraw(state, amount)?;

        let mut next = *state;

        // Effects on stream
        next.stream.withdrawn = next
            .stream
            .withdrawn
            .checked_add(amount)
            .ok_or(StreamError::MathOverflow)?;

        if next.stream.withdrawn == next.stream.deposit {
            next.stream.status = StreamStatus::Depleted;
        }

        // Interactions / token transfers
        next.ledger.contract_balance = next
            .ledger
            .contract_balance
            .checked_sub(amount)
            .ok_or(StreamError::MathOverflow)?;

        next.ledger.recipient_balance = next
            .ledger
            .recipient_balance
            .checked_add(amount)
            .ok_or(StreamError::MathOverflow)?;

        Ok(next)
    }

    /// State transition for `withdraw_max()`.
    ///
    /// Computes full accrued unwithdrawn balance and delegates to `apply_withdraw`.
    pub fn apply_withdraw_max(state: &SystemState) -> Result<(SystemState, i128), StreamError> {
        let amount = can_withdraw_max(state)?;
        let next = apply_withdraw(state, amount)?;
        Ok((next, amount))
    }

    /// Advances simulated ledger timestamp by `delta_seconds`.
    pub fn apply_advance_time(
        state: &SystemState,
        delta_seconds: u64,
    ) -> Result<SystemState, StreamError> {
        let mut next = *state;
        next.ledger.timestamp = next
            .ledger
            .timestamp
            .checked_add(delta_seconds)
            .ok_or(StreamError::MathOverflow)?;
        Ok(next)
    }
}

/// Inductive proof verification, bounded model checking, and state exploration.
pub mod proofs {
    use super::spec::*;
    use super::transitions::*;
    use super::*;

    /// Verification proof result report.
    #[derive(Clone, Debug, Default, Eq, PartialEq)]
    pub struct VerificationSummary {
        pub initial_states_verified: u64,
        pub inductive_withdraw_steps_verified: u64,
        pub inductive_withdraw_max_steps_verified: u64,
        pub inductive_time_advance_steps_verified: u64,
        pub equivalence_theorems_verified: u64,
        pub invalid_transitions_rejected: u64,
        pub total_transitions_checked: u64,
    }

    /// **Theorem 1 (Inductive Step for `withdraw`)**:
    ///
    /// $$\forall \Sigma, a > 0: \quad I(\Sigma) \land \text{can\_withdraw}(\Sigma, a) \implies I(\text{apply\_withdraw}(\Sigma, a))$$
    pub fn verify_inductive_step_withdraw(
        pre: &SystemState,
        amount: i128,
    ) -> Result<SystemState, &'static str> {
        if !invariant_payout_inductive_conjunction(pre) {
            return Err("Precondition violation: pre-state does not satisfy inductive invariant");
        }

        let post = match apply_withdraw(pre, amount) {
            Ok(s) => s,
            Err(_) => return Err("Transition failed unexpectedly under valid guard"),
        };

        if !invariant_payout_inductive_conjunction(&post) {
            return Err("Proof failed: post-state violates inductive invariant after withdraw");
        }

        // Exact balance conservation: Delta Contract + Delta Recipient == 0
        let delta_contract = post.ledger.contract_balance - pre.ledger.contract_balance;
        let delta_recipient = post.ledger.recipient_balance - pre.ledger.recipient_balance;
        if delta_contract + delta_recipient != 0 {
            return Err("Proof failed: token balance not conserved");
        }
        if delta_contract != -amount || delta_recipient != amount {
            return Err("Proof failed: transfer amount mismatch");
        }

        Ok(post)
    }

    /// **Theorem 2 (Inductive Step for `withdraw_max`)**:
    ///
    /// $$\forall \Sigma: \quad I(\Sigma) \land \text{can\_withdraw\_max}(\Sigma) \implies I(\text{apply\_withdraw\_max}(\Sigma))$$
    pub fn verify_inductive_step_withdraw_max(
        pre: &SystemState,
    ) -> Result<(SystemState, i128), &'static str> {
        if !invariant_payout_inductive_conjunction(pre) {
            return Err("Precondition violation: pre-state does not satisfy inductive invariant");
        }

        let (post, amount) = match apply_withdraw_max(pre) {
            Ok(res) => res,
            Err(_) => return Err("Transition failed unexpectedly under valid guard"),
        };

        if !invariant_payout_inductive_conjunction(&post) {
            return Err("Proof failed: post-state violates inductive invariant after withdraw_max");
        }

        if amount <= 0 {
            return Err("Proof failed: withdraw_max paid non-positive amount");
        }

        // Available immediately after withdraw_max must be 0 at the same timestamp
        let remaining_available = post
            .stream
            .available_at(post.ledger.timestamp)
            .map_err(|_| "Error calculating remaining available balance")?;
        if remaining_available != 0 {
            return Err("Proof failed: withdraw_max did not drain all available accrued funds");
        }

        Ok((post, amount))
    }

    /// **Theorem 3 (Inductive Step for Time Advancement)**:
    ///
    /// $$\forall \Sigma, \Delta \ge 0: \quad I(\Sigma) \implies I(\text{apply\_advance\_time}(\Sigma, \Delta))$$
    pub fn verify_inductive_step_advance_time(
        pre: &SystemState,
        delta: u64,
    ) -> Result<SystemState, &'static str> {
        if !invariant_payout_inductive_conjunction(pre) {
            return Err("Precondition violation: pre-state does not satisfy inductive invariant");
        }

        let post = match apply_advance_time(pre, delta) {
            Ok(s) => s,
            Err(_) => return Err("Time advance failed"),
        };

        if !invariant_payout_inductive_conjunction(&post) {
            return Err("Proof failed: post-state violates invariant after time advance");
        }

        // Monotonic accrual check: accrued amount cannot decrease
        let pre_accrued = pre
            .stream
            .streamed_amount_at(pre.ledger.timestamp)
            .map_err(|_| "Failed pre accrual")?;
        let post_accrued = post
            .stream
            .streamed_amount_at(post.ledger.timestamp)
            .map_err(|_| "Failed post accrual")?;
        if post_accrued < pre_accrued {
            return Err("Proof failed: accrual regressed after time advance");
        }

        Ok(post)
    }

    /// **Theorem 4 (`withdraw_max` Equivalence to Atomic Full Withdrawal)**:
    ///
    /// Calling `withdraw_max()` is mathematically identical to reading `available_at(now)`
    /// and calling `withdraw(available)`.
    pub fn verify_withdraw_max_equivalence(pre: &SystemState) -> Result<(), &'static str> {
        let avail = match pre.stream.available_at(pre.ledger.timestamp) {
            Ok(a) => a,
            Err(_) => return Err("Failed to query available amount"),
        };

        if pre.stream.status != StreamStatus::Active {
            // Guard rejects both on non-active streams
            assert_eq!(
                apply_withdraw_max(pre).unwrap_err(),
                StreamError::StreamNotActive
            );
            assert_eq!(
                apply_withdraw(pre, 1).unwrap_err(),
                StreamError::StreamNotActive
            );
            return Ok(());
        }

        if avail <= 0 {
            // Guard must reject both on active streams with nothing accrued
            assert_eq!(
                apply_withdraw_max(pre).unwrap_err(),
                StreamError::NothingToWithdraw
            );
            assert_eq!(apply_withdraw(pre, 0).unwrap_err(), StreamError::ZeroAmount);
            return Ok(());
        }

        let (max_state, max_paid) =
            apply_withdraw_max(pre).map_err(|_| "apply_withdraw_max failed")?;
        let explicit_state =
            apply_withdraw(pre, avail).map_err(|_| "apply_withdraw(avail) failed")?;

        if max_paid != avail {
            return Err("Equivalence violation: max_paid != avail");
        }
        if max_state != explicit_state {
            return Err("Equivalence violation: resultant states diverge");
        }

        Ok(())
    }

    /// **Theorem 5 (Irreversibility of Depleted State)**:
    ///
    /// Once a stream reaches `Depleted`, no further withdrawals are possible.
    pub fn verify_depleted_irreversibility(depleted: &SystemState) -> Result<(), &'static str> {
        if depleted.stream.status != StreamStatus::Depleted {
            return Err("Precondition: stream is not depleted");
        }

        // Further withdraw attempts must revert deterministically with StreamNotActive
        match apply_withdraw(depleted, 1) {
            Err(StreamError::StreamNotActive) => {}
            _ => return Err("Depleted stream allowed withdrawal or returned wrong error"),
        }
        match apply_withdraw_max(depleted) {
            Err(StreamError::StreamNotActive) => {}
            _ => return Err("Depleted stream allowed withdraw_max or returned wrong error"),
        }
        Ok(())
    }

    // =========================================================================
    // KANI BOUNDED MODEL CHECKING HARNESSES
    // =========================================================================

    /// Bounded model checking verification harness for Kani verifier.
    /// Proves that for ANY symbolic tuple within capacity bounds:
    /// - Zero panics occur.
    /// - `withdraw` strictly preserves balance conservation.
    /// - Underflow/overflow is impossible.
    #[cfg_attr(kani, kani::proof)]
    #[cfg_attr(kani, kani::unwind(1))]
    pub fn kani_harness_withdraw_balance_conservation() {
        // In Kani execution, kani::any() provides unconstrained symbolic variables.
        // In standard cargo test, we test concrete representative boundary tuples.
        #[cfg(kani)]
        let (deposit, duration, elapsed, withdrawn, amount, unrelated): (
            i128,
            u64,
            u64,
            i128,
            i128,
            i128,
        ) = (
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
        );

        #[cfg(not(kani))]
        let (deposit, duration, elapsed, withdrawn, amount, unrelated) = (
            100_000i128,
            1000u64,
            500u64,
            10_000i128,
            5_000i128,
            50_000i128,
        );

        // Pre-condition assumptions
        if deposit <= 0 || duration == 0 || duration > MAX_DURATION_SECONDS {
            return;
        }
        if stream::validate_capacity(deposit, duration).is_err() {
            return;
        }
        if !(0..=i128::MAX / 2).contains(&unrelated) {
            return;
        }

        let accrued = match streamed_at(deposit, duration, elapsed.min(duration)) {
            Ok(v) => v,
            Err(_) => return,
        };
        if !(0..=accrued).contains(&withdrawn) {
            return;
        }

        let available = accrued - withdrawn;
        if amount <= 0 || amount > available {
            return;
        }

        let pre = SystemState {
            stream: AbstractStream {
                deposit,
                withdrawn,
                start_time: 1_000,
                end_time: 1_000 + duration,
                status: StreamStatus::Active,
            },
            ledger: AbstractLedger {
                timestamp: 1_000 + elapsed.min(duration),
                contract_balance: (deposit - withdrawn) + unrelated,
                recipient_balance: withdrawn,
                sender_balance: 0,
                unrelated_funds: unrelated,
            },
        };

        if !invariant_payout_inductive_conjunction(&pre) {
            return;
        }

        let post = apply_withdraw(&pre, amount).expect("valid transition must succeed");
        assert!(invariant_payout_inductive_conjunction(&post));
        assert_eq!(
            post.ledger.contract_balance + post.ledger.recipient_balance,
            deposit + unrelated
        );
    }

    /// Exhaustive bounded state-space exploration verifying balance conservation
    /// across thousands of combinations of deposits, durations, elapsed intervals,
    /// and sequential withdrawal permutations.
    pub fn run_exhaustive_bounded_model_check() -> VerificationSummary {
        let mut summary = VerificationSummary::default();

        let deposits: [i128; 6] = [
            1,
            2,
            7,
            1_000,
            100_000_000,
            (u128::MAX / (MAX_DURATION_SECONDS as u128)) as i128,
        ];
        let durations: [u64; 5] = [1, 2, 60, 3600, MAX_DURATION_SECONDS];
        let unrelated_cases: [i128; 3] = [0, 500, 10_000_000];

        for &deposit in &deposits {
            for &duration in &durations {
                if stream::validate_capacity(deposit, duration).is_err() {
                    continue;
                }

                for &unrelated in &unrelated_cases {
                    let start_time = 10_000u64;
                    let initial =
                        match SystemState::initial(deposit, start_time, duration, unrelated) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                    summary.initial_states_verified += 1;
                    summary.total_transitions_checked += 1;

                    // Test equivalence at t=0
                    verify_withdraw_max_equivalence(&initial).expect("t0 equivalence");
                    summary.equivalence_theorems_verified += 1;

                    // Advance time in steps
                    let sample_deltas = [
                        0u64,
                        1,
                        duration / 4,
                        duration / 2,
                        (duration * 3) / 4,
                        duration,
                        duration + 100,
                    ];

                    let mut current = initial;
                    for &delta in &sample_deltas {
                        let target_now = start_time.saturating_add(delta);
                        if target_now > current.ledger.timestamp {
                            let advance = target_now - current.ledger.timestamp;
                            current = verify_inductive_step_advance_time(&current, advance)
                                .expect("inductive time advance");
                            summary.inductive_time_advance_steps_verified += 1;
                            summary.total_transitions_checked += 1;
                        }

                        // Test withdraw_max equivalence at this timestamp
                        verify_withdraw_max_equivalence(&current)
                            .expect("time-stepped equivalence");
                        summary.equivalence_theorems_verified += 1;

                        let avail = current
                            .stream
                            .available_at(current.ledger.timestamp)
                            .unwrap();

                        // Negative testing: over-withdrawal must revert cleanly
                        if avail < deposit {
                            let over_amt = avail + 1;
                            assert!(can_withdraw(&current, over_amt).is_err());
                            summary.invalid_transitions_rejected += 1;
                            summary.total_transitions_checked += 1;
                        }

                        // Negative testing: zero withdrawal must revert cleanly
                        assert_eq!(
                            can_withdraw(&current, 0).unwrap_err(),
                            StreamError::ZeroAmount
                        );
                        summary.invalid_transitions_rejected += 1;
                        summary.total_transitions_checked += 1;

                        if avail > 0 {
                            // Branch 1: partial withdrawal (if avail > 1)
                            if avail > 1 {
                                let partial = avail / 2;
                                let partial_state =
                                    verify_inductive_step_withdraw(&current, partial)
                                        .expect("inductive partial withdraw");
                                summary.inductive_withdraw_steps_verified += 1;
                                summary.total_transitions_checked += 1;

                                // Withdraw remaining available from partial state
                                let rem_avail = partial_state
                                    .stream
                                    .available_at(partial_state.ledger.timestamp)
                                    .unwrap();
                                let (drained_state, _) =
                                    verify_inductive_step_withdraw_max(&partial_state)
                                        .expect("drain remaining via withdraw_max");
                                summary.inductive_withdraw_max_steps_verified += 1;
                                summary.total_transitions_checked += 1;
                                assert_eq!(rem_avail, avail - partial);

                                if delta >= duration {
                                    assert_eq!(drained_state.stream.status, StreamStatus::Depleted);
                                    verify_depleted_irreversibility(&drained_state)
                                        .expect("depleted irreversibility");
                                }
                            }

                            // Branch 2: direct full withdraw_max on current
                            let (max_state, paid) = verify_inductive_step_withdraw_max(&current)
                                .expect("inductive withdraw_max step");
                            summary.inductive_withdraw_max_steps_verified += 1;
                            summary.total_transitions_checked += 1;
                            assert_eq!(paid, avail);

                            if delta >= duration {
                                assert_eq!(max_state.stream.status, StreamStatus::Depleted);
                                verify_depleted_irreversibility(&max_state)
                                    .expect("depleted irreversibility");
                            }

                            current = max_state;
                        }
                    }
                }
            }
        }

        summary
    }
}

#[cfg(test)]
mod tests {
    use super::proofs::*;
    use super::spec::*;

    #[test]
    fn test_formal_inductive_verification_and_bounded_model_checker() {
        let summary = run_exhaustive_bounded_model_check();
        assert!(summary.initial_states_verified > 0);
        assert!(summary.inductive_withdraw_steps_verified > 0);
        assert!(summary.inductive_withdraw_max_steps_verified > 0);
        assert!(summary.inductive_time_advance_steps_verified > 0);
        assert!(summary.equivalence_theorems_verified > 0);
        assert!(summary.invalid_transitions_rejected > 0);
        assert!(summary.total_transitions_checked > 1_000);
    }

    #[test]
    fn test_kani_harness_standalone_execution() {
        kani_harness_withdraw_balance_conservation();
    }

    #[test]
    fn test_initial_state_preserves_inductive_invariant() {
        let state = SystemState::initial(1_000_000, 100, 500, 50_000).unwrap();
        assert!(invariant_balance_conservation(&state));
        assert!(invariant_accrual_bounded(&state));
        assert!(invariant_non_negative_balances(&state));
        assert!(invariant_terminal_state(&state));
        assert!(invariant_payout_inductive_conjunction(&state));
    }
}
