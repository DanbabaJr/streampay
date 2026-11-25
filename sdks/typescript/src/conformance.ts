#!/usr/bin/env node
/**
 * Prints the canonical decoding of every vector for the cross-language
 * conformance runner.
 *
 *   node dist/src/conformance.js [vectorsDir]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SPEC_FINGERPRINT } from "./generated.js";
import { decodeVector, type VectorFile } from "./vectors.js";

function defaultVectorsDir(): string {
  return fileURLToPath(new URL("../../../vectors/", import.meta.url));
}

const dir = process.argv[2] ?? defaultVectorsDir();
const vectors: Record<string, unknown> = {};

for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
  const vector = JSON.parse(readFileSync(join(dir, file), "utf8")) as VectorFile;
  let decoded: unknown;
  try {
    decoded = decodeVector(vector);
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  vectors[vector.name] = decoded;
}

console.log(
  JSON.stringify({ sdk: "typescript", specFingerprint: SPEC_FINGERPRINT, vectors }, null, 2)
);
