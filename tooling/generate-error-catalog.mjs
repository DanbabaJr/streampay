#!/usr/bin/env node
/**
 * Error Catalog & Client Mapping Generator (Issue #221)
 *
 * Generates:
 *   - docs/errors.md (authoritative index catalog with version stamp)
 *   - docs/errors/{code}.md (individual detailed pages with remediation & cross-links)
 *   - frontend/lib/errors.ts (full 1..N client mapping with describeError fallback)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ERRORS_RS = resolve(ROOT, 'contracts/streaming-payments/src/errors.rs');
const SURFACE_RS = resolve(ROOT, 'contracts/streaming-payments/src/surface.rs');

const errorsContent = readFileSync(ERRORS_RS, 'utf8');
const surfaceContent = readFileSync(SURFACE_RS, 'utf8');

// Deterministic schema fingerprint: derived from the catalog's actual source
// content, NOT from HEAD or the environment. The CI regeneration-diff gate
// (`node tooling/generate-error-catalog.mjs && git diff --exit-code ...`)
// requires that regenerating the same tree always reproduces byte-identical
// output, so nothing volatile (git sha, timestamps) may appear in generated
// files. Line endings are normalized first: a contributor on Windows (CRLF
// working tree) and CI on Linux (LF) must compute the same fingerprint.
const norm = (s) => s.replace(/\r\n/g, '\n');
const schemaFingerprint = createHash('sha256')
  .update(norm(errorsContent))
  .update(norm(surfaceContent))
  .digest('hex')
  .slice(0, 16);

// Parse enum StreamError variants
const variantRegex = /^\s*([A-Za-z0-9_]+)\s*=\s*(\d+),/gm;
const variants = [];
let match;
while ((match = variantRegex.exec(errorsContent)) !== null) {
  variants.push({
    name: match[1],
    code: parseInt(match[2], 10),
  });
}

// Verification probes are *derived*, never curated.
//
// Each error page links to the code that proves the failure is reachable. Those
// links used to be hand-written per code, and most of them named test functions
// that do not exist — a reader (or an auditor) clicking one landed on a dead
// symbol, and `scripts/check_docs_links.mjs` reported ~50 warnings on every CI
// run. Deriving them from the branch registry makes the catalog structurally
// honest: `surface.rs::Branch::error()` is the same file the contract's coverage
// test walks, so a code that has a branch has a real probe, and one that does
// not is retired.
//
// Everything emitted here is re-checked against the source before writing, so a
// future refactor that renames a branch or a test fails generation instead of
// silently shipping a dead link.
const fileCache = new Map();
const sourceOf = (relPath) => {
  if (!fileCache.has(relPath)) {
    try {
      fileCache.set(relPath, readFileSync(resolve(ROOT, relPath), 'utf8'));
    } catch {
      fileCache.set(relPath, null);
    }
  }
  return fileCache.get(relPath);
};

const refExists = (ref) => {
  const sep = ref.indexOf('::');
  const path = sep === -1 ? ref : ref.slice(0, sep);
  const symbol = sep === -1 ? null : ref.slice(sep + 2);
  const content = sourceOf(path);
  if (content === null) return false;
  return symbol === null || content.includes(symbol);
};

// `Branch::A | Branch::B => StreamError::C` — alternations are wrapped across
// lines in the registry, so rejoin them before scanning.
const branchesByError = new Map();
const registrySource = surfaceContent.replace(/\r?\n\s*\|\s*/g, ' ');
for (const m of registrySource.matchAll(/Branch::([A-Za-z0-9_]+)((?:\s*\|\s*Branch::[A-Za-z0-9_]+)*)\s*=>\s*StreamError::([A-Za-z0-9_]+)/g)) {
  const group = [`Branch::${m[1]}`, m[2] || ''];
  const names = [...group.join(' ').matchAll(/Branch::([A-Za-z0-9_]+)/g)].map((x) => x[1]);
  const target = m[3];
  if (!branchesByError.has(target)) branchesByError.set(target, []);
  for (const name of names) {
    if (!branchesByError.get(target).includes(name)) branchesByError.get(target).push(name);
  }
}

