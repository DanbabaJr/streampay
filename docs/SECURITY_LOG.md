# Security Log

Append-only operational security log for StreamPay: key ceremonies, rotations,
secret-handling audits, and drill results. Newest entries at the bottom. One
line or block per event; link evidence (workflow runs, PRs, matrix artifacts)
and never record secret material — public keys, hashes, and ledger numbers
only.

---

## 2026-10-17 — Secrets hygiene audit (issue #208)

**Scope.** Entire repository working tree and full git history, for embedded
Stellar secret key material (`S…` seeds, `secret_key`/`SECRET_KEY`
assignments, raw 32-byte seeds, testnet keys baked into scripts/docs), plus
hardcoded account/contract addresses that could bind identity or leak
deployment state.

**Method.**

```bash
# working tree
git grep -E "S[A-Z2-7]{55}" HEAD -- .
git grep -lE "(secret_key|secretKey|SECRET)\s*[:=]\s*['\"][A-Za-z0-9]{30,}" HEAD -- .
git ls-files | grep -iE "\.env|credentials|\.pem|\.key"
# full history (all commits on all refs)
git grep -E "S[A-Z2-7]{55}" $(git rev-list --all) -- .
```

**Findings.**

1. **No secret key material found** in HEAD or anywhere in git history. All
   operational secrets are referenced by environment-variable *name* only
   (`MAINNET_DEPLOYER_SECRET`, `TTL_SENTINEL_EXTENDER_SECRET`,
   `TTL_SENTINEL_WEBHOOK_URL`, `ONCALL_WEBHOOK_URL`), consistent with the
   inventory in [`docs/OPERATIONS.md`](./OPERATIONS.md) §2.1. **No rotation or
   scrub was required.**
2. No `.env`, credential, `.pem`, or `.key` files are tracked (only
   `frontend/.env.example` and `indexer/.env.example` placeholders).
3. Hardcoded **public** addresses exist and were individually verified as
   non-sensitive:
   - `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`,
     `GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7`,
     `GDG2PZ7U4B6L64QFLXZN3Z3S4K6Y5US2VPO6Z2A7K63VBLT3QMN7USDC` —
     Stellar's public testnet demo anchor addresses, copied from Stellar
     developer documentation into
     [`docs/WEBHOOKS.md`](./WEBHOOKS.md) and
     [`scripts/anchor_offramp_demo.js`](../scripts/anchor_offramp_demo.js).
     They are public keys of a public testnet service; no secret material for
     them exists in this repository. Left in place.
   - `GAAAA…WHF` in [`scripts/verify-fees.ts`](../scripts/verify-fees.ts) is
     the ed25519 zero key used as a simulation source. Not a key anyone holds.

**Git history note.** Per the audit above, no historical testnet key has ever
been committed to this repository, so there is nothing to purge and no
post-scrub rotation to record. If a future audit finds an embedded key: (1)
treat it as compromised regardless of network, (2) rotate the role via
[`docs/rotation-runbook.md`](./rotation-runbook.md), (3) purge with
`git filter-repo`, force-push all refs, and invalidate CI caches, (4) record
all four steps in a new entry here. Audit commands are kept above so the sweep
is reproducible.

**Follow-ups.** The key ceremony ([`docs/ceremony.md`](./ceremony.md)) and
quarterly rotation drill
([`scripts/key_rotation_drill.ts`](../scripts/key_rotation_drill.ts),
[`.github/workflows/key-rotation-drill.yml`](../.github/workflows/key-rotation-drill.yml))
land with the same change; the first scheduled drill run attaches its
pass/fail matrix artifact below.
