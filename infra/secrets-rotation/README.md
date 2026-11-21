# Zero-downtime secrets rotation

Webhook signing keys and RPC credentials expire. Rotating them by hand has two
failure modes, and both are common: rotate-then-update, where deliveries fail
until every subscriber has the new key, and never-rotate, where a key survives
the person who created it. This directory documents the pipeline that avoids
both; the implementation lives in
[`indexer/src/secrets/rotation.ts`](../../indexer/src/secrets/rotation.ts) and
[`indexer/src/rpc-manager.ts`](../../indexer/src/rpc-manager.ts).

```
issue ──► health check ──► promote ──► overlap window ──► retire
              │
              └─ fails ──► abort: previous secret stays active + alert
```

Nothing in this design holds a secret in the audit log, in a metric, or in a
fingerprint that can be reversed: every record is a sha256 prefix of the key id.

## Webhook signing keys

1. `WebhookKeyRotation.rotate(endpointId)` promotes a new key and keeps the old
   one in `webhook_endpoints.previous_secret`. It proves the pair verifies
   before reporting success, so a rotation that would break delivery fails
   instead of shipping.
2. During the overlap, `generateSignatureHeader` emits **one `v1` signature per
   active key** in `Streampay-Signature`. A subscriber that has not yet fetched
   the new key verifies with the old one; a subscriber that has verifies with
   the new one. Neither is asked to accept an unverified request.
3. The overlap is derived from the row's `updated_at` + policy window, so it
   survives a restart without a schema change.
4. After the window, verification *rejects* the previous key whether or not the
   sweep has run, and the sweep then clears `previous_secret`. A missed sweep
   cannot extend a key's life.

Retention is bounded from both sides: `SECRET_OVERLAP_MS` defaults to 24h and is
clamped to a 60s minimum.

## RPC credentials

`RpcManager.rotateCredentials(updates)` is the hot-reload path:

- each candidate is probed (`getLatestLedger`) against its endpoint **before**
  anything is swapped;
- one failed probe aborts the whole update — a partial rotation is never left
  behind, and the previous credential stays active on every endpoint;
- on success the credential map is swapped atomically. Requests carry a snapshot
  of that map from the moment they start, so an in-flight call finishes on the
  credential it began with and the next call uses the new one. No connection is
  torn down because there is no pool: credentials ride on each request;
- the health map (failure counts, ledger lag, unhealthy endpoints) is never
  touched by a rotation. A probe is not traffic and cannot mark a working
  endpoint unhealthy.

Configured from the environment by
[`indexer/src/secrets/config.ts`](../../indexer/src/secrets/config.ts):

| Variable | Meaning |
|---|---|
| `SECRETS_ROTATION_ENABLED` | `1` enables the scheduled rotation engine (default off) |
| `SECRET_OVERLAP_MS` | overlap window (default 24h, minimum 60s) |
| `SECRET_ROTATION_INTERVAL_MS` | rotation interval (default 30d, never below the overlap) |
| `SECRET_ROTATION_MAX_FAILURES` | consecutive aborts before the scheduler backs off (default 3) |
| `SECRET_ROTATION_AUDIT_PATH` | append the hash-chained audit log here |
| `WEBHOOK_KEY_SWEEP_INTERVAL_MS` | how often expired previous keys are retired |
| `RPC_AUTH_HEADER` / `RPC_AUTH_VALUE`, `RPC_BEARER_TOKEN` | credential applied to RPC requests |
| `RPC_CREDENTIAL_NAME` | secrets-manager key holding the RPC credential |

## Secrets manager integration

`SecretsProvider` is the seam (`get`/`put`). `EnvSecretProvider` is the default
for deployments that inject secrets as environment variables;
`MemorySecretProvider` is for tests and dry runs. An AWS Secrets Manager, GCP
Secret Manager or Vault adapter is a class implementing those two methods — the
rotation lifecycle, overlap, abort and audit behaviour is unchanged, which is
why none of it is written against a specific vendor.

A rotation that cannot read or write the provider aborts. There is no fallback
path that keeps a stale secret and reports success: the outcome is `ok: false`,
the previous secret remains active, and `onAlert` fires.

## Audit and reversibility

`AuditLog` appends `rotation_started`, `rotation_promoted`, `rotation_aborted`
and `secret_retired` entries, each hashing the previous entry's hash plus its
own fields:

```
hash = sha256(prevHash + seq + at + action + secretName + keyId + previousKeyId + actor + detail)
```

`verify()` recomputes the chain and names the first broken sequence, so an
edited or deleted entry is detectable from the log alone. Nothing is deleted on
rotation: a rollback promotes the previous value again, and the audit shows both
movements.

## Tests

```sh
cd indexer
npm run build
node --test dist/secrets/rotation.test.js dist/rpc-credentials.test.js
```

They cover the overlap window (both keys valid inside, only the new one
outside), dual-signed header acceptance, aborted rotations on a failed health
check / failed provider write / vanished endpoint, audit tampering and deletion,
rotation under continuous load (no verification may fail, the live key set never
exceeds two), and hot reload with an in-flight request plus preserved failover
state. `.github/workflows/secrets-rotation.yml` runs them on a schedule and on
every change to this surface.