const REGISTRY = 'contracts/streaming-payments/src/surface.rs';
const MATRIX_TEST =
  'contracts/streaming-payments/src/error_surface_test.rs::error_surface_matrix_proves_every_branch_is_reachable';

function probeFor(variantName) {
  const branches = branchesByError.get(variantName) || [];
  // Retired variants keep their wire code but have no instrumented branch, so
  // the registry's retirement list is the honest pointer.
  const ref = branches.length ? `${REGISTRY}::${branches[0]}` : `${REGISTRY}::RETIRED_CODES`;
  if (!refExists(ref)) {
    throw new Error(
      `generated probe '${ref}' for ${variantName} does not resolve in the source — ` +
        'the branch registry changed shape; fix this generator rather than emitting a dead link'
    );
  }
  return { ref, branches };
}

for (const ref of [MATRIX_TEST, REGISTRY, 'contracts/streaming-payments/src/errors.rs']) {
  if (!refExists(ref)) {
    throw new Error(`catalog cross-link '${ref}' does not resolve in the source`);
  }
}

// Curated authoritative remediations, client mappings and tests for StreamPay errors
const ERROR_METADATA = {
  1: {
    remediation: 'Verify the stream ID exists in your transaction history or recipient dashboard before calling any stream entrypoint.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nrejected!(f.client.mock_all_auths().try_get_stream(&999));',
  },
  2: {
    remediation: 'This role check is retired on-chain. Ensure the caller owns or is authorized on the stream via NotAuthorized (#12) checks.',
    toastClass: 'warning',
    retryable: false,
    reproduction: '// Retired code. No on-chain branch triggers this error.\n// Reserved for append-only numbering continuity.',
  },
  3: {
    remediation: 'This role check is retired on-chain. Ensure the caller is the registered stream recipient via NotAuthorized (#12) checks.',
    toastClass: 'warning',
    retryable: false,
    reproduction: '// Retired code. No on-chain branch triggers this error.\n// Reserved for append-only numbering continuity.',
  },
  4: {
    remediation: 'Check the stream cancelable flag before calling cancel_stream; non-cancelable streams run until their duration ends.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);\nrejected!(f.client.mock_all_auths().try_cancel_stream(&f.recipient, &id));',
  },
  5: {
    remediation: 'Query the stream status before mutating it; completed or cancelled streams cannot be withdrawn from, topped up, or cancelled again.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);\nf.client.mock_all_auths().cancel_stream(&f.sender, &id);\nrejected!(f.client.mock_all_auths().try_withdraw(&id, &1));',
  },
  6: {
    remediation: 'Read the current ledger close time and set start_time at or after that value.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nf.advance_time(DAY);\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &DEPOSIT,\n    &now, &(now + 2 * DAY), &false,\n));',
  },
  7: {
    remediation: 'Ensure end_time is strictly greater than start_time by at least 1 second before calling create_stream.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &DEPOSIT,\n    &(now + DAY), &(now + DAY), &false,\n));',
  },
  8: {
    remediation: 'Reduce the stream duration to at most MAX_DURATION_SECONDS (10 years).',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &DEPOSIT,\n    &now, &(now + MAX_DURATION_SECONDS + 1), &false,\n));',
  },
  9: {
    remediation: 'Pass a deposit amount greater than zero to create_stream, withdraw, or top_up.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &0,\n    &(now + DAY), &(now + 2 * DAY), &false,\n));',
  },
  10: {
    remediation: 'Query get_stream to read the current accrued amount, then request at most that value or call withdraw_max.',
    toastClass: 'warning',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);\nf.advance_time(2 * DAY);\nrejected!(f.client.mock_all_auths().try_withdraw(&id, &(DEPOSIT / 10 + 1)));',
  },
  11: {
    remediation: 'Reduce the deposit amount or the stream duration so that deposit * duration fits within u128 arithmetic bounds.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &i128::MAX,\n    &now, &(now + 2 * 365 * DAY), &false,\n));',
  },
  12: {
    remediation: 'Sign the transaction with the sender, recipient, or designated governor account required for this call.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet id = f.create_stream(DEPOSIT, DAY, 10 * DAY, true);\nlet stranger = Address::generate(&f.env);\nrejected!(f.client.mock_all_auths().try_cancel_stream(&stranger, &id));',
  },
  13: {
    remediation: 'Wait until the stream has started and funds have accrued, then retry withdraw or withdraw_max after the ledger timestamp advances.',
    toastClass: 'info',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);\nrejected!(f.client.mock_all_auths().try_withdraw_max(&id));',
  },
  14: {
    remediation: 'Set the fee rate to at most MAX_FEE_BPS (1,000 bps = 10%) when calling set_fee_bps.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nrejected!(f.client.mock_all_auths().try_set_fee_bps(&f.governor, &(MAX_FEE_BPS + 1)));',
  },
  15: {
    remediation: 'Switch to the authorized governor wallet before calling treasury or governance entrypoints.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet stranger = Address::generate(&f.env);\nrejected!(f.client.mock_all_auths().try_set_fee_bps(&stranger, &0));',
  },
  16: {
    remediation: 'Ask the current governor to call nominate_governor with the target address before calling accept_governor.',
    toastClass: 'warning',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nrejected!(f.client.mock_all_auths().try_accept_governor(&f.sender));',
  },
  17: {
    remediation: 'Query the collected fee balance for the token before calling withdraw_treasury; request at most the available amount.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nrejected!(f.client.mock_all_auths().try_withdraw_treasury(&f.governor, &f.token, &f.recipient, &1));',
  },
  18: {
    remediation: 'Verify the scheduled intent ID from your scheduling transaction receipt before calling execute_scheduled or cancel_scheduled.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nrejected!(f.client.try_get_intent(&999));',
  },
  19: {
    remediation: 'Check the intent status before calling execute_scheduled; already executed, cancelled, or expired intents cannot be re-executed.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nlet id = schedule_intent(&f, now, now + DAY);\nf.client.mock_all_auths().execute_scheduled(&id, &f.recipient);\nrejected!(f.client.mock_all_auths().try_execute_scheduled(&id, &f.recipient));',
  },
  20: {
    remediation: 'Wait until the current ledger timestamp reaches the intent execute_after time before calling execute_scheduled.',
    toastClass: 'info',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nlet id = schedule_intent(&f, now + DAY, now + 3 * DAY);\nrejected!(f.client.mock_all_auths().try_execute_scheduled(&id, &f.recipient));',
  },
  21: {
    remediation: 'The intent has expired. Call reclaim_expired to recover deposited funds, then schedule a new intent if needed.',
    toastClass: 'warning',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nlet id = schedule_intent(&f, now, now + DAY);\nf.advance_time(DAY);\nrejected!(f.client.mock_all_auths().try_execute_scheduled(&id, &f.recipient));',
  },
  22: {
    remediation: 'Cancel the scheduled intent before its execute_after timestamp; once the execution window opens, cancellation is no longer allowed.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nlet id = schedule_intent(&f, now, now + DAY);\nrejected!(f.client.mock_all_auths().try_cancel_scheduled(&f.sender, &id));',
  },
  23: {
    remediation: 'Validate occurrence_count > 0, interval > 0, and expires_at > execute_after before calling schedule_stream.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nrejected!(f.client.mock_all_auths().try_schedule_stream(\n    &f.sender, &f.recipient, &f.token, &DEPOSIT,\n    &(now + 2 * DAY), &(now + 3 * DAY), &false,\n    &0, &0, &0, &now, &(now + DAY),\n));',
  },
  24: {
    remediation: 'This is a security invariant failure. Stored intent parameters were tampered with. Report the incident to the protocol security oncall immediately.',
    toastClass: 'error',
    retryable: false,
    reproduction: '// Tamper with stored intent to break hash commitment:\nf.env.as_contract(&contract, || {\n    let mut intent = storage.get(&DataKey::Intent(id)).unwrap();\n    intent.deposit += 1;\n    storage.set(&DataKey::Intent(id), &intent);\n});\nrejected!(f.client.mock_all_auths().try_execute_scheduled(&id, &f.recipient));',
  },
  25: {
    remediation: 'Wait until the current ledger timestamp is past the intent expires_at before calling reclaim_expired.',
    toastClass: 'warning',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nlet id = schedule_intent(&f, now, now + DAY);\nrejected!(f.client.try_reclaim_expired(&id));',
  },
  26: {
    remediation: 'Check the sender token balance and allowance cover deposit_amount + fee before calling create_stream.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = RefusingFixture::setup_quiet();\nf.refuse(false, true);\nlet now = f.env.ledger().timestamp();\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &DEPOSIT,\n    &now, &(now + 2 * DAY), &false,\n));',
  },
  27: {
    remediation: 'Ensure the caller has sufficient token balance and an active trustline authorization before calling top_up.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = RefusingFixture::setup_quiet();\nlet id = f.create(DEPOSIT, 0, 10 * DAY);\nf.refuse(false, true);\nrejected!(f.client.mock_all_auths().try_top_up(&id, &DEPOSIT));',
  },
  28: {
    remediation: 'Verify the recipient address has a valid trustline for the stream asset token and is authorized to receive transfers.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = RefusingFixture::setup_quiet();\nlet id = f.create(DEPOSIT, 0, 10 * DAY);\nf.advance_time(DAY);\nf.refuse(true, false);\nrejected!(f.client.mock_all_auths().try_withdraw(&id, &(DEPOSIT / 10)));',
  },
  29: {
    remediation: 'Check the sender token account status and trustline before cancelling; the refund transfer must be receivable.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = RefusingFixture::setup_quiet();\nlet id = f.create(DEPOSIT, DAY, 10 * DAY);\nf.refuse(true, false);\nrejected!(f.client.mock_all_auths().try_cancel_stream(&f.sender, &id));',
  },
  30: {
    remediation: 'Ensure the destination treasury account has an active trustline for the token and can receive transfers.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = RefusingFixture::setup_quiet();\nf.client.mock_all_auths().set_fee_bps(&f.governor, &100);\nlet _id = f.create(DEPOSIT, 0, 10 * DAY);\nf.refuse(true, false);\nrejected!(f.client.mock_all_auths().try_withdraw_treasury(\n    &f.governor, &f.token, &f.recipient, &1,\n));',
  },
  31: {
    remediation: 'Check the governance policy allowlist for the asset token before creating a stream; propose adding the asset via the governor.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet admin = Address::generate(&f.env);\nf.client.mock_all_auths().policy_init(&admin);\nf.client.mock_all_auths().policy_set_timelock_delay(&0);\nf.client.mock_all_auths().policy_propose_asset(&f.token, &false);\nf.client.mock_all_auths().policy_execute_asset(&f.token);\nlet now = f.env.ledger().timestamp();\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &DEPOSIT,\n    &(now + DAY), &(now + 2 * DAY), &false,\n));',
  },
  32: {
    remediation: 'Wait until the queued policy change timelock delay has elapsed before calling policy_execute_asset.',
    toastClass: 'info',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet admin = Address::generate(&f.env);\nf.client.mock_all_auths().policy_init(&admin);\nf.client.mock_all_auths().policy_propose_asset(&f.token, &false);\nrejected!(f.client.mock_all_auths().try_policy_execute_asset(&f.token));',
  },
  33: {
    remediation: 'Call policy_propose_asset to queue a change before calling policy_execute_asset.',
    toastClass: 'warning',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet admin = Address::generate(&f.env);\nf.client.mock_all_auths().policy_init(&admin);\nrejected!(f.client.mock_all_auths().try_policy_execute_asset(&f.token));',
  },
  34: {
    remediation: 'Call policy_init with the initial governor and parameters before using any policy entrypoint.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nrejected!(f.client.mock_all_auths().try_policy_execute_asset(&f.token));',
  },
  35: {
    remediation: 'Ask the current policy admin to call policy_propose_handoff before calling policy_accept_handoff.',
    toastClass: 'warning',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet admin = Address::generate(&f.env);\nf.client.mock_all_auths().policy_init(&admin);\nrejected!(f.client.mock_all_auths().try_policy_accept_handoff());',
  },
  36: {
    remediation: 'The contract is frozen for maintenance. Wait for the governor to call set_frozen(false) before retrying operations.',
    toastClass: 'warning',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nf.client.mock_all_auths().set_frozen(&f.governor, &true);\nlet now = f.env.ledger().timestamp();\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &DEPOSIT,\n    &(now + DAY), &(now + 2 * DAY), &false,\n));',
  },
  37: {
    remediation: 'Call set_frozen(true) before invoking migrate_storage; migration requires the contract to be frozen first.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nrejected!(f.client.mock_all_auths().try_migrate_storage(&f.governor, &0, &50));',
  },
  38: {
    remediation: 'Call propose_upgrade before calling execute_upgrade or cancel_upgrade.',
    toastClass: 'warning',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nrejected!(f.client.mock_all_auths().try_execute_upgrade(&f.governor));',
  },
  39: {
    remediation: 'Wait until the upgrade timelock delay has fully elapsed before calling execute_upgrade.',
    toastClass: 'info',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet wasm = BytesN::from_array(&f.env, &[0x42; 32]);\nf.client.mock_all_auths().propose_upgrade(&f.governor, &wasm, &MIN_UPGRADE_DELAY_SECONDS);\nrejected!(f.client.mock_all_auths().try_execute_upgrade(&f.governor));',
  },
  40: {
    remediation: 'Set the upgrade delay to at least MIN_UPGRADE_DELAY_SECONDS when calling propose_upgrade.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet wasm = BytesN::from_array(&f.env, &[0x42; 32]);\nrejected!(f.client.mock_all_auths().try_propose_upgrade(&f.governor, &wasm, &0));',
  },
  41: {
    remediation: 'Storage migration is a one-time operation. No action needed; the contract is already up to date.',
    toastClass: 'info',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nf.client.mock_all_auths().set_frozen(&f.governor, &true);\nf.client.mock_all_auths().migrate_storage(&f.governor, &0, &50);\nrejected!(f.client.mock_all_auths().try_migrate_storage(&f.governor, &0, &50));',
  },
  42: {
    remediation: 'Increase the deposit amount or decrease the duration so the payment rate meets the governance policy floor.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nf.client.mock_all_auths().set_stream_policy(\n    &f.governor, &Some(f.token.clone()),\n    &crate::StreamPolicy { min_deposit: 0, min_duration: 0, max_duration: 0, min_rate: 1_000, max_rate: 0 },\n);\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &100,\n    &(now + DAY), &(now + 2 * DAY), &false,\n));',
  },
  43: {
    remediation: 'Decrease the deposit amount or increase the duration so the payment rate stays at or below the governance policy ceiling.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nf.client.mock_all_auths().set_stream_policy(\n    &f.governor, &Some(f.token.clone()),\n    &crate::StreamPolicy { min_deposit: 0, min_duration: 0, max_duration: 0, min_rate: 0, max_rate: 10 },\n);\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &DEPOSIT,\n    &(now + DAY), &(now + 2 * DAY), &false,\n));',
  },
  44: {
    remediation: 'Increase the stream duration to at least the governance policy min_duration for this asset.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nf.client.mock_all_auths().set_stream_policy(\n    &f.governor, &Some(f.token.clone()),\n    &crate::StreamPolicy { min_deposit: 0, min_duration: 2 * DAY, max_duration: 0, min_rate: 0, max_rate: 0 },\n);\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &DEPOSIT,\n    &(now + DAY), &(now + DAY + 3600), &false,\n));',
  },
  45: {
    remediation: 'Decrease the stream duration to at most the governance policy max_duration for this asset.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nf.client.mock_all_auths().set_stream_policy(\n    &f.governor, &Some(f.token.clone()),\n    &crate::StreamPolicy { min_deposit: 0, min_duration: 0, max_duration: DAY, min_rate: 0, max_rate: 0 },\n);\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &DEPOSIT,\n    &(now + DAY), &(now + 3 * DAY), &false,\n));',
  },
  46: {
    remediation: 'Increase the initial deposit to at least the governance policy min_deposit for this asset.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nf.client.mock_all_auths().set_stream_policy(\n    &f.governor, &Some(f.token.clone()),\n    &crate::StreamPolicy { min_deposit: 1_000, min_duration: 0, max_duration: 0, min_rate: 0, max_rate: 0 },\n);\nrejected!(f.client.mock_all_auths().try_create_stream(\n    &f.sender, &f.recipient, &f.token, &500,\n    &(now + DAY), &(now + 2 * DAY), &false,\n));',
  },
  47: {
    remediation: 'Submit at least one entry in the create_streams_batch call.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet entries = soroban_sdk::Vec::new(&f.env);\nrejected!(f.client.mock_all_auths().try_create_streams_batch(&entries));',
  },
  48: {
    remediation: 'Reduce the batch size to at most MAX_BATCH entries when calling create_streams_batch.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet now = f.env.ledger().timestamp();\nlet mut entries = soroban_sdk::Vec::new(&f.env);\nfor _ in 0..=(crate::stream::MAX_BATCH) {\n    entries.push_back(crate::stream::BatchEntry {\n        sender: f.sender.clone(), recipient: f.recipient.clone(),\n        token: f.token.clone(), deposit: DEPOSIT,\n        start_time: now + DAY, end_time: now + 2 * DAY, cancelable: false,\n    });\n}\nrejected!(f.client.mock_all_auths().try_create_streams_batch(&entries));',
  },
  49: {
    remediation: 'Ensure the sponsor address is registered before calling sponsored_withdraw. Register via register_sponsor if needed.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet sponsor = Address::generate(&f.env);\nlet id = f.create_stream(DEPOSIT, DAY, 10 * DAY, false);\nrejected!(sponsored_claim(&f, &sponsor, id, 1, 1, { f.env.ledger().timestamp() + DAY }));',
  },
  56: {
    remediation: 'Set the oracle threshold to a value between 1 and the publisher count.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet pub1 = Address::generate(&f.env);\nlet mut pubs = soroban_sdk::Vec::new(&f.env);\npubs.push_back(pub1);\nrejected!(f.client.mock_all_auths().try_set_oracle_config(&f.governor, &pubs, &2, &3600));',
  },
  57: {
    remediation: 'Call set_oracle_config to configure oracle publishers before calling oracle entrypoints.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet pub1 = Address::generate(&f.env);\nlet now = f.env.ledger().timestamp();\nrejected!(f.client.mock_all_auths().try_submit_oracle_time(&pub1, &now));',
  },
  58: {
    remediation: 'Verify the oracle report timestamp is within the configured staleness window and submit a fresh report.',
    toastClass: 'error',
    retryable: true,
    reproduction: 'let f = Fixture::setup_quiet();\nlet pub1 = Address::generate(&f.env);\nlet mut pubs = soroban_sdk::Vec::new(&f.env);\npubs.push_back(pub1.clone());\nf.client.mock_all_auths().set_oracle_config(&f.governor, &pubs, &1, &3600);\nlet now = f.env.ledger().timestamp();\nrejected!(f.client.mock_all_auths().try_submit_oracle_time(&pub1, &(now + 4000)));',
  },
  59: {
    remediation: 'Ensure the caller address is in the configured oracle publisher list before calling submit_oracle_time.',
    toastClass: 'error',
    retryable: false,
    reproduction: 'let f = Fixture::setup_quiet();\nlet pub1 = Address::generate(&f.env);\nlet unauthorized = Address::generate(&f.env);\nlet mut pubs = soroban_sdk::Vec::new(&f.env);\npubs.push_back(pub1);\nf.client.mock_all_auths().set_oracle_config(&f.governor, &pubs, &1, &3600);\nlet now = f.env.ledger().timestamp();\nrejected!(f.client.mock_all_auths().try_submit_oracle_time(&unauthorized, &now));',
  },
};

