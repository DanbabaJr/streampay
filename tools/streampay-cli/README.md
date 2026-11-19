# StreamPay CLI

Headless TypeScript CLI for reading StreamPay contract state. It uses the
repository's Stellar SDK dependency and invokes Soroban RPC
`simulateTransaction` (never signing or submitting) for every snapshot.

Requires Node.js 22.6 or newer.

## Install

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

Exit codes:

| Code | Meaning |
|---:|---|
| 0 | Success, including a clean SIGINT shutdown of `--watch` |
| 1 | RPC failure |
| 2 | Invalid command or arguments (including a sub-minimum `--interval`) |
| 4 | Soroban simulation rejected `get_stream` (e.g. stream not found) |

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
