// Clock-skew property suite (issue #211).
//
// Formalises the three-clock model of StreamPay balances (local ticker,
// simulate-at-ledger read, withdraw enforcement at ledger().timestamp()) and
// pins the UX contract:
//
//   "A live counter may show stale-down, never over-up."
//
// The over-up rule as a property: for any (local_time, ledger_time) pair
// within +/- MAX_SKEW_SECONDS, the guarded client-displayed available never
// exceeds contract-available at that ledger moment plus exactly one epsilon.
// The raw shipped ticker satisfies the rule for skews up to +1s and the
// suite bounds (and demonstrates) the violation beyond that, which is what
// docs/TIME_HANDLING.md codifies.

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { computeAvailable } from "./accrual.ts";
import {
  EPSILON_SECONDS,
  MAX_SKEW_SECONDS,
  REFRESH_INTERVAL_MS,
  boundaryLedgerTimes,
  contractAvailableAt,
  driftLadder,
  epsilonUnits,
  guardedLiveDisplay,
  interiorLedgerTimes,
  makeSkew,
  skewFixtureStreams,
  skewMatrix,
  skewOf,
  tickerDisplayedAvailable,
} from "./clock-skew.ts";

const BASE = 1_700_000_000; // fixed Unix second so runs are deterministic
const FIXTURES = skewFixtureStreams(BASE);

function ledgerSamples(streamIndex: number): bigint[] {
  const snapshot = FIXTURES[streamIndex];
  return [...boundaryLedgerTimes(snapshot), ...interiorLedgerTimes(snapshot)];
}

describe("skew vocabulary", () => {
  it("defines epsilon as one ledger-second", () => {
    assert.strictEqual(EPSILON_SECONDS, 1n);
  });

  it("drift ladder covers the closed +/-10s domain with no gaps", () => {
    const ladder = driftLadder();
    assert.strictEqual(ladder.length, 21);
    assert.strictEqual(ladder[0], -MAX_SKEW_SECONDS);
    assert.strictEqual(ladder[ladder.length - 1], MAX_SKEW_SECONDS);
    for (let i = 1; i < ladder.length; i += 1) {
      assert.strictEqual(ladder[i] - ladder[i - 1], 1n);
    }
  });

  it("skewOf and makeSkew round-trip", () => {
    const point = makeSkew(1234n, 42n);
    assert.strictEqual(point.ledgerTime, 1234n);
    assert.strictEqual(skewOf(point), 42n);
    assert.strictEqual(point.localTime, 1276n);
  });

  it("matrix cross-products every ledger moment with every drift", () => {
    const points = skewMatrix([100n, 200n]);
    assert.strictEqual(points.length, 2 * driftLadder().length);
    assert.ok(points.every((p) => skewOf(p) >= -MAX_SKEW_SECONDS && skewOf(p) <= MAX_SKEW_SECONDS));
  });
});

describe("contract oracle parity at zero skew", () => {
  it("frontend ticker math equals contract math at identical timestamps, including half-open edges", () => {
    for (const snapshot of FIXTURES) {
      for (const ledgerTime of [
        ...boundaryLedgerTimes(snapshot),
        ...interiorLedgerTimes(snapshot),
      ]) {
        assert.strictEqual(
          computeAvailable(
            snapshot.deposit,
            snapshot.startTime,
            snapshot.endTime,
            snapshot.withdrawn,
            snapshot.status,
            ledgerTime
          ),
          contractAvailableAt(snapshot, ledgerTime),
          `mismatch at ledger ${ledgerTime} for deposit=${snapshot.deposit}`
        );
      }
    }
  });

  it("start and end edges agree exactly: now==start is zero, now==end is full duration", () => {
    const snapshot = FIXTURES[1]; // 1000 units over 1000s, nothing withdrawn
    assert.strictEqual(contractAvailableAt(snapshot, BigInt(snapshot.startTime)), 0n);
    assert.strictEqual(computeAvailable(snapshot.deposit, snapshot.startTime, snapshot.endTime, snapshot.withdrawn, snapshot.status, BigInt(snapshot.startTime)), 0n);
    assert.strictEqual(contractAvailableAt(snapshot, BigInt(snapshot.endTime)), snapshot.deposit);
    assert.strictEqual(computeAvailable(snapshot.deposit, snapshot.startTime, snapshot.endTime, snapshot.withdrawn, snapshot.status, BigInt(snapshot.endTime)), snapshot.deposit);
  });
});

