import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

const schema = JSON.parse(
  readFileSync(new URL("../json-schema-v1.json", import.meta.url), "utf8")
) as object;

const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

/** Returns null when `value` matches schema v1, else a readable error string. */
export function schemaError(value: unknown): string | null {
  if (validate(value)) return null;
  return JSON.stringify(validate.errors);
}
