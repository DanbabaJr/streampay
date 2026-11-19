# ADR 0009: ESLint 9 Pinning for Next.js 16 Flat Config Compatibility

Status: Superseded by commit [8ac0d12](https://github.com/Neziahtech/streampay/commit/8ac0d12a4b77309fde0de1ac0fc347747d83efca)
Date: 2026-10-04
Deciders: StreamPay Engineering Team

> [!NOTE]
> **Superseded Notice (2026-10-15):**
> This decision was superseded in code on 2026-10-15 by commit [8ac0d12](https://github.com/Neziahtech/streampay/commit/8ac0d12a4b77309fde0de1ac0fc347747d83efca) ("npm: bump eslint from 9.39.5 to 10.12.0 in /frontend"), which upgraded `frontend/package.json` to `eslint@^10.12.0` once upstream flat-config compatibility was resolved. This record is preserved as an immutable historical artifact documenting the original constraint and rationale that motivated the pinning.

## Context and Problem Statement

During the frontend upgrade to Next.js 16 (`next@16.3.8` / `next@16.4.0`), two significant tooling shifts occurred:
1. The legacy `next lint` CLI command was removed by Next.js, requiring the project to execute `eslint .` directly using the modern ESLint flat config format (`eslint.config.mjs`).
2. Dependabot opened automated pull requests (PR #20 and PR #44) attempting to upgrade `eslint` from `9.39.5` to `10.11.0` and `10.12.0`.

When ESLint 10 was installed, the CI linting gate crashed with fatal exceptions:
```text
TypeError: context.getFilename is not a function
    at RuleContext.getFilename (.../node_modules/@next/eslint-plugin-next/...)
```
ESLint 10 removed deprecated APIs, including `context.getFilename()`, in favor of `context.filename`. However, `@next/eslint-plugin-next` and `eslint-config-next@16` still relied on `context.getFilename()`, creating an incompatible dependency chain.

## Decision Drivers

- Maintain clean, automated CI linting (`npm run lint`) on all pull requests.
- Adopt modern ESLint flat configuration (`eslint.config.mjs`) as required by Next.js 16.
- Prevent automated dependency upgrade bots from merging breaking major versions of linters.

## Considered Options

- Option 1: Pin `eslint` to `^9.39.5` (9.x series) and maintain flat config with direct `eslint .`.
- Option 2: Upgrade to ESLint 10 and patch upstream Next.js plugins locally.
- Option 3: Revert to ESLint 8 and legacy `.eslintrc.json`.

## Decision Outcome

Chosen option: "Option 1: Pin `eslint` to `^9.39.5` (9.x series)", because:
1. ESLint 9 fully supports the flat configuration standard (`eslint.config.mjs`) without deprecation warnings.
2. ESLint 9 retains backwards-compatible shims for `context.getFilename()`, allowing `@next/eslint-plugin-next` and `eslint-config-next` to execute without crashes.
3. In `frontend/package.json`, `eslint` was pinned to `^9.39.5` and the lint script was defined as:
   ```json
   "lint": "eslint ."
   ```
   (Note: subsequently superseded on 2026-10-15 by commit `8ac0d12` bumping `frontend/package.json` to `^10.12.0`).
4. Automated PRs attempting to bump `eslint` to version 10 were held until upstream compatibility unblocked the upgrade.

### Consequences

- **Positive:**
  - CI linting is 100% stable with zero errors and zero warnings across the frontend codebase.
  - Future-proof flat config architecture is fully preserved.
  - Build and lint workflows pass reliably in clean environments.
- **Negative / Trade-offs:**
  - Requires maintaining an explicit dependency boundary and declining Dependabot suggestions for `eslint@10`.

## Alternatives Considered

### Option 2: Upgrade to ESLint 10 with Local Patching

- Good, because it uses the latest major version of ESLint.
- Bad, because maintaining local patch-package shims against Next.js internal plugins introduces high maintenance overhead and risks breaking on subsequent Next.js patch releases.

### Option 3: Revert to ESLint 8 with `.eslintrc.json`

- Good, because ESLint 8 is mature.
- Bad, because ESLint 8 is end-of-life and incompatible with Next.js 16's transition away from `next lint`.

## Validation and Evidence

- Defined in `frontend/package.json` (`"eslint": "^9.39.5"` and `"eslint.config.mjs"`).
- Documented in commit `4c48978adbdfc5eea9788970075708cd1100e3c3` ("fix(frontend): complete the Next 16 migration the merged dependabot PR started").
- Prior revert commit `5fd6a54` ("fix(frontend): revert eslint to ^8 — eslint-config-next@15 peers cap at eslint 9").
- Superseded in commit `8ac0d12` ("npm: bump eslint from 9.39.5 to 10.12.0 in /frontend") on 2026-10-15.
- CI gate runs `npm run lint` cleanly in `.github/workflows/ci.yml`.
