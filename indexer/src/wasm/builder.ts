/**
 * Minimal hand-rolled WASM module builder (issue #580).
 *
 * There is no WAT toolchain in this repo (no `wat2wasm`, no Rust), so the
 * example plugins and the hostile plugins used by the tests are built here
 * by encoding the binary format directly: LEB128 values, sections, and a
 * tiny structured assembler for function bodies. Nothing here is a
 * dependency of the plugin *host* — the host only ever consumes opaque
 * bytes — but these builders are the reference for what a valid plugin
 * looks like, and the example plugin is
 * `buildDropIfContainsPlugin("withdrawn")`.
 *
 * All builders produce modules that satisfy the ABI in `abi.ts`: no
 * imports, one memory (initial 1 page, maximum {@link MAX_MEMORY_PAGES}),
 * exports `memory` + `transform(inputPtr, inputLen) -> outputLen`.
 */
import {
  INPUT_OFFSET,
  MAX_MEMORY_PAGES,
  OUTPUT_OFFSET,
  PLUGIN_DATA_OFFSET,
} from "./abi.js";

// ── LEB128 ──────────────────────────────────────────────────────────────────

function uleb(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function sleb(value: number): number[] {
  const out: number[] = [];
  let v = value | 0;
  for (;;) {
    let byte = v & 0x7f;
    v >>= 7;
    const signBit = byte & 0x40;
    if ((v === 0 && !signBit) || (v === -1 && signBit)) {
      out.push(byte);
      break;
    }
    out.push(byte | 0x80);
  }
  return out;
}

function vec(items: number[][]): number[] {
  const out = uleb(items.length);
  for (const item of items) out.push(...item);
  return out;
}

function nameBytes(name: string): number[] {
  const bytes = new TextEncoder().encode(name);
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

// ── Structured assembler ────────────────────────────────────────────────────
// Labels are lexically scoped; `br`/`brIf` resolve a label name to the
// branch depth from the current frame stack.

class Asm {
  bytes: number[] = [];
  private frames: Array<{ name: string; kind: "block" | "loop" | "if" }> = [];

  u8(...ops: number[]): this {
    this.bytes.push(...ops);
    return this;
  }
  i32Const(value: number): this {
    return this.u8(0x41, ...sleb(value));
  }
  localGet(index: number): this {
    return this.u8(0x20, ...uleb(index));
  }
  localSet(index: number): this {
    return this.u8(0x21, ...uleb(index));
  }
  i32Add(): this {
    return this.u8(0x6a);
  }
  i32Sub(): this {
    return this.u8(0x6b);
  }
  i32Eq(): this {
    return this.u8(0x46);
  }
  i32GeU(): this {
    return this.u8(0x4f);
  }
  /** `i32.load8_u`, alignment 0, offset 0; address is on the stack. */
  load8U(): this {
    return this.u8(0x2d, 0x00, 0x00);
  }
  /** `memory.copy dest src size`, all on the stack. */
  memoryCopy(): this {
    return this.u8(0xfc, 0x0a, 0x00, 0x00);
  }
  /** `memory.grow size` (size on the stack); returns previous pages or -1. */
  memoryGrow(): this {
    return this.u8(0x40, 0x00);
  }
  drop(): this {
    return this.u8(0x1a);
  }
  return_(): this {
    return this.u8(0x0f);
  }
  unreachable(): this {
    return this.u8(0x00);
  }
  block(name: string): this {
    this.u8(0x02, 0x40);
    this.frames.push({ name, kind: "block" });
    return this;
  }
  loop(name: string): this {
    this.u8(0x03, 0x40);
    this.frames.push({ name, kind: "loop" });
    return this;
  }
  if_(): this {
    this.u8(0x04, 0x40);
    this.frames.push({ name: "", kind: "if" });
    return this;
  }
  else_(): this {
    return this.u8(0x05);
  }
  end(): this {
    if (this.frames.length === 0) throw new Error("asm: end() with no open frame");
    this.frames.pop();
    return this.u8(0x0b);
  }
  private depth(name: string): number {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].name === name) return this.frames.length - 1 - i;
    }
    throw new Error(`asm: unknown label ${name}`);
  }
  br(name: string): this {
    return this.u8(0x0c, ...uleb(this.depth(name)));
  }
  brIf(name: string): this {
    return this.u8(0x0d, ...uleb(this.depth(name)));
  }
}

// ── Module assembly ─────────────────────────────────────────────────────────

interface FuncDef {
  /** Locals as [count, valueType] entries; 0x7f is i32. */
  locals?: Array<[number, number]>;
  code: number[];
}

interface ModuleOptions {
  imports?: Array<{ module: string; name: string }>;
  /** Omit the memory section entirely (invalid plugin, for tests). */
  memory?: boolean;
  memoryInitial?: number;
  /** `null` declares no maximum (invalid plugin, for tests). */
  memoryMax?: number | null;
  exportMemory?: boolean;
  exportTransform?: boolean;
  funcs: FuncDef[];
  data?: Array<{ offset: number; bytes: Uint8Array }>;
}

