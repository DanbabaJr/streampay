# 📊 StreamPay Protocol Benchmark: Cross-Chain Streaming Comparison

A public, reproducible, and verifiable performance benchmark comparing **StreamPay** (Stellar / Soroban) against **Sablier V2** (Ethereum / Arbitrum) and **Superfluid CFA** (Polygon / Arbitrum / Ethereum) across the four primary economic and architectural axes that govern payment streaming systems:

1. **Storage Bytes per Stream**: On-chain persistent footprint per stream instance.
2. **Cost per Second of Stream Life**: Ongoing state rent vs perpetual state storage vs buffer capital lockup.
3. **Claim Cost**: Receiver withdrawal invocation overhead (CPU instructions, gas units, and transaction fees).
4. **Cancel Cost**: Premature settlement, unaccrued deposit refunds, and contract teardown.

---

## 🎯 1. Summary Comparison Matrix

All figures reflect canonical contract executions on active test suites and audited mainnet deployments.

| Metric | StreamPay (Stellar) | Sablier V2 (Arbitrum L2) | Sablier V2 (Ethereum L1) | Superfluid CFA (Arbitrum L2) | Superfluid CFA (Ethereum L1) |
|---|---:|---:|---:|---:|---:|
| **Execution Model** | Soroban WASM (Rust) | EVM (Solidity) | EVM (Solidity) | EVM (Solidity) | EVM (Solidity) |
| **Escrow Design** | Discrete Escrow | Discrete Escrow (ERC-721) | Discrete Escrow (ERC-721) | Continuous Flow (Dynamic) | Continuous Flow (Dynamic) |
| **Storage Bytes / Stream** | **484 B** (1 entry) | **128 B** (4 slots) | **128 B** (4 slots) | **128 B** (4 slots) | **128 B** (4 slots) |
| **Cost / Second of Life** | **0.968 stroops/s** (~$0.030/mo) | **$0.00 / s** | **$0.00 / s** | **$0.00 / s** (+ buffer lock) | **$0.00 / s** (+ buffer lock) |
| **Create Stream Fee** | **0.000350 XLM** (~$0.000042) | **218,450 gas** (~$0.0655) | **218,450 gas** (~$13.11) | **174,800 gas** (~$0.0524) | **174,800 gas** (~$10.49) |
| **Claim Cost (1 Claim)** | **0.000245 XLM** (~$0.000029) | **59,320 gas** (~$0.0178) | **59,320 gas** (~$3.56) | **0 gas** (Passive flow) | **0 gas** (Passive flow) |
| **Cancel Cost** | **0.000320 XLM** (~$0.000038) | **84,150 gas** (~$0.0252) | **84,150 gas** (~$5.05) | **78,600 gas** (~$0.0236) | **78,600 gas** (~$4.72) |
| **Claim CPU / Gas** | **384,170 CPU** | **59,320 Gas** | **59,320 Gas** | **0 Gas** (52k to unwrap) | **0 Gas** (52k to unwrap) |
| **30-Day Stream (4 Claims)** | **$0.0303 total** | **$0.1619 total** | **$32.40 total** | **$0.1110 total** | **$15.21 total** |
| **30-Day Stream (30 Claims)**| **$0.0311 total** | **$0.6247 total** | **$124.96 total** | **$0.0820 total** | **$15.21 total** |

*Economic assumptions: ETH = $3,000; XLM = $0.12; L1 gas = 20 gwei; Arbitrum L2 gas = 0.1 gwei; Stellar base fee = 100 stroops.*

---

## ⚖️ 2. Cross-Chain Honesty & Normalization

A credible benchmark must acknowledge that **EVM gas units and Soroban CPU instructions cannot be compared 1:1**, because each chain operates under an fundamentally different resource allocation and metering philosophy.

### What is Comparable

1. **User-Experienced Economic Cost**: Real-world transaction and maintenance costs denominated in USD across typical market conditions (L1 gas vs L2 gas vs Stellar base/resource fees).
2. **Operational Frequency Sensitivity**: How total costs scale as stream frequency, duration, and claim cadences increase.
3. **Escrow Solvency & Capital Requirements**: Whether 100% principal is locked upfront (StreamPay, Sablier) versus relying on buffer deposits and liquidation sentinels (Superfluid).

### What is NOT Comparable

1. **EVM Gas vs Soroban Instructions**:
   - EVM gas is a synthetic aggregate metric bundling CPU execution, memory allocation, and permanent disk writes into a single scalar, heavily distorted by arbitrary 20,000-gas SSTORE cliffs.
   - Soroban meters each dimension orthogonally: CPU instructions (100M transaction limit), memory bytes, read/write ledger entries, and serialized read/write bytes are priced separately according to actual node hardware cost.
