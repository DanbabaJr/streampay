# Wave contributor guide

How work flows through StreamPay for contributors who arrive via the
[Drips Wave](https://www.drips.network/wave) program (the issues labelled
**Stellar Wave**): from claiming an issue to seeing it resolved.

This page covers the *process*. It deliberately links to, rather than repeats,
the documents that own each topic:

| For… | Read |
|---|---|
| Toolchain setup, coding conventions, generated files, branch/PR rules | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| What a PR must tick off | [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md) |
| The shape of a well-specified ticket | [`docs/GOOD_FIRST_ISSUES.md`](./GOOD_FIRST_ISSUES.md) |
| What CI actually runs | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) |
| Reporting a vulnerability (never as a public issue) | [`SECURITY.md`](../SECURITY.md) |

## The lifecycle at a glance

```text
find issue → apply on the issue → maintainer assigns you → build on a branch
   → open PR ("Closes #N") → CI + review → merge → maintainer marks the issue
   completed → issue is resolved
```

## 1. Getting assigned

**Assignment is required before you start.** Every Wave issue says so in its
*Guidelines*. In practice:

1. Pick an open issue with the **Stellar Wave** label. Read the whole
   description, especially *Requirements and context*, which names the files and
   documents you must read first.
2. Apply to work on it through the Drips Wave application comment on the issue.
   Say concretely how you will approach it: which modules you will touch and how
   you will test. A specific plan is easier for maintainers to accept than a
   general offer.
3. **Wait to be assigned.** A comment alone is not an assignment. The
   *Assignees* field on the issue and the confirmation comment from the
   `drips-wave` bot are the signals that you may start. Work done before then
   may not be accepted for that issue.
4. The bot's comment states the **due date** for the issue. That date, not your
   own estimate, is your deadline. Leave maintainers enough time to review before
   it.

