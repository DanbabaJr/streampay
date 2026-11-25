//! Coverage-guided fuzzing of the dispute-bond economics: the escalating
//! bond function and the expiry split. These are the anti-griefing core —
//! a recipient must always pay a bounded but non-zero cost per blocked
//! window, and the bond must never be created or destroyed by resolution.
//!
//! Run locally with:
//!
//! ```sh
//! cargo +nightly install cargo-fuzz   # once
//! cd fuzz
//! cargo fuzz run dispute_bond
//! cargo fuzz run dispute_bond -- -max_total_time=60   # 60s session
//! ```
//!
//! Oracles asserted on every input:
//!
//! `required_bond(deposit, prior)` (pure, checked):
//!
//! 1. No panics on any input, ever (including negatives and zeros).
//! 2. Every `Ok(bond)` is at least `MIN_DISPUTE_BOND`.
//! 3. Exactness: when the scaled product fits `u128`, the bond is the
//!    floored ratio `deposit * BPS * (prior + 1) / 10_000` (floored up to
//!    the minimum).
//! 4. Monotonic: the bond never shrinks when the deposit grows or another
//!    dispute round is added — serial griefing always costs at least as
//!    much as the round before.
//! 5. `Err` is *only* ever `MathOverflow`, and only when the product above
//!    genuinely leaves `u128` / `i128` (degenerate inputs return the floor).
//!
//! `bond_shares(bond)` (the expiry split):
//!
//! 6. Conservation: `sender_share + recipient_share == bond` — the contract
//!    can never over-pay or under-pay a bond at expiry.
//! 7. Fairness: the split is exact or off-by-one in the sender's favor.

#![no_main]

use libfuzzer_sys::fuzz_target;
use streampay_contract::{
    bond_shares, required_bond, DISPUTE_BOND_BPS, MIN_DISPUTE_BOND,
};

fuzz_target!(|input: (i128, u32, u32)| {
    let (deposit, prior, elapsed) = input;
    // --- required_bond ----------------------------------------------------
    let bond = match required_bond(deposit, prior) {
        Ok(bond) => {
            // (2): the floor makes disputes on dust deposits non-free.
            assert!(
                bond >= MIN_DISPUTE_BOND,
                "bond {bond} below the floor for {deposit}/{prior}"
            );
            // (3): exact floored ratio when the product fits.
            let rounds = (prior as u128) + 1;
            let exact = (deposit as u128)
                .checked_mul(DISPUTE_BOND_BPS)
                .and_then(|p| p.checked_mul(rounds))
                .map(|scaled| (scaled / 10_000).max(MIN_DISPUTE_BOND as u128));
            if let Some(expected) = exact {
                assert!(
                    i128::try_from(expected).is_ok(),
                    "Ok bond {bond} although the ratio {expected} leaves i128"
                );
                assert_eq!(bond as u128, expected);
            } else {
                // (5): Ok implies a genuinely in-range product, so the
                // reference must exist for positive deposits.
                assert!(deposit <= 0, "Ok bond for overflowing {deposit}/{prior}");
            }
            bond
        }
        Err(streampay_contract::StreamError::MathOverflow) => {
            // (5): overflow is the only failure mode, and it is genuine.
            let rounds = (prior as u128) + 1;
            let product_overflows = (deposit as u128)
                .checked_mul(DISPUTE_BOND_BPS)
                .and_then(|p| p.checked_mul(rounds))
                .map(|scaled| scaled / 10_000 > i128::MAX as u128)
                .unwrap_or(true);
            assert!(
                deposit > 0 && product_overflows,
                "MathOverflow reported although the bond fits for {deposit}/{prior}"
            );
            return;
        }
        Err(other) => panic!("unexpected error variant: {other:?}"),
    };

    // (4): monotonicity in the round counter and in the deposit.
    if let Some(next_prior) = prior.checked_add(1) {
        if let Some(next) = required_bond(deposit, next_prior).ok() {
            assert!(
                next >= bond,
                "bond decreased from {bond} to {next} at the next dispute round"
            );
        }
    }
    if let Some(bigger) = deposit.checked_add(elapsed as i128).filter(|d| *d > deposit) {
        if let Some(next) = required_bond(bigger, prior).ok() {
            assert!(
                next >= bond,
                "bond decreased from {bond} to {next} for a bigger deposit"
            );
        }
    }

    // --- bond_shares ------------------------------------------------------
    for bond in [bond, MIN_DISPUTE_BOND, elapsed as i128] {
        let (sender, recipient) = bond_shares(bond);
        // (6): conservation — the split pays out exactly the escrowed bond.
        assert_eq!(
            sender + recipient,
            bond,
            "bond {bond} not conserved by split {sender}/{recipient}"
        );
        // (7): near-even, rounding favors the sender.
        assert!(sender >= recipient && sender - recipient <= 1);
    }
});
