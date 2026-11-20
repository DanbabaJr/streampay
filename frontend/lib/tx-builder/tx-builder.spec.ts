import { describe, expect, it } from "vitest";
import {
  Address,
  Networks,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import createStreamFixture from "./fixtures/create-stream.json";
import { assessSandboxSafety } from "./safety";
import {
  CONTRACT_SPEC,
  SPEC_FUNCTIONS,
  getFunctionSpec,
  getStructSpec,
} from "./spec";
import { buildTransaction } from "./transaction";
import {
  buildInvokeOperation,
  defaultArgsForFunction,
  emptyValue,
  isUnionValue,
  sampleValue,
  toScVal,
  type TxValue,
} from "./values";
import { buildCreateStreamOperation } from "../stellar-ops";

const DEMO = createStreamFixture;

function invocation(functionName: string, args: Record<string, TxValue>) {
  const operation = buildInvokeOperation(
    CONTRACT_SPEC,
    DEMO.contractId,
    functionName,
    args,
  );
  const raw = xdr.Operation.fromXDR(operation.toXDR("base64"), "base64");
  if (raw.body.type !== "invokeHostFunction") {
    throw new Error(`expected invokeHostFunction, got ${raw.body.type}`);
  }
  const hostFunction = raw.body.invokeHostFunctionOp.hostFunction;
  if (hostFunction.type !== "hostFunctionTypeInvokeContract") {
    throw new Error(`expected invokeContract, got ${hostFunction.type}`);
  }
  return hostFunction.invokeContract;
}

function sampleArgs(functionName: string): Record<string, TxValue> {
  const fn = getFunctionSpec(functionName);
  if (!fn) throw new Error(`missing spec function ${functionName}`);
  return Object.fromEntries(
    fn.args.map((arg) => [arg.name, sampleValue(CONTRACT_SPEC, arg.type)]),
  );
}

describe("canonical contract spec", () => {
  it("is the expected 117-entrypoint surface", () => {
    expect(SPEC_FUNCTIONS).toHaveLength(117);
    expect(SPEC_FUNCTIONS.map((entry) => entry.name)).toContain("create_stream");
    expect(SPEC_FUNCTIONS.map((entry) => entry.name)).toContain("governance_propose");
  });

  it("builds a contract invocation for every entrypoint from generated values", () => {
    const failures: string[] = [];
    for (const fn of SPEC_FUNCTIONS) {
      try {
        const invoke = invocation(fn.name, sampleArgs(fn.name));
        expect(String(invoke.functionName)).toBe(fn.name);
        expect(invoke.args).toHaveLength(fn.args.length);
      } catch (error) {
        failures.push(`${fn.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("create_stream end-to-end demo", () => {
  it("matches the canonical SDK operation XDR", () => {
    const operation = buildInvokeOperation(
      CONTRACT_SPEC,
      DEMO.contractId,
      DEMO.functionName,
      DEMO.args,
    );
    const canonical = buildCreateStreamOperation(
      DEMO.contractId,
      DEMO.args.sender,
      DEMO.args.recipient,
      DEMO.args.token,
      DEMO.args.deposit_amount,
      BigInt(DEMO.args.start_time),
      BigInt(DEMO.args.end_time),
      DEMO.args.cancelable,
    );
    expect(operation.toXDR("base64")).toBe(canonical.toXDR("base64"));

    const args = invocation(DEMO.functionName, DEMO.args).args;
    expect(scValToNative(args[0])).toBe(DEMO.args.sender);
    expect(scValToNative(args[3])).toBe(101n);
    expect(scValToNative(args[4])).toBe(1000n);
    expect(scValToNative(args[6])).toBe(true);
  });

  it("builds and round-trips a Testnet transaction", () => {
    const transaction = buildTransaction({
      spec: CONTRACT_SPEC,
      contractId: DEMO.contractId,
      source: DEMO.source,
      functionName: DEMO.functionName,
      values: DEMO.args,
    });
    expect(transaction.networkPassphrase).toBe(Networks.TESTNET);
    const roundTripped = TransactionBuilder.fromXDR(transaction.toXDR(), Networks.TESTNET);
    expect(roundTripped.toXDR()).toBe(transaction.toXDR());
  });
});

describe("recursive value forms", () => {
  it("generates repeatable StreamInput groups for nested vectors", () => {
    const values = defaultArgsForFunction(CONTRACT_SPEC, "create_streams");
    const input = sampleValue(CONTRACT_SPEC, "StreamInput");
    values.inputs = [input, input];
    const scVal = toScVal(
      CONTRACT_SPEC,
      { vec: "StreamInput" },
      values.inputs,
      "create_streams.inputs",
    );
    expect(scVal.type).toBe("scvVec");
    if (scVal.type !== "scvVec") return;
    const native = scValToNative(scVal) as Array<Record<string, unknown>>;
    expect(native).toHaveLength(2);
    expect(native[0].recipient).toBe(DEMO.args.sender);
  });

  it("distinguishes None from Some and requires a valid inner value", () => {
    const none = toScVal(CONTRACT_SPEC, { option: "address" }, null, "set_stream_policy.token");
    expect(none.type).toBe("scvVoid");

    const some = toScVal(
      CONTRACT_SPEC,
      { option: "address" },
      DEMO.args.token,
      "set_stream_policy.token",
    );
    expect(scValToNative(some)).toBe(DEMO.args.token);

    expect(() =>
      toScVal(CONTRACT_SPEC, { option: "address" }, "", "set_stream_policy.token"),
    ).toThrow(/address is required/);
  });

  it("encodes unions as a case symbol plus the typed payload", () => {
    const action = sampleValue(CONTRACT_SPEC, "GovernanceAction");
    expect(isUnionValue(action)).toBe(true);
    if (!isUnionValue(action)) return;
    const scVal = toScVal(CONTRACT_SPEC, "GovernanceAction", action, "governance_propose.action");
    const native = scValToNative(scVal) as unknown[];
    expect(native[0]).toBe(action.variant);
    expect(native).toHaveLength(1 + action.values.length);

    const custom = {
      variant: "SetStreamPolicy",
      values: [null, sampleValue(CONTRACT_SPEC, "StreamPolicy")],
    };
    const customNative = scValToNative(
      toScVal(CONTRACT_SPEC, "GovernanceAction", custom, "governance_propose.action"),
    ) as unknown[];
    expect(customNative[0]).toBe("SetStreamPolicy");
    expect(customNative[1]).toBeNull();
  });

  it("encodes enums as a single-case symbol vector", () => {
    const scVal = toScVal(CONTRACT_SPEC, "IntentStatus", "Pending", "intent.status");
    expect(scValToNative(scVal)).toEqual(["Pending"]);
  });

  it("sorts struct maps by field name for canonical encoding", () => {
    const struct = getStructSpec("StreamInput");
    expect(struct).toBeDefined();
    const values = sampleValue(CONTRACT_SPEC, "StreamInput");
    const scVal = toScVal(CONTRACT_SPEC, "StreamInput", values, "input");
    expect(scVal.type).toBe("scvMap");
    if (scVal.type !== "scvMap") return;
    const keys = (scVal.map ?? []).map((entry) => {
      if (entry.key.type !== "scvSymbol") throw new Error("expected symbol key");
      return entry.key.sym.toString();
    });
    expect(keys).toEqual([...keys].sort());
  });
});

describe("input validation", () => {
  it("rejects malformed addresses, short bytes, and out-of-range integers", () => {
    expect(() => toScVal(CONTRACT_SPEC, "address", "not-an-address", "arg")).toThrow(
      /not a valid Stellar address/,
    );
    expect(() => toScVal(CONTRACT_SPEC, "bytes32", "abcd", "arg")).toThrow(
      /exactly 32 bytes/,
    );
    expect(() => toScVal(CONTRACT_SPEC, "u32", "4294967296", "arg")).toThrow(
      /u32 must be between/,
    );
    expect(() => toScVal(CONTRACT_SPEC, "i128", "1.5", "arg")).toThrow(/is not an integer/);
  });

  it("produces an empty value for every argument type in the spec", () => {
    const seen = new Set<string>();
    const walk = (type: unknown): void => {
      if (typeof type === "string") {
        seen.add(type);
        return;
      }
      if (!type || typeof type !== "object") return;
      if ("vec" in type) walk((type as { vec: unknown }).vec);
      else if ("option" in type) walk((type as { option: unknown }).option);
      else if ("result" in type) {
        const result = (type as { result: { ok: unknown; err: unknown } }).result;
        walk(result.ok);
        walk(result.err);
      }
    };
    for (const fn of SPEC_FUNCTIONS) for (const arg of fn.args) walk(arg.type);
    for (const typeName of seen) {
      expect(() => emptyValue(CONTRACT_SPEC, typeName), typeName).not.toThrow();
    }
  });
});

describe("testnet safety gate", () => {
  it("accepts explicit Testnet and local RPC hosts", () => {
    expect(assessSandboxSafety("testnet", "https://soroban-testnet.stellar.org").safe).toBe(true);
    expect(assessSandboxSafety("testnet", "http://localhost:8000").safe).toBe(true);
  });

  it("refuses PUBLIC networks, mainnet RPCs, and unknown hosts", () => {
    const publicNetwork = assessSandboxSafety("public", "https://soroban-testnet.stellar.org");
    expect(publicNetwork.safe).toBe(false);
    expect(publicNetwork.reasons.join(" ")).toMatch(/PUBLIC/);

    const mainnetRpc = assessSandboxSafety("testnet", "https://soroban.stellar.org");
    expect(mainnetRpc.safe).toBe(false);
    expect(mainnetRpc.reasons.join(" ")).toMatch(/mainnet endpoint/);

    expect(assessSandboxSafety("testnet", "https://rpc.example.com").safe).toBe(false);
  });
});

describe("misc", () => {
  it("fails unknown entrypoints and unsupported types with actionable errors", () => {
    expect(() =>
      buildInvokeOperation(CONTRACT_SPEC, DEMO.contractId, "not_a_function", {}),
    ).toThrow(/Unknown contract function/);
    expect(() => toScVal(CONTRACT_SPEC, "NotAType", "x", "arg")).toThrow(
      /unsupported contract spec type/,
    );
  });

  it("encodes addresses with the SDK Address wrapper", () => {
    const scVal = toScVal(CONTRACT_SPEC, "address", DEMO.args.token, "arg");
    expect(scVal.type).toBe("scvAddress");
    if (scVal.type !== "scvAddress") return;
    expect(Address.fromScAddress(scVal.address).toString()).toBe(DEMO.args.token);
  });
});
