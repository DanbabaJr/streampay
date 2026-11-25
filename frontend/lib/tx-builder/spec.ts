/**
 * Typed access to the canonical StreamPay contract spec.
 *
 * The spec is generated from the contract (`sdks/spec/streampay.spec.json`)
 * and is the same source the TypeScript SDK is generated from. The builder
 * intentionally reads it at runtime rather than hardcoding a form per
 * entrypoint: every current and future function, including its nested structs,
 * vectors, options, enums and unions, is rendered from these definitions.
 */
import rawSpec from "../../../sdks/spec/streampay.spec.json";

export type TypeRef =
  | string
  | { vec: TypeRef }
  | { option: TypeRef }
  | { result: { ok: TypeRef; err: TypeRef } };

export interface SpecArg {
  name: string;
  type: TypeRef;
  doc?: string;
}

export interface SpecFunction {
  name: string;
  doc?: string;
  args: SpecArg[];
  returns?: TypeRef;
  error?: string | null;
  mutating?: boolean;
}

export interface SpecField {
  name: string;
  type: TypeRef;
  doc?: string;
}

export interface SpecStruct {
  name: string;
  doc?: string;
  fields: SpecField[];
}

export interface SpecEnum {
  name: string;
  doc?: string;
  encoding?: string;
  cases: Array<{ name: string; doc?: string; value?: number }>;
}

export interface SpecUnion {
  name: string;
  doc?: string;
  cases: Array<{ name: string; doc?: string; types: TypeRef[] }>;
}

export interface ContractSpec {
  schema: string;
  generator?: string;
  contract: {
    name: string;
    crate?: string;
    version: string;
    description?: string;
  };
  constants?: Record<string, { value: number | string; type: string }>;
  functions: SpecFunction[];
  structs: SpecStruct[];
  enums: SpecEnum[];
  unions: SpecUnion[];
  events?: unknown[];
}

/** Canonical source path, shown in the UI so integrators know what drives the form. */
export const SPEC_SOURCE = "sdks/spec/streampay.spec.json";

export const CONTRACT_SPEC = rawSpec as unknown as ContractSpec;

export const SPEC_FUNCTIONS = CONTRACT_SPEC.functions;

const FUNCTIONS = new Map(SPEC_FUNCTIONS.map((entry) => [entry.name, entry]));
const STRUCTS = new Map(CONTRACT_SPEC.structs.map((entry) => [entry.name, entry]));
const ENUMS = new Map(CONTRACT_SPEC.enums.map((entry) => [entry.name, entry]));
const UNIONS = new Map(CONTRACT_SPEC.unions.map((entry) => [entry.name, entry]));

export function getFunctionSpec(name: string): SpecFunction | undefined {
  return FUNCTIONS.get(name);
}

export function getStructSpec(name: string): SpecStruct | undefined {
  return STRUCTS.get(name);
}

export function getEnumSpec(name: string): SpecEnum | undefined {
  return ENUMS.get(name);
}

export function getUnionSpec(name: string): SpecUnion | undefined {
  return UNIONS.get(name);
}

export function isVecType(type: TypeRef): type is { vec: TypeRef } {
  return typeof type === "object" && "vec" in type;
}

export function isOptionType(type: TypeRef): type is { option: TypeRef } {
  return typeof type === "object" && "option" in type;
}

export function isResultType(type: TypeRef): type is { result: { ok: TypeRef; err: TypeRef } } {
  return typeof type === "object" && "result" in type;
}

/** Human-readable type label for form headings and error messages. */
export function formatTypeRef(type: TypeRef): string {
  if (typeof type === "string") return type;
  if (isVecType(type)) return `vec<${formatTypeRef(type.vec)}>`;
  if (isOptionType(type)) return `option<${formatTypeRef(type.option)}>`;
  if (isResultType(type)) {
    return `result<${formatTypeRef(type.result.ok)}, ${formatTypeRef(type.result.err)}>`;
  }
  return "unknown";
}
