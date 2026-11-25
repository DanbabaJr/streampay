/**
 * Minimal JSON Schema validator for the indexer's OpenAPI contract tests
 * (issue #480).
 *
 * It deliberately implements only the keywords `indexer/openapi.json` uses —
 * `$ref`, `type`, `const`, `enum`, `required`, `properties`,
 * `additionalProperties`, `items`, `oneOf`, `anyOf`, `allOf`, `minimum`,
 * `maximum`, `pattern`, `minItems` and `maxItems` — so the contract suite needs
 * no new dependency. Annotation-only keywords (`description`, `example`,
 * `default`, `format`) are ignored.
 *
 * The goal is drift detection against the committed document, not general
 * JSON Schema conformance: if a schema in the spec uses a keyword this file
 * does not know, `assertKnownKeywords` reports it instead of silently passing.
 */

export type JsonSchema = Record<string, unknown> | boolean;

export interface ValidationError {
  /** JSON-pointer-ish path to the offending value, e.g. `$[0].depth.pending`. */
  path: string;
  message: string;
}

const KNOWN_KEYWORDS = new Set([
  "$ref",
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "oneOf",
  "anyOf",
  "allOf",
  "minimum",
  "maximum",
  "pattern",
  "minItems",
  "maxItems",
  "default",
  "example",
  "examples",
  "format",
]);

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith("#/")) {
    throw new Error(`unsupported $ref (only local refs are supported): ${ref}`);
  }
  let node: unknown = root;
  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") {
      throw new Error(`$ref does not resolve: ${ref}`);
    }
    node = (node as Record<string, unknown>)[part];
  }
  if (node === undefined) throw new Error(`$ref does not resolve: ${ref}`);
  return node as JsonSchema;
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      throw new Error(`unsupported JSON Schema type: ${type}`);
  }
}

/**
 * Validate `value` against `schema`. `root` is the OpenAPI document (or any
 * object holding the components) used to resolve local `$ref`s.
 */
export function validateSchema(
  schema: JsonSchema,
  value: unknown,
  root: JsonSchema,
  path = "$",
): ValidationError[] {
  if (schema === true) return [];
  if (schema === false) return [{ path, message: "schema is false: no value is allowed" }];

  const errors: ValidationError[] = [];

  if (typeof schema.$ref === "string") {
    return validateSchema(resolveRef(root, schema.$ref), value, root, path);
  }

  if ("const" in schema && value !== schema.const) {
    errors.push({ path, message: `expected ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
    errors.push({ path, message: `expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}` });
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((type) => typeMatches(type, value))) {
      errors.push({ path, message: `expected type ${types.join(" | ")}, got ${describe(value)}` });
      // A wrong base type makes the remaining keyword checks meaningless.
      return errors;
    }
  }

  if (typeof value === "string" && typeof schema.pattern === "string") {
    if (!new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `does not match pattern ${schema.pattern}: ${JSON.stringify(value)}` });
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}, got ${value}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}, got ${value}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push({ path, message: `expected at least ${schema.minItems} items, got ${value.length}` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push({ path, message: `expected at most ${schema.maxItems} items, got ${value.length}` });
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(schema.items as JsonSchema, item, root, `${path}[${index}]`));
      });
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;

    for (const required of (schema.required ?? []) as string[]) {
      if (!(required in record)) {
        errors.push({ path, message: `missing required property "${required}"` });
      }
    }

    for (const [key, propertyValue] of Object.entries(record)) {
      if (key in properties) {
        errors.push(...validateSchema(properties[key], propertyValue, root, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: "unexpected property (additionalProperties: false)" });
      } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        errors.push(
          ...validateSchema(schema.additionalProperties as JsonSchema, propertyValue, root, `${path}.${key}`),
        );
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as JsonSchema[]) {
      errors.push(...validateSchema(sub, value, root, path));
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const matches = (schema.anyOf as JsonSchema[]).some((sub) => validateSchema(sub, value, root, path).length === 0);
    if (!matches) errors.push({ path, message: "does not match any anyOf branch" });
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as JsonSchema[]).filter(
      (sub) => validateSchema(sub, value, root, path).length === 0,
    );
    if (matches.length !== 1) {
      errors.push({ path, message: `expected exactly one oneOf branch to match, matched ${matches.length}` });
    }
  }

  return errors;
}

/** Fail loudly when the spec grows a keyword the validator would silently skip. */
export function assertKnownKeywords(schema: JsonSchema, path = "#"): void {
  if (schema === true || schema === false) return;
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) {
      throw new Error(`openapi.json uses unsupported schema keyword "${keyword}" at ${path}`);
    }
  }
  const walk = (child: unknown, childPath: string): void => {
    if (Array.isArray(child)) {
      child.forEach((item, index) => walk(item, `${childPath}[${index}]`));
    } else if (child !== null && typeof child === "object") {
      assertKnownKeywords(child as JsonSchema, childPath);
    }
  };
  for (const key of ["properties", "items", "additionalProperties", "oneOf", "anyOf", "allOf"]) {
    if (key === "properties" && schema.properties) {
      for (const [name, sub] of Object.entries(schema.properties as Record<string, unknown>)) {
        walk(sub, `${path}/properties/${name}`);
      }
    } else if (key === "items") {
      walk(schema.items, `${path}/items`);
    } else if (key !== "properties") {
      walk(schema[key], `${path}/${key}`);
    }
  }
  // `enum`, `const`, `required`, `type` hold plain data, not sub-schemas.
}

export function formatErrors(errors: ValidationError[]): string {
  return errors.map((error) => `  ${error.path}: ${error.message}`).join("\n");
}
