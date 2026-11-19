# Fiat-Adjacent Off-Ramp Integration Recipe (SEP-24 / SEP-6)

> **Document Status**: Production Architecture Recipe & Prototyping Guide  
> **Target Audience**: Integrators, Payroll Ops, Frontend Engineers building StreamPay payout flows.  
> **Demo Reference Script**: [`scripts/anchor_offramp_demo.js`](../scripts/anchor_offramp_demo.js)

---

## 1. Overview & Objective

This recipe documents and prototypes how StreamPay functions as the **crypto-leg of real-world payroll payouts**.

In a continuous payroll stream:
1. An employer deposits stable assets (e.g., USDC, EURC) into the **StreamPay Soroban smart contract**.
2. Stream balance accrues by the second according to employment contracts.
3. A recipient triggers a stream withdrawal (`withdraw` or `withdraw_max`) landing funds directly into their Stellar account.
4. Through a regulated **Stellar Anchor (SEP-24 / SEP-6)**, those stable assets are routed through traditional banking rails (ACH, SEPA, PIX, Wire) into the recipient's local bank account.

```
+-----------------------------------------------------------------------------------------------------+
|                                          STREAMPAY PROTOCOL (SOROBAN)                               |
|                                                                                                     |
|  [ Employer ] -- (deposit_amount) --> [ StreamPay Contract ] -- (continuous per-sec accrual)       |
+---------------------------------------------------|-------------------------------------------------+
                                                    |
                                      recipient.withdraw_max()
                                                    |
                                                    v
+-----------------------------------------------------------------------------------------------------+
|                                          STELLAR LEDGER (CRYPTO LEG)                                |
|                                                                                                     |
|  [ Recipient Stellar Wallet ] ===== (SEP-24 Stellar Payment) =====> [ Anchor Regulated Account ]    |
+-----------------------------------------------------------------------------|-----------------------+
                                                                              |
                                                            SEP-24 Interactive KYC / Payout Rail
                                                                              |
                                                                              v
+-----------------------------------------------------------------------------------------------------+
|                                          REGULATED BANKING LEG (FIAT)                               |
|                                                                                                     |
|  [ Anchor Clearing Partner ] ===== (Local Rails: ACH / SEPA / Wire) ====> [ Recipient Bank Account ]|
+-----------------------------------------------------------------------------------------------------+
```

---

## 2. Testnet Anchor Landscape & Candidate Status

When integrating or testing off-ramp workflows, the following public testnet anchors implement SEP-24 / SEP-6 / SEP-10:

| Anchor Candidate | Home Domain / Endpoint | SEP-24 / SEP-6 Support | Supported Testnet Currencies | Current Status / Notes |
| :--- | :--- | :--- | :--- | :--- |
| **SDF Reference Anchor** | `testanchor.stellar.org` | SEP-6, SEP-24, SEP-38, SEP-10 | `SRT` (Stellar Reference Token), `USDC` | Active & canonical reference server. Reliable for testing SEP-24 interactive modal frames and simulated KYC approval. |
| **Anclap (Latin America)** | `testnet.anclap.com` | SEP-24, SEP-6 | `ARS`, `BRL`, `COP`, `PEN` | LatAm fiat off-ramp candidate. Periodic testnet maintenance; recommended for regional testing. |
| **MyKobo (Africa / Europe)** | `testnet.mykobo.co` | SEP-24, SEP-38 | `EURC`, `NGN` | SEPA & Nigerian banking rails. Useful for cross-border payroll off-ramp prototypes. |
| **StreamPay Mock Anchor** | Built-in (`scripts/anchor_offramp_demo.js`) | SEP-24 `/info`, `/transactions/withdraw/interactive`, `/transaction` | `USDC`, `EURC` | Local zero-dependency deterministic simulator for CI, offline testing, and error injection. |

---

## 3. End-to-End Payout Lifecycle

### Phase 1: Stream Accrual & Claim
The recipient checks accrued funds using `available(stream_id)` on the StreamPay contract and calls:
```bash
stellar contract invoke \
  --id $STREAMPAY_CONTRACT \
  --source recipient \
  --network testnet \
  -- withdraw_max --stream_id $STREAM_ID
```
Tokens are minted/transferred from the contract escrow into the recipient's Stellar address.

