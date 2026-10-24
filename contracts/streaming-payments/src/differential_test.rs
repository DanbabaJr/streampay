//! Differential tests: Wasm contract execution vs reference model.
//!
//! Executes all seeded unit test scenarios against both sides, verifies roundtrip
//! seed persistence, and demonstrates that the differential oracle catches intentional
//! model divergences.
#![cfg(test)]

extern crate std;
use std::format;
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::println;

use streampay_model::seeds::{
    all_seeded_scenarios, seed_cancel_by_sender, seed_create_and_linear_withdraw,
    seed_protocol_fees_and_treasury_withdraw,
};
use streampay_model::ActionSequence;

use crate::differential_harness::DifferentialHarness;

#[test]
fn differential_test_all_unit_test_seeded_scenarios() {
    for (name, sequence) in all_seeded_scenarios() {
        let mut harness = DifferentialHarness::new();
        harness.execute_sequence(&sequence.actions);
        println!(
            "Differential scenario passed: {name} ({} actions)",
            sequence.actions.len()
        );
    }
}

#[test]
fn generate_and_verify_seed_corpus_files() {
    let corpus_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fuzz")
        .join("corpus")
        .join("differential");

    fs::create_dir_all(&corpus_dir).expect("failed to create corpus dir");

    for (name, sequence) in all_seeded_scenarios() {
        let bytes = sequence.to_bytes();
        let file_path = corpus_dir.join(format!("seed_{name}"));
        fs::write(&file_path, &bytes).expect("failed to write seed file");

        // Verify roundtrip decoding and execution
        let decoded = ActionSequence::from_bytes(&bytes).expect("failed to decode seed");
        assert_eq!(decoded, sequence, "decoded seed mismatch for {name}");

        let mut harness = DifferentialHarness::new();
        harness.execute_sequence(&decoded.actions);
    }
}

#[test]
fn demonstrate_intentional_accrual_divergence_caught() {
    let mut harness = DifferentialHarness::new();
    // Temporarily break the model by introducing an off-by-one in accrual math (+1 token)
    harness.model.mutations.break_accrual_add_one = true;

    let seq = seed_create_and_linear_withdraw();
    let result = catch_unwind(AssertUnwindSafe(|| {
        harness.execute_sequence(&seq.actions);
    }));

    assert!(
        result.is_err(),
        "Harness MUST catch intentional accrual divergence"
    );
    println!("SUCCESS: Intentional accrual divergence was caught by the differential harness!");
}

#[test]
fn demonstrate_intentional_fee_divergence_caught() {
    let mut harness = DifferentialHarness::new();
    // Temporarily break the model by introducing an off-by-one in protocol fee calculation (+1 token)
    harness.model.mutations.break_fee_math_add_one = true;

    let seq = seed_protocol_fees_and_treasury_withdraw();
    let result = catch_unwind(AssertUnwindSafe(|| {
        harness.execute_sequence(&seq.actions);
    }));

    assert!(
        result.is_err(),
        "Harness MUST catch intentional fee calculation divergence"
    );
    println!(
        "SUCCESS: Intentional fee calculation divergence was caught by the differential harness!"
    );
}

#[test]
fn demonstrate_intentional_cancel_split_divergence_caught() {
    let mut harness = DifferentialHarness::new();
    // Temporarily break the model by shortchanging the sender refund by 1 token
    harness.model.mutations.break_cancel_sender_refund_sub_one = true;

    let seq = seed_cancel_by_sender();
    let result = catch_unwind(AssertUnwindSafe(|| {
        harness.execute_sequence(&seq.actions);
    }));

    assert!(
        result.is_err(),
        "Harness MUST catch intentional cancel refund divergence"
    );
    println!(
        "SUCCESS: Intentional cancel split divergence was caught by the differential harness!"
    );
}
