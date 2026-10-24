# ⚡ StreamPay Testnet Demo Walkthrough

This guide walks you through the complete lifecycle of a continuous, per-second payment stream on Stellar Testnet: from account creation and contract deployment to stream creation, live accrual monitoring, recipient withdrawals, and pro-rata cancellation.

You can run the entire workflow automatically with one script, or follow the step-by-step manual instructions below.

---

## Architecture & Lifecycle Overview

```text
 1. Setup & Deposit Approval
    Sender approves StreamPay contract on SAC Token
    Token.approve(spender = Contract, amount = Deposit)
             │
 2. Stream Creation
    create_stream(sender, recipient, token, deposit, start, end, cancelable)
    Contract pulls deposit; status = Active; stream_id = 1
             │
 3. Continuous Accrual
    Linear per-second release: streamed(t) = deposit × elapsed / duration
    Public read: available(stream_id)
             │
 4. Claim / Withdrawal
    Recipient calls withdraw_max(stream_id)
    Contract transfers accrued tokens to recipient; withdrawn updated
             │
 5. Pro-Rata Cancellation
    Sender or Recipient calls cancel_stream(caller, stream_id)
    Atomic split: Recipient ← accrued balance, Sender ← unaccrued remainder
    Stream status = Cancelled
```

---

## Prerequisites

Before starting, ensure your system has the following tools installed:

1. **Rust Toolchain** ($\ge$ 1.85):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup target add wasm32v1-none
   ```
2. **Stellar CLI** ($\ge$ 28.1.0):
   ```bash
   cargo install stellar-cli --locked
   stellar --version
   ```
3. **cURL**:
   Required for communicating with Friendbot and Horizon REST endpoints.
4. **OpenSSL** ($\ge$ 1.1.1):
   Required to verify the signed release attestation before deploying. Preinstalled
   on most systems; `openssl version` to check.
5. **Node.js** ($\ge$ 20, optional for frontend):
   Required only if running the Next.js web application.

---

## Option A: One-Command Quickstart

To build the Wasm, **prove it against a signed release attestation**, fund
identities, deploy the contract, create a custom demo asset, and open a live
1-hour stream in a single command:

```bash
./scripts/deploy_testnet.sh
```

### The deployment gate

Nothing is deployed until the bytes have been proven — a public chain cannot
un-deploy, so verification happens *before* the transaction, never after. The
script runs
[`scripts/verify_wasm.sh`](../scripts/verify_wasm.sh), which recomputes the
Wasm digest, fetches the signed attestation for the release, verifies the
Ed25519 signature against the public key pinned in your own checkout, and
confirms the attestation names the bytes you hold. See
[`ATTESTATION.md`](./ATTESTATION.md) for what that does and does not prove.

If you are demoing **unreleased** work, no attestation describes it and the gate
correctly refuses. Say so deliberately rather than silently:

```bash
# Deploy the published, provable artifact instead of your local build
gh release download v0.5.0 --pattern 'streampay_contract.wasm' --dir /tmp
CONTRACT_WASM=/tmp/streampay_contract.wasm ./scripts/deploy_testnet.sh

# Verify against a specific release tag
WASM_ATTESTATION_TAG=v0.5.0 ./scripts/deploy_testnet.sh

# Deploy unproven local work to testnet, knowingly (recorded in the summary)
SKIP_WASM_ATTESTATION=1 ./scripts/deploy_testnet.sh
```

### Expected Terminal Output:

```text
==> Checking prerequisites
    stellar CLI: stellar 28.1.0 (c0f4d0da891bbf214c08b8c5035ae6db80e9a3bd)
    cargo: cargo 1.99.1 (5f94df478 2026-08-27)
    Identity 'deployer' (GBUQNYE74F2UKN3J5N2K...) is funded.

==> Building contract Wasm
    Wasm binary ready at: target/wasm32v1-none/release/streampay_contract.wasm

==> Verifying the Wasm against a signed release attestation
    no WASM_ATTESTATION_TAG set — resolving the latest published release