[`CONTRIBUTING.md`](../CONTRIBUTING.md#good-first-issues) describes claiming a
*good first issue* by commenting. For Wave issues, follow this section instead:
assignment comes first.

If you can no longer finish an assigned issue, say so on the issue early so it
can be reassigned.

## 2. Complexity labels and Points

Wave issues carry a **complexity label**, which is the program's sizing
convention:

| Label | Typical scope (indicative; the maintainer's label on the issue is what counts) |
|---|---|
| **Trivial** | Small, well-bounded change; little context needed. |
| **Medium** | A self-contained feature, test suite or document that touches several files. |
| **High** | Cross-cutting or risky work (for example money-touching contract code). |

The label appears on the issue with a description such as
*"Drips Wave complexity tier: Medium (150 points)"*, and the same figure appears
in the *Points* line of the issue's *Guidelines*.

**Points are the Wave program's scoring unit.** They record how the program
sized the issue and are awarded when a maintainer marks the issue completed.
This repository does not set, promise or guarantee any payment, amount or reward
for any issue. How the program uses points is defined by Drips Wave, not by this
repo. A maintainer may adjust an issue's complexity and points; do not rely on
the figures when planning your time.

## 3. Branches, commits and the PR

The rules live in [`CONTRIBUTING.md`](../CONTRIBUTING.md#branch--pr-process).
The short version for Wave work:

- Fork, then branch from an up-to-date `main`. Use `feat/<topic>`, `fix/<topic>`
  or `docs/<topic>`. The issue's *Suggested execution* section usually names the
  branch.
- Keep the PR to the one issue. Small and reviewable beats broad.
- Fill in the [PR template](../.github/PULL_REQUEST_TEMPLATE.md).
- **The PR description must contain `Closes #<issue number>`.** The issue's
  Guidelines require it, and it is how the issue and your PR are linked so the
  work is tracked. Without it the contribution may not be attributed to the
  issue.
- Add a `CHANGELOG.md` entry under **Unreleased** when the change is user- or
  operator-visible, as CONTRIBUTING asks.
- Open the PR early (a draft is fine) so reviewers can steer.

## 4. Before you open the PR

CI is a set of jobs in [`ci.yml`](../.github/workflows/ci.yml). Every gate is an
ordinary command, so you can run it locally. Merge `main` into your branch first
(a PR with conflicts gets no CI run at all), then run what matches the files you
touched. Install steps and prerequisites are in
[CONTRIBUTING](../CONTRIBUTING.md#setup-clean-machine).

| CI job | Run locally (from the repo root unless noted) |
|---|---|
| **Contract**: format, clippy, tests, wasm | `npm run lint:fix` then `npm run lint` (`cargo fmt --all -- --check` + `cargo clippy --all-targets -- -D warnings`); `cargo test --workspace --locked`; `cd contracts/streaming-payments && stellar contract build` |
| **Contract**: error codes and generated docs | `npm run codes:check`; `npm run generated:surface` |
| **Event registry** | `npm run generated:events`; `npm run events:compat:test` |
| **Frontend**: lint, typecheck, tests, build | `cd frontend && npm ci && npm run lint && npm run typecheck && npm test && npm run test:scheduler && npm run build` |
| **Frontend**: differential vectors | `npm run generated:vectors` |
| **Storybook / visual** | `cd frontend && npm run build-storybook`; baselines: `bash frontend/scripts/visual-baselines.sh` (needs Docker; see [`STORYBOOK.md`](./STORYBOOK.md#baselines)) |
| **Indexer** | `cd indexer && npm ci && npm run typecheck && npm test` |
| **TTL sentinel** | `cd infra/ttl-sentinel && npm ci && npm run typecheck && npm test` |
| **CLI parity** | `cd tools/streampay-cli && npm install --no-package-lock --ignore-scripts && npm test` |
| **Docs**: link lint | `npm run links:check` |
| **Docs job**: JSON keys, line endings, migration audit | `npm run json:check`; `npm run eol:check`; `bash scripts/migrate_audit.sh --check` |
| **Perf budgets**: error catalog | `npm run generated:catalog` |
| **Security**: advisories and licenses | `cargo deny check`; `npm audit --omit=dev --audit-level=high` in each Node package you touched |
| **Benchmarks** | `npm run benchmark:verify` |

All generated files (`docs/ERROR_SURFACE.md`, the error catalog, the accrual
vectors, the event registry artifacts) must be regenerated, never hand-edited.
`npm run generated:check` runs the whole set. See
[Generated files & CI gates](../CONTRIBUTING.md#generated-files--ci-gates), which
also lists the gate that owns each file. `npm run matrix` chains most of the
repo-level checks in one go.

Checklist:

- [ ] `main` is merged into the branch and there are no conflicts
- [ ] The commands in the table that match the files you changed pass
- [ ] `npm run links:check` passes if you touched or added any Markdown
- [ ] `npm run generated:check` is clean, and any new generated files are
      `git add`ed (untracked files are invisible to `git diff`)
- [ ] The PR template is filled in and the description contains `Closes #<N>`
- [ ] Tests cover new behavior; `docs/ARCHITECTURE.md` and `CHANGELOG.md` are
      updated where CONTRIBUTING says so

A job that needs a toolchain you do not have (Rust, Docker) can still be left to
CI. Say so in the PR rather than leaving it unmentioned.

## 5. Review

- A maintainer reviews PRs for Wave issues **within the wave window**. There is
  **no guaranteed turnaround**: review time depends on maintainer availability
  and on how many PRs are open.
- CONTRIBUTING sets the approval bar: one maintainer approval for docs and
  frontend changes, two for changes to money-touching contract code.
- Reviews are the normal place for requested changes. Respond to them promptly,
  and keep pushing to the same branch.
- Issues that are **not resolved within the wave roll over**. Being assigned
  does not reserve an issue indefinitely, so tell maintainers early if you are
  blocked.
- Opening the PR well before the due date is the only thing in your control that
  leaves room for review.

## 6. What "resolved" means

An issue is **resolved** when a maintainer marks it **completed** in the Wave
program, which normally happens after your PR has been reviewed and merged. The
sequence is:

1. The PR is merged into `main` (CI green, required approvals given).
2. The linked issue closes through `Closes #<N>`.
3. The maintainer marks the issue completed for the program.

Merging alone does not make a Wave issue resolved, and a PR that is not linked
to its issue may not be recognised. Points, as described in
[§2](#2-complexity-labels-and-points), are tied to the maintainer's completion
mark.

## Where to get help

- Ask on the issue itself; questions there help the next contributor too.
- Check the relevant doc first, starting with the table at the top of this page.
- Never post a suspected vulnerability publicly: follow
  [`SECURITY.md`](../SECURITY.md).
