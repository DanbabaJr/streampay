/**
 * Spec-driven values for the transaction builder.
 *
 * This module is deliberately free of React and RPC so it can be unit tested
 * and reused by headless tooling. The form renderer and the ScVal encoder share
 * `emptyValue` / `sampleValue`, which is what keeps the generated fields and
 * the XDR payload in the same shape.
 */
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  type ContractSpec,
  type SpecEnum,
  type SpecStruct,
  type SpecUnion,
  type TypeRef,
  formatTypeRef,
  getEnumSpec,
  getStructSpec,
  getUnionSpec,
  isOptionType,
  isResultType,
  isVecType,
} from "./spec";

export type TxValue =
  | string
  | boolean
  | null
  | TxValue[]
  | { [field: string]: TxValue }
  | UnionValue;

export interface UnionValue {
  variant: string;
  values: TxValue[];
}

const INTEGER_TYPES = new Set(["u32", "u64", "i128"]);
const PRIMITIVE_TYPES = new Set([
  "address",
  "bool",
  "u32",
  "u64",
  "i128",
  "bytes32",
  "bytes64",
  "string",
  "symbol",
]);

const U32_MAX = (1n << 32n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;

export function isUnionValue(value: TxValue): value is UnionValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "variant" in value &&
    "values" in value &&
    Array.isArray((value as UnionValue).values)
  );
}

export function isStructValue(value: TxValue): value is { [field: string]: TxValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isUnionValue(value);
}

/** The value a freshly rendered field starts with (empty strings for text). */
export function emptyValue(spec: ContractSpec, type: TypeRef): TxValue {
  if (typeof type === "string") {
    switch (type) {
      case "address":
      case "bytes32":
      case "bytes64":
      case "string":
      case "symbol":
        return "";
      case "bool":
        return false;
      case "u32":
      case "u64":
      case "i128":
        return "0";
      default: {
        const struct = getStructSpec(type);
        if (struct) return emptyStructValue(spec, struct);
        const enumSpec = getEnumSpec(type);
        if (enumSpec) return emptyEnumValue(enumSpec);
        const union = getUnionSpec(type);
        if (union) return emptyUnionValue(spec, union);
        throw new Error(`Unsupported contract spec type '${type}'`);
      }
    }
  }
  if (isVecType(type)) return [];
  if (isOptionType(type)) return null;
  if (isResultType(type)) {
    return { variant: "Ok", values: [emptyValue(spec, type.result.ok)] };
  }
  throw new Error(`Unsupported contract spec type '${formatTypeRef(type)}'`);
}

/** A non-empty value used by tests and "add item" affordances. */
export function sampleValue(spec: ContractSpec, type: TypeRef): TxValue {
  if (typeof type === "string") {
    switch (type) {
      case "address":
        return "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
      case "bytes32":
        return "11".repeat(32);
      case "bytes64":
        return "22".repeat(64);
      case "bool":
        return false;
      case "u32":
      case "u64":
      case "i128":
        return "1";
      case "string":
      case "symbol":
        return "sandbox";
      default: {
        const struct = getStructSpec(type);
        if (struct) {
          return Object.fromEntries(
            struct.fields.map((field) => [field.name, sampleValue(spec, field.type)]),
          );
        }
        const enumSpec = getEnumSpec(type);
        if (enumSpec) return enumSpec.cases[0]?.name ?? "";
        const union = getUnionSpec(type);
        if (union) {
          const first = union.cases[0];
          if (!first) throw new Error(`Union '${type}' has no cases`);
          return {
            variant: first.name,
            values: first.types.map((caseType) => sampleValue(spec, caseType)),
          };
        }
        throw new Error(`Unsupported contract spec type '${type}'`);
      }
    }
  }
  if (isVecType(type)) return [];
  if (isOptionType(type)) return null;
  if (isResultType(type)) {
    return { variant: "Ok", values: [sampleValue(spec, type.result.ok)] };
  }
  throw new Error(`Unsupported contract spec type '${formatTypeRef(type)}'`);
}

function emptyStructValue(spec: ContractSpec, struct: SpecStruct): TxValue {
  return Object.fromEntries(
    struct.fields.map((field) => [field.name, emptyValue(spec, field.type)]),
  );
}

function emptyEnumValue(enumSpec: SpecEnum): TxValue {
  return enumSpec.cases[0]?.name ?? "";
}

function emptyUnionValue(spec: ContractSpec, union: SpecUnion): TxValue {
  const first = union.cases[0];
  if (!first) throw new Error(`Union '${union.name}' has no cases`);
  return {
    variant: first.name,
    values: first.types.map((caseType) => emptyValue(spec, caseType)),
  };
}

/** Default argument object for a function selected in the UI. */
export function defaultArgsForFunction(
  spec: ContractSpec,
  functionName: string,
): Record<string, TxValue> {
  const fn = spec.functions.find((candidate) => candidate.name === functionName);
  if (!fn) throw new Error(`Unknown contract function '${functionName}'`);
  return Object.fromEntries(
    fn.args.map((arg) => [arg.name, emptyValue(spec, arg.type)]),
  );
}

function parseInteger(value: TxValue, path: string): bigint {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`${path}: expected an integer, got ${typeof value}`);
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`${path}: '${text}' is not an integer`);
  }
  return BigInt(text);
}