// Ensure directories exist
mkdirSync(resolve(ROOT, 'docs/errors'), { recursive: true });

// 1. Generate individual docs/errors/{code}.md pages
for (const item of variants) {
  const meta = ERROR_METADATA[item.code] || {
    remediation: 'Contact protocol support if this error persists.',
    toastClass: 'error',
    retryable: false,
  };

  const isRetired = item.code === 2 || item.code === 3;
  const status = isRetired ? 'Retired (Unreachable)' : 'Active (Enforced)';
  const probe = probeFor(item.name);
  const siblingsNote =
    probe.branches.length > 1
      ? ` — ${probe.branches.length} registry branches map to this code (${probe.branches
          .slice(1)
          .map((b) => `\`${b}\``)
          .join(', ')} share the probe)`
      : '';

  const pageContent = `# Error #${item.code}: ${item.name}

<!-- Generated by tooling/generate-error-catalog.mjs. Do not edit manually. -->

## Summary
- **Numeric Code**: \`#${item.code}\`
- **Variant Name**: \`${item.name}\`
- **Status**: ${status}
- **Client Toast Level**: \`${meta.toastClass.toUpperCase()}\`
- **Retryable**: \`${meta.retryable ? 'Yes' : 'No'}\`

---

## Trigger Conditions
This error is returned by the contract when:
- \`${item.name}\` validation fails during entrypoint invocation.
${isRetired ? '- *Note*: This code is reserved/retired on-chain to guarantee append-only numbering continuity.' : ''}

---

## User Remediation Guidance
> **Plain-Language Remediation**:  
> ${meta.remediation}

${meta.reproduction ? `---