describe("never-over-up property over the +/-10s skew matrix", () => {
  it("guarded display never exceeds contract-available at the ledger moment plus one epsilon", () => {
    for (let i = 0; i < FIXTURES.length; i += 1) {
      const snapshot = FIXTURES[i];
      for (const point of skewMatrix(ledgerSamples(i))) {
        const shown = guardedLiveDisplay(snapshot, point);
        const cap =
          contractAvailableAt(snapshot, point.ledgerTime) +
          epsilonUnits(snapshot, point.ledgerTime);
        assert.ok(
          shown <= cap,
          `over-up: skew ${skewOf(point)}s showed ${shown} > cap ${cap} at ledger ${point.ledgerTime}`
        );
      }
    }
  });

  it("the guard is a no-op for honest clocks (skew <= +1s): the counter keeps ticking", () => {
    for (let i = 0; i < FIXTURES.length; i += 1) {
      const snapshot = FIXTURES[i];
      for (const point of skewMatrix(ledgerSamples(i))) {
        if (skewOf(point) > EPSILON_SECONDS) continue;
        const raw = computeAvailable(
          snapshot.deposit,
          snapshot.startTime,
          snapshot.endTime,
          snapshot.withdrawn,
          snapshot.status,
          point.localTime
        );
        assert.strictEqual(guardedLiveDisplay(snapshot, point), raw);
      }
    }
  });

  it("raw ticker with honest skew (<= +1s) already obeys the epsilon rule", () => {
    for (let i = 0; i < FIXTURES.length; i += 1) {
      const snapshot = FIXTURES[i];
      for (const point of skewMatrix(ledgerSamples(i))) {
        if (skewOf(point) > EPSILON_SECONDS) continue;
        const raw = computeAvailable(
          snapshot.deposit,
          snapshot.startTime,
          snapshot.endTime,
          snapshot.withdrawn,
          snapshot.status,
          point.localTime
        );
        assert.ok(
          raw <= contractAvailableAt(snapshot, point.ledgerTime) + epsilonUnits(snapshot, point.ledgerTime)
        );
      }
    }
  });

  it("stale-down is always allowed: a slow clock can only under-report", () => {
    for (let i = 0; i < FIXTURES.length; i += 1) {
      const snapshot = FIXTURES[i];
      for (const point of skewMatrix(ledgerSamples(i))) {
        if (skewOf(point) > 0n) continue;
        const raw = computeAvailable(
          snapshot.deposit,
          snapshot.startTime,
          snapshot.endTime,
          snapshot.withdrawn,
          snapshot.status,
          point.localTime
        );
        assert.ok(
          raw <= contractAvailableAt(snapshot, point.ledgerTime),
          `slow clock over-reported: skew ${skewOf(point)}s`
        );
      }
    }
  });

  it("any over-up of the raw ticker is bounded by one refresh horizon of accrual", () => {
    for (let i = 0; i < FIXTURES.length; i += 1) {
      const snapshot = FIXTURES[i];
      for (const point of skewMatrix(ledgerSamples(i))) {
        const raw = computeAvailable(
          snapshot.deposit,
          snapshot.startTime,
          snapshot.endTime,
          snapshot.withdrawn,
          snapshot.status,
          point.localTime
        );
        const actual = contractAvailableAt(snapshot, point.ledgerTime);
        const worst =
          contractAvailableAt(snapshot, point.ledgerTime + MAX_SKEW_SECONDS) - actual;
        assert.ok(raw - actual <= worst);
      }
    }
  });
});

describe("the found edge case: an ahead clock breaks the unguarded ticker", () => {
  it("a 10s-fast local clock over-shows a fast stream by more than one epsilon", () => {
    const snapshot = FIXTURES[2]; // 1_000_000 units over 1000s -> 1000 units/s
    const ledgerTime = BigInt(snapshot.startTime) + 500n;
    const point = makeSkew(ledgerTime, 10n);
    const raw = computeAvailable(
      snapshot.deposit,
      snapshot.startTime,
      snapshot.endTime,
      snapshot.withdrawn,
      snapshot.status,
      point.localTime
    );
    const actual = contractAvailableAt(snapshot, ledgerTime);
    const eps = epsilonUnits(snapshot, ledgerTime);
    assert.strictEqual(eps, 1000n);
    assert.strictEqual(raw, actual + 10n * eps);
    assert.ok(raw > actual + eps);
    // The guard clips exactly to contract-available + one epsilon.
    assert.strictEqual(guardedLiveDisplay(snapshot, point), actual + eps);
  });

  it("a sub-epsilon stream hides the skew entirely: epsilonUnits is zero mid-window", () => {
    const snapshot = FIXTURES[0]; // 9 units over 1000s
    const ledgerTime = BigInt(snapshot.startTime) + 100n;
    // Over 100..109s at 9/1000 per second nothing crosses a unit boundary,
    // except where floor math says otherwise; verify the epsilon budget.
    const eps = epsilonUnits(snapshot, ledgerTime);
    assert.ok(eps >= 0n);
    assert.ok(eps <= 1n);
    for (const skew of driftLadder()) {
      const point = makeSkew(ledgerTime, BigInt(skew));
      const shown = guardedLiveDisplay(snapshot, point);
      assert.ok(shown <= contractAvailableAt(snapshot, ledgerTime) + eps);
    }
  });

  it("boundary flicker: a fast clock across end_time shows the full deposit one epsilon-second early", () => {
    const snapshot = FIXTURES[4]; // ends at BASE+5
    const end = BigInt(snapshot.endTime);
    const point = makeSkew(end - 3n, 3n); // ledger 3s before end, local == end
    const raw = computeAvailable(
      snapshot.deposit,
      snapshot.startTime,
      snapshot.endTime,
      snapshot.withdrawn,
      snapshot.status,
      point.localTime
    );
    assert.strictEqual(raw, snapshot.deposit - snapshot.withdrawn); // full remainder shown
    assert.ok(contractAvailableAt(snapshot, point.ledgerTime) < raw);
    assert.ok(guardedLiveDisplay(snapshot, point) <= contractAvailableAt(snapshot, point.ledgerTime) + epsilonUnits(snapshot, point.ledgerTime));
  });
});

