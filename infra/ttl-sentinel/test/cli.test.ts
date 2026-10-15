import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { main } from '../src/cli.js';
import { CONTRACT_ID } from './fixtures.js';

function tempState(): string {
  return join(mkdtempSync(join(tmpdir(), 'ttl-sentinel-cli-')), 'state.json');
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test('rent --json prints a coherent offline projection', async () => {
  const { code, out } = await capture(() => main(['rent', '--streams', '100', '--addresses', '50', '--json']));
  assert.equal(code, 0);
  const parsed = JSON.parse(out) as {
    streams: number;
    addresses: number;
    sizes: { stream: number; index: number; code: number };
    rent: { totalXlmAtState: string; perStreamMonthlyXlmAtState: string; rows: { cls: string }[] };
  };
  assert.equal(parsed.streams, 100);
  assert.equal(parsed.addresses, 50);
  assert.equal(parsed.sizes.stream, 504);
  assert.ok(Number(parsed.rent.totalXlmAtState) > 0);
  assert.ok(parsed.rent.rows.some((r) => r.cls === 'code'), 'code rent is the dominant fixed cost');
});

test('rent honours --code-bytes and --state-size', async () => {
  const { out } = await capture(() => main(['rent', '--streams', '1', '--code-bytes', '1000', '--state-size', '0', '--json']));
  const parsed = JSON.parse(out) as { sizes: { code: number }; rent: { rows: { cls: string; bytesEach: number }[] } };
  assert.equal(parsed.sizes.code, 1000);
  assert.equal(parsed.rent.rows.find((r) => r.cls === 'code')?.bytesEach, 1000);
});

test('scan without a contract id fails loudly', async () => {
  await assert.rejects(() => main(['scan', '--state', tempState()]), /no contract id/);
});

test('extend refuses to run while the extender is disabled (read-only core)', async () => {
  await assert.rejects(
    () => main(['extend', '--contract', CONTRACT_ID, '--state', tempState()]),
    /extender is disabled/,
  );
});

test('unknown commands exit with code 2 and print usage', async () => {
  const { code, err } = await capture(() => main(['frobnicate']));
  assert.equal(code, 2);
  assert.match(err, /unknown command: frobnicate/);
});

test('--help prints usage without touching the network', async () => {
  const { code, out } = await capture(() => main(['--help']));
  assert.equal(code, 0);
  assert.match(out, /ttl-sentinel <command>/);
  assert.match(out, /OPTIONAL funded auto-extender/);
});