==> StreamPay Wasm attestation check
    artifact : target/wasm32v1-none/release/streampay_contract.wasm
    sha256   : 7f3c1e9b...  (184320 bytes)
    attestation: release asset: Neziahtech/streampay@v0.5.0
    signature  : valid (key attestations/signing-key.pub)
    digest     : matches the attested wasm_sha256
============================================================
  ATTESTATION VERIFIED — this Wasm is the signed release build
============================================================

==> Deploying or verifying contract on testnet
    Deploying new contract to testnet (governor: GBUQNYE74F2UKN3J5N2K...)
    Contract deployed successfully: CA3D52RZWTGQ7DCU5E7JNKDMXY5L4N6ZQRJ4V7W5KLMNOPTUVWXYZA

==> Preparing demo actors (sender & recipient)
    Identity 'sender' (GD3K5V2X6M7N...) is funded.
    Identity 'recipient' (GC7F4R8Q9S1T...) is funded.

==> Preparing demo SAC asset
    Identity 'demo_issuer' (GA1B2C3D4E5F...) is funded.
    Creating demo asset DEMO8421 with issuer GA1B2C3D4E5F...
    Demo token address: CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
    Minting 1,000,000,000 units to sender (GD3K5V2X6M7N...)

==> Approving streaming contract as spender
==> Creating demo stream (1 hour, cancelable)
    Stream created successfully: #1

==> Verifying stream accrual

==================================================================
  ⚡ StreamPay Testnet Demo Stream #1 is Live!
==================================================================

  Contract ID   : CA3D52RZWTGQ7DCU5E7JNKDMXY5L4N6ZQRJ4V7W5KLMNOPTUVWXYZA
  Stream ID     : 1
  Token Address : CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
  Available Now : 277777 units
...
```

The script is **idempotent-ish**: if you re-run it with pre-existing or cached identities, it detects the active contract and stream and reuses them safely.

---

## Option B: Step-by-Step Manual Walkthrough

### Step 1: Generate & Fund Keypairs

Generate separate identities for the governor/deployer, sender, recipient, and demo token issuer:

```bash
stellar keys generate deployer    --network testnet
stellar keys generate sender      --network testnet
stellar keys generate recipient   --network testnet
stellar keys generate demo_issuer --network testnet
```

Fund each identity via Stellar Friendbot:

```bash
for actor in deployer sender recipient demo_issuer; do
  addr=$(stellar keys address "$actor" | tr -d '\r')
  echo "Funding $actor ($addr)..."
  curl -s "https://friendbot.stellar.org?addr=$addr" >/dev/null
done
```

**Verification:**
Query the Horizon testnet endpoint to confirm the accounts exist:
```bash
curl -sf "https://horizon-testnet.stellar.org/accounts/$(stellar keys address sender | tr -d '\r')" | grep -q "id" && echo "Sender funded OK"
```

---

### Step 2: Build, Verify & Deploy the Contract

Build the contract Wasm targeting `wasm32v1-none`:

```bash
cd contracts/streaming-payments
stellar contract build
cd ../..
```

**Verify before you deploy.** A Soroban contract is immutable at its address and
cannot be un-deployed, so the bytes have to be proven first, not reviewed after.
This recomputes the digest, fetches the signed attestation, checks the Ed25519
signature against the key pinned in your checkout, and confirms the attestation
describes the Wasm you are holding:

```bash
scripts/verify_wasm.sh target/wasm32v1-none/release/streampay_contract.wasm \
  --tag v0.5.0 --require-repro
```

Expect `ATTESTATION VERIFIED`, exit status `0`. **Do not deploy on any other
result** — a `DIGEST MISMATCH` or a failed signature means the bytes you are
about to put on chain are not the bytes that were reviewed and signed. If you
are walking through this on unreleased local code, no attestation describes it;
reproduce the build yourself instead of deploying blind:

```bash
scripts/reproducible_build.sh --ref v0.5.0
```

Deploy the contract to testnet. The constructor binds the treasury governor at deploy time:

```bash
DEPLOYER=$(stellar keys address deployer | tr -d '\r')

CONTRACT=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/streampay_contract.wasm \
  --source deployer --network testnet \
  -- --governor "$DEPLOYER" | tail -n 1 | tr -d '\r')

