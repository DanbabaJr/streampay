# StreamPay CLI

Headless TypeScript CLI for reading StreamPay contract state. It uses the
repository's Stellar SDK dependency and invokes Soroban RPC
`simulateTransaction` (never signing or submitting) for every snapshot.

Requires Node.js 22.6 or newer.

## Install

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

## Commands

`status` and `get` are aliases: both read `get_stream` and print one decoded
stream snapshot.

```bash
streampay --contract <CONTRACT_ID> status --stream-id 12
streampay --contract <CONTRACT_ID> --json get --stream-id 12
streampay --network mainnet --contract <CONTRACT_ID> status --stream-id 12
```

Options:

| Option | Meaning |
|---|---|
| `--contract <C...>` | StreamPay contract id (required) |
| `--stream-id <n>` | Stream id (required) |
| `--network <testnet\|mainnet>` | Network (default: `testnet`) |
| `--rpc-url <url>` | Soroban RPC endpoint |
| `--json` | Emit one JSON object matching schema v1 |
| `--watch` | Poll and emit JSON Lines (see below) |
| `--interval <ms>` | Watch poll interval (default: 5000; minimum: 1000) |
| `-h`, `--help` | Usage |

The snapshot contains the contract's full `Stream` state (`id`, parties,
token, deposit, withdrawn, window, cancelable, status). Amounts are decimal
strings in smallest token units; timestamps are Unix seconds.

## Watch mode

```bash
streampay --contract <CONTRACT_ID> --watch --interval 5000 status --stream-id 12
```

Watch mode always emits JSON Lines on stdout, even without `--json`:

- one `event: "change"` line on the first successful poll (the baseline), and
  then exactly one line each time the **decoded** stream state changes;
- nothing for polls that observe the same state;
- one `event: "summary"` line when SIGINT stops the watch, then exit code 0.

Change detection compares the decoded `Stream` projection (`id`, sender,
recipient, token, deposit, withdrawn, start/end time, cancelable, status),
not raw RPC bytes. RPC metadata such as `latestLedger`, simulation cost, and
ledger timestamps therefore never counts as a change. `available` is not part
of the projection: it accrues every second and is not stored contract state.

### Interval floor

`--interval` is in milliseconds. Values below **1000 ms** are rejected with
exit code 2 so a forgotten flag cannot burn an RPC budget at sub-second
cadence. The default is 5000 ms.

## Scripting contract

The stable schema is [`json-schema-v1.json`](./json-schema-v1.json),
versioned by `schemaVersion: 1`. Non-watch output is a single JSON object;
watch output is one object per line. Error objects use the same
`schemaVersion`, with `ok: false` and a stable `error.code`.
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
| 0 | Success, including a clean SIGINT shutdown of `--watch` |
| 1 | RPC failure |
| 2 | Invalid command or arguments (including a sub-minimum `--interval`) |
| 4 | Soroban simulation rejected `get_stream` (e.g. stream not found) |
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

The tests use an in-process mocked Soroban RPC and cover: one line per state
change, silence on unchanged polls, SIGINT summary/exit 0, schema validation
of every emitted line, and byte-identical non-watch output across ledger
noise.

## PR description

Closes #519
The sandbox integration test exercises a real testnet Soroban simulation when
`STREAMPAY_TEST_CONTRACT_ID`, `STREAMPAY_TEST_SOURCE`, and
`STREAMPAY_TEST_STREAM_ID` identify a funded recipient stream with at least one
smallest unit available. It skips when these variables are absent. Optional
`STREAMPAY_TEST_RPC_URL` overrides the testnet endpoint.

## PR description

Closes #112
