/**
 * Plugin validation (issue #580).
 *
 * A plugin is accepted only if it is a well-formed WASM module that can run
 * under the pure transform ABI with no host imports at all:
 *
 *   - `WebAssembly.validate` passes;
 *   - it declares **no imports** — the import allowlist is empty, so any
 *     import is rejected, and I/O / network / state-mutating imports are
 *     named in the error (`env.fetch`, `wasi_snapshot_preview1.fd_write`,
 *     …) rather than failing silently;
 *   - it exports `memory` and `transform`;
 *   - its declared linear memory has a maximum, and that maximum (and its
 *     initial size) is within the configured page cap — a module that
 *     declares no maximum could grow without bound, so it is rejected;
 *   - it has no `start` section — a start function would run arbitrary code
 *     at instantiation time, outside the transform call the host budgets.
 *
 * Validation never instantiates the module: instantiation would execute data
 * segments and a start function, so the memory limits are read by parsing
 * the binary's memory section directly (a small LEB128 section walk), and
 * imports/exports come from `WebAssembly.Module.imports/exports`.
 */
import {
  MAX_MEMORY_PAGES,
  MAX_PLUGIN_BYTES,
  type PluginLimits,
  resolveLimits,
} from "./abi.js";

export class PluginValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginValidationError";
    this.code = code;
  }
}

interface MemoryInfo {
  initial: number;
  maximum: number | null;
}

function readUleb(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= bytes.length) throw new PluginValidationError("malformed", "truncated LEB128 in module");
    const byte = bytes[pos];
    pos += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new PluginValidationError("malformed", "LEB128 value too large in module");
  }
  return { value, next: pos };
}

/** Walk the section table; returns the payload of each section found. */
function sections(bytes: Uint8Array): Array<{ id: number; payload: Uint8Array }> {
  if (bytes.length < 8) throw new PluginValidationError("malformed", "module too short for WASM header");
  let pos = 8;
  const out: Array<{ id: number; payload: Uint8Array }> = [];
  while (pos < bytes.length) {
    const id = bytes[pos];
    pos += 1;
    const { value: size, next } = readUleb(bytes, pos);
    pos = next;
    if (pos + size > bytes.length) throw new PluginValidationError("malformed", "section overruns module");
    out.push({ id, payload: bytes.subarray(pos, pos + size) });
    pos += size;
  }
  return out;
}

function parseMemorySection(bytes: Uint8Array): MemoryInfo[] {
  const found = sections(bytes).find((s) => s.id === 5);
  if (!found) return [];
  const payload = found.payload;
  const { value: count, next } = readUleb(payload, 0);
  const memories: MemoryInfo[] = [];
  let pos = next;
  for (let i = 0; i < count; i++) {
    if (pos >= payload.length) throw new PluginValidationError("malformed", "truncated memory section");
    const flags = payload[pos];
    pos += 1;
    const initial = readUleb(payload, pos);
    pos = initial.next;
    if (flags === 0x01) {
      const maximum = readUleb(payload, pos);
      pos = maximum.next;
      memories.push({ initial: initial.value, maximum: maximum.value });
    } else if (flags === 0x00) {
      memories.push({ initial: initial.value, maximum: null });
    } else {
      throw new PluginValidationError("malformed", `unsupported memory limits flags 0x${flags.toString(16)}`);
    }
  }
  return memories;
}

function hasStartSection(bytes: Uint8Array): boolean {
  return sections(bytes).some((s) => s.id === 8);
}

export interface ValidatedPlugin {
  module: WebAssembly.Module;
  memory: MemoryInfo;
}

/**
 * Validate `bytes` as a plugin module. Returns the compiled module and its
 * memory declaration. Throws `PluginValidationError` (with a stable `code`)
 * for anything that must not run.
 */
export function validatePlugin(bytes: Uint8Array, limits: PluginLimits = {}): ValidatedPlugin {
  const resolved = resolveLimits(limits);
  if (bytes.length === 0) throw new PluginValidationError("empty", "plugin is empty");
  if (bytes.length > resolved.maxPluginBytes) {
    throw new PluginValidationError(
      "too_large",
      `plugin is ${bytes.length} bytes, over the ${resolved.maxPluginBytes} byte limit`,
    );
  }
  if (!WebAssembly.validate(bytes as BufferSource)) {
    throw new PluginValidationError("invalid_wasm", "bytes are not a valid WebAssembly module");
  }
  const module = new WebAssembly.Module(bytes as BufferSource);

  // No imports at all: the pure ABI needs no host functions, so every import
  // — WASI, env, or anything else — is a capability the sandbox must not have.
  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    const first = imports[0];
    const names = imports.map((i) => `${i.module}.${i.name}`).join(", ");
    throw new PluginValidationError(
      "forbidden_import",
      `plugin imports ${names}; plugins must have no imports (first: ${first.module}.${first.name})`,
    );
  }

  const exports = WebAssembly.Module.exports(module);
  const kinds = new Map(exports.map((e) => [e.name, e.kind]));
  if (kinds.get("memory") !== "memory") {
    throw new PluginValidationError("missing_memory", 'plugin must export linear memory as "memory"');
  }
  if (kinds.get("transform") !== "function") {
    throw new PluginValidationError("missing_transform", 'plugin must export a function named "transform"');
  }

  if (hasStartSection(bytes)) {
    throw new PluginValidationError("start_section", "plugin must not have a start function");
  }

  const memories = parseMemorySection(bytes);
  if (memories.length !== 1) {
    throw new PluginValidationError("memory", `plugin must declare exactly one memory, found ${memories.length}`);
  }
  const memory = memories[0];
  if (memory.initial < 1) {
    throw new PluginValidationError("memory", "plugin memory must start with at least 1 page");
  }
  if (memory.maximum === null) {
    throw new PluginValidationError(
      "memory_unbounded",
      "plugin memory must declare a maximum number of pages",
    );
  }
  if (memory.maximum > resolved.maxMemoryPages) {
    throw new PluginValidationError(
      "memory_too_large",
      `plugin memory maximum is ${memory.maximum} pages, over the ${resolved.maxMemoryPages} page limit`,
    );
  }
  if (memory.initial > memory.maximum) {
    throw new PluginValidationError("memory", "plugin memory initial size exceeds its maximum");
  }
  return { module, memory };
}
