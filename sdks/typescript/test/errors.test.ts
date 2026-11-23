import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  StreamPayError,
  decodeError,
  RETIRED_CONTRACT_ERROR_CODES,
  contractErrorMapping,
} from "../src/errors.js";
import {
  CONTRACT_ERRORS,
  contractErrorName,
  contractErrorFromMessage,
} from "../src/generated.js";

interface ContractErrorEntry {
  code: number;
  name: string;
  retired: boolean;
}

export function parseContractErrorRegistry(
  errorsSource: string,
  surfaceSource: string
): ContractErrorEntry[] {
  const enumMatch = /pub enum StreamError\s*\{([\s\S]*?)^\}/m.exec(errorsSource);
  if (!enumMatch) {
    throw new Error("StreamError enum could not be parsed");
  }

  const entries: ContractErrorEntry[] = [];
  for (const rawLine of enumMatch[1]!.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,?\s*$/.exec(line);
    if (match) {
      entries.push({ code: Number(match[2]!), name: match[1]!, retired: false });
    }
  }

  if (entries.length === 0) {
    throw new Error("no StreamError discriminants parsed");
  }

  const retiredMatch =
    /pub const RETIRED_CODES[^=]*=\s*&\[[\s\S]*?\];/.exec(surfaceSource);
  if (!retiredMatch) {
    throw new Error("RETIRED_CODES could not be parsed");
  }
  const retiredNames = new Set(
    [...retiredMatch[0].matchAll(/StreamError::([A-Za-z_][A-Za-z0-9_]*)/g)].map(
      (match) => match[1]
    )
  );

  for (const entry of entries) {
    entry.retired = retiredNames.has(entry.name);
  }
  return entries;
}

export function readContractErrorRegistry(
  errorsPath: string,
  surfacePath: string
): ContractErrorEntry[] {
  if (!existsSync(errorsPath)) throw new Error(`contract error source unreadable: ${errorsPath}`);
  if (!existsSync(surfacePath)) throw new Error(`retired-code source unreadable: ${surfacePath}`);
  return parseContractErrorRegistry(
    readFileSync(errorsPath, "utf8"),
    readFileSync(surfacePath, "utf8")
  );
}

export function validateContractErrorMappings(
  contractEntries: ContractErrorEntry[],
  sdkMappings: Readonly<Record<number, string>>,
  retiredMappings: ReadonlySet<number>
): void {
  if (contractEntries.length === 0) {
    throw new Error("contract error enumeration is empty");
  }

  const contractByCode = new Map(contractEntries.map((entry) => [entry.code, entry]));
  if (contractByCode.size !== contractEntries.length) {
    throw new Error("contract error enumeration contains duplicate codes");
  }

  const contractNames = new Set<string>();
  for (const entry of contractEntries) {
    if (contractNames.has(entry.name)) {
      throw new Error(`contract error name duplicated: ${entry.name}`);
    }
    contractNames.add(entry.name);
  }

  const missing: string[] = [];
  const wrongNames: string[] = [];
  const sdkNames = new Set<string>();
  for (const entry of contractEntries) {
    const sdkName = sdkMappings[entry.code];
    if (sdkName === undefined) {
      missing.push(`${entry.code}:${entry.name}`);
      continue;
    }
    if (sdkName !== entry.name) {
      wrongNames.push(`${entry.code}:${entry.name} (SDK=${sdkName})`);
    }
    if (sdkNames.has(sdkName)) {
      throw new Error(`SDK error name duplicated: ${sdkName}`);
    }
    sdkNames.add(sdkName);
  }

  if (missing.length > 0) {
    throw new Error(`missing SDK mappings: ${missing.join(", ")}`);
  }
  if (wrongNames.length > 0) {
    throw new Error(`SDK mappings point to the wrong contract name: ${wrongNames.join(", ")}`);
  }

  for (const entry of contractEntries) {
    if (entry.retired && !retiredMappings.has(entry.code)) {
      throw new Error(`retired contract code ${entry.code}:${entry.name} is not marked retired in the SDK`);
    }
    if (!entry.retired && retiredMappings.has(entry.code)) {
      throw new Error(`active contract code ${entry.code}:${entry.name} is marked retired in the SDK`);
    }
  }

  for (const [codeText, sdkName] of Object.entries(sdkMappings)) {
    const code = Number(codeText);
    const contractEntry = contractByCode.get(code);
    if (contractEntry === undefined && !retiredMappings.has(code)) {
      throw new Error(`SDK maps unknown contract code ${code}:${sdkName}`);
    }
  }
}

test("contract error codes map to names", () => {
  assert.equal(contractErrorName(10), "AmountExceedsAvailable");
  assert.equal(contractErrorName(999), undefined);
  assert.equal(contractErrorFromMessage("HostError: Error(Contract, #13)"), 13);
  assert.equal(contractErrorFromMessage("network down"), undefined);
});