function buildModule(opts: ModuleOptions): Uint8Array {
  const bytes: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const importedFuncCount = opts.imports?.length ?? 0;

  // Type section: one type, (i32, i32) -> i32.
  bytes.push(...section(1, vec([[0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f]])));

  // Import section.
  if (opts.imports && opts.imports.length > 0) {
    bytes.push(
      ...section(
        2,
        vec(
          opts.imports.map((imp) => [
            ...nameBytes(imp.module),
            ...nameBytes(imp.name),
            0x00, // function import
            0x00, // type 0
          ]),
        ),
      ),
    );
  }

  // Function section: every defined function uses type 0.
  bytes.push(...section(3, vec(opts.funcs.map(() => [0x00]))));

  // Memory section.
  if (opts.memory !== false) {
    const initial = opts.memoryInitial ?? 1;
    const max = opts.memoryMax === undefined ? MAX_MEMORY_PAGES : opts.memoryMax;
    const limits = max === null ? [0x00, ...uleb(initial)] : [0x01, ...uleb(initial), ...uleb(max)];
    bytes.push(...section(5, vec([limits])));
  }

  // Export section.
  const exports: number[][] = [];
  if (opts.exportMemory !== false && opts.memory !== false) {
    exports.push([...nameBytes("memory"), 0x02, 0x00]);
  }
  if (opts.exportTransform !== false) {
    // Defined functions follow imported ones in the function index space.
    exports.push([...nameBytes("transform"), 0x00, ...uleb(importedFuncCount)]);
  }
  if (exports.length > 0) bytes.push(...section(7, vec(exports)));

  // Code section.
  bytes.push(
    ...section(
      10,
      vec(
        opts.funcs.map((fn) => {
          const locals = vec((fn.locals ?? []).map(([count, type]) => [...uleb(count), type]));
          const body = [...locals, ...fn.code, 0x0b];
          return [...uleb(body.length), ...body];
        }),
      ),
    ),
  );

  // Data section: active segments into memory 0.
  if (opts.data && opts.data.length > 0) {
    bytes.push(
      ...section(
        11,
        vec(
          opts.data.map((seg) => [
            0x00,
            0x41,
            ...sleb(seg.offset),
            0x0b,
            ...uleb(seg.bytes.length),
            ...seg.bytes,
          ]),
        ),
      ),
    );
  }
  return new Uint8Array(bytes);
}

/** Copy the input JSON to the output slot and return its length. */
export function buildPassthroughPlugin(): Uint8Array {
  const asm = new Asm();
  asm.i32Const(OUTPUT_OFFSET).localGet(0).localGet(1).memoryCopy().localGet(1);
  return buildModule({ funcs: [{ code: asm.bytes }] });
}

/**
 * Always reply with the same JSON, whatever the input is. Used for
 * projection plugins: the reply's `data` becomes the event's new data.
 */
export function buildConstOutputPlugin(json: string): Uint8Array {
  const payload = new TextEncoder().encode(json);
  const asm = new Asm();
  asm
    .i32Const(OUTPUT_OFFSET)
    .i32Const(PLUGIN_DATA_OFFSET)
    .i32Const(payload.length)
    .memoryCopy()
    .i32Const(payload.length);
  return buildModule({
    funcs: [{ code: asm.bytes }],
    data: [{ offset: PLUGIN_DATA_OFFSET, bytes: payload }],
  });
}

/**
 * Drop the event when the serialised input JSON contains `needle` as a
 * substring, otherwise pass it through unchanged. The needle is matched
 * with a single-pass scan (no self-overlapping needles: the scan restarts
 * at the first needle byte on a mismatch, which is exact when the needle
 * has no proper prefix that is also a suffix — true for "withdrawn").
 */
export function buildDropIfContainsPlugin(needle: string): Uint8Array {
  if (needle.length === 0) throw new Error("needle must not be empty");
  const needleBytes = new TextEncoder().encode(needle);
  const asm = new Asm();
  // locals: 2 = i, 3 = matched, 4 = current byte.
  asm.i32Const(0).localSet(2);
  asm.i32Const(0).localSet(3);
  asm.block("exit");
  asm.loop("loop");
  // if (i >= inputLen) break;
  asm.localGet(2).localGet(1).i32GeU().brIf("exit");
  // b = input[inputPtr + i]
  asm.localGet(0).localGet(2).i32Add().load8U().localSet(4);
  // if (b == needle[matched]) { matched++; if (matched == needleLen) return DROP; }
  asm.localGet(4).i32Const(PLUGIN_DATA_OFFSET).localGet(3).i32Add().load8U().i32Eq();
  asm.if_();
  asm.localGet(3).i32Const(1).i32Add().localSet(3);
  asm.localGet(3).i32Const(needleBytes.length).i32Eq();
  asm.if_();
  asm.i32Const(-1).return_();
  asm.end();
  asm.else_();
  // else if (b == needle[0]) matched = 1; else matched = 0;
  asm.localGet(4).i32Const(PLUGIN_DATA_OFFSET).load8U().i32Eq();
  asm.if_();
  asm.i32Const(1).localSet(3);
  asm.else_();
  asm.i32Const(0).localSet(3);
  asm.end();
  asm.end();
  asm.localGet(2).i32Const(1).i32Add().localSet(2);
  asm.br("loop");
  asm.end(); // loop
  asm.end(); // block
  asm.i32Const(OUTPUT_OFFSET).localGet(0).localGet(1).memoryCopy().localGet(1);
  return buildModule({
    funcs: [{ locals: [[3, 0x7f]], code: asm.bytes }],
    data: [{ offset: PLUGIN_DATA_OFFSET, bytes: needleBytes }],
  });
}

