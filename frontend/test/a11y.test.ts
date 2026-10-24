/**
 * WCAG 2.1 AA Accessibility Gate
 *
 * Runs axe-core against representative HTML snapshots of every page/component
 * in the app. Uses JSDOM so no browser is needed — the test runs in Node's
 * built-in test runner via `npm run test:a11y`.
 *
 * Baseline exceptions: any rule disabled here must carry a justification
 * comment explaining why the violation cannot be fixed at this layer.
 *
 * Usage:
 *   npm run test:a11y          # single run (CI-safe)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import axe from "axe-core";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Helper: run axe against an HTML string, return violations filtered to AA.
// ---------------------------------------------------------------------------
async function runAxe(
  html: string,
  {
    disabledRules = [],
    context = "body",
  }: { disabledRules?: string[]; context?: string } = {}
): Promise<axe.Result[]> {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    // Silence JSDOM console noise from inline scripts
    virtualConsole: new (await import("jsdom")).VirtualConsole(),
  });

  const { window } = dom;

  // Inject axe-core into the JSDOM window so it can walk the DOM
  const axeSource = require.resolve("axe-core");
  const { readFileSync } = await import("node:fs");
  const axeScript = readFileSync(axeSource, "utf8");
  const scriptEl = window.document.createElement("script");
  scriptEl.textContent = axeScript;
  window.document.head.appendChild(scriptEl);

  return new Promise((resolve, reject) => {
    // @ts-expect-error — axe is now on the JSDOM window
    (window as unknown as { axe: typeof axe }).axe.run(
      window.document.querySelector(context) ?? window.document,
      {
        runOnly: { type: "tag", values: ["wcag2aa", "wcag21aa", "best-practice"] },
        rules: Object.fromEntries(
          disabledRules.map((id) => [id, { enabled: false }])
        ),
      },
      (err: Error | null, results: axe.AxeResults) => {
        if (err) { reject(err); return; }
        resolve(results.violations);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Helper: assert no violations, printing a useful diff on failure.
// ---------------------------------------------------------------------------
function assertNoViolations(violations: axe.Result[], label: string): void {
  if (violations.length === 0) return;

  const details = violations
    .map((v) => {
      const nodes = v.nodes
        .map((n) => `    • ${n.html}\n      Fix: ${n.failureSummary ?? v.description}`)
        .join("\n");
      return `[${v.id}] ${v.help} (impact: ${v.impact ?? "unknown"})\n${nodes}`;
    })
    .join("\n\n");

  assert.fail(
    `${label} — ${violations.length} axe violation(s):\n\n${details}\n`
  );
}

// ---------------------------------------------------------------------------
// Shared wrapper that all pages sit inside (layout.tsx)
// ---------------------------------------------------------------------------
function withLayout(bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StreamPay — streaming payments on Stellar</title>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

// ===========================================================================
// 1. Home page (unauthenticated — connect screen)
// ===========================================================================
describe("Home page — unauthenticated", () => {
  test("passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<main class="wrap">
  <div style="display:flex; justify-content:space-between; align-items:center;">
    <div class="kicker mono">SOROBAN · STELLAR</div>
    <a href="/docs" style="color:#38bdf8; font-size:0.85rem; text-decoration:none;">API Docs ↗</a>
  </div>
  <h1>StreamPay</h1>
  <p class="muted">Continuous, per-second payment streams — payroll, vesting, subscriptions. Connect Freighter to begin.</p>
  <div style="display:flex; gap:12px; align-items:center;">
    <button type="button">Connect Freighter</button>
    <a href="/simulator" style="display:inline-block; padding:10px 18px; color:#39c5ff; text-decoration:none; font-weight:600; font-size:14px;">
      Accrual Simulator →
    </a>
  </div>
</main>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "Home (unauthenticated)");
  });
});

// ===========================================================================
// 2. Stream create form (StreamForm)
// ===========================================================================
describe("StreamForm", () => {
  test("passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<main class="wrap">
  <form class="card">
    <h2>Create a stream</h2>
    <div class="row">
      <div>
        <label for="asset">Asset</label>
        <select id="asset" name="asset">
          <option value="native">Native XLM</option>
          <option value="contract">Token contract (USDC-style)</option>
        </select>
      </div>
      <div>
        <label for="recipient">Recipient</label>
        <input id="recipient" type="text" required placeholder="G…" autocomplete="off" />
      </div>
    </div>
    <div class="row">
      <div>
        <label for="deposit">Deposit (smallest units)</label>
        <input id="deposit" type="number" min="1" required value="1000000000" />
      </div>
      <div>
        <label for="days">Duration (days)</label>
        <input id="days" type="number" min="0.001" step="any" required value="30" />
      </div>
      <div>
        <label for="cancelable">Recipient may cancel?</label>
        <select id="cancelable" name="cancelable">
          <option value="yes">Yes (cancelable)</option>
          <option value="no">No (sender-only)</option>
        </select>
      </div>
    </div>
    <p class="muted">Amounts are in smallest units (7 decimals for XLM and testnet USDC).</p>
    <button type="submit">Create stream</button>
  </form>
</main>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "StreamForm");
  });
});

// ===========================================================================
// 3. Stream detail page (StreamDetailClient)
// ===========================================================================
describe("Stream detail", () => {
  test("passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<main class="wrap">
  <p class="kicker mono">STREAM #42</p>
  <h1>Streaming</h1>

  <section class="card" aria-label="Stream status">
    <div class="row">
      <div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="35"
           aria-label="Withdrawal progress: 35% withdrawn" style="flex:1; height:8px; background:#22304a; border-radius:999px; overflow:hidden;">
        <div style="width:35%; height:100%; background:linear-gradient(90deg,#8b7cff,#39c5ff);"></div>
      </div>
      <span class="mono">35% withdrawn</span>
    </div>
    <table>
      <caption class="sr-only">Stream details for stream #42</caption>
      <tbody>
        <tr><th scope="row">Sender</th><td class="mono">GABC…</td></tr>
        <tr><th scope="row">Recipient</th><td class="mono">GXYZ…</td></tr>
        <tr><th scope="row">Token</th><td class="mono">CTOKEN…</td></tr>
        <tr><th scope="row">Deposit</th><td class="mono">1000000</td></tr>
        <tr><th scope="row">Withdrawn</th><td class="mono">350000</td></tr>
        <tr>
          <th scope="row">Available now</th>
          <td>
            <span class="mono" aria-live="polite" aria-label="Available balance: 12345 units" id="available-display">12345</span>
            <span class="sr-only" aria-live="polite" aria-atomic="true" id="available-announce"></span>
          </td>
        </tr>
        <tr><th scope="row">Window</th><td class="mono">2025-01-01 → 2025-12-31</td></tr>
        <tr><th scope="row">Cancelable</th><td>true</td></tr>
        <tr><th scope="row">Status</th><td>Active</td></tr>
      </tbody>
    </table>
  </section>

  <section class="card" aria-labelledby="withdraw-heading">
    <h2 id="withdraw-heading">Withdraw accrued funds</h2>
    <div class="row" role="group" aria-labelledby="withdraw-heading">
      <label for="withdraw-amount" class="sr-only">Withdrawal amount in smallest token units</label>
      <input id="withdraw-amount" type="number" min="0" placeholder="amount (defaults to available)"
             aria-describedby="withdraw-hint" />
      <span id="withdraw-hint" class="sr-only">Leave blank to withdraw all available. Current accrued balance: 12345 units.</span>
      <button type="button">Withdraw</button>
      <button type="button" aria-describedby="withdraw-max-hint">Withdraw max</button>
      <span id="withdraw-max-hint" class="sr-only">Atomically claims the full accrued balance.</span>
    </div>
  </section>

  <section class="card" aria-labelledby="cancel-heading">
    <h2 id="cancel-heading">Cancel stream</h2>
    <p class="muted">Pays the recipient everything accrued and refunds the sender the rest, atomically. This is irreversible.</p>
    <button type="button" aria-describedby="cancel-warning">Cancel stream</button>
    <p id="cancel-warning" class="sr-only">Warning: this action is irreversible.</p>
  </section>
</main>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "Stream detail");
  });
});

// ===========================================================================
// 4. Stream list table (StreamList)
// ===========================================================================
describe("StreamList", () => {
  test("passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<main class="wrap">
  <section class="card" aria-labelledby="streams-heading">
    <h2 id="streams-heading">Your streams</h2>
    <table aria-describedby="streams-heading">
      <caption class="sr-only">List of your payment streams</caption>
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">Token</th>
          <th scope="col">Recipient</th>
          <th scope="col">Deposit</th>
          <th scope="col">Withdrawn</th>
          <th scope="col">Status</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="mono"><a href="/stream/1">#1</a></td>
          <td class="mono" title="CXLM…">XLM</td>
          <td class="mono">GABC1234…</td>
          <td class="mono">1000000</td>
          <td class="mono">350000</td>
          <td><span class="status-badge status-active">Active</span></td>
          <td>
            <div class="row" role="group" aria-label="Actions for stream #1">
              <label for="amount-1" class="sr-only">Amount for stream #1 operations</label>
              <input id="amount-1" type="number" min="1" placeholder="amount"
                     aria-label="Amount for stream #1" />
              <button type="button" aria-label="Withdraw from stream #1">Withdraw</button>
              <button type="button" aria-label="Withdraw max from stream #1"
                      title="Claim the entire accrued balance in one call">Max</button>
              <button type="button" aria-label="Top up stream #1">Top up</button>
              <button type="button" aria-label="Cancel stream #1">Cancel</button>
              <button type="button" aria-label="Refresh stream #1">↻ <span class="sr-only">Refresh</span></button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</main>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "StreamList");
  });
});

// ===========================================================================
// 5. Toast notifications
// ===========================================================================
describe("Toast notifications", () => {
  test("success toast passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<main class="wrap"><h1>StreamPay</h1></main>
<div class="toast-container" role="region" aria-label="Notifications" aria-live="polite">
  <div class="toast-item toast-success" role="status">
    <span class="toast-icon" aria-hidden="true">✓</span>
    <div class="toast-message">Stream #1 created successfully.</div>
    <button type="button" class="toast-close" aria-label="Dismiss notification">×</button>
  </div>
</div>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "Toast (success)");
  });

  test("error toast passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<main class="wrap"><h1>StreamPay</h1></main>
<div class="toast-container" role="region" aria-label="Notifications" aria-live="assertive">
  <div class="toast-item toast-error" role="alert">
    <span class="toast-icon" aria-hidden="true">✕</span>
    <div class="toast-message">Transaction failed. Check your wallet balance.</div>
    <button type="button" class="toast-close" aria-label="Dismiss notification">×</button>
  </div>
</div>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "Toast (error)");
  });
});

// ===========================================================================
// 6. Address Explorer (AddressExplorerClient)
// ===========================================================================
describe("Address Explorer", () => {
  test("passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<main class="wrap">
  <div style="margin-bottom:16px;">
    <a href="/" style="font-size:13px; color:#93a1b8;">← Back to StreamPay</a>
  </div>

  <header style="margin-bottom:20px;">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
      <div>
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <h1 style="margin:0 0 4px 0; font-size:26px;">Address Explorer</h1>
          <span class="live-indicator" aria-label="Live accrual updating every second">
            <span class="live-dot" aria-hidden="true"></span>
            Live
          </span>
        </div>
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:4px;">
          <span class="mono" style="font-size:14px; word-break:break-all;">GABC1234…</span>
          <button type="button" class="copy-btn" aria-label="Copy address to clipboard">Copy</button>
        </div>
        <p aria-live="polite" aria-atomic="true" class="sr-only" id="copy-status"></p>
      </div>
    </div>
  </header>

  <section class="stats-grid" aria-label="Address stream aggregates">
    <div class="stat-box">
      <span class="stat-label" id="stat-total">Total Streams</span>
      <span class="stat-value" aria-labelledby="stat-total">5</span>
    </div>
    <div class="stat-box">
      <span class="stat-label" id="stat-active">Active Streams</span>
      <span class="stat-value" aria-labelledby="stat-active" style="color:#3ddc84;">3</span>
    </div>
    <div class="stat-box">
      <span class="stat-label" id="stat-deposited">Total Deposited</span>
      <span class="stat-value" aria-labelledby="stat-deposited">5000000</span>
    </div>
    <div class="stat-box">
      <span class="stat-label" id="stat-claimed">Total Claimed</span>
      <span class="stat-value" aria-labelledby="stat-claimed" style="color:#39c5ff;">1750000</span>
    </div>
  </section>

  <nav class="filter-controls" aria-label="Filter streams">
    <div class="filter-group" role="tablist" aria-label="Direction filter">
      <a href="/address/GABC?tab=all" class="filter-btn active" role="tab" aria-selected="true">All Streams</a>
      <a href="/address/GABC?tab=incoming" class="filter-btn" role="tab" aria-selected="false">Incoming (Recipient)</a>
      <a href="/address/GABC?tab=outgoing" class="filter-btn" role="tab" aria-selected="false">Outgoing (Sender)</a>
    </div>
    <div class="filter-group" role="group" aria-label="Status filter">
      <a href="/address/GABC?status=all" class="filter-btn active" aria-current="true">All Status</a>
      <a href="/address/GABC?status=active" class="filter-btn">Active Only</a>
      <a href="/address/GABC?status=ended" class="filter-btn">Ended</a>
    </div>
  </nav>

  <section aria-label="Stream listings">
    <article class="stream-card" aria-labelledby="stream-1-title">
      <div class="stream-card-header">
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <a href="/stream/1" class="mono" id="stream-1-title" style="font-size:16px; font-weight:700; color:#39c5ff;">Stream #1</a>
          <span class="status-badge status-active">Active</span>
          <span class="badge-pill" style="background:rgba(61,220,132,0.12); color:#3ddc84;">Incoming</span>
        </div>
        <div style="font-size:13px;">
          <span class="muted">Sender: </span>
          <a href="/address/GSENDER" class="mono" style="color:#e8eefb;">GSEN…</a>
        </div>
      </div>

      <div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="42"
           aria-label="Stream #1 accrual progress: 42%"
           class="progress-track">
        <div class="progress-fill" style="width:42%;"></div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin:12px 0; font-size:13px;">
        <div>
          <div class="muted" style="font-size:11px; text-transform:uppercase;" id="avail-label-1">Available Now</div>
          <div class="mono" aria-labelledby="avail-label-1" style="font-size:16px; font-weight:700; color:#3ddc84;">12345</div>
        </div>
        <div>
          <div class="muted" style="font-size:11px; text-transform:uppercase;" id="deposit-label-1">Total Deposit</div>
          <div class="mono" aria-labelledby="deposit-label-1" style="font-size:14px;">1000000</div>
        </div>
      </div>
    </article>
  </section>

  <nav aria-label="Pagination navigation">
    <a href="/address/GABC" class="page-btn" aria-disabled="true" tabindex="-1">← Newer (Previous)</a>
    <a href="/address/GABC?cursor=5&amp;dir=forward" class="page-btn">Older (Next) →</a>
  </nav>
</main>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "Address Explorer");
  });
});

// ===========================================================================
// 7. Accrual / Vesting Simulator page
// ===========================================================================
describe("Accrual Simulator", () => {
  test("passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<main class="wrap">
  <div style="margin-bottom:16px;">
    <a href="/" style="color:#39c5ff; text-decoration:none; font-size:14px;">← Back to StreamPay</a>
  </div>
  <h1>Accrual &amp; Vesting Simulator</h1>
  <p class="muted">Pure client-side accrual oracle and vesting schedule playground.</p>

  <section class="card" aria-labelledby="params-heading">
    <h2 id="params-heading">Schedule Parameters</h2>
    <div class="row">
      <div>
        <label for="deposit-range">Total Deposit (tokens): 10,000</label>
        <input id="deposit-range" type="range" min="100" max="1000000" step="100" value="10000"
               aria-valuemin="100" aria-valuemax="1000000" aria-valuenow="10000" />
      </div>
      <div>
        <label for="duration-range">Total Duration (seconds): 3600s (60m)</label>
        <input id="duration-range" type="range" min="60" max="86400" step="60" value="3600"
               aria-valuemin="60" aria-valuemax="86400" aria-valuenow="3600" />
      </div>
    </div>

    <div style="margin-top:16px; display:flex; gap:12px; align-items:center;">
      <label style="margin:0; display:flex; align-items:center; gap:8px; cursor:pointer;">
        <input type="checkbox" id="use-segments" name="use-segments" />
        <span>Enable Multi-Segment Milestones</span>
      </label>
    </div>

    <div class="row" style="margin-top:12px;">
      <div>
        <label for="cliff-dur">Cliff Duration (seconds): 600s (10m)</label>
        <input id="cliff-dur" type="range" min="0" max="3600" step="30" value="600"
               aria-valuemin="0" aria-valuemax="3600" aria-valuenow="600" />
      </div>
      <div>
        <label for="cliff-pct">Cliff Unlock: 20% (200 tokens)</label>
        <input id="cliff-pct" type="range" min="0" max="100" step="5" value="20"
               aria-valuemin="0" aria-valuemax="100" aria-valuenow="20" />
      </div>
    </div>
  </section>

  <section class="card" aria-labelledby="scrubber-heading">
    <h2 id="scrubber-heading">Time Scrubber (Elapsed: 1800s / 3600s)</h2>
    <div style="margin:14px 0;">
      <label for="time-scrubber">Scrub Time (t = 1800s)</label>
      <input id="time-scrubber" type="range" min="0" max="3600" step="1" value="1800"
             style="width:100%;" aria-valuemin="0" aria-valuemax="3600" aria-valuenow="1800" />
    </div>
    <div class="row" style="margin-top:16px;">
      <div style="padding:12px; background:#0b121e; border-radius:8px; border:1px solid #22304a;">
        <span class="muted" id="vesting-label">Claimable at t (Vesting Schedule)</span>
        <div class="mono" aria-labelledby="vesting-label" style="font-size:22px; font-weight:bold; color:#3ddc84;">5000 tokens</div>
        <span class="muted" style="font-size:12px;">50.00% unlocked</span>
      </div>
      <div style="padding:12px; background:#0b121e; border-radius:8px; border:1px solid #22304a;">
        <span class="muted" id="linear-label">Contract Pure streamed_at (Linear)</span>
        <div class="mono" aria-labelledby="linear-label" style="font-size:22px; font-weight:bold; color:#39c5ff;">5000 tokens</div>
        <span class="muted" style="font-size:12px;">Floor pro-rata reference</span>
      </div>
    </div>
  </section>

  <section class="card" aria-labelledby="chart-heading">
    <h2 id="chart-heading">Claim Curves (Claimable vs Time)</h2>
    <div style="overflow-x:auto; display:flex; justify-content:center;">
      <svg viewBox="0 0 600 240" role="img" aria-labelledby="chart-title chart-desc"
           style="width:100%; max-width:600px; background:#080c14; border-radius:8px; border:1px solid #22304a;">
        <title id="chart-title">Accrual curve chart</title>
        <desc id="chart-desc">Line chart showing the vesting schedule curve (solid green) and the pure linear streamed_at reference (dashed cyan) over the stream duration. X axis: time in seconds. Y axis: tokens accrued.</desc>
        <line x1="40" y1="200" x2="560" y2="200" stroke="#22304a" />
        <line x1="40" y1="40" x2="40" y2="200" stroke="#22304a" />
        <path d="M 40 200 L 560 40" fill="none" stroke="#3ddc84" stroke-width="3" />
        <path d="M 40 200 L 560 40" fill="none" stroke="#39c5ff" stroke-width="2" stroke-dasharray="4 4" opacity="0.6" />
        <text x="40" y="228" fill="#93a1b8" font-size="11" font-family="monospace">0s</text>
        <text x="510" y="228" fill="#93a1b8" font-size="11" font-family="monospace">3600s</text>
        <text x="10" y="50" fill="#93a1b8" font-size="11" font-family="monospace">10000</text>
        <text x="10" y="200" fill="#93a1b8" font-size="11" font-family="monospace">0</text>
      </svg>
    </div>

    <div style="display:flex; gap:20px; margin-top:14px; font-size:13px; justify-content:center;"
         role="list" aria-label="Chart legend">
      <div role="listitem" style="display:flex; align-items:center; gap:6px;">
        <span style="width:16px; height:3px; background:#3ddc84; display:inline-block;" aria-hidden="true"></span>
        <span>Vesting Schedule Curve</span>
      </div>
      <div role="listitem" style="display:flex; align-items:center; gap:6px;">
        <span style="width:16px; height:2px; border-top:2px dashed #39c5ff; display:inline-block;" aria-hidden="true"></span>
        <span>Pure streamed_at Reference</span>
      </div>
      <div role="listitem" style="display:flex; align-items:center; gap:6px;">
        <span style="width:16px; height:2px; border-top:2px dashed #ff6b6b; display:inline-block;" aria-hidden="true"></span>
        <span>Cliff Point</span>
      </div>
    </div>
  </section>
</main>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "Accrual Simulator");
  });
});

// ===========================================================================
// 8. BatchStreamForm
// ===========================================================================
describe("BatchStreamForm", () => {
  test("passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<main class="wrap">
  <form class="card" aria-labelledby="batch-heading" novalidate>
    <h2 id="batch-heading">Batch payroll stream</h2>
    <div>
      <label for="batch-token">Token contract ID</label>
      <input id="batch-token" type="text" required placeholder="C… (Stellar Asset Contract ID)"
             autocomplete="off" aria-describedby="batch-token-hint" />
      <span id="batch-token-hint" class="sr-only">Enter the Stellar Asset Contract ID for the token to stream, e.g. a C… address.</span>
    </div>
    <div style="margin-top:12px;">
      <label for="batch-csv">Recipients CSV</label>
      <textarea id="batch-csv" required rows="5"
                placeholder="address,rate,duration&#10;G…,1000,86400"
                aria-describedby="batch-csv-hint"></textarea>
      <span id="batch-csv-hint" class="sr-only">One recipient per line. Format: Stellar address, rate in smallest units per second, duration in seconds.</span>
    </div>
    <div style="margin-top:12px;">
      <label for="batch-cancelable">Recipients may cancel?</label>
      <select id="batch-cancelable" name="batch-cancelable">
        <option value="yes">Yes (cancelable)</option>
        <option value="no">No (sender-only)</option>
      </select>
    </div>
    <button type="submit" style="margin-top:16px;">Create batch streams</button>
  </form>
</main>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "BatchStreamForm");
  });
});

// ===========================================================================
// 9. Network / contract indicator (issue #33)
//
// Colours below are the flattened (opaque) equivalents of the rgba tints in
// globals.css — JSDOM cannot composite alpha channels, and these are the
// effective backgrounds the user sees over --panel (#111725).
// ===========================================================================
describe("Network indicator", () => {
  const CONTRACT_ID = "CAAP5FRQLPBOHD3CH7XMD4JY4WAX5PP3HNRWZP6Y3LZJZ4RQAB4D";

  test("badge passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<header class="network-indicator">
  <div class="network-bar" style="background:#111725;">
    <span class="network-chip network-chip-testnet"
          style="background:#211d19; color:#f59e0b; border:1px solid #644919;">TESTNET</span>
    <span class="network-text" style="color:#93a1b8;">Stellar Testnet</span>
    <a class="network-contract mono" style="color:#39c5ff;"
       href="https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}"
       title="${CONTRACT_ID}">
      <span aria-hidden="true">contract CAAP5FRQ…AB4D</span>
      <span class="sr-only">Streaming contract id ${CONTRACT_ID} — opens the block explorer</span>
    </a>
  </div>
</header>
<main class="wrap"><h1>StreamPay</h1></main>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "Network indicator (badge)");
  });

  test("wallet mismatch warning passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<header class="network-indicator">
  <div class="network-bar" style="background:#111725;">
    <span class="network-chip network-chip-testnet"
          style="background:#211d19; color:#f59e0b; border:1px solid #644919;">TESTNET</span>
    <span class="network-text" style="color:#93a1b8;">Stellar Testnet</span>
  </div>
  <div class="network-warning" role="alert" style="background:#241d21; color:#e8eefb;">
    <div class="network-warning-body">
      <strong class="network-warning-title" style="color:#ff6b6b;">
        Wallet is on Public Network (mainnet)
      </strong>
      <p class="network-warning-text" style="color:#e8eefb;">
        This app signs for Testnet. Transactions will fail until the wallet matches.
      </p>
      <p class="network-warning-hint" style="color:#93a1b8;">
        Open the Freighter extension, switch to Testnet in its network picker, then reconnect.
      </p>
    </div>
    <button type="button" class="network-warning-dismiss toast-close"
            style="color:#ff6b6b;" aria-label="Dismiss network warning">×</button>
  </div>
</header>
<main class="wrap"><h1>StreamPay</h1></main>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "Network indicator (mismatch warning)");
  });

  test("unconfigured contract state passes WCAG 2.1 AA", async () => {
    const html = withLayout(`
<header class="network-indicator">
  <div class="network-bar" style="background:#111725;">
    <span class="network-chip network-chip-public"
          style="background:#163d2b; color:#3ddc84; border:1px solid #1d5c3c;">PUBLIC</span>
    <span class="network-text" style="color:#93a1b8;">Stellar Public Network (mainnet)</span>
    <span class="network-contract-unset" style="color:#93a1b8;">contract id not configured</span>
  </div>
</header>
<main class="wrap"><h1>StreamPay</h1></main>`);

    const violations = await runAxe(html);
    assertNoViolations(violations, "Network indicator (no contract id)");
  });
});