2. **State Rent vs Perpetual State Bloat**:
   - **Ethereum & EVM Chains**: Storage is perpetual. Once written via `SSTORE`, a storage slot remains in state indefinitely without paying ongoing rent. The protocol compensates by punishing creation with high gas costs (~80,000 gas for 4 new slots).
   - **Stellar / Soroban**: Employs **State Archival**. State is not free: every persistent ledger entry pays rent proportional to its size and duration in ledgers (1 ledger ~ 5 seconds). If rent is exhausted, state is archived. StreamPay automatically extends TTL by 500,000 ledgers (~29 days) on creation and on every touch (claims, top-ups, cancels), shielding users from archival risk while honoring the ledger's true operational cost.
3. **Discrete Linear Escrow vs Continuous Differential Flow**:
   - Sablier and StreamPay lock 100% of the stream's deposit upfront. Insolvency is mathematically impossible, but claims require explicit on-chain transactions.
   - Superfluid shifts balances continuously via a differential accumulator (`balanceOf(t) = static + flowRate * dt`). Receivers experience **zero-gas claims**, but senders must lock a 4-hour liquidation buffer deposit and are exposed to bot liquidation if their wallet balance is depleted.

---

## 🔬 3. Inline Measurement Methodology

### StreamPay (Soroban)
- **Measurement Tool**: Built-in Soroban SDK cost meter: `env.cost_estimate().budget().cpu_instruction_cost()` and `memory_bytes_cost()`.
- **Harness Source**: [`contracts/streaming-payments/examples/protocol_benchmark.rs`](../contracts/streaming-payments/examples/protocol_benchmark.rs)
- **Rent Rate Formula**:
  $$\text{Rent Stroops / Second} = \text{Entry Bytes} \times \text{Rate} \times \frac{1}{\text{Seconds per Ledger}}$$
  Where $\text{Entry Bytes} = 484\text{ B}$, $\text{Rate} = 0.01\text{ stroops/byte/ledger}$, and $\text{Seconds per Ledger} = 5.0\text{ s}$:
  $$\text{Rent} = 484 \times 0.01 \times 0.2 = 0.968\text{ stroops/second} = 0.0000000968\text{ XLM/second}$$
  Monthly cost (30 days): $0.968 \times 86{,}400 \times 30 = 2{,}509{,}056\text{ stroops} \approx 0.2509\text{ XLM} \approx \$0.0301\text{ USD}$.

### Sablier V2 (Lockup Linear)
- **Source**: `sablier-labs/v2-core` (commit `3eb3cfa`, May 2023).
- **Measurement Tool**: Foundry `forge test --gas-report` against `SablierV2LockupLinear.sol` test suite.
- **Mainnet Deployments**:
  - Ethereum Mainnet: `0xAFb9797282b35606d649B25A775C17f920272B6c`
  - Arbitrum One: `0x2C460eb3aAadAd3c8e54736fdf5A5B63402cf894`
- **Audits**: Cantina (May 2023), Code4rena (June 2023).

### Superfluid CFAv1
- **Source**: `superfluid-finance/protocol-monorepo` (`contracts/agreements/ConstantFlowAgreementV1.sol`).
- **Measurement Tool**: Hardhat gas reporter & published technical specifications (dated March 2024).
- **Deployments**:
  - CFAv1 Proxy: `0xEd6B5CD325f0F6E6705775a644b50997FAae61a8` (Ethereum, Arbitrum, Polygon).
- **Buffer Mechanism**: Minimum 4 hours of flow locked as liquidation buffer collateral.

---

## 🛠️ 4. How to Reproduce Locally

Anyone can re-run the Soroban measurement harness on any machine and obtain identical numbers:

```bash
# 1. Run the Soroban protocol measurement executable
cargo run -p streampay-contract --example protocol_benchmark

# 2. Output raw JSON metrics
cargo run -p streampay-contract --example protocol_benchmark -- --json

# 3. Re-run harness and update benchmark data
npm run benchmark:measure

# 4. Run CI regression verification gate
npm run benchmark:verify
```

---

## 📢 5. Methodology Dispute & Contribution Policy

The methodology and competitor reference numbers in this benchmark are open for public dispute and refinement.

If you believe any competitor gas figure, storage estimation, or calculation parameter can be improved:
1. Open an issue or pull request titled `benchmark: dispute <competitor or metric>`.
2. Provide a deterministic reproduction script (Foundry test, Hardhat trace, or block explorer transaction hash).
3. Update `benchmarks/data/competitors.json` with the citation, date, and verified transaction link.
4. All approved dispute PRs will be merged and deployed directly to the live dashboard.
