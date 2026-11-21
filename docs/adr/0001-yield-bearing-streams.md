# ADR 0001: Yield-Bearing Streams

- Status: Proposed; implementation is gated on deployment verification and the
  accounting details below.
- Date: 2026-10-16
- Issue: #52

## Context

StreamPay currently holds every stream's full outstanding balance as the
underlying token. Its safety invariant is that the contract can synchronously
pay every accrued withdrawal and cancellation split. Investing those tokens
changes that invariant: a lending position is not equivalent to liquid token
custody, and an external market call adds a new trust and failure boundary.

The requested policies are per stream: `interest_to_sender`,
`interest_inflates_stream`, or `interest_to_treasury(address)`. The principal
accounting must remain denominated in the streamed token. Yield must be
measured as underlying tokens actually recovered, not estimated from an APR or
an oracle price.

## Candidate market and rationale

The candidate adapter target is Blend v2 on Stellar. Blend is a native
Soroban lending protocol, and its documented pool interface supports supplying
and withdrawing an underlying reserve through `submit()` requests. Blend
positions use non-transferable bTokens whose underlying value follows the
reserve's `bRate`.

This is a protocol-family selection, not approval of a particular pool. Blend
explicitly makes pool selection a first-order integration decision. Its
deployment listing publishes protocol and factory addresses, not one
universally suitable pool/reserve for StreamPay. Before production integration
is enabled, the deployment must pin the network, pool contract address,
underlying reserve address, pool version, and verified contract interface.
Arbitrary caller-supplied pool addresses are not acceptable as an implicit
trust model.

The adapter should use Blend's uncollateralized `Deposit` / `Withdraw`
requests, not `SupplyCollateral` / `WithdrawCollateral`: StreamPay does not
borrow, and collateral semantics add liquidation exposure without benefiting
the stream. The adapter must verify the selected pool supports the stream's
token. Blend `submit()` requires the relevant contract authorization for the
fund movement; this must be tested against the exact pool version and a local
Soroban host.

Blend v2 is preferred over a generic yield aggregator for the first adapter
because its native Soroban pool interface and underlying-denominated positions
avoid a bridge and avoid needing StreamPay to value rewards in a second asset.
This choice does not imply that any particular pool is safe or liquid.

## Oracle dependency

StreamPay must not use an oracle to calculate stream principal, available
amount, yield, or payout. All user-facing amounts remain in the underlying
asset's integer units. The selected Blend pool has its own configured oracle;
that oracle is part of Blend's risk and may affect pool operations, reserve
health, liquidation, or market availability. A stale, manipulated, or
unavailable pool oracle can therefore cause loss or prevent exit even though
StreamPay never reads its price feed.

Before deployment, record the chosen pool's oracle address, supported assets,
oracle freshness/availability behavior, and upgrade/admin controls. Do not
count BLND emissions as stream yield in the initial adapter: they are a
separate asset with separate valuation and claim risks.

## Liquidity, pause, and insolvency risks

Blend documents that withdrawal requires sufficient unborrowed reserve
liquidity. High utilization can make a lender's position temporarily
unwithdrawable. Pool status can also block requests. In the event the backstop
cannot cover bad debt, losses can be socialized among lenders. A contract-side
percentage buffer cannot eliminate these risks: at any instant the sender can
cancel, making the entire outstanding stream balance payable across the
recipient and sender split. Keeping the entire liability in liquid custody
would preserve today's guarantee but would invest no funds and earn no yield.

Therefore, this ADR selects **deferred claims** rather than claiming the
existing synchronous payout guarantee can survive market lockup. A withdrawal
or cancellation that cannot be funded from liquid assets may create an
explicit pending claim. Claims must survive stream cancellation, remain
withdrawable after the stream's normal lifecycle, and not be silently
reclassified as paid. This changes public API, storage, events, and frontend
behavior. Keeping every liability liquid is rejected because it preserves
current semantics but leaves no stream funds earning yield.

No market call may be allowed to make a stream's accounting disappear or
prevent unrelated streams from operating. A market pause, insufficient
liquidity, or failed exit must either leave state unchanged and preserve a
claim for retry, or execute a specified, auditable loss-allocation transition.
It must never silently report the nominal amount as paid when fewer tokens
were received.