echo "Contract ID: $CONTRACT"
```
`create_stream` pulls the deposit through this allowance — without it the
pull fails with `DepositTransferFailed` (#26): token-side failures are mapped
to distinct StreamPay codes, so a token's own error number can never
masquerade as one.

**Expected Terminal Output:**
```text
Contract ID: CA3D52RZWTGQ7DCU5E7JNKDMXY5L4N6ZQRJ4V7W5KLMNOPTUVWXYZA
```

**Verification:**
Test liveness by calling `total_streams` (read-only):
```bash
stellar contract invoke --id "$CONTRACT" --source deployer --network testnet -- total_streams
```
Expected output: `0`

---

### Step 3: Register Demo Asset & Approve Contract

Soroban interacts with classic Stellar assets through Stellar Asset Contracts (SAC). Create a custom asset, mint tokens to the sender, and approve the streaming contract to transfer deposit tokens.

```bash
ISSUER=$(stellar keys address demo_issuer | tr -d '\r')
SENDER=$(stellar keys address sender | tr -d '\r')
RECIPIENT=$(stellar keys address recipient | tr -d '\r')

# 1. Create SAC demo asset
SALT=$(date +%s%N | cut -c1-32)
TOKEN=$(stellar contract asset create \
  --source demo_issuer --network testnet \
  --issuer "$ISSUER" \
  --max-alpha4 "DEMO" \
  --amount 1000000000 \
  --salt "$SALT" | tail -n 1 | tr -d '\r')

echo "Token Address: $TOKEN"

# 2. Mint 1,000,000,000 units (100.0 DEMO tokens with 7 decimals) to sender
stellar contract invoke \
  --id "$TOKEN" --source demo_issuer --network testnet \
  -- mint --to "$SENDER" --amount 1000000000

# 3. Approve the StreamPay contract to pull deposit
stellar contract invoke \
  --id "$TOKEN" --source sender --network testnet \
  -- approve --spender "$CONTRACT" --amount 1000000000 --expiration_ledger +5000
```

**Verification:**
Check the sender's token balance:
```bash
stellar contract invoke --id "$TOKEN" --source sender --network testnet -- balance --id "$SENDER"
```
Expected output: `1000000000`

---

### Step 4: Create the Payment Stream

Open a 1-hour linear payment stream of 100 DEMO tokens (`1000000000` stroops) to the recipient:

```bash
NOW=$(date +%s)
END=$((NOW + 3600))

STREAM_ID=$(stellar contract invoke \
  --id "$CONTRACT" --source sender --network testnet \
  -- create_stream \
     --sender "$SENDER" \
     --recipient "$RECIPIENT" \
     --token "$TOKEN" \
     --deposit_amount 1000000000 \
     --start_time "$NOW" \
     --end_time "$END" \
     --cancelable true | tail -n 1 | tr -d '\r')

echo "Stream ID: $STREAM_ID"
```

**Expected Terminal Output:**
```text
Stream ID: 1
```

**Verification:**
Inspect the stream data stored on-chain:
```bash
stellar contract invoke --id "$CONTRACT" --source sender --network testnet -- get_stream --stream_id 1
```
Expected output:
```json
{
  "cancelable": true,
  "deposit": 1000000000,
  "end_time": 1740003600,
  "id": 1,
  "recipient": "GC7F4R8Q9S1T...",
  "sender": "GD3K5V2X6M7N...",
  "start_time": 1740000000,
  "status": "Active",
  "token": "CDLZFC3SYJYD...",
  "withdrawn": 0
}
```

---

### Step 5: Monitor Accrual

Accrual accumulates linearly per second:
$$\text{streamed}(t) = \text{deposit} \times \frac{\min(now, end\_time) - start\_time}{end\_time - start\_time}$$
$$\text{available}(t) = \text{streamed}(t) - \text{withdrawn}$$

Query accrued funds available to withdraw:
```bash
stellar contract invoke --id "$CONTRACT" --source sender --network testnet -- available --stream_id 1
```

**Expected Terminal Output:**
```text
277777
```
*(Increases by ~277,777 units every second: 1,000,000,000 / 3,600)*

---

### Step 6: Recipient Claim (`withdraw` & `withdraw_max`)

The recipient can withdraw accrued tokens at any time.
### 9. Scheduled intent + keeper

Pre-authorize a one-shot stream that a keeper materializes for you. The sender
approves the escrow exactly as in §3 (here `deposit + fee`), then schedules it:

```bash
NOW=$(date +%s)
stellar contract invoke --id $CONTRACT --source sender --network testnet -- \
  schedule_stream \
    --sender $SENDER --recipient $RECIPIENT --token $TOKEN \
    --deposit_amount 1000000 --start_time $((NOW + 60)) --end_time $((NOW + 3660)) \
    --cancelable true --interval 0 --occurrences 1 --fee_budget 100000 \
    --execute_after $NOW --expires_at $((NOW + 300))
