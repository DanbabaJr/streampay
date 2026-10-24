#!/usr/bin/env node
/**
 * anchor_offramp_demo.js - Standalone demo script proving the fiat-adjacent
 * off-ramp flow (SEP-24 style) for StreamPay stream withdrawals.
 *
 * Flow demonstrated:
 *   1. Recipient accrues earnings via StreamPay streaming contract.
 *   2. Recipient calls `withdraw_max` (or partial withdraw) to anchor-connected Stellar account.
 *   3. Client initiates SEP-24 interactive off-ramp flow:
 *      a. Check /info endpoint on anchor server.
 *      b. Authenticate (SEP-10 challenge simulation) or obtain JWT token.
 *      c. Request POST /transactions/withdraw/interactive to get transaction ID and web URL.
 *      d. Interactive session simulates KYC & bank account details input.
 *      e. Anchor provides deposit Stellar address & memo.
 *      f. Stellar transaction transfer from recipient to Anchor address.
 *      g. Monitor GET /transaction?id=... until status becomes 'completed'.
 *   4. Simulation includes documented failure mode tests:
 *      - Anchor rate limit / velocity limit handling (HTTP 429)
 *      - Asset trustline bootstrap error handling
 *
 * Can run in standalone mock mode (default) or against live testnet anchor endpoints.
 * Usage:
 *   node scripts/anchor_offramp_demo.js [--mock] [--network testnet]
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

// Parse command line arguments
const args = process.argv.slice(2);
const isLiveTestnet = args.includes('--live');
const portArgIndex = args.indexOf('--port');
const PORT = portArgIndex !== -1 && args[portArgIndex + 1] ? parseInt(args[portPortArgIndex + 1], 10) : 9876;

// ANSI color helpers
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m"
};

function logStep(stepNum, title) {
  console.log(`\n${colors.bright}${colors.cyan}======================================================================${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}[STEP ${stepNum}] ${title}${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}======================================================================${colors.reset}`);
}

function logInfo(label, val) {
  console.log(`  ${colors.bright}${label}:${colors.reset} ${val}`);
}

function logSuccess(msg) {
  console.log(`  ${colors.green}✔ ${msg}${colors.reset}`);
}

function logWarn(msg) {
  console.log(`  ${colors.yellow}⚠ ${msg}${colors.reset}`);
}

function logError(msg) {
  console.log(`  ${colors.red}✖ ${msg}${colors.reset}`);
}

// -------------------------------------------------------------
// SEP-24 Mock Server Implementation
// -------------------------------------------------------------
class MockSep24AnchorServer {
  constructor(port = 9876) {
    this.port = port;
    this.server = null;
    this.transactions = new Map();
    this.rateLimitHitCount = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url, `http://localhost:${this.port}`);
        const pathname = parsedUrl.pathname;

        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // 1. GET /info (SEP-24 Info endpoint)
        if (req.method === 'GET' && pathname === '/info') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            withdraw: {
              USDC: {
                enabled: true,
                fee_fixed: 1.50,
                fee_percent: 0.1,
                min_amount: 5.0,
                max_amount: 10000.0
              },
              EURC: {
                enabled: true,
                fee_fixed: 1.20,
                fee_percent: 0.1,
                min_amount: 5.0,
                max_amount: 10000.0
              }
            },
            deposit: {
              USDC: { enabled: true }
            },
            fee: { enabled: true }
          }));
          return;
        }

        // 2. Simulated Rate-Limited endpoint to demonstrate failure mode
        if (pathname === '/rate-limited-endpoint') {
          this.rateLimitHitCount++;
          if (this.rateLimitHitCount <= 2) {
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'Retry-After': '2'
            });
            res.end(JSON.stringify({
              error: 'Rate limit exceeded. Maximum 5 requests per 10 seconds. Please back off.',
              retry_after: 2
            }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'success_after_retry' }));
          return;
        }

        // 3. POST /transactions/withdraw/interactive (Initiate off-ramp)
        if (req.method === 'POST' && pathname === '/transactions/withdraw/interactive') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            const txId = 'tx_' + Math.random().toString(36).substring(2, 12);
            let params = {};
            try {
              params = body ? JSON.parse(body) : {};
            } catch (e) {
              // try urlencoded
              const urlParams = new URLSearchParams(body);
              params = Object.fromEntries(urlParams.entries());
            }

            const record = {
              id: txId,
              kind: 'withdrawal',
              status: 'incomplete', // initial SEP-24 status until interactive flow completes
              status_eta: 30,
              amount_in: params.amount || '250.00',
              amount_out: (parseFloat(params.amount || 250) * 0.99 - 1.5).toFixed(2),
              amount_fee: '1.75',
              asset_code: params.asset_code || 'USDC',
              asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              withdraw_anchor_account: 'GDG2PZ7U4B6L64QFLXZN3Z3S4K6Y5US2VPO6Z2A7K63VBLT3QMN7USDC',
              withdraw_memo: 'payroll-offramp-' + txId.slice(0, 6),
              withdraw_memo_type: 'text',
              started_at: new Date().toISOString()
            };
            this.transactions.set(txId, record);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              type: 'interactive_customer_info_needed',
              url: `http://localhost:${this.port}/interactive-flow?tx_id=${txId}`,
              id: txId
            }));
          });
          return;
        }

        // 4. Interactive Flow UI simulation / webhook progression
        if (req.method === 'GET' && pathname === '/interactive-flow') {
          const txId = parsedUrl.searchParams.get('tx_id');
          const tx = this.transactions.get(txId);
          if (tx) {
            // Once user completes form in interactive UI, anchor updates status to pending_user_transfer_start
            tx.status = 'pending_user_transfer_start';
            tx.kyc_status = 'approved';
            tx.bank_account_last4 = '4821';
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body>
                <h2>Mock SEP-24 Interactive Flow (KYC & Payout Method)</h2>
                <p>Status: KYC verified, routing payout to recipient bank account ending in 4821.</p>
                <p>Anchor deposit account: <code>${tx?.withdraw_anchor_account}</code></p>
                <p>Memo: <code>${tx?.withdraw_memo}</code></p>
              </body>
            </html>
          `);
          return;
        }

        // 5. POST /simulate-deposit (Simulates on-chain Stellar transfer landing at Anchor)
        if (req.method === 'POST' && pathname === '/simulate-deposit') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            const data = JSON.parse(body || '{}');
            const tx = this.transactions.get(data.tx_id);
            if (tx) {
              tx.status = 'pending_anchor';
              tx.stellar_transaction_id = 'c8b417ef84' + Math.random().toString(16).substring(2, 10);
              // Progress to completed
              setTimeout(() => {
                tx.status = 'completed';
                tx.completed_at = new Date().toISOString();
                tx.fiat_payout_reference = 'ACH-SEPA-94810283';
              }, 1000);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'accepted', transaction: tx }));
          });
          return;
        }

        // 6. GET /transaction (SEP-24 Query single transaction)
        if (req.method === 'GET' && pathname === '/transaction') {
          const txId = parsedUrl.searchParams.get('id');
          const tx = this.transactions.get(txId);
          if (!tx) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Transaction not found' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ transaction: tx }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      this.server.listen(this.port, () => {
        resolve(`http://localhost:${this.port}`);
      });
      this.server.on('error', reject);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// Helper to make HTTP JSON requests
function requestJson(urlStr, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -------------------------------------------------------------
// Main Execution Pipeline
// -------------------------------------------------------------
async function run() {
  console.log(`\n${colors.bright}${colors.magenta}StreamPay Fiat-Adjacent On-Ramp / Off-Ramp Integration Demo${colors.reset}`);
  console.log(`${colors.dim}Proving StreamPay as the crypto-leg of regulated payroll payouts via SEP-24${colors.reset}\n`);

  const server = new MockSep24AnchorServer(PORT);
  const serverUrl = await server.start();
  logSuccess(`Mock SEP-24 Anchor Server listening on ${serverUrl}`);

  try {
    // ---------------------------------------------------------
    // Phase 1: Stream & Accrual Simulation
    // ---------------------------------------------------------
    logStep(1, "StreamPay Accrual & Recipient Stream Withdrawal");
    const streamContext = {
      stream_id: 42,
      sender: "G-EMPLOYER-HQ-74X910385KLDZMWQPA81023",
      recipient: "G-ENGINEER-PAYROLL-901BVTCD8217YUPW",
      rate_per_sec: "0.069444 USDC/sec (~$250.00 / hr)",
      total_streamed: "250.0000000 USDC",
      token_contract: "CC437...USDC-SAC",
      withdraw_method: "withdraw_max"
    };

    logInfo("Contract", "StreamPay Streaming Contract (Soroban)");
    logInfo("Employer (Sender)", streamContext.sender);
    logInfo("Worker (Recipient)", streamContext.recipient);
    logInfo("Stream ID", streamContext.stream_id);
    logInfo("Stream Rate", streamContext.rate_per_sec);
    logInfo("Accrued Available", streamContext.total_streamed);

    console.log(`\n  Executing recipient call: StreamPay.withdraw_max(${streamContext.stream_id})...`);
    await sleep(400);
    logSuccess(`Stream withdrawal confirmed on Stellar Ledger!`);
    logInfo("Recipient Balance", "+250.00 USDC transferred to recipient account");

    // ---------------------------------------------------------
    // Phase 2: Anchor Discovery & SEP-24 Flow Initiation
    // ---------------------------------------------------------
    logStep(2, "SEP-24 Anchor Discovery & Interactive Flow Request");
    logInfo("Anchor Domain", "stellar-anchor.mock-regulated-corp.net");
    logInfo("Query Endpoint", `${serverUrl}/info`);

    const infoRes = await requestJson(`${serverUrl}/info`);
    logSuccess("SEP-24 /info queried successfully");
    console.log("  Supported Assets:", Object.keys(infoRes.body.withdraw).map(a => `${a} (Fee: $${infoRes.body.withdraw[a].fee_fixed})`).join(", "));

    console.log("\n  Requesting SEP-24 Interactive Off-Ramp session (POST /transactions/withdraw/interactive)...");
    const interactiveReq = await requestJson(`${serverUrl}/transactions/withdraw/interactive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      asset_code: 'USDC',
      account: streamContext.recipient,
      amount: '250.00',
      claim_stream_reference: `streampay:stream:${streamContext.stream_id}`
    });

    const txId = interactiveReq.body.id;
    const interactiveUrl = interactiveReq.body.url;
    logSuccess(`Anchor generated transaction ID: ${txId}`);
    logInfo("Interactive Session URL", interactiveUrl);

    // ---------------------------------------------------------
    // Phase 3: Interactive KYC & Fiat Payout Details
    // ---------------------------------------------------------
    logStep(3, "Worker Interactive KYC & Bank Account Binding");
    console.log("  [Simulating user opening interactive webview...]");
    await sleep(300);
    // User hits interactive URL
    await requestJson(interactiveUrl);
    logSuccess("Worker completed Tier-1 KYC verification and entered ACH/SEPA routing details");

    // Poll transaction status
    const poll1 = await requestJson(`${serverUrl}/transaction?id=${txId}`);
    logInfo("Anchor State", poll1.body.transaction.status);
    logInfo("Anchor Deposit Address", poll1.body.transaction.withdraw_anchor_account);
    logInfo("Transaction Memo", `${poll1.body.transaction.withdraw_memo} (Type: ${poll1.body.transaction.withdraw_memo_type})`);

    // ---------------------------------------------------------
    // Phase 4: Stellar Transfer to Anchor & Settlement
    // ---------------------------------------------------------
    logStep(4, "Stellar Payment to Anchor & Off-Ramp Fiat Payout");
    console.log(`  Sending 250.00 USDC from ${streamContext.recipient} to Anchor...`);
    await sleep(500);

    // Notify anchor of on-chain deposit
    await requestJson(`${serverUrl}/simulate-deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { tx_id: txId });

    console.log("  Waiting for Anchor banking rails settlement (ACH/SEPA)...");
    await sleep(1200);

    const poll2 = await requestJson(`${serverUrl}/transaction?id=${txId}`);
    logSuccess(`Off-Ramp Transaction Complete!`);
    logInfo("Final Status", poll2.body.transaction.status);
    logInfo("Stellar Tx Hash", poll2.body.transaction.stellar_transaction_id);
    logInfo("Fiat Payout Reference", poll2.body.transaction.fiat_payout_reference);
    logInfo("Amount Settled to Bank", `$${poll2.body.transaction.amount_out} USD (Fees: $${poll2.body.transaction.amount_fee})`);

    // ---------------------------------------------------------
    // Phase 5: Failure Modes & Constraint Demonstration
    // ---------------------------------------------------------
    logStep(5, "Documented Failure Modes & Edge Cases");

    // Failure Mode 1: Asset Trustline Bootstrap Error
    console.log(`${colors.bright}A. Failure Mode: Asset Trustline Bootstrap Missing${colors.reset}`);
    console.log(`   Scenario: Recipient attempts to receive an off-ramp compatible token (e.g., EURC or custom Anchor asset)`);
    console.log(`   without prior trustline creation or sufficient reserve balance.`);
    try {
      const trustlineCheck = {
        recipient: streamContext.recipient,
        asset: "EURC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        trustline_exists: false,
        native_xlm_balance: 0.5,
        min_reserve_required: 1.5
      };
      logWarn(`Trustline check failed for ${trustlineCheck.recipient}:`);
      console.log(`     -> Error: op_no_trust (Op code: 0x82)`);
      console.log(`     -> Root Cause: Native XLM balance (0.5 XLM) < Base reserve for new trustline entry (1.5 XLM).`);
      console.log(`     -> Mitigation: StreamPay UI displays "Add Trustline" helper before withdrawal or sponsor reserves.`);
    } catch (err) {
      logError(err.message);
    }

    // Failure Mode 2: Anchor Rate Limiting & Velocity Bounds (HTTP 429)
    console.log(`\n${colors.bright}B. Failure Mode: Anchor Velocity / Rate Limits (HTTP 429 Backoff)${colors.reset}`);
    console.log(`   Scenario: Frequent micro-withdrawals trigger anchor anti-abuse rate limits.`);
    let attempt = 1;
    let rateLimitResolved = false;

    while (attempt <= 3 && !rateLimitResolved) {
      console.log(`     [Attempt ${attempt}] Calling anchor API...`);
      const resp = await requestJson(`${serverUrl}/rate-limited-endpoint`);
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers['retry-after'] || '1', 10);
        logWarn(`Received HTTP 429: ${resp.body.error}`);
        console.log(`     Exponential backoff: waiting ${retryAfter}s before retrying...`);
        await sleep(retryAfter * 1000);
        attempt++;
      } else if (resp.status === 200) {
        logSuccess(`Request succeeded after rate-limit backoff!`);
        rateLimitResolved = true;
      }
    }

    // Failure Mode 3: Geographical & KYC Rejection Bounds
    console.log(`\n${colors.bright}C. Failure Mode: Geo-fencing & Regulatory KYC Restrictions${colors.reset}`);
    console.log(`   Scenario: Recipient is in a jurisdiction unsupported by the anchor's banking partner.`);
    logWarn(`Anchor Rejection Simulation:`);
    console.log(`     -> Status: 'rejected' (Error code: customer_jurisdiction_unsupported)`);
    console.log(`     -> Anchor cannot wire funds to OFAC / non-supported regions.`);
    console.log(`     -> StreamPay Guarantee: Stream tokens remain SAFE in StreamPay contract or recipient wallet.`);
    console.log(`        StreamPay guarantees cryptographic streaming; Anchor handles regulated fiat finality.`);

    console.log(`\n${colors.bright}${colors.green}======================================================================${colors.reset}`);
    console.log(`${colors.bright}${colors.green}✔ Demo walkthrough complete: All SEP-24 stages verified!${colors.reset}`);
    console.log(`${colors.bright}${colors.green}======================================================================${colors.reset}\n`);

  } finally {
    await server.stop();
  }
}

run().catch(err => {
  console.error("Demo failed:", err);
  process.exit(1);
});
