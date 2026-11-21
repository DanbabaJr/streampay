//! Oracle report staleness boundary tests.

#![cfg(test)]

use crate::test::Fixture;
use crate::events::OracleStaleFallback;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    Address, Event as _, Vec,
};

const MAX_STALE_SECONDS: u64 = 10;

#[test]
fn staleness_boundary_and_fallback_lifecycle() {
    let f = Fixture::setup();
    let publisher = Address::generate(&f.env);
    let mut publishers = Vec::new(&f.env);
    publishers.push_back(publisher.clone());
    f.client.mock_all_auths().set_oracle_config(
        &f.governor,
        &publishers,
        &1,
        &MAX_STALE_SECONDS,
    );

    let stream_id = f.create_stream_with_oracle(1_000, 0, 100, false, true);
    let report_ledger_time = f.ledger_time() + 100;
    f.set_ledger_time(report_ledger_time);
    let oracle_time = report_ledger_time + 5;
    f.client
        .mock_all_auths()
        .submit_oracle_time(&publisher, &oracle_time);

    for age in [MAX_STALE_SECONDS - 1, MAX_STALE_SECONDS] {
        f.set_ledger_time(report_ledger_time + age);
        let resolved = f.client.resolve_time(&stream_id, &true);
        assert_eq!(resolved.timestamp, oracle_time, "report age {age}");
        assert!(resolved.is_oracle, "report age {age}");
        assert_eq!(
            f.env
                .events()
                .all()
                .filter_by_contract(&f.client.address)
                .events()
                .len(),
            0
        );
    }

    let stale_ledger_time = report_ledger_time + MAX_STALE_SECONDS + 1;
    f.set_ledger_time(stale_ledger_time);
    let resolved = f.client.resolve_time(&stream_id, &true);
    assert_eq!(resolved.timestamp, stale_ledger_time);
    assert!(!resolved.is_oracle);
    let fallback_event = OracleStaleFallback {
        stream_id,
        ledger_time: stale_ledger_time,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [fallback_event.to_xdr(&f.env, &f.client.address)]
    );

    // Each stale resolution emits one fallback event, including repeated
    // resolutions while the report remains stale.
    let repeated_stale_ledger_time = stale_ledger_time + 1;
    f.set_ledger_time(repeated_stale_ledger_time);
    let resolved = f.client.resolve_time(&stream_id, &true);
    assert_eq!(resolved.timestamp, repeated_stale_ledger_time);
    assert!(!resolved.is_oracle);
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [OracleStaleFallback {
            stream_id,
            ledger_time: repeated_stale_ledger_time,
        }
        .to_xdr(&f.env, &f.client.address)]
    );

    let fresh_report_ledger_time = f.ledger_time();
    let refreshed_oracle_time = fresh_report_ledger_time - 1;
    f.client
        .mock_all_auths()
        .submit_oracle_time(&publisher, &refreshed_oracle_time);
    let resolved = f.client.resolve_time(&stream_id, &true);
    assert_eq!(resolved.timestamp, refreshed_oracle_time);
    assert!(resolved.is_oracle);
    assert_eq!(
        f.env
            .events()
            .all()
            .filter_by_contract(&f.client.address)
            .events()
            .len(),
        0
    );

    let stale_again_ledger_time = fresh_report_ledger_time + MAX_STALE_SECONDS + 1;
    f.set_ledger_time(stale_again_ledger_time);
    let resolved = f.client.resolve_time(&stream_id, &true);
    assert_eq!(resolved.timestamp, stale_again_ledger_time);
    assert!(!resolved.is_oracle);
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [OracleStaleFallback {
            stream_id,
            ledger_time: stale_again_ledger_time,
        }
        .to_xdr(&f.env, &f.client.address)]
    );
}
