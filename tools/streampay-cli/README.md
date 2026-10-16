# StreamPay CLI

Headless TypeScript CLI for StreamPay contract operations. It uses the
repository's Stellar SDK dependency and invokes Soroban RPC `simulateTransaction`
for every mutating transaction before signing or submission. Simulation output
includes the actual RPC ledger footprint and event-derived token balance
deltas; it does not predict final account balances with local accrual math.

## Install

Requires Node.js 22.6 or newer.

```bash
cd tools/streampay-cli
npm install
npm link
```

Set `STREAMPAY_SECRET_KEY` for the environment signer. Keep secret material out
of command-line arguments and shell history.

## Commands

```bash
streampay --contract <CONTRACT_ID> --signer env create \
  --token <TOKEN_ID> --recipient <RECIPIENT> --deposit 1000000 --days 30

streampay --contract <CONTRACT_ID> --signer env withdraw \
  --stream-id 12 --amount 5000

streampay --contract <CONTRACT_ID> --signer env cancel --stream-id 12
streampay --contract <CONTRACT_ID> --signer env top-up --stream-id 12 --amount 5000
streampay --contract <CONTRACT_ID> --signer env claim-all

streampay --contract <CONTRACT_ID> --signer env --dry-run --json \
  withdraw --stream-id 12 --amount 5000
```

Amounts are integer smallest-token units. `create` schedules its start 60
seconds after invocation so the ledger can include the transaction before the
stream begins. Creation requires the sender to have approved the StreamPay
contract to spend the deposit (and any configured protocol fee) on the token.
`claim-all` discovers recipient streams on-chain, selects currently active
streams with a positive on-chain `available` result, and simulates/submits
batches of up to 50 `withdraw_max` operations.

## Signers

- `--signer env` reads `STREAMPAY_SECRET_KEY` (override with `--secret-env`).
- `--signer file --key-file <path>` decrypts the versioned AES-256-GCM key
  file using the password in `STREAMPAY_KEY_PASSWORD` (override with
  `--password-env`). Create a file with
  `streampay key encrypt --out <path>`; the command reads both values from
  those environment variables and requests owner-only permissions on POSIX.
  On Windows, store the file in a directory protected by the account's ACL.
- `--signer ledger --source <G...>` prints the assembled unsigned transaction
  XDR after simulation. Sign that exact XDR with a hardware wallet, then pass
  the signed envelope in `--signed-xdr <path>` to submit it. Its transaction
  hash must match the simulated transaction. For multi-batch `claim-all`, each
  invocation prepares or submits the next batch; repeat until the output no
  longer contains `hasMore: true`.

`--dry-run` never submits, regardless of signer mode. `--rpc-url` and
`--network testnet|mainnet` select the RPC; defaults are Stellar testnet.

## Scripting Contract

`--json` emits one JSON object per invocation. The stable schema is
[`json-schema-v1.json`](./json-schema-v1.json), versioned by `schemaVersion: 1`.
Amounts, fees, and deltas are decimal strings to preserve integer precision.
Footprint entries and event payloads are base64 XDR from the successful RPC
simulation. `expectedBalances.changes` contains token-unit deltas decoded from
StreamPay contract events; they are not post-transaction balances. Error
objects use the same `schemaVersion`, with `ok: false` and a stable `error.code`.

Exit codes:

| Code | Meaning |
|---:|---|
| 0 | Success, simulation, preparation, or no eligible claims |
| 1 | RPC or on-chain submission failure |
| 2 | Invalid command or arguments |
| 3 | Signer or encrypted key failure |
| 4 | Soroban simulation rejected the operation |
| 5 | Transaction inclusion timeout |

The schema and exit codes are part of the CLI's v1 scripting API. Breaking
changes require a schema/major-version change.

## Tests

```bash
npm run typecheck
npm test
```

The sandbox integration test exercises a real testnet Soroban simulation when
`STREAMPAY_TEST_CONTRACT_ID`, `STREAMPAY_TEST_SOURCE`, and
`STREAMPAY_TEST_STREAM_ID` identify a funded recipient stream with at least one
smallest unit available. It skips when these variables are absent. Optional
`STREAMPAY_TEST_RPC_URL` overrides the testnet endpoint.

## PR description

Closes #112