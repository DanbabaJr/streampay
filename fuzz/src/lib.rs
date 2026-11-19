//! Shared code for the StreamPay fuzz targets.
//!
//! [`campaign`] is the stateful differential harness the persistent fuzz
//! campaign runs (see `docs/FUZZ_CAMPAIGN.md`). It drives the Soroban contract
//! and the reference model from issue #16 through the same operation sequence,
//! across many concurrent streams and several assets, and treats any
//! divergence between them as the crash criterion.

pub mod campaign;
