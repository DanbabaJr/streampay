## What

<!-- One or two sentences: what changes and why. Link issues with "Fixes #N". -->

## Contract impact

- [ ] No public API change (signatures / error codes / events)
- [ ] Error codes appended (not renumbered)
- [ ] Error catalog entries reviewed (remediations and client mapping verified)
- [ ] New behavior covered by tests
- [ ] `docs/ARCHITECTURE.md` updated if a design decision changed

## Checklist (CI runs all of these)

Run this **after** merging `main` into your branch — every item is a CI gate with
the same command, so a clean local run means a clean CI run.

- [ ] Branch is up to date with `main` (a conflicted PR gets **no** CI run at all)
- [ ] `npm run lint:fix` — then commit what changed (`cargo fmt --all -- --check` is the gate)
- [ ] `cargo clippy --all-targets -- -D warnings`
- [ ] `cargo test -p streampay-contract`
- [ ] `npm run codes:check` — prints the highest error code in use and the next
      free one, and checks `surface.rs` wiring: a code duplicated with another
      merged PR is `E0081` in CI, a code no `Branch` returns is a wasm-build failure
- [ ] `npm run generated:check` — regenerates `docs/ERROR_SURFACE.md`, the error
      catalog (`docs/errors.md`, `docs/errors/<code>.md`, `frontend/lib/errors.ts`)
      and `tests/vectors/accrual_vectors.json`, then fails on drift. A failing run
      has already written the right files: `git add` what it prints.
- [ ] `npm run eol:check` — CRLF committed in a text file (whole-file `cargo fmt`
      diffs and shifted content hashes); fix with `git add --renormalize .`
- [ ] `npm run links:check` — internal Markdown links and `#anchors` resolve
      (renamed documents are the usual failure; the output names the closest path)
- [ ] `cd frontend && npm run lint && npm run typecheck && npm test && npm run build` (if frontend touched)

See [CONTRIBUTING.md](../CONTRIBUTING.md#generated-files--ci-gates) for what each
generated file comes from and which job enforces it.
