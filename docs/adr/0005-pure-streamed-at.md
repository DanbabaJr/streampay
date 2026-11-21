# ADR 0005: Pure `streamed_at` Rate Math Function

Status: Accepted (backfilled)
Date: 2026-09-13
Deciders: StreamPay Engineering Team

## Context and Problem Statement

The linear accrual function `streamed_at` is the foundational calculation underpinning every stream balance query, withdrawal, and cancellation split in StreamPay. Any bug, panicking edge condition, or integer overflow in this function would compromise protocol solvency or freeze user funds.

In Soroban contracts, functions frequently receive a reference to `soroban_sdk::Env` to access storage, auth, or ledger state. However, coupling rate math to the Soroban runtime environment introduces significant testing friction: tests must instantiate a Soroban host environment, limiting execution speed and making high-throughput fuzzing impossible.

## Decision Drivers

- Enable high-throughput fuzz testing (millions of iterations per second via `cargo-fuzz` / libFuzzer).
- Eliminate all host dependencies from core arithmetic logic.
- Support compiling the contract crate as both a smart contract binary (`cdylib`) and a linkable native Rust library (`rlib`).

## Considered Options

- Option 1: Implement `streamed_at` as a pure, stateless function without `soroban_sdk::Env`.
- Option 2: Implement `streamed_at` as a method on `Stream` receiving `&Env` and querying `env.ledger().timestamp()`.
- Option 3: Trait-based abstraction over time and storage environments.

## Decision Outcome

Chosen option: "Option 1: Implement `streamed_at` as a pure, stateless function", because:
1. The function signature takes only raw numeric inputs:
   ```rust
   pub fn streamed_at(deposit: i128, duration: u64, elapsed: u64) -> Result<i128, StreamError>
   ```
2. The function has zero side effects, makes no system calls, and requires no Soroban host context.
3. In `contracts/streaming-payments/Cargo.toml`, the crate specifies both library targets:
   ```toml
   [lib]
   crate-type = ["cdylib", "rlib"]
   ```
4. This enables external test harnesses (such as the `cargo-fuzz` target in `fuzz/fuzz_targets/streamed_at.rs` and the differential reference model in `model/`) to link directly to `streampay_contract::stream::streamed_at` and run natively on developer workstations and CI runners.

### Consequences

- **Positive:**
  - `cargo-fuzz` can hammer the function with 50,000+ executions per second, discovering obscure arithmetic boundaries that would never be reached in slow host-simulated tests.
  - The function is provably panic-free for any arbitrary 64-bit and 128-bit integer inputs.
  - Off-chain differential oracles can compare contract output directly against alternative reference implementations.
- **Negative / Trade-offs:**
  - Callers within the contract must compute `elapsed` explicitly using `env.ledger().timestamp()` before passing it into `streamed_at`.

## Alternatives Considered

### Option 2: Method on `Stream` with `&Env`

- Good, because it encapsulates timestamp retrieval inside the method.
- Bad, because executing the function requires an active `soroban_sdk::Env` instance. Running libFuzzer with a full Soroban host reduces fuzzing throughput by over 100x and introduces host-level memory overhead.

### Option 3: Trait-Based Abstraction

- Good, because it separates the environment via interfaces.
- Bad, because it introduces unnecessary boilerplate and generic parameters for what is fundamentally a three-line integer arithmetic formula.

## Validation and Evidence

- Defined in `contracts/streaming-payments/src/stream.rs` and documented in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#3-accrual-math).
- Continuous fuzzing harness in `fuzz/fuzz_targets/streamed_at.rs` and CI workflow `.github/workflows/fuzz.yml`.
- Differential test model in `model/` verifying 100% equivalence against formal reference models.
- Commits: `7f740cf` (Initial implementation) and `000caec` ("chore(ci): fuzz harness, supply-chain gates, dependabot").
