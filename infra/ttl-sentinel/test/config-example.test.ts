// The example config must stay loadable: it is the file the README tells
// operators to copy, so drift between it and the schema is a doc bug that
// fails CI instead of a support ticket.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { CLASS_CLIFFS } from '../src/cliff.js';

// dist/test/config-example.test.js → up 2 = infra/ttl-sentinel/
const EXAMPLE = fileURLToPath(new URL('../../ttl-sentinel.config.example.json', import.meta.url));

test('the example config parses and validates', () => {
  const cfg = loadConfig({ configPath: EXAMPLE, env: {} });

  assert.equal(cfg.contractId.length > 0, true, 'example must set a contract id');
  assert.equal(cfg.extender.enabled, false, 'the extender must ship disabled');
  assert.equal(cfg.extender.dryRun, true, 'the extender must ship in dry-run');
  assert.equal(cfg.extender.thresholdLedgers, 200_000);
  assert.equal(cfg.extender.extendTo, 500_000);
});

test('the example schedule keeps warnings inside every class cliff', () => {
  const cfg = loadConfig({ configPath: EXAMPLE, env: {} });

  for (const [cls, s] of Object.entries(cfg.schedules)) {
    const cliff = CLASS_CLIFFS[cls as keyof typeof CLASS_CLIFFS].worstCaseLedgers;
    assert.ok(
      s.warnLedgers < cliff,
      `${cls}: warnLedgers ${s.warnLedgers} must stay below the ${cliff}-ledger cliff`,
    );
  }
});

test('the example never points the sentinel at a secret baked into the file', () => {
  const cfg = loadConfig({ configPath: EXAMPLE, env: {} });

  // Only the *name* of the env var is configurable; a literal secret in a
  // config file would be committed by accident sooner or later.
  assert.match(cfg.extender.secretKeyEnv, /^[A-Z][A-Z0-9_]*$/);
  assert.doesNotThrow(() => JSON.stringify(cfg), 'config must stay JSON-serializable');
});