### Phase 2: Anchor Discovery & Service Info
1. The client queries the anchor's `stellar.toml` (located at `https://<anchor-domain>/.well-known/stellar.toml`) to find `TRANSFER_SERVER_SEP0024`.
2. The client checks supported withdrawal corridors via `GET /info`:
```http
GET /info HTTP/1.1
Host: testanchor.stellar.org
```
Response:
```json
{
  "withdraw": {
    "USDC": {
      "enabled": true,
      "fee_fixed": 1.50,
      "fee_percent": 0.1,
      "min_amount": 5.0,
      "max_amount": 10000.0
    }
  }
}
```

### Phase 3: SEP-10 Stellar Authentication
The client authenticates their Stellar account by signing a cryptographic challenge transaction (SEP-10):
```http
GET /auth?account=G_RECIPIENT_ADDRESS HTTP/1.1
```
The Anchor returns a challenge XDR; the client signs it with the recipient's private key and exchanges it for a JWT bearer token.

### Phase 4: Initiate SEP-24 Interactive Off-Ramp
The recipient client submits the off-ramp intent:
```http
POST /transactions/withdraw/interactive HTTP/1.1
Host: testanchor.stellar.org
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json

{
  "asset_code": "USDC",
  "amount": "250.00",
  "account": "G_RECIPIENT_ADDRESS"
}
```
Response:
```json
{
  "type": "interactive_customer_info_needed",
  "url": "https://testanchor.stellar.org/sep24/interactive?transaction_id=tx_948194",
  "id": "tx_948194"
}
```

