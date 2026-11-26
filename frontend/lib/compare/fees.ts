// Fee estimate. The contract charges no protocol fee; the cost to the sender is
// the network fee for the create and withdraw transactions. Both numbers are
// user-adjustable estimates (stroops), clearly labelled in the UI.
export interface FeeAssumptions {
  /** Estimated stroops per transaction. */
  txFee: bigint;
  /** Number of withdrawals expected over the stream's life. */
  withdrawals: bigint;
  /** Optional protocol fee in basis points of the deposit (0 for the current contract). */
  protocolFeeBps: bigint;
}

export const DEFAULT_FEES: FeeAssumptions = { txFee: 100_000n, withdrawals: 1n, protocolFeeBps: 0n };

export interface FeeBreakdown {
  creation: bigint;
  withdrawals: bigint;
  protocol: bigint;
  total: bigint;
}

export function estimateFees(deposit: bigint, f: FeeAssumptions): FeeBreakdown {
  const creation = f.txFee;
  const withdrawals = f.txFee * f.withdrawals;
  const protocol = (deposit * f.protocolFeeBps) / 10_000n;
  return { creation, withdrawals, protocol, total: creation + withdrawals + protocol };
}
