/**
 * Transaction assembly for the spec-driven builder.
 *
 * The operation itself comes from `values.ts`; this module only wraps it in a
 * Stellar transaction. Simulation uses a dummy sequence (`Account(source, "0")`)
 * so integrators can inspect a call before their source account is funded.
 * Submission goes through the normal `server.getAccount(source)` path in the
 * page, because the signed transaction needs the account's real sequence.
 */
import {
  Account,
  Networks,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { ContractSpec } from "./spec";
import { buildInvokeOperation, type TxValue } from "./values";

export const SANDBOX_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

export const SANDBOX_NETWORK_PASSPHRASE = Networks.TESTNET;
export const SANDBOX_BASE_FEE = "100000";

export interface BuildTransactionInput {
  spec: ContractSpec;
  contractId: string;
  source: string;
  functionName: string;
  values: Record<string, TxValue>;
  /** Real account for submission; omitted for simulation. */
  account?: Account;
  fee?: string;
  timeoutSeconds?: number;
}

export function buildTransaction(input: BuildTransactionInput): Transaction {
  const account = input.account ?? new Account(input.source, "0");
  return new TransactionBuilder(account, {
    fee: input.fee ?? SANDBOX_BASE_FEE,
    networkPassphrase: SANDBOX_NETWORK_PASSPHRASE,
  })
    .addOperation(
      buildInvokeOperation(input.spec, input.contractId, input.functionName, input.values),
    )
    .setTimeout(input.timeoutSeconds ?? 60)
    .build();
}
