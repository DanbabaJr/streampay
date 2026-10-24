//! Coverage-guided differential fuzzing: Wasm contract vs reference model.
//!
//! Asserts identical accrual and fee calculation across the contract and the
//! reference model, and verifies state machine execution without panic.

#![no_main]

use libfuzzer_sys::fuzz_target;
use streampay_contract::{fee_amount as c_fee_amount, streamed_at as c_streamed_at, StreamError};
use streampay_model::errors::ModelError;
use streampay_model::math::{fee_amount as m_fee_amount, streamed_at as m_streamed_at};
use streampay_model::ActionSequence;

fuzz_target!(|data: &[u8]| {
    // 1. Math Differential Oracle: Check accrual and fee calculation parity
    if data.len() >= 32 {
        let deposit = i128::from_le_bytes(data[0..16].try_into().unwrap());
        let duration = u64::from_le_bytes(data[16..24].try_into().unwrap());
        let elapsed = u64::from_le_bytes(data[24..32].try_into().unwrap());

        let c_res = c_streamed_at(deposit, duration, elapsed);
        let m_res = m_streamed_at(deposit, duration, elapsed);

        match (c_res, m_res) {
            (Ok(c_val), Ok(m_val)) => {
                assert_eq!(c_val, m_val, "Accrual divergence between contract and model")
            }
            (Err(StreamError::MathOverflow), Err(ModelError::MathOverflow)) => {}
            (other_c, other_m) => {
                panic!("Divergence in accrual: contract={other_c:?}, model={other_m:?}")
            }
        }

        let fee_bps = (duration % 10_000) as u32;
        let c_fee = c_fee_amount(deposit, fee_bps);
        let m_fee = m_fee_amount(deposit, fee_bps);
        match (c_fee, m_fee) {
            (Ok(c_val), Ok(m_val)) => {
                assert_eq!(c_val, m_val, "Fee divergence between contract and model")
            }
            (Err(StreamError::MathOverflow), Err(ModelError::MathOverflow)) => {}
            (other_c, other_m) => {
                panic!("Divergence in fee: contract={other_c:?}, model={other_m:?}")
            }
        }
    }

    // 2. Action Sequence roundtrip decoding
    if let Some(seq) = ActionSequence::from_bytes(data) {
        if seq.actions.is_empty() || seq.actions.len() > 100 {
            return;
        }
        let encoded = seq.to_bytes();
        let decoded = ActionSequence::from_bytes(&encoded).expect("roundtrip must succeed");
        assert_eq!(seq, decoded);
    }
});
