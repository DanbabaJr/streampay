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

function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `could not find ${signature}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

test('TTL constants match the contract', () => {
  const src = source(STREAM_RS);
  assert.equal(constValue(src, 'TTL_THRESHOLD_LEDGERS'), CONTRACT_TTL_THRESHOLD_LEDGERS);
  assert.equal(constValue(src, 'TTL_EXTEND_LEDGERS'), CONTRACT_TTL_EXTEND_LEDGERS);
});

test('stream writes do extend the TTL (200k → 500k)', () => {
  const body = fnBody(source(STREAM_RS), 'pub fn put_stream');
  assert.match(body, /extend_ttl\(\s*&key,\s*TTL_THRESHOLD_LEDGERS,\s*TTL_EXTEND_LEDGERS\s*\)/);
});

test('index writes and reads extend the TTL', () => {
  const src = source(STREAM_RS);
  const push = fnBody(src, 'fn push_to_index');
  assert.match(push, /extend_ttl\(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS\)/);
  const page = fnBody(src, 'pub fn page_stream_ids');
  assert.match(page, /extend_ttl\(key, TTL_THRESHOLD_LEDGERS, TTL_EXTEND_LEDGERS\)/);
});

test('the counter is NEVER extended — its cliff is min_persistent_entry_ttl', () => {
  const body = fnBody(source(STREAM_RS), 'pub fn next_stream_id');
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