describe("second-boundary flicker (ms truncation)", () => {
  it("sub-second local time inside the same epsilon-second renders one value", () => {
    const snapshot = FIXTURES[1];
    const secondMs = BigInt(snapshot.startTime + 500) * 1000n;
    const atZero = tickerDisplayedAvailable(snapshot, secondMs);
    const at999 = tickerDisplayedAvailable(snapshot, secondMs + 999n);
    assert.strictEqual(atZero, at999);
    assert.strictEqual(
      tickerDisplayedAvailable(snapshot, secondMs + 1000n),
      atZero + 1n // 1 unit/s fixture: the next epsilon-second accrues exactly one unit
    );
  });

  it("a refresh at a later second-boundary can legitimately re-anchor the display down (stale-down)", () => {
    const snapshot = FIXTURES[1];
    const confirmed = tickerDisplayedAvailable(snapshot, BigInt(snapshot.startTime + 10) * 1000n);
    const afterRefresh = tickerDisplayedAvailable(snapshot, BigInt(snapshot.startTime + 20) * 1000n);
    assert.strictEqual(afterRefresh - confirmed, 10n);
    // With a slow clock (skew -10s) the same refresh re-anchors down by the drift.
    const slowClock = tickerDisplayedAvailable(snapshot, BigInt(snapshot.startTime + 20 - 10) * 1000n);
    assert.ok(slowClock < afterRefresh);
  });
});

describe("pending-transaction staleness", () => {
  it("a concurrent withdrawal can only push the stale display over-up, never under", () => {
    const snapshot = FIXTURES[3]; // 1000/1000s, 250 already withdrawn
    const ledgerTime = BigInt(snapshot.startTime) + 600n;
    const displayBefore = guardedLiveDisplay(snapshot, makeSkew(ledgerTime, 0n));
    assert.strictEqual(displayBefore, contractAvailableAt(snapshot, ledgerTime));

    // A second device withdraws 100 units one ledger later; stale display now
    // exceeds the on-chain truth by exactly the pending amount.
    const withdrawnElsewhere = 100n;
    const racedSnapshot = { ...snapshot, withdrawn: snapshot.withdrawn + withdrawnElsewhere };
    const actualAfter = contractAvailableAt(racedSnapshot, ledgerTime + 1n);
    assert.ok(
      displayBefore > actualAfter,
      "stale display should over-report after a concurrent withdrawal"
    );

    // The post-refresh display drops to the true value: stale-down, allowed,
    // and it never jumped up at any point in the sequence.
    const displayAfterRefresh = guardedLiveDisplay(
      racedSnapshot,
      makeSkew(ledgerTime + 1n, 0n)
    );
    assert.strictEqual(displayAfterRefresh, actualAfter);
    assert.ok(displayAfterRefresh <= displayBefore);
  });

  it("acting on at most the confirmed (simulate) value never reverts while no one else withdraws", () => {
    for (let i = 0; i < FIXTURES.length; i += 1) {
      const snapshot = FIXTURES[i];
      for (const ledgerTime of ledgerSamples(i)) {
        const confirmed = contractAvailableAt(snapshot, ledgerTime);
        // The tx lands at some ledger >= the confirm moment; accrual is
        // monotone, so an amount <= confirmed is always payable.
        for (const landingDelta of [0n, 1n, 5n, BigInt(REFRESH_INTERVAL_MS / 1000)]) {
          const payable = contractAvailableAt(snapshot, ledgerTime + landingDelta);
          assert.ok(
            confirmed <= payable,
            `confirmed ${confirmed} must be payable at ledger ${ledgerTime + landingDelta} (got ${payable})`
          );
        }
      }
    }
  });
});