### Phase 5: Recipient Bank Details & KYC
The frontend opens a secure webview / modal to the returned `url`. The recipient:
- Verifies personal identification (Tier-1 / Tier-2 KYC as mandated by the anchor's regulator).
- Enters bank account coordinates (IBAN / BIC for SEPA, Routing & Account Number for ACH).
- Confirms the transaction fee and estimated settlement ETA.

### Phase 6: On-Chain Transfer to Anchor
Upon modal completion, polling `GET /transaction?id=tx_948194` reports `pending_user_transfer_start` with:
- `withdraw_anchor_account`: Anchor's custody address (e.g., `GDG2P...`)
- `withdraw_memo`: Unique transaction routing memo (e.g., `tx_948194`)
- `withdraw_memo_type`: `text` or `id`

The recipient's wallet executes standard Stellar payment:
```bash
stellar tx send \
  --source recipient \
  --destination $ANCHOR_ACCOUNT \
  --asset USDC:$USDC_ISSUER \
  --amount 250.00 \
  --memo $WITHDRAW_MEMO
```

### Phase 7: Fiat Settlement Finality
The Anchor observes the on-chain payment, updates transaction status to `pending_anchor`, clears funds via local banking rails, and marks status as `completed` with a fiat bank reference ID.

---

## 4. Honest Constraint List: What StreamPay Can & Cannot Guarantee

When pitching or deploying StreamPay as a payroll backbone, clear boundaries between smart contract guarantees and anchor realities are essential:

```
+----------------------------------------------------+----------------------------------------------------+
|             StreamPay Guarantees                   |              Anchor Dependent / Cannot Guarantee   |
+----------------------------------------------------+----------------------------------------------------+
| 1. Second-by-second linear accrual precision       | 1. Fiat bank wire arrival time (ACH/SEPA delays)   |
| 2. Cryptographic non-custodial escrow security     | 2. Anchor KYC / AML verification approval          |
| 3. Unconditional withdrawal rights to on-chain     | 3. Anchor availability & server uptime             |
|    escrow accrued balance                          | 4. FX rate conversion volatility (if non-USD)      |
| 4. Deterministic fee calculation & event logging   | 5. Velocity limits & daily withdrawal caps         |
| 5. Multi-token support (any SEP-41 / SAC token)    | 6. Geographic / sanctions jurisdiction clearance   |
+----------------------------------------------------+----------------------------------------------------+
```

### 1. KYC / AML Jurisdiction Bounds
* **Limitation**: Anchors are licensed Money Services Businesses (MSBs) or financial institutions subject to FinCEN, FATF, and local banking laws. If a recipient resides in an unserviced jurisdiction or fails identity checks, the anchor **will refuse the off-ramp order**.
* **StreamPay Guarantee**: StreamPay never locks or burns recipient funds if an anchor rejects a user. The accrued tokens remain safely on the Stellar ledger in the recipient's non-custodial address or inside the contract unwithdrawn. The recipient may route through an alternative anchor or custody directly.

### 2. Velocity & Ticket Size Limits
* **Limitation**: Anchors impose tiered velocity limits (e.g., maximum $2,000/day for Tier-1 KYC; $50,000/month for Tier-2). Micro-withdrawals (e.g., withdrawing $0.05 every 10 seconds) will trigger anchor rate limits (`HTTP 429 Too Many Requests`) or fixed fee erosion (e.g., paying a $1.50 fixed wire fee on a $2 withdrawal).
* **StreamPay Recommendation**: StreamPay clients should batch off-ramps (e.g., weekly or monthly payout triggers) or educate users on minimum viable off-ramp batches.

### 3. Settlement Delays
* **Limitation**: While Soroban and Stellar achieve finality in 3–5 seconds, traditional fiat clearing systems (ACH, SEPA, SWIFT) take hours to days and operate strictly during banking business days.
* **StreamPay Guarantee**: StreamPay's crypto leg achieves instant on-chain finality. Anchor status polling (`pending_anchor` -> `completed`) must inform the user that banking rails are asynchronous.

---

## 5. Documented Failure Modes & Mitigations

### Failure Mode 1: Asset Trustline Bootstrap Missing
* **Symptom**: When attempting to withdraw a newly streamed asset or swap to an anchor's payout token, transactions fail with `op_no_trust` or Soroban host error `Error(Contract, #XX)`.
* **Root Cause**: Stellar accounts require a trustline entry for any non-native asset. Creating a trustline requires account base reserves (0.5 XLM minimum reserve). If an account is empty or unfunded with XLM, trustline establishment fails.
* **Mitigation**:
  1. StreamPay UI should check recipient trustlines during the onboarding/stream-claim flow.
  2. Implement sponsored reserves (SEP-0029 or Soroban sponsor footprints) where employers sponsor trustline creation reserves for their workforce.

### Failure Mode 2: Anchor Rate Limiting (HTTP 429)
* **Symptom**: Polling the Anchor endpoint during rapid status checks returns `429 Too Many Requests` with a `Retry-After` header.
* **Mitigation**: Clients must implement exponential backoff with jitter and respect the `Retry-After` header returned by the anchor server.

### Failure Mode 3: Memo Omission or Transposition
* **Symptom**: Recipient sends USDC directly to the Anchor's base public key without specifying the unique `withdraw_memo`.
* **Root Cause**: Anchors use pooled custodial Stellar addresses and match incoming transfers to off-ramp orders via memo.
* **Mitigation**: StreamPay client applications must programmatically bundle the transaction payment and freeze manual memo editing when triggering off-ramp payments.

---

## 6. Running the Demo Script

The repository includes a working, zero-dependency demonstration script: [`scripts/anchor_offramp_demo.js`](../scripts/anchor_offramp_demo.js).

### Execution

```bash
# Run standalone mock SEP-24 walkthrough
node scripts/anchor_offramp_demo.js
```

### What the script validates:
1. **Accrual & Claim**: Simulates StreamPay contract accrual and `withdraw_max` balance update.
2. **Anchor Discovery**: Queries mock SEP-24 `/info` endpoint.
3. **Interactive Handshake**: Generates an interactive session URL and simulates KYC & bank account binding.
4. **Deposit & Settlement**: Transfers crypto to Anchor deposit account with verified memo and monitors payout completion (`ACH-SEPA` reference confirmation).
5. **Edge Case Verification**: Executes automated tests for:
   - Trustline bootstrap missing (`op_no_trust`)
   - HTTP 429 rate limit backoff and retry handling
   - Geo-fencing & KYC refusal failure scenarios
