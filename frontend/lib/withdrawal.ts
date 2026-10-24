/**
 * Pure validation and formatting helpers for stream withdrawal operations.
 */

export interface WithdrawalValidationResult {
  valid: boolean;
  error?: string;
  overWithdrawal: boolean;
  amount: bigint;
}

/**
 * Validates a user-input withdrawal amount against the available balance.
 * Prevents client-side over-withdrawal, negative amounts, and invalid numbers.
 */
export function validateWithdrawal(
  amountStr: string,
  available: bigint | null
): WithdrawalValidationResult {
  const trimmed = amountStr.trim();
  if (!trimmed) {
    return {
      valid: false,
      error: "Please enter an amount to withdraw.",
      overWithdrawal: false,
      amount: 0n,
    };
  }

  let amount: bigint;
  try {
    amount = BigInt(trimmed);
  } catch {
    return {
      valid: false,
      error: "Invalid numeric amount.",
      overWithdrawal: false,
      amount: 0n,
    };
  }

  if (amount <= 0n) {
    return {
      valid: false,
      error: "Withdrawal amount must be greater than zero.",
      overWithdrawal: false,
      amount,
    };
  }

  if (available !== null && amount > available) {
    return {
      valid: false,
      error: `Amount exceeds the currently accrued ${available.toString()} units. The contract will reject this call with AmountExceedsAvailable.`,
      overWithdrawal: true,
      amount,
    };
  }

  return {
    valid: true,
    overWithdrawal: false,
    amount,
  };
}

/**
 * Formats token units for display.
 */
export function fmtUnits(v: bigint | number | string): string {
  try {
    return BigInt(v).toString();
  } catch {
    return String(v);
  }
}
