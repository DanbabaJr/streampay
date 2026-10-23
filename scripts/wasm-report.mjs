#!/usr/bin/env node
// Size report for a built Soroban contract Wasm.
//
// Parses the Wasm binary format directly (no external dependencies) and
// prints a section table plus a per-function size breakdown mapped to
// exported entrypoint names. Used to measure the effect of size-reduction
// work (see docs/WASM_SIZE.md).
//
// Usage: node scripts/wasm-report.mjs <path/to/contract.wasm> [--json]

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const path = args.find((a) => !a.startsWith('--'));
if (!path) {
  console.error('usage: node scripts/wasm-report.mjs <contract.wasm> [--json]');
  process.exit(2);
}

const buf = readFileSync(path);

// --- LEB128 helpers ---------------------------------------------------------
class Cursor {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  byte() {
    if (this.pos >= this.buf.length) throw new Error('unexpected end of file');
    return this.buf[this.pos++];
  }
  varUint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  }
  bytes(n) {
    const out = this.buf.subarray(this.pos, this.pos + n);
    if (out.length !== n) throw new Error('unexpected end of file');
    this.pos += n;
    return out;
  }
  utf8(n) {
    return new TextDecoder().decode(this.bytes(n));
  }
}

const c = new Cursor(buf);
if (c.byte() !== 0x00 || c.byte() !== 0x61 || c.byte() !== 0x73 || c.byte() !== 0x6d) {
  console.error('not a wasm file');
  process.exit(1);
}
c.bytes(4); // version

const sections = [];
while (c.pos < buf.length) {
  const start = c.pos;
  const id = c.byte();
  const size = c.varUint();
  const payload = c.bytes(size);
  sections.push({ id, start, size, payload });
}

const sectionName = (s) => {
  if (s.id !== 0) return ['', 'type', 'import', 'function', 'table', 'memory', 'global', 'export', 'start', 'element', 'code', 'data', 'datacount'][s.id];
  const cur = new Cursor(s.payload);
  return cur.utf8(cur.varUint());
};

// --- imports & exports (to name function indices) ----------------------------
let importCount = 0;
const importSection = sections.find((s) => s.id === 2);
if (importSection) {
  const cur = new Cursor(importSection.payload);
  const n = cur.varUint();
  for (let i = 0; i < n; i++) {
    cur.utf8(cur.varUint()); // module
    cur.utf8(cur.varUint()); // name
    const kind = cur.byte();
    if (kind === 0) {
      cur.varUint(); // type index
      importCount++;
    } else if (kind === 1) {
      cur.byte(); cur.varUint(); cur.varUint();
    } else if (kind === 2) {
      cur.varUint();
    } else if (kind === 3) {
      cur.varUint(); cur.varUint();
    } else if (kind === 4) {
      cur.varUint(); cur.varUint();
    }
  }
}

const exportNames = new Map(); // function index -> export name
const exportSection = sections.find((s) => s.id === 7);
if (exportSection) {
  const cur = new Cursor(exportSection.payload);
  const n = cur.varUint();
  for (let i = 0; i < n; i++) {
    const name = cur.utf8(cur.varUint());
    const kind = cur.byte();
    const idx = cur.varUint();
    if (kind === 0) exportNames.set(idx, name);
  }
}

// --- per-function sizes from the code section --------------------------------
const functions = [];
const codeSection = sections.find((s) => s.id === 10);
if (codeSection) {
  const cur = new Cursor(codeSection.payload);
  const n = cur.varUint();
  for (let i = 0; i < n; i++) {
    const bodySize = cur.varUint();
    cur.bytes(bodySize);
    functions.push({ index: importCount + i, size: bodySize, name: exportNames.get(importCount + i) });
  }
}

// --- report ------------------------------------------------------------------
const total = buf.length;
const named = functions.filter((f) => f.name);
const namedBytes = named.reduce((a, f) => a + f.size, 0);

if (json) {
  console.log(JSON.stringify({
    file: path,
    total_bytes: total,
    sections: sections.map((s) => ({ name: sectionName(s) || `custom(${sectionName(s)})`, size: s.size })),
    functions: functions,
    named_function_bytes: namedBytes,
  }, null, 2));
} else {
  console.log(`# Wasm size report: ${path}`);
  console.log(`Total: ${total} bytes (${(total / 1024).toFixed(1)} KiB)\n`);
  console.log('## Sections');
  for (const s of sections) console.log(`  ${String(s.size).padStart(7)}  ${sectionName(s)}`);
  console.log('\n## Functions by size (exported entrypoints marked with *)');
  for (const f of [...functions].sort((a, b) => b.size - a.size).slice(0, 40)) {
    console.log(`  ${String(f.size).padStart(6)}  func[${f.index}]${f.name ? ` * ${f.name}` : ''}`);
  }
  console.log(`\nExported function bodies: ${named.length} (${namedBytes} bytes of ${functions.reduce((a, f) => a + f.size, 0)} code bytes)`);
}