## Reproduction

The following test code triggers this error condition:

\`\`\`rust
${meta.reproduction}
\`\`\`

This reproduction is derived from the contract's error surface tests in \`error_surface_test.rs\`.

` : ''}---

## Client-Side Mapping
\`\`\`json
{
  "code": ${item.code},
  "variant": "${item.name}",
  "toastClass": "${meta.toastClass}",
  "retryable": ${meta.retryable},
  "message": "${item.name} (#${item.code}): ${meta.remediation}"
}
\`\`\`

---

## Automated Verification & Cross-Links
- **Instrumented branch**: [\`${probe.ref}\`](../../${probe.ref})${siblingsNote}
- **Reachability proof**: [\`${MATRIX_TEST}\`](../../${MATRIX_TEST}) — walks every registry branch and asserts each code is produced or retired.
- **Error Surface Registry**: [\`contracts/streaming-payments/src/surface.rs\`](../../contracts/streaming-payments/src/surface.rs)
- **Error Enum Definition**: [\`contracts/streaming-payments/src/errors.rs\`](../../contracts/streaming-payments/src/errors.rs)
`;

  writeFileSync(resolve(ROOT, `docs/errors/${item.code}.md`), pageContent, 'utf8');
}

// 2. Generate docs/errors.md (Master Index Catalog)
let indexMd = `<!-- Generated by tooling/generate-error-catalog.mjs. Do not edit by hand. -->
<!-- Version: schema_fingerprint=${schemaFingerprint} -->

# StreamPay On-Chain Error Code Catalog

Authoritative registry of all **${variants.length}** append-only on-chain error codes returned by the StreamPay Soroban smart contract.

## Release & Schema Version
- **Schema Fingerprint**: \`${schemaFingerprint}\`
- **Catalog Version Guarantee**: Append-only numeric code preservation (codes 1–${variants.length}).

---

## Error Code Registry Index

| Code | Variant Name | Status | Toast Level | Retryable | Remediation Guidance | Detail Page |
| ---: | --- | --- | --- | :---: | --- | :---: |
`;