An emergency exit cannot promise a slippage bound from the Blend interface
alone. The adapter must record actual underlying tokens received. Any shortfall
against the internal book value is a realized loss, not negative interest. The
selected product behavior is deferred claims with proportional loss allocation:
unpaid market-backed claims share actual realized losses proportionally,
including recipient accrual, sender refund, and prior pending claims. This
requires a share/index accounting design that does not scan all streams and
does not allow one stream's exit to consume another's claim. No oracle-derived
haircut may be substituted for actual recovered token balance. The precise
share/index and rounding rules remain a pre-implementation design gate.

## Accounting and policy requirements

- Store an explicit policy per stream, including the treasury address in the
  treasury variant. The treasury cannot be changed after creation.
- Track invested principal, liquid underlying, and recovered yield separately
  from the existing `deposit` and `withdrawn` fields.
- Attribute realized yield only when the market returns more underlying than
  the corresponding invested basis. Do not accrue an estimated APY.
- `interest_to_sender`: realized interest is payable to the sender on
  settlement/cancellation; it does not increase recipient streaming accrual.
- `interest_inflates_stream`: the selected rule is a new linear tranche from
  the time yield is realized to the original stream end; if realized at or
  after the end, it is immediately accrued. No amount already available to the
  recipient may decrease.
- `interest_to_treasury(address)`: realized interest is a separate treasury
  claim and must not reduce either party's principal claim.
- Every transition must preserve checked arithmetic, checks-effects-
  interactions, and isolation between streams. External calls must be covered
  by reentrancy tests.
- Persisted `Stream` values are public contract storage. Adding fields or
  changing enum layouts requires an explicit upgrade/migration analysis; old
  entries must not become unreadable.

## Required tests and verification

Use a mock market with configurable supply/withdraw outcomes. Cover normal
interest realization for all policies, market pause, insufficient exit
liquidity, partial/haircut exit, insolvency, reentrancy, and recovery/retry of
pending claims. Assert that the contract never
marks unpaid amounts as paid, no stream can consume another stream's assets,
and aggregate liquid plus market assets plus realized losses reconcile with
all outstanding claims. Extend the fuzz target to exercise the pure interest
ledger and loss-allocation invariants.

Run the existing contract gates and measure coverage on the changed accounting
surface. The repository's current CI coverage summary is not a 95% enforcement
gate; the requested 95% minimum must be demonstrated for the feature's
relevant contract code, not inferred from a passing test suite.

## Expected APY versus added contract risk

Blend's realized return depends on utilization, reserve parameters, fees, and
market conditions; there is no fixed or guaranteed APY. Expected yield must
be compared with the additional risk of pool/oracle failure, utilization
lockup, backstop shortfall, adapter defects, contract upgrades, extra Soroban
invocations, and deferred-claim UX. No APR promise belongs in the contract.
The user-facing integration must disclose that yield can be zero or negative
after losses and that market exit may be delayed if deferred claims are
selected.

## Decision gates before contract implementation

1. Pin the exact Blend network, pool address/version, reserve token, and oracle
   details; verify the deployed interface and authorization behavior.
2. Implement deferred claims for insufficient liquidity, including claim
  persistence after cancellation and the retry UX.
3. Implement the selected proportional loss allocation with a share/index
  ledger; specify rounding and prove that claims remain isolated without a
  global stream scan.
4. Define a measurable liquid-buffer policy and the exact behavior when the
   buffer is exhausted or the pool is paused.
5. Define when sender and treasury yield claims become payable and ensure
  payout does not depend on the stream remaining active.

Until those gates are resolved, yield must remain disabled and the existing
escrow path must remain unchanged. A mock adapter may validate a selected
design, but it is not evidence that a production Blend deployment is safe.

## References

- [Blend integration guide](https://docs.blend.capital/tech-docs/integrations/integrate-pool)
- [Blend fund management](https://docs.blend.capital/tech-docs/core-contracts/lending-pool/fund-management)
- [Blend protocol tokens](https://docs.blend.capital/tech-docs/core-contracts/lending-pool/protocol-tokens)
- [Blend lending risks and liquidity](https://docs.blend.capital/users/lending-borrowing/lending)
- [Blend deployments](https://docs.blend.capital/mainnet-deployments)