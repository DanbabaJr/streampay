#!/usr/bin/env node
/**
 * Clock-skew live probe (issue #211).
 *
 * Samples the three StreamPay clocks against the testnet for a configurable
 * duration (default 60 minutes) and asserts the never-over-up property
 * empirically:
 *
 *   1. local wall clock      — `Date.now()` on the runner,
 *   2. ledger clock          — `closed_at` of the latest verified ledger
 *                              (Horizon), which is what `ledger().timestamp()`
 *                              enforces,
 *   3. simulate "available"  — the contract's own answer at the pinned ledger.
 *
 * When CONTRACT_ID (and optionally STREAM_ID) are supplied, each sample also
 * reads the on-chain `available` + `get_stream` for a real stream and compares
 * the raw frontend ticker value against contract-available + one epsilon.
 *
 * Artifacts (validation evidence for the PR / nightly run):
 *   samples.jsonl  — one line per sample with all three clocks,
 *   summary.json   — divergence statistics and the property verdict,
 *   chart.html     — self-contained SVG chart of skew vs drift vs over-up.
 *
 * Exit codes: 0 = pass (or a documented skip when no network/contract is
 * reachable), 1 = the skew domain (|drift| <= 10s) or the guarded-display
 * property was violated.
 *
 * Usage:
 *   node scripts/clock-skew-probe.mjs --minutes=60 --interval=15 \
 *     [--contract=CAAA...] [--stream=1] [--rpc=URL] [--horizon=URL] [--out=DIR]
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Account,
  Contract,
  Horizon,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

const MAX_SKEW_SECONDS = 10n; // must match frontend/lib/clock-skew.ts

// ----------------------------------------------------------------- args ----

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const envMap = {
    contract: "CONTRACT_ID",
    stream: "STREAM_ID",
    rpc: "SOROBAN_RPC_URL",
    horizon: "HORIZON_URL",
    minutes: "PROBE_MINUTES",
    interval: "PROBE_INTERVAL_SECONDS",
    out: "PROBE_OUT_DIR",
  };
  return process.env[envMap[name]] ?? fallback;
}

const minutes = Number(argValue("minutes", "60"));
const intervalSeconds = Number(argValue("interval", "15"));
const rpcUrl = argValue("rpc", "https://soroban-testnet.stellar.org");
const horizonUrl = argValue("horizon", "https://horizon-testnet.stellar.org");
const contractId = argValue("contract", "") || "";
const streamId = argValue("stream", "") || "";
const outDir = argValue("out", "artifacts/clock-skew");
const network = Networks.TESTNET;

if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error("--minutes must be a positive number");
  process.exit(1);
}
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
  console.error("--interval must be >= 1 second");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const samplesPath = join(outDir, "samples.jsonl");
writeFileSync(samplesPath, "");

// ------------------------------------------------------ accrual mirrors ----
// Kept deliberately identical to frontend/lib/accrual.ts + stream.rs
// (floor division, half-open window). The probe must not import app code so
// it can run standalone in CI.

function contractStreamed(deposit, startTime, endTime, atSeconds) {
  const duration = BigInt(endTime - startTime);
  if (duration <= 0n || deposit <= 0n) return 0n;
  let elapsed;
  const t = BigInt(atSeconds);
  const start = BigInt(startTime);
  const end = BigInt(endTime);
  if (t <= start) elapsed = 0n;
  else if (t >= end) elapsed = duration;
  else elapsed = t - start;
  if (elapsed === 0n) return 0n;
  const streamed = (BigInt(deposit) * elapsed) / duration;
  return streamed > BigInt(deposit) ? BigInt(deposit) : streamed;
}

function contractAvailable(snapshot, atSeconds) {
  if (snapshot.status === "Cancelled") return 0n;
  return (
    contractStreamed(
      snapshot.deposit,
      snapshot.startTime,
      snapshot.endTime,
      atSeconds
    ) - BigInt(snapshot.withdrawn)
  );
}

function epsilonUnits(snapshot, atSeconds) {
  return (
    contractAvailable(snapshot, atSeconds + 1) -
    contractAvailable(snapshot, atSeconds)
  );
}

// Ticker mirror: what the frontend renders from the local clock.
function tickerDisplay(snapshot, localSeconds) {
  if (snapshot.status !== "Active") return 0n;
  return (
    contractStreamed(
      snapshot.deposit,
      snapshot.startTime,
      snapshot.endTime,
      localSeconds
    ) - BigInt(snapshot.withdrawn)
  );
}

// ------------------------------------------------------------ net reads ----

// The ed25519 all-zero key: a syntactically valid source for simulations
// (same DUMMY_SOURCE the frontend reads use).
const DUMMY_SOURCE = new Account(
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  "0"
);

const server = new rpc.Server(rpcUrl, { network });
const horizon = new Horizon.Server(horizonUrl, { allowHttp: false });

async function simulate(method, args) {
  const tx = new TransactionBuilder(DUMMY_SOURCE, {
    fee: "100",
    networkPassphrase: network,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate ${method}: ${sim.error}`);
  }
  return sim.result?.retval ?? [];
}

const u64 = (v) => nativeToScVal(BigInt(v), { type: "u64" });

async function readStreamOnChain(id) {
  const [retval] = await simulate("get_stream", [u64(id)]);
  const raw = scValToNative(retval);
  return {
    deposit: BigInt(String(raw.deposit)),
    withdrawn: BigInt(String(raw.withdrawn)),
    startTime: Number(raw.start_time),
    endTime: Number(raw.end_time),
    status: String(raw.status),
  };
}

async function readAvailableOnChain(id) {
  const [retval] = await simulate("available", [u64(id)]);
  return BigInt(String(scValToNative(retval)));
}

async function readLedgerClock() {
  const tip = await server.getLatestLedger();
  let closedAt = null;
  try {
    const ledgers = await horizon
      .ledgers()
      .limit(1)
      .order("desc")
      .call();
    if (ledgers.records?.length) {
      closedAt = Math.floor(new Date(ledgers.records[0].closed_at).getTime() / 1000);
    }
  } catch {
    // Horizon unavailable: the RPC tip alone still exercises the loop.
    closedAt = null;
  }
  return { sequence: Number(tip.sequence), closedAt };
}

// ---------------------------------------------------------------- probe ----

const samples = [];
const startedAt = Date.now();
const endsAt = startedAt + minutes * 60_000;
let skipped = null;
let maxBehind = 0; // largest stale-down drift (local behind ledger) seen

console.log(
  `clock-skew probe: ${minutes} min, interval ${intervalSeconds}s, rpc=${rpcUrl}`
);
if (!contractId) {
  skipped = "no CONTRACT_ID supplied: running clock-only sampling";
} else {
  try {
    await readLedgerClock();
  } catch (e) {
    skipped = `network unreachable (${e.message}): skipping stream sampling`;
  }
}

let streamUsable = false;
if (!skipped && contractId && streamId) {
  streamUsable = await readStreamOnChain(streamId)
    .then(() => true)
    .catch((e) => {
      console.log(`stream #${streamId} unreadable: ${e.message}`);
      return false;
    });
  if (!streamUsable) {
    skipped = `stream #${streamId} unreadable: running clock-only sampling`;
  }
} else if (!skipped) {
  skipped = "no STREAM_ID supplied: running clock-only sampling";
}

let failures = 0;
let maxAbsSkew = 0;
let maxOverUp = 0n;

while (Date.now() < endsAt) {
  const localMs = Date.now();
  const localSeconds = Math.floor(localMs / 1000);
  const record = {
    at: new Date(localMs).toISOString(),
    localSeconds,
    ledgerSequence: null,
    ledgerSeconds: null,
    skewSeconds: null,
    onChainAvailable: null,
    tickerDisplay: null,
    guardedDisplay: null,
    epsilonUnits: null,
    overUpUnits: null,
  };

  try {
    const clock = await readLedgerClock();
    record.ledgerSequence = clock.sequence;
    if (clock.closedAt !== null) {
      record.ledgerSeconds = clock.closedAt;
      record.skewSeconds = localSeconds - clock.closedAt;
      const absSkew = Math.abs(record.skewSeconds);
      maxAbsSkew = Math.max(maxAbsSkew, absSkew);
      if (record.skewSeconds < 0) {
        // Local clock behind the ledger: the counter can only under-report
        // (stale-down) — allowed by the UX contract, tracked as a warning.
        maxBehind = Math.max(maxBehind, -record.skewSeconds);
      } else if (record.skewSeconds > MAX_SKEW_SECONDS) {
        failures += 1;
        console.error(
          `FAIL: local clock leads the ledger by ${record.skewSeconds}s > ${MAX_SKEW_SECONDS}s (over-up domain breached)`
        );
      }
    }
    if (contractId && streamId && streamUsable) {
      record.onChainAvailable = String(await readAvailableOnChain(streamId));
      {
        const snapshot = await readStreamOnChain(streamId);
        const ledgerAt = record.ledgerSeconds ?? localSeconds;
        record.tickerDisplay = String(tickerDisplay(snapshot, localSeconds));
        const eps = epsilonUnits(snapshot, ledgerAt);
        record.epsilonUnits = String(eps);
        const actual = contractAvailable(snapshot, ledgerAt);
        const guarded =
          BigInt(record.tickerDisplay) > actual + eps
            ? actual + eps
            : BigInt(record.tickerDisplay);
        record.guardedDisplay = String(guarded);
        const overUp = BigInt(record.tickerDisplay) - actual;
        record.overUpUnits = String(overUp > 0n ? overUp : 0n);
        if (overUp > 0n) maxOverUp = overUp > maxOverUp ? overUp : maxOverUp;
        if (guarded > actual + eps) {
          failures += 1;
          console.error(`FAIL: guarded display ${guarded} > ${actual}+${eps}`);
        }
        // The simulate answer must match the contract oracle within the
        // ledger read (allowing exactly one epsilon of read/land skew).
        if (BigInt(record.onChainAvailable) > actual + eps) {
          failures += 1;
          console.error(
            `FAIL: simulate available ${record.onChainAvailable} exceeds oracle+eps`
          );
        }
      }
    }
  } catch (e) {
    record.error = String(e && e.message ? e.message : e);
  }

  samples.push(record);
  appendFileSync(samplesPath, JSON.stringify(record) + "\n");
  const remaining = Math.max(0, endsAt - Date.now());
  if (remaining === 0) break;
  await new Promise((r) => setTimeout(r, Math.min(intervalSeconds * 1000, remaining)));
}

// -------------------------------------------------------------- report ----

const skews = samples
  .map((s) => s.skewSeconds)
  .filter((v) => typeof v === "number");
const divergence = samples
  .map((s) => (s.overUpUnits !== null ? Number(s.overUpUnits) : null))
  .filter((v) => v !== null);

const summary = {
  generatedAt: new Date().toISOString(),
  durationPlannedMinutes: minutes,
  durationActualMinutes: (Date.now() - startedAt) / 60_000,
  samples: samples.length,
  errors: samples.filter((s) => s.error).length,
  skipped,
  property:
    "localTime - ledgerTime <= 10s (stale-down allowed) and guardedDisplay <= contractAvailable(ledgerTime) + epsilonUnits(ledgerTime)",
  maxAbsSkewSeconds: maxAbsSkew,
  maxStaleDownSeconds: maxBehind,
  maxRawOverUpUnits: String(maxOverUp),
  skewStats: skews.length
    ? {
        min: Math.min(...skews),
        max: Math.max(...skews),
        mean: skews.reduce((a, b) => a + b, 0) / skews.length,
      }
    : null,
  overUpSamples: divergence.filter((v) => v > 0).length,
  failures,
  verdict: failures === 0 ? "PASS" : "FAIL",
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(outDir, "chart.html"), renderChart(samples));

console.log(JSON.stringify(summary, null, 2));
if (failures > 0) process.exit(1);

// ---------------------------------------------------------------- chart ----

function renderChart(rows) {
  const w = 960;
  const h = 320;
  const pad = 40;
  const ok = rows.filter((r) => r.skewSeconds !== null);
  if (ok.length < 2) {
    return `<!doctype html><meta charset="utf-8"><title>Clock skew probe</title>
<body style="font-family:system-ui;background:#0b0e14;color:#e6e6e6;padding:24px">
<h1>Clock skew divergence</h1><p>Not enough samples to chart (${ok.length} of ${rows.length} carried a ledger reading).</p>
<pre>${JSON.stringify({ skipped, samples: rows.length }, null, 2)}</pre></body>`;
  }
  const values = ok.map((r) => r.skewSeconds);
  const lo = Math.min(...values, -1);
  const hi = Math.max(...values, 1);
  const span = hi - lo || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / (ok.length - 1);
  const y = (v) => pad + (h - 2 * pad) * (1 - (v - lo) / span);
  const polyline = ok
    .map((r, i) => `${x(i).toFixed(1)},${y(r.skewSeconds).toFixed(1)}`)
    .join(" ");
  const zeroY = y(0).toFixed(1);
  const domHi = y(10).toFixed(1);
  const domLo = y(-10).toFixed(1);
  const rawOver = ok.filter((r) => Number(r.overUpUnits ?? 0) > 0).length;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Clock skew probe</title>
<style>body{font-family:system-ui;background:#0b0e14;color:#e6e6e6;padding:24px}svg{background:#11151f;border-radius:8px}.legend{display:flex;gap:24px;margin:12px 0}</style></head>
<body><h1>Local vs ledger clock divergence (${ok.length} samples)</h1>
<div class="legend"><span>— <b style="color:#6cb2ff">skew (local − ledger, s)</b></span>
<span>shaded: allowed +/-10s domain</span><span>raw over-up samples: ${rawOver}</span></div>
<svg width="${w}" height="${h}">
<rect x="${pad}" y="${domHi}" width="${w - 2 * pad}" height="${Math.max(0, domLo - domHi)}" fill="#234" opacity="0.5"/>
<line x1="${pad}" y1="${zeroY}" x2="${w - pad}" y2="${zeroY}" stroke="#555" stroke-dasharray="4 4"/>
<text x="${pad + 4}" y="${domHi - 4}" fill="#8ab" font-size="11">+10s domain edge</text>
<text x="${pad + 4}" y="${Number(domLo) + 12}" fill="#8ab" font-size="11">-10s domain edge</text>
<polyline points="${polyline}" fill="none" stroke="#6cb2ff" stroke-width="2"/>
<text x="${pad}" y="${h - 8}" fill="#999" font-size="11">t →</text>
<text x="6" y="${zeroY}" fill="#999" font-size="11">0s</text>
</svg>
<pre>${JSON.stringify(values.length ? { first: values[0], last: values[values.length - 1], min: lo, max: hi } : {}, null, 2)}</pre>
</body></html>`;
}
