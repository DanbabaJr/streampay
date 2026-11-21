/**
 * Decodes the shared conformance vectors into canonical JSON.
 *
 * This file is the TypeScript consumer of the shared conformance suite in
 * sdks/vectors. It decodes the raw XDR with public stellar-sdk primitives plus
 * the generated codecs and compares against the recorded canonical JSON, so a
 * codec that drifts from the contract's wire format fails here. Later language
 * SDKs consume the same files.
 */
import {
  Address,
  Networks,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  FUNCTIONS,
  contractErrorName,
  decodeGetStreamResult,
  decodeStreamPayEvent,
  type StreamPayEvent,
} from "./generated.js";

export type Canonical = unknown;

interface VectorFile {
  schema: string;
  name: string;
  specFingerprint: string;
  transactionEnvelopeXdr: string;
  resultXdr: string;
  eventsXdr: string[];
  expected?: Canonical;
}

type InvokeContractOperation = {
  func: {
    invokeContract(): {
      contractAddress(): xdr.ScAddress;
      functionName(): unknown;
      args(): xdr.ScVal[];
    };
  };
};

type ParsedTransaction = {
  source: string;
  fee: string;
  sequence: string;
  signatures: unknown[];
  operations: InvokeContractOperation[];
};

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}: expected a string`);
  return value;
}

function readMember<T>(target: unknown, key: string): T {
  const member = (target as Record<string, unknown> | undefined)?.[key];
  return (typeof member === "function" ? (member as () => T).call(target) : member) as T;
}

function canonicalStream(value: xdr.ScVal): Canonical {
  const stream = decodeGetStreamResult(value);
  return {
    id: stream.id.toString(),
    sender: stream.sender,
    recipient: stream.recipient,
    token: stream.token,
    deposit: stream.deposit.toString(),
    withdrawn: stream.withdrawn.toString(),
    start_time: stream.startTime.toString(),
    end_time: stream.endTime.toString(),
    cancelable: stream.cancelable,
    status: stream.status,
    use_oracle: stream.useOracle,
  };
}

function canonicalValue(value: xdr.ScVal, type: string): Canonical {
  if (type === "void") return null;
  if (type === "Stream") return canonicalStream(value);
  if (type.startsWith("vec:")) {
    const inner = type.slice(4);
    const native = scValToNative(value);
    if (!Array.isArray(native)) throw new Error(`${type}: expected an array`);
    // Re-decode each element through its ScVal counterpart is not necessary:
    // integers are the only vector type today.
    return native.map((item) => {
      if (inner === "u64" || inner === "i128") return String(item);
      if (inner === "address") return asString(item, inner);
      throw new Error(`unsupported vec element type ${inner}`);
    });
  }
  const native = scValToNative(value);
  switch (type) {
    case "address":
      return asString(native, type);
    case "i128":
    case "u64":
      return String(native);
    case "u32":
      return String(Number(native));
    case "bool":
      return Boolean(native);
    default:
      throw new Error(`unsupported canonical type ${type}`);
  }
}

function canonicalEvent(event: StreamPayEvent): Canonical {
  const base = { contract: event.contractId, name: event.type };
  switch (event.type) {
    case "StreamCreated":
      return {
        ...base,
        topics: { stream_id: event.streamId.toString() },
        data: {
          sender: event.sender,
          recipient: event.recipient,
          token: event.token,
          deposit: event.deposit.toString(),
          start_time: event.startTime.toString(),
          end_time: event.endTime.toString(),
          cancelable: event.cancelable,
        },
      };
    case "Withdrawn":
      return {
        ...base,
        topics: { stream_id: event.streamId.toString() },
        data: {
          recipient: event.recipient,
          amount: event.amount.toString(),
          withdrawn_total: event.withdrawnTotal.toString(),
        },
      };
    case "StreamCancelled":
      return {
        ...base,
        topics: { stream_id: event.streamId.toString() },
        data: {
          cancelled_by: event.cancelledBy,
          recipient_amount: event.recipientAmount.toString(),
          sender_amount: event.senderAmount.toString(),
        },
      };
    case "StreamToppedUp":
      return {
        ...base,
        topics: { stream_id: event.streamId.toString() },
        data: {
          sender: event.sender,
          amount: event.amount.toString(),
          new_deposit: event.newDeposit.toString(),
        },
      };
  }
}

/** Decodes one vector into `{ transaction, result, events }`. */
export function decodeVector(vector: VectorFile): Canonical {
  const tx = TransactionBuilder.fromXDR(
    vector.transactionEnvelopeXdr,
    Networks.TESTNET
  ) as unknown as ParsedTransaction;
  const operation = tx.operations[0];
  if (operation === undefined || typeof operation.func?.invokeContract !== "function") {
    throw new Error("vector has no invokeContract operation");
  }

  const invoke = operation.func.invokeContract();
  const functionName = String(invoke.functionName());
  const spec = FUNCTIONS.find((candidate) => candidate.name === functionName);
  if (spec === undefined) throw new Error(`function ${functionName} is not in the spec`);

  const scvals = invoke.args();

  const args: Record<string, Canonical> = {};
  spec.argNames.forEach((name, index) => {
    const value = scvals[index];
    if (value === undefined) throw new Error(`${spec.name} is missing argument ${name}`);
    args[name] = canonicalValue(value, spec.argTypes[index] ?? "unknown");
  });

  const resultScVal = xdr.ScVal.fromXDR(vector.resultXdr, "base64");
  const result = (() => {
    const switchName = readMember<{ name?: string }>(resultScVal, "switch")?.name;
    if (switchName === "scvError") {
      const errorShape = readMember<unknown>(resultScVal, "error");
      const rawCode = readMember<number>(errorShape, "contractCode");
      const code = typeof rawCode === "number" ? rawCode : -1;
      const name = contractErrorName(code) ?? "UnknownStreamError";
      return { error: { name, code } };
    }
    return { ok: canonicalValue(resultScVal, spec.returnType) };
  })();

  const events = vector.eventsXdr.map((encoded) => {
    const decoded = decodeStreamPayEvent(xdr.ContractEvent.fromXDR(encoded, "base64"));
    if (decoded === null) throw new Error("vector contains an event outside the StreamPay interface");
    return canonicalEvent(decoded);
  });

  return {
    transaction: {
      contract: Address.fromScAddress(invoke.contractAddress()).toString(),
      function: functionName,
      args,
      source: tx.source,
      fee: String(tx.fee),
      sequence: String(tx.sequence),
      signatures: tx.signatures.length,
    },
    result,
    events,
  };
}

export type { VectorFile };