```

Expected output: the intent id (`1`). Inspect it with `get_intent --intent_id 1`
— `status: Pending`, `occurrences_remaining: 1`.

Run the reference keeper against it (it simulates before sending):

```bash
CONTRACT_ID=$CONTRACT ONCE=1 INTENTS="1" ./scripts/keeper.sh
```

Expected: the keeper reports the intent as executable, sends the call, and the
fee is paid to the keeper. `get_intent --intent_id 1` now shows
`status: Executed`; the created stream id is in the `ScheduledStreamExecuted`
event and appears in `recipient_streams` / `sender_streams`.

For a **recurring** intent, set `--occurrences 3 --interval 86400` (three daily
streams) and the keeper will execute each occurrence as it comes due. See
[`SCHEDULED_INTENTS.md`](./SCHEDULED_INTENTS.md) for the timing model, the
keeper economics, and the threat model.

### 10. (Optional) Protocol fees + public verification

Fees are off by default. The governor (the deployer in this demo) can
configure ten basis points on new streams:

#### Option 1: Partial Withdrawal
Withdraw a specific amount:
```bash
stellar contract invoke --id "$CONTRACT" --source recipient --network testnet -- \
  withdraw --stream_id 1 --amount 100000
```

#### Option 2: Full Atomic Withdrawal (`withdraw_max`)
Withdraw all currently accrued funds in a single transaction:
```bash
stellar contract invoke --id "$CONTRACT" --source recipient --network testnet -- \
  withdraw_max --stream_id 1
```

**Expected Terminal Output:**
```text
555554
```

**Verification:**
1. Check recipient's token balance:
   ```bash
   stellar contract invoke --id "$TOKEN" --source recipient --network testnet -- balance --id "$RECIPIENT"
   ```
   *Expected: Matches total withdrawn units.*
2. Check `available` immediately after:
   ```bash
   stellar contract invoke --id "$CONTRACT" --source recipient --network testnet -- available --stream_id 1
   ```
   *Expected: Near 0 (only 1–2 seconds of elapsed accrual).*

---

### Step 7: Pro-Rata Stream Cancellation (`cancel_stream`)

If the stream is created with `cancelable: true`, either the sender or the recipient can cancel it. The contract atomically executes a fair pro-rata split:
- **Recipient** receives all accrued but unwithdrawn funds.
- **Sender** receives an instant refund of all unaccrued deposit tokens.

```bash
stellar contract invoke --id "$CONTRACT" --source sender --network testnet -- \
  cancel_stream --caller "$SENDER" --stream_id 1