for (const item of variants) {
  const meta = ERROR_METADATA[item.code] || {
    remediation: 'Contact protocol support if this error persists.',
    toastClass: 'error',
    retryable: false,
  };
  const isRetired = item.code === 2 || item.code === 3;
  const statusBadge = isRetired ? 'Retired' : 'Active';
  const retryBadge = meta.retryable ? 'Yes' : 'No';

  indexMd += `| **#${item.code}** | \`${item.name}\` | ${statusBadge} | \`${meta.toastClass}\` | ${retryBadge} | ${meta.remediation} | [View Docs](errors/${item.code}.md) |\n`;
}

indexMd += `\n---

## Client Error Handling Protocol

When the Soroban RPC returns an invocation rejection in the form:
\`\`\`text
Error(Contract, #${1})
\`\`\`

The client application intercepts and translates it using \`describeError\` from \`frontend/lib/errors.ts\`.

- **\`error\`**: Terminal or authorization failure requiring user input correction or different wallet.
- **\`warning\`**: Operational conflict or state mismatch (e.g. withdrawal exceeds accrued balance).
- **\`info\`**: Timelock or scheduling wait period (e.g. stream not yet due for execution).

---

## Maintenance & CI Invariants
1. **Append-Only**: Codes are never renumbered or deleted.
2. **Exhaustive Mapping**: Every variant in \`StreamError\` has a corresponding entry in this catalog and in \`frontend/lib/errors.ts\`.
3. **CI Gate**: CI runs \`node tooling/generate-error-catalog.mjs\` and verifies zero diff with git.
`;

