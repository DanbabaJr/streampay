# Security policy

## Supported versions

| Version | Supported |
|---|---|
| main branch | ✅ |

## Reporting a vulnerability

StreamPay moves real funds. If you find a bug that could move funds
incorrectly, break an invariant (`0 ≤ withdrawn ≤ streamed ≤ deposit`, or the
contract-balance coverage invariant), or bypass an auth check:

1. **Do not open a public issue.**
2. Use GitHub's [private vulnerability reporting](
   https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
   on this repository — it reaches the maintainers directly and keeps the
   report confidential. If GitHub is unavailable to you, open a private
   report against any maintainer fork, or DM the handle listed in
   `.github/CODEOWNERS` — we will move the conversation to a confidential
   channel immediately.
3. Include a reproduction (test, tx traces, or a written scenario).

> Before mainnet (v1.0) we will publish a dedicated `security@` address with
> a PGP key alongside the release artifacts; until then, GitHub private
> reports are the canonical intake channel.

For **non-exploitable** findings — hardening gaps, defense-in-depth weaknesses,
or issues that are already disclosed or fixed — use the public
[security report form](.github/ISSUE_TEMPLATE/security-report.yml). It is
classified, labeled, and acknowledged automatically by the
[triage workflow](.github/workflows/security-triage.yml). Reward tiers, scope,
the loss model behind them, and the triage SLA are documented in
[`docs/BOUNTY.md`](docs/BOUNTY.md).

We aim to acknowledge within 72 hours and will credit reporters in the
release notes unless they prefer anonymity. Please give us a reasonable
window to fix before public disclosure.

## Invariants worth testing against

- Per stream: `0 ≤ withdrawn ≤ streamed ≤ deposit`.
- Global: contract token balance ≥ Σ(deposit − withdrawn) over live streams.
- Every payout path is checks-effects-interactions ordered (no reentrancy
  window on token transfers).
- All expected failures return `StreamError` codes; no panics on any input.
