# Testnet lifecycle canary

The scheduled workflow runs a fresh StreamPay lifecycle on Stellar testnet:

1. Ensure the bot sender account and a separate, deterministic recipient
   derived from the bot key exist through Friendbot; the derived recipient key
   never leaves the runner.
2. Approve the native XLM Stellar Asset Contract, create a cancelable stream,
   wait for accrual, withdraw a partial amount, withdraw the maximum available,
   then cancel.
3. Build contract calls with the frontend's signing-free
   `frontend/lib/stellar-ops.ts` operation builders and submit each transaction
   only after Soroban RPC simulation succeeds.

Each run starts a newly created stream and never depends on stream ids or state
from an earlier run. The recipient is deterministically derived from the sender
key. When a sender secret is configured, the recipient account is stable and
its claims remain recoverable; with the default ephemeral sender, the testnet
balances are disposable and both keys are discarded after the run.
If no sender secret is configured, the runner creates an ephemeral keypair in
memory and funds it from the testnet Friendbot. A configured sender secret is
optional and is used only when present. The runner verifies the RPC-reported
network passphrase before funding or submitting transactions; the report says
`unverified` until that check succeeds. The RPC URL must use HTTPS, and any
Friendbot override must be the official `https://friendbot.stellar.org/`
endpoint.

Set these repository variables to enable live runs:

- Variable `STREAMPAY_CANARY_CONTRACT_ID`: deployed testnet StreamPay contract.
- Optional variable `STREAMPAY_CANARY_TOKEN_ID`: SEP-41 token contract id; by
  default the testnet native XLM Stellar Asset Contract is used.
- Optional variable `STREAMPAY_CANARY_RPC_URL`: alternate testnet Soroban RPC.
- Optional secret `STREAMPAY_CANARY_SECRET_KEY`: a testnet sender key; omit it
  to use an ephemeral keypair funded by Friendbot.
- Optional secret `ONCALL_WEBHOOK_URL`: Slack/Discord-compatible on-call
  webhook. If it is absent, the exact alert is still written to the workflow
  summary and uploaded evidence artifact.

Use the workflow's `force_failure` dispatch input to verify the simulation
failure alert without contacting Friendbot or submitting a transaction. The
alert and JSON artifact include the exact step, failure class, RPC excerpt,
unsigned transaction/operation XDR when available, commit, actor, and workflow
run URL. If a stage fails after stream creation, the runner attempts a cleanup
cancellation and reports any cleanup failure separately.

Local validation (Node.js 22.6+):

`runner.ts` executes `frontend/lib/stellar-ops.ts`, and Node resolves a bare
specifier from the importing file upwards — so that module looks for
`@stellar/stellar-sdk` in `frontend/lib/node_modules`, then
`frontend/node_modules`, then the repository root, and never in this
directory's own `node_modules`. Both trees therefore have to be installed for
the suite to load; a `tools/canary`-only install fails at import time with
`ERR_MODULE_NOT_FOUND`. The CI jobs install both.

```bash
npm ci --prefix ../../frontend --ignore-scripts   # the imported module's own tree
npm ci --ignore-scripts                           # this tool's tree
npm test
npm run typecheck
npm audit --omit=dev --audit-level=high
npm run canary
```

The live command requires the same environment values as the workflow. It
writes `canary-result.json` in the current directory and exits non-zero on
failure.