test("simulation failures keep the contract code", () => {
  const error = StreamPayError.fromRpc(
    "simulation",
    "HostError: Error(Contract, #10)",
    "AAAA"
  );
  assert.equal(error.kind, "simulation");
  assert.deepEqual(error.contract, { code: 10, name: "AmountExceedsAvailable" });
  assert.match(error.message, /simulation failed: AmountExceedsAvailable \(#10\)/);
  assert.equal(error.transactionXdr, "AAAA");
});

test("submission failures without a contract code are still classified", () => {
  const error = StreamPayError.fromRpc("submission", "tx_bad_seq");
  assert.equal(error.kind, "submission");
  assert.equal(error.contract, undefined);
  assert.match(error.message, /submission failed: tx_bad_seq/);
});

test("decode failures are their own class", () => {
  const error = decodeError("expected u64, got bool");
  assert.equal(error.kind, "decode");
  assert.match(error.message, /decode failed/);
});

const rootUrl = new URL("../../../../", import.meta.url);
const errorsRsUrl = new URL("contracts/streaming-payments/src/errors.rs", rootUrl);
const surfaceRsUrl = new URL("contracts/streaming-payments/src/surface.rs", rootUrl);

test("every contract error code has an exact SDK mapping", () => {
  const contractEntries = readContractErrorRegistry(
    fileURLToPath(errorsRsUrl),
    fileURLToPath(surfaceRsUrl)
  );

  assert.ok(contractEntries.length >= 99, "contract error enumeration unexpectedly empty");
  const sorted = [...contractEntries].sort((a, b) => a.code - b.code);
  assert.equal(sorted[0]!.code, 1);
  assert.equal(
    sorted.length,
    sorted.at(-1)!.code,
    "contract error codes must remain contiguous"
  );

  validateContractErrorMappings(
    contractEntries,
    CONTRACT_ERRORS,
    RETIRED_CONTRACT_ERROR_CODES
  );
});

test("retired contract codes are explicitly represented", () => {
  assert.deepEqual([...RETIRED_CONTRACT_ERROR_CODES].sort((a, b) => a - b), [2, 3]);
  assert.deepEqual(contractErrorMapping(2), {
    code: 2,
    name: "NotStreamSender",
    retired: true,
  });
  assert.deepEqual(contractErrorMapping(3), {
    code: 3,
    name: "NotStreamRecipient",
    retired: true,
  });
  assert.deepEqual(contractErrorMapping(125), {
    code: 125,
    name: "InvalidHookSelector",
    retired: false,
  });
});

test("contract names and docs pages stay aligned", () => {
  const contractEntries = readContractErrorRegistry(
    fileURLToPath(errorsRsUrl),
    fileURLToPath(surfaceRsUrl)
  );
  const catalog = readFileSync(
    fileURLToPath(new URL("frontend/lib/errors.ts", rootUrl)),
    "utf8"
  );
  const surface = readFileSync(
    fileURLToPath(new URL("docs/ERROR_SURFACE.md", rootUrl)),
    "utf8"
  );

  for (const entry of contractEntries) {
    const pagePath = fileURLToPath(
      new URL(`docs/errors/${entry.code}.md`, rootUrl)
    );
    assert.ok(existsSync(pagePath), `missing docs page for ${entry.code}:${entry.name}`);
    const page = readFileSync(pagePath, "utf8");
    assert.match(page, new RegExp(`Variant Name.*${entry.name}`));
    assert.match(page, new RegExp(`\\"variant\\": \\"${entry.name}\\"`));
    assert.match(catalog, new RegExp(`^\\s*${entry.code}:\\s*\\{\\s*code:\\s*${entry.code},\\s*name:\\s*"${entry.name}"`, "m"));
    assert.match(surface, new RegExp(`\\| ${entry.code} \\| \`${entry.name}\` \\|`));
  }
});

test("completeness gate names exact missing mappings", () => {
  const contractEntries = readContractErrorRegistry(
    fileURLToPath(errorsRsUrl),
    fileURLToPath(surfaceRsUrl)
  );
  const sdkMappings = { ...CONTRACT_ERRORS } as Record<number, string>;
  delete sdkMappings[10];

  assert.throws(
    () => validateContractErrorMappings(
      contractEntries,
      sdkMappings,
      RETIRED_CONTRACT_ERROR_CODES
    ),
    /missing SDK mappings: 10:AmountExceedsAvailable/
  );
});

test("enumeration self-check rejects empty and unreadable sources", () => {
  assert.throws(
    () => parseContractErrorRegistry("", ""),
    /StreamError enum could not be parsed/
  );
  assert.throws(
    () => parseContractErrorRegistry(
      "pub enum StreamError {\nStreamNotFound = 1,\n}",
      ""
    ),
    /RETIRED_CODES could not be parsed/
  );
  assert.throws(
    () => readContractErrorRegistry(
      fileURLToPath(new URL("does-not-exist-errors.rs", rootUrl)),
      fileURLToPath(surfaceRsUrl)
    ),
    /contract error source unreadable/
  );
  assert.throws(
    () => validateContractErrorMappings([], CONTRACT_ERRORS, RETIRED_CONTRACT_ERROR_CODES),
    /contract error enumeration is empty/
  );
});
