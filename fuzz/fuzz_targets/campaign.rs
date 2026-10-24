//! Persistent-campaign target: stateful, multi-asset, many-stream differential
//! fuzzing of the natively compiled contract against the reference model.
//!
//! The crash criterion is divergence; see `streampay_fuzz::campaign`.
//! `STREAMPAY_FUZZ_TRACE=1` prints the decoded op sequence first, which is how
//! triage turns a crasher into something a reader can follow.

#![no_main]

use libfuzzer_sys::fuzz_target;
use streampay_fuzz::campaign::{decode, trace, Backend, Campaign};

fuzz_target!(|data: &[u8]| {
    if std::env::var_os("STREAMPAY_FUZZ_TRACE").is_some() {
        eprint!("{}", trace(data));
    }
    let ops = decode(data);
    if ops.is_empty() {
        return;
    }
    Campaign::new(Backend::Native).run(&ops);
});
