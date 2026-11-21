//! The sentinel's cliff model is only correct if its constants and its
//! understanding of the contract's TTL behaviour stay in sync with
//! `contracts/streaming-payments/src/stream.rs`. These tests read that file
//! and fail on drift — including the *absence* of a TTL extension on the
//! counter, which is what makes its 4095-ledger cliff real.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CONTRACT_TTL_EXTEND_LEDGERS, CONTRACT_TTL_THRESHOLD_LEDGERS } from '../src/constants.js';

// dist/test/constants-sync.test.js → up 4 = repo root
const STREAM_RS = new URL('../../../../contracts/streaming-payments/src/stream.rs', import.meta.url);
const LIB_RS = new URL('../../../../contracts/streaming-payments/src/lib.rs', import.meta.url);

function source(url: URL): string {
  return readFileSync(url, 'utf8');
}

function constValue(src: string, name: string): number {
  const match = new RegExp(`${name}\\s*:\\s*u32\\s*=\\s*([0-9_]+)`).exec(src);
  assert.ok(match, `could not find ${name} in the contract source`);
  return Number((match[1] as string).replace(/_/g, ''));
}

const FN_DEF = /^(?:pub(?:\([^)]*\))?\s+)?fn\s+([a-zA-Z_][a-zA-Z_0-9]*)[<(]/gm;

/**
 * Every function *defined* in this file, keyed by name (line-anchored, so doc
 * references like `[`page_stream_ids`]` and call sites are not definitions).
 */
function definitions(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(FN_DEF)) {
    const name = m[1];
    if (!name) continue;
    if (out.has(name)) continue; // first definition wins, as the compiler would
    const start = (m.index ?? 0) + m[0].length - name.length - 1;
    const open = src.indexOf('{', start);
    assert.ok(open >= 0, `definition \`${name}\` has no body`);
    out.set(name, braceBlock(src, open));
  }
  return out;
}

function braceBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced braces');
}

/**
 * The body of a function plus the bodies of the same-file functions it calls,
 * transitively. A one-line wrapper is a legitimate way to share a
 * read-modify-write-and-extend body, so a guard that looked only at the wrapper
 * would fail on a refactor that changed nothing about the on-chain behaviour —
 * and would pass on a wrapper whose delegate had quietly stopped extending.
 */
function bodyTree(defs: Map<string, string>, root: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const queue = [root];
  while (queue.length) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const body = defs.get(name);
    assert.ok(body, `could not find a definition for \`${name}\` in stream.rs`);
    parts.push(body);
    for (const call of body.matchAll(/([a-zA-Z_][a-zA-Z_0-9]*)\s*\(/g)) {
      const callee = call[1] as string;
      if (defs.has(callee) && !seen.has(callee)) queue.push(callee);
    }
  }
  return parts.join('\n');
}

// The persistent-key extension shape the sentinel's cliff model depends on:
// `extend_ttl(<key>, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS)`.
const EXTEND_PERSISTENT =
  /extend_ttl\(\s*&?key\s*,\s*TTL_THRESHOLD_LEDGERS\s*,\s*TTL_EXTEND_LEDGERS\s*\)/;

test('TTL constants match the contract', () => {
  const src = source(STREAM_RS);
  assert.equal(constValue(src, 'TTL_THRESHOLD_LEDGERS'), CONTRACT_TTL_THRESHOLD_LEDGERS);
  assert.equal(constValue(src, 'TTL_EXTEND_LEDGERS'), CONTRACT_TTL_EXTEND_LEDGERS);
});

test('stream writes do extend the TTL (200k → 500k)', () => {
  assert.match(bodyTree(definitions(source(STREAM_RS)), 'put_stream'), EXTEND_PERSISTENT);
});

test('index writes and reads extend the TTL', () => {
  const defs = definitions(source(STREAM_RS));
  // push_to_index appends; page_stream_ids is the public read — currently a thin
  // wrapper over page_stream_ids_with_len, and the guard follows that delegation
  // rather than demanding the call sit inline in the wrapper.
  assert.match(bodyTree(defs, 'push_to_index'), EXTEND_PERSISTENT);
  assert.match(bodyTree(defs, 'page_stream_ids'), EXTEND_PERSISTENT);
  // The withdraw_all work split paging into a length-returning core and added an
  // index prune; both read and write the same key, so both are under the guard.
  assert.match(bodyTree(defs, 'page_stream_ids_with_len'), EXTEND_PERSISTENT);
  assert.match(bodyTree(defs, 'remove_from_index'), EXTEND_PERSISTENT);
});

test('the counter is NEVER extended — its cliff is min_persistent_entry_ttl', () => {
  // Delegation-aware too: a counter that extended through a helper would break
  // the cliff model exactly as loudly as one that extended inline.
  const body = bodyTree(definitions(source(STREAM_RS)), 'next_stream_id');
  assert.doesNotMatch(body, /extend_ttl/, 'a counter extension would invalidate the 4095-ledger cliff model');
  // It also treats a missing entry as id 1 — which is why an archived counter
  // is a creation-liveness incident, not a silent state corruption.
  assert.match(body, /unwrap_or\(1\)/);
});

test('the contract never extends its instance or code entries', () => {
  const src = source(STREAM_RS) + source(LIB_RS);
  assert.doesNotMatch(src, /instance\(\)\.extend_ttl/, 'instance/code cliffs assume no on-chain extension');
  assert.doesNotMatch(src, /extend_ttl_instance/, 'instance/code cliffs assume no on-chain extension');
});