```

**Verification:**
1. Check stream status:
   ```bash
   stellar contract invoke --id "$CONTRACT" --source sender --network testnet -- get_stream --stream_id 1
   ```
   Expected output field: `"status": "Cancelled"`
2. Verify token balances:
   The sender's balance is refunded the unaccrued remainder, and the recipient holds all earned tokens. Total tokens across sender + recipient equal the initial 1,000,000,000 units.

---

### Step 8: Discovery via Address Indexes

StreamPay maintains on-chain append-only indexes for user streams without requiring an external indexer:

### 10. (Optional) Gas sponsorship — claim for free

Continue from the demo stream (`recipient` still holds no XLM for fees in a
fresh wallet; that is exactly the case sponsorship solves).

1. **Sponsor registers a budget** — the sponsor account funds its own gas
   and bounds exposure (here: 500 M units per 1-hour window, 50 M per
   beneficiary):

   ```bash
   stellar keys generate sponsor --network testnet
   curl "https://friendbot.stellar.org?addr=$(stellar keys address sponsor)"
   stellar contract invoke --id $CONTRACT --source sponsor --network testnet -- \
     register_sponsor --sponsor $(stellar keys address sponsor) --token $TOKEN \
     --per_period_limit 500000000 --per_beneficiary_limit 50000000 \
     --window_seconds 3600 --operator_key <64-hex ed25519 pk>
   ```

2. **Beneficiary enrolls a consent key** (one-time, paid by the beneficiary;
   the frontend does this via `enroll_beneficiary` with a generated
   ed25519 keypair stored in `localStorage`):

   ```bash
   stellar contract invoke --id $CONTRACT --source recipient --network testnet -- \
     enroll_beneficiary --beneficiary $(stellar keys address recipient) \
     --public_key <32-hex ed25519 pk>
   ```

3. **Relay the claim.** Any funded account can submit; both signatures are
   over the SHA-256 digest of the canonical message (see
   `docs/ARCHITECTURE.md` §13.2 — the parity vectors in
   `sponsor_test.rs` / `lib/sponsor.test.ts` pin the exact bytes):

   ```bash
   stellar contract invoke --id $CONTRACT --source anyone --network testnet -- \
     sponsored_withdraw --sponsor $SPONSOR --beneficiary $RECIPIENT \
     --stream_id 1 --amount 1000000 --nonce 1 --deadline <unix+300> \
     --operator_sig <64-hex> --beneficiary_sig <64-hex>
   ```

   Expected: recipient is paid 1 000 000 units, the sponsor's window spend
   grows by the same amount (`sponsor_period_spend`), and resubmitting the
   identical call fails with `ClaimNonceReplay` (53). In the frontend this
   whole step is the **Claim for free** button POSTing
   `{ intent, beneficiarySig }` to the operator relay.

> **Status:** steps 1–3 are the scripted runbook for this feature; the
> signature generation was verified end-to-end against the frozen wire
> vectors in both test suites, but a live testnet run with a screenshot was
> **not** captured for this PR — it needs a deployed contract, a funded
> sponsor and a running relay, which the CI environment does not have.
> `scripts/deploy_testnet.sh` + `npm run dev` reproduce the self-paid demo
> today; the sponsored path follows the steps above once deployed.

## Frontend

```bash
cd frontend
cp .env.example .env.local   # paste the contract id (+ sponsor/relay vars for §10)
npm ci && npm run dev
```

Connect Freighter (testnet network), import the `sender` seed
(`stellar keys show sender`) or use any funded testnet account, and create
streams from the form. The stream list persists across reloads; each row
links to `/stream/<id>` with a live `available` read and one-click
**Withdraw max** — or, when a sponsor covers the stream's token
(`NEXT_PUBLIC_SPONSOR_ADDRESS` + `NEXT_PUBLIC_SPONSOR_RELAY_URL`),
**Claim for free**: the page shows who pays the network fee and how much of
the sponsor budget remains before signing the claim intent.
# Streams where an account is the recipient
stellar contract invoke --id "$CONTRACT" --source anyone --network testnet -- \
  recipient_streams --recipient "$RECIPIENT" --offset 0 --limit 50

# Streams where an account is the sender
stellar contract invoke --id "$CONTRACT" --source anyone --network testnet -- \
  sender_streams --sender "$SENDER" --offset 0 --limit 50
```

**Expected Terminal Output:**
```text
[1]
```

---

## Frontend Integration

To view and interact with the stream from the web UI:

1. Update `frontend/.env.local`:
   ```bash
   echo "NEXT_PUBLIC_STREAMING_CONTRACT_ID=$CONTRACT" > frontend/.env.local
   ```
2. Start the development server:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
3. Open `http://localhost:3000` in your browser. Connect the Freighter browser extension (configured to **Testnet**), import your testnet account seed, and view the live streaming dashboard!