function integerRange(type: "u32" | "u64" | "i128", value: bigint, path: string): bigint {
  if (type === "u32" && (value < 0n || value > U32_MAX)) {
    throw new Error(`${path}: u32 must be between 0 and ${U32_MAX}`);
  }
  if (type === "u64" && (value < 0n || value > U64_MAX)) {
    throw new Error(`${path}: u64 must be between 0 and ${U64_MAX}`);
  }
  if (type === "i128" && (value < I128_MIN || value > I128_MAX)) {
    throw new Error(`${path}: i128 is out of range`);
  }
  return value;
}

function hexToBytes(value: TxValue, path: string, byteLength: number): Uint8Array {
  const text = String(value).trim().replace(/^0x/i, "");
  if (!new RegExp(`^[0-9a-fA-F]{${byteLength * 2}}$`).test(text)) {
    throw new Error(`${path}: expected exactly ${byteLength} bytes (${byteLength * 2} hex characters)`);
  }
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function structScVal(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  // Soroban structs are maps; canonical encoding orders keys lexicographically.
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(
    sorted.map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
}

/**
 * Encode a form value to the ScVal the contract expects for `type`.
 * Throws a path-qualified error so the UI can point at the exact field.
 */
export function toScVal(
  spec: ContractSpec,
  type: TypeRef,
  value: TxValue,
  path: string,
): xdr.ScVal {
  if (typeof type === "string") {
    switch (type) {
      case "address": {
        if (typeof value !== "string" || value.trim() === "") {
          throw new Error(`${path}: address is required`);
        }
        try {
          return nativeToScVal(new Address(value.trim()), { type: "address" });
        } catch {
          throw new Error(`${path}: '${value}' is not a valid Stellar address or contract id`);
        }
      }
      case "bool":
        if (typeof value !== "boolean") throw new Error(`${path}: expected true or false`);
        return nativeToScVal(value);
      case "u32":
      case "u64":
      case "i128": {
        const parsed = integerRange(type, parseInteger(value, path), path);
        return nativeToScVal(parsed, { type });
      }
      case "bytes32":
        return xdr.ScVal.scvBytes(hexToBytes(value, path, 32));
      case "bytes64":
        return xdr.ScVal.scvBytes(hexToBytes(value, path, 64));
      case "string":
        return xdr.ScVal.scvString(String(value));
      case "symbol": {
        const text = String(value);
        if (!/^[A-Za-z0-9_]{1,32}$/.test(text)) {
          throw new Error(`${path}: symbol must be 1-32 letters, digits or underscores`);
        }
        return xdr.ScVal.scvSymbol(text);
      }
      default: {
        const struct = getStructSpec(type);
        if (struct) {
          if (!isStructValue(value)) {
            throw new Error(`${path}: expected an object for ${type}`);
          }
          return structScVal(
            struct.fields.map((field) => [
              field.name,
              toScVal(spec, field.type, value[field.name], `${path}.${field.name}`),
            ]),
          );
        }
        const enumSpec = getEnumSpec(type);
        if (enumSpec) {
          const caseName = String(value);
          if (!enumSpec.cases.some((entry) => entry.name === caseName)) {
            throw new Error(`${path}: '${caseName}' is not a case of ${type}`);
          }
          return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(caseName)]);
        }
        const union = getUnionSpec(type);
        if (union) {
          if (!isUnionValue(value)) {
            throw new Error(`${path}: expected a variant for ${type}`);
          }
          const chosen = union.cases.find((entry) => entry.name === value.variant);
          if (!chosen) {
            throw new Error(`${path}: '${value.variant}' is not a case of ${type}`);
          }
          const payload = chosen.types.map((caseType, index) =>
            toScVal(spec, caseType, value.values[index], `${path}.${chosen.name}[${index}]`),
          );
          return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(chosen.name), ...payload]);
        }
        throw new Error(`${path}: unsupported contract spec type '${type}'`);
      }
    }
  }

  if (isVecType(type)) {
    if (!Array.isArray(value)) throw new Error(`${path}: expected a list`);
    return xdr.ScVal.scvVec(
      value.map((item, index) => toScVal(spec, type.vec, item, `${path}[${index}]`)),
    );
  }
  if (isOptionType(type)) {
    if (value === null || value === undefined) {
      return xdr.ScVal.scvVoid();
    }
    return toScVal(spec, type.option, value, path);
  }
  if (isResultType(type)) {
    if (!isUnionValue(value)) throw new Error(`${path}: expected Ok or Err`);
    const chosen = value.variant === "Err" ? type.result.err : type.result.ok;
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(value.variant === "Err" ? "Err" : "Ok"),
      toScVal(spec, chosen, value.values[0], `${path}.${value.variant}`),
    ]);
  }
  throw new Error(`${path}: unsupported contract spec type '${formatTypeRef(type)}'`);
}

/** Build the contract invocation operation for a function and its form values. */
export function buildInvokeOperation(
  spec: ContractSpec,
  contractId: string,
  functionName: string,
  values: Record<string, TxValue>,
): xdr.Operation {
  const fn = spec.functions.find((candidate) => candidate.name === functionName);
  if (!fn) throw new Error(`Unknown contract function '${functionName}'`);
  const args = fn.args.map((arg) =>
    toScVal(spec, arg.type, values[arg.name], `${fn.name}.${arg.name}`),
  );
  return new Contract(contractId).call(fn.name, ...args);
}

export function isIntegerType(type: TypeRef): boolean {
  return typeof type === "string" && INTEGER_TYPES.has(type);
}

export function isPrimitiveType(type: TypeRef): boolean {
  return typeof type === "string" && PRIMITIVE_TYPES.has(type);
}
