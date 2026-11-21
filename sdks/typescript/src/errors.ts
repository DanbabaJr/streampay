import { contractErrorFromMessage, contractErrorName } from "./generated.js";

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

  constructor(message: string, kind: FailureKind, options: StreamPayErrorOptions = {}) {
    super(message);
    this.name = "StreamPayError";
    this.kind = kind;
    if (options.contract !== undefined) this.contract = options.contract;
    if (options.rpcMessage !== undefined) this.rpcMessage = options.rpcMessage;
    if (options.transactionXdr !== undefined) this.transactionXdr = options.transactionXdr;
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