---

## Shareable Payment Links — Freelancer Invoice Walkthrough

Freelancers and DAOs can invoice clients with a single shareable link instead of onboarding payers through a manual wallet tutorial:

### 1. Generating a Payment Link
From the stream details page (`/stream/[id]`), click **"Copy Shareable Payment Link"**. This generates a deterministic, privacy-blinded URL:
```text
https://streampay.finance/pay/eyJkIjp7InZlcnNpb24iOjEsInN0cmVhbUlkIjoiNDIiLCJjb250cmFjdEhpbnQiOiJDRExaRkMiLCJibGluZGVkUmVjaXBpZW50IjoiZjNhOGMyYjQxOTg3ZTIxYSIsInNhbHQiOiI4YzkxYjJjMyJ9LCJjIjoiZDc0MmEzYjEifQ
```

### 2. Client Opens Invoice (Zero-Login / Zero-Wallet)
- The client pastes or clicks the link in any browser or messaging app.
- Messaging apps (Slack, Discord, Telegram, Twitter/X) render rich dynamic OpenGraph cards (e.g. `Active Stream — 500 USDC | StreamPay`).
- The link resolves directly against the Stellar network client-side.
- The visitor sees the real-time linear accrual ticker, progress bar, token contract, and stream timeline.
- **Privacy Guaranteed**: The payee's full Stellar public key is never shown in plain text or leaked to URL unfurlers; it remains protected behind a cryptographic commitment.

### 3. Claiming with Freighter
1. The freelancer clicks **"Connect Freighter & Claim"**.
2. Freighter opens to connect the wallet.
3. StreamPay verifies that the connected wallet address matches the blinded commitment.
4. If verified, the **"Claim [Amount] Tokens"** action unlocks.
5. Clicking Claim submits an atomic `withdraw_max` transaction to Stellar Soroban.
6. A verified **Receipt View** appears with the transaction hash and a direct link to Stellar Expert.

---

## Common Errors & Troubleshooting

| Error Code / Message | Cause | Resolution |
|---|---|---|
| `Error(Contract, #1)` (`StreamNotFound`) | Stream ID does not exist, was never created, or storage entry expired. | Check the stream ID using `total_streams` or query `sender_streams`. |
| `Error(Contract, #2)` / `Error(Contract, #11)` (`StreamNotActive`) | Stream is in `Cancelled` or `Completed` status. | Stream has already concluded; check status with `get_stream`. |
| `Error(Contract, #4)` (`DepositNonPositive`) | Deposit amount passed is $\le 0$. | Ensure `deposit_amount` is a positive 128-bit integer. |
| `Error(Contract, #5)` (`StartTimeInPast`) | `start_time` is earlier than current ledger timestamp. | Use current ledger time: `$(date +%s)`. |
| `Error(Contract, #6)` (`InvalidTimeRange`) | `end_time` $\le$ `start_time`. | Ensure `end_time` is strictly after `start_time` (e.g., `NOW + 3600`). |
| `Error(Contract, #7)` (`DurationTooLong`) | Duration exceeds protocol maximum (5 years). | Reduce duration to $\le 157,680,000$ seconds. |
| `Error(Contract, #10)` (`AmountExceedsAvailable`) | `withdraw` requested more than current accrued available amount. | Check `available` first or use `withdraw_max`. |
| `Error(Contract, #12)` (`CancelStreamNotAuthorized`) | Caller is not sender, or caller is recipient on an uncancelable stream. | Verify caller address matches `sender`, or ensure stream was created with `cancelable: true`. |
| `Error(Contract, #13)` (`NothingToWithdraw`) | `withdraw_max` invoked when available balance is 0. | Wait for tokens to accrue over time before calling `withdraw_max`. |
| `HostError` / `Contract, #4` on Token | Missing SAC token allowance. | Ensure sender called `token.approve(spender = CONTRACT, amount = deposit, expiration_ledger = ...)`. |
| Friendbot 429 / 504 | Friendbot rate-limiting or temporary downtime. | Fund account manually via [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=testnet). |