writeFileSync(resolve(ROOT, 'docs/errors.md'), indexMd, 'utf8');

// 3. Generate frontend/lib/errors.ts
let tsCode = `// Generated by tooling/generate-error-catalog.mjs. Do not edit by hand.
// Version: schema_fingerprint=${schemaFingerprint}


export interface ErrorCatalogEntry {
  code: number;
  name: string;
  remediation: string;
  toastClass: 'error' | 'warning' | 'info';
  retryable: boolean;
}

export const ERROR_CATALOG: Record<number, ErrorCatalogEntry> = {
`;

for (const item of variants) {
  const meta = ERROR_METADATA[item.code] || {
    remediation: 'Contact protocol support if this error persists.',
    toastClass: 'error',
    retryable: false,
  };
  tsCode += `  ${item.code}: {
    code: ${item.code},
    name: "${item.name}",
    remediation: "${meta.remediation.replace(/"/g, '\\"')}",
    toastClass: "${meta.toastClass}",
    retryable: ${meta.retryable},
  },\n`;
}

tsCode += `};

export function getErrorDetails(err: unknown): ErrorCatalogEntry | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/Error\\(Contract, #(\\d+)\\)/);
  if (match) {
    const code = Number(match[1]);
    return ERROR_CATALOG[code] ?? null;
  }
  return null;
}

export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/Error\\(Contract, #(\\d+)\\)/);
  if (match) {
    const code = Number(match[1]);
    const entry = ERROR_CATALOG[code];
    if (entry) {
      return \`Contract rejected the call: \${entry.name} (#\${code}). \${entry.remediation}\`;
    }
    return \`Contract error #\${code}\`;
  }
  return message;
}
`;

writeFileSync(resolve(ROOT, 'frontend/lib/errors.ts'), tsCode, 'utf8');

console.log(`[Success] Generated catalog for ${variants.length} error codes:`);
console.log(`  - docs/errors.md`);
console.log(`  - docs/errors/*.md (${variants.length} files)`);
console.log(`  - frontend/lib/errors.ts`);