/**
 * Enrichment plugin: copy the input JSON to the output, inserting
 * `,"enriched":true` before the final `}`. Only valid for a non-empty JSON
 * object input (the only shape the host ever sends).
 */
export function buildEnrichPlugin(): Uint8Array {
  const suffix = new TextEncoder().encode(',"enriched":true}');
  const asm = new Asm();
  // copy inputLen-1 bytes (everything but the closing brace)
  asm.i32Const(OUTPUT_OFFSET).localGet(0).localGet(1).i32Const(1).i32Sub().memoryCopy();
  // copy the suffix to OUTPUT_OFFSET + inputLen - 1
  asm
    .i32Const(OUTPUT_OFFSET)
    .localGet(1)
    .i32Add()
    .i32Const(1)
    .i32Sub()
    .i32Const(PLUGIN_DATA_OFFSET)
    .i32Const(suffix.length)
    .memoryCopy();
  asm.localGet(1).i32Const(suffix.length - 1).i32Add();
  return buildModule({
    funcs: [{ code: asm.bytes }],
    data: [{ offset: PLUGIN_DATA_OFFSET, bytes: suffix }],
  });
}

/** A plugin that never returns: the worker timeout must kill it. */
export function buildInfiniteLoopPlugin(): Uint8Array {
  const asm = new Asm();
  // The trailing `i32.const 0` is dead code: the loop never exits, but the
  // validator still requires the (i32, i32) -> i32 function to leave a
  // value on the stack at fallthrough.
  asm.loop("l").br("l").end().i32Const(0);
  return buildModule({ funcs: [{ code: asm.bytes }] });
}

/**
 * A plugin that grows memory forever. Growth past the declared maximum
 * fails (returns -1) and the loop keeps spinning, so the worker timeout
 * must kill it — memory growth alone never escapes the budget.
 */
export function buildGrowLoopPlugin(): Uint8Array {
  const asm = new Asm();
  asm.loop("l").i32Const(1).memoryGrow().drop().br("l").end().i32Const(0);
  return buildModule({ funcs: [{ code: asm.bytes }] });
}

/** A plugin whose transform traps immediately (`unreachable`). */
export function buildTrapPlugin(): Uint8Array {
  return buildModule({ funcs: [{ code: new Asm().unreachable().bytes }] });
}

/** A plugin that returns a reply length above the output cap. */
export function buildHugeOutputLengthPlugin(): Uint8Array {
  return buildModule({ funcs: [{ code: new Asm().i32Const(99999).bytes }] });
}

/** A plugin that replies with bytes that are not JSON. */
export function buildInvalidOutputPlugin(): Uint8Array {
  return buildConstOutputPlugin("this is not json");
}

/** A plugin importing a host function — rejected at validation. */
export function buildIllegalImportPlugin(moduleName: string, importName: string): Uint8Array {
  const asm = new Asm();
  asm.i32Const(OUTPUT_OFFSET).localGet(0).localGet(1).memoryCopy().localGet(1);
  return buildModule({
    imports: [{ module: moduleName, name: importName }],
    funcs: [{ code: asm.bytes }],
  });
}

/** A passthrough plugin declaring the given memory maximum (in pages). */
export function buildPluginWithMemoryMax(maxPages: number | null, initialPages = 1): Uint8Array {
  const asm = new Asm();
  asm.i32Const(OUTPUT_OFFSET).localGet(0).localGet(1).memoryCopy().localGet(1);
  return buildModule({ funcs: [{ code: asm.bytes }], memoryMax: maxPages, memoryInitial: initialPages });
}

/** A module with no memory at all (invalid plugin, for tests). */
export function buildPluginWithoutMemory(): Uint8Array {
  return buildModule({ memory: false, exportMemory: false, funcs: [{ code: new Asm().i32Const(0).bytes }] });
}

/** A module with memory but no `transform` export (invalid plugin, for tests). */
export function buildPluginWithoutTransform(): Uint8Array {
  return buildModule({ exportTransform: false, funcs: [{ code: new Asm().i32Const(0).bytes }] });
}

export { INPUT_OFFSET };
