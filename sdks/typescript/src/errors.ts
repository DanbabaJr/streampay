import {
  contractErrorFromMessage,
  contractErrorName,
  type StreamErrorName,
} from "./generated.js";

/** Contract error codes that are retained for wire compatibility but retired.
 *
 * Kept in step with `RETIRED_CODES` in `contracts/streaming-payments/src/surface.rs`;
 * `test/errors.test.ts` fails if the two ever disagree. */
export const RETIRED_CONTRACT_ERROR_CODES: ReadonlySet<number> = new Set([
  2, 3, 126, 127, 128, 129,
]);

export interface ContractErrorMapping {
  code: number;
  name: StreamErrorName;
  retired: boolean;
}

/** Returns a typed SDK mapping, including an explicit retired marker. */
export function contractErrorMapping(code: number): ContractErrorMapping | undefined {
  const name = contractErrorName(code);
  if (name === undefined) return undefined;
  return {
    code,
    name,
    retired: RETIRED_CONTRACT_ERROR_CODES.has(code),
  };
}

/** Where in the transaction pipeline the failure happened. */
export type FailureKind =
  | "simulation"
  | "submission"
  | "inclusion"
  | "decode"
  | "transport";

export interface ContractFailure {
  code: number;
  name: string;
}

export interface StreamPayErrorOptions {
  contract?: ContractFailure;
  rpcMessage?: string;
  transactionXdr?: string;
  /** Hex hash of the signed envelope, when one was submitted. */
  transactionHash?: string;
}

/**
 * The single error type raised by the client. `kind` separates a preflight
 * (`simulation`) failure from a rejected submission (`submission`) or a
 * transaction that made it into a ledger but failed (`inclusion`), which is
 * exactly the split an operator needs when a call goes wrong.
 */
export class StreamPayError extends Error {
  readonly kind: FailureKind;
  readonly contract?: ContractFailure;
  readonly rpcMessage?: string;
  readonly transactionXdr?: string;
  readonly transactionHash?: string;

  constructor(message: string, kind: FailureKind, options: StreamPayErrorOptions = {}) {
    super(message);
    this.name = "StreamPayError";
    this.kind = kind;
    if (options.contract !== undefined) this.contract = options.contract;
    if (options.rpcMessage !== undefined) this.rpcMessage = options.rpcMessage;
    if (options.transactionXdr !== undefined) this.transactionXdr = options.transactionXdr;
    if (options.transactionHash !== undefined) this.transactionHash = options.transactionHash;
  }

  /** Builds an error from raw RPC text, extracting the typed contract code. */
  static fromRpc(
    kind: FailureKind,
    rpcMessage: string,
    transactionXdr?: string
  ): StreamPayError {
    const code = contractErrorFromMessage(rpcMessage);
    const name = code === undefined ? undefined : contractErrorName(code);
    const contract =
      code !== undefined && name !== undefined ? { code, name } : undefined;
    const label =
      contract === undefined
        ? `${kind} failed`
        : `${kind} failed: ${contract.name} (#${contract.code})`;
    const options: StreamPayErrorOptions = { rpcMessage };
    if (contract !== undefined) options.contract = contract;
    if (transactionXdr !== undefined) options.transactionXdr = transactionXdr;
    return new StreamPayError(`${label}: ${rpcMessage}`, kind, options);
  }
}

export function decodeError(message: string, transactionXdr?: string): StreamPayError {
  const options: StreamPayErrorOptions = { rpcMessage: message };
  if (transactionXdr !== undefined) options.transactionXdr = transactionXdr;
  return new StreamPayError(`decode failed: ${message}`, "decode", options);
}
