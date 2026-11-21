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

## Read-only snapshots: `status` / `get`

`status` and `get` are aliases: both read `get_stream` and print one decoded
stream snapshot. They never sign or submit anything.

```bash
streampay --contract <CONTRACT_ID> status --stream-id 12
streampay --contract <CONTRACT_ID> --json get --stream-id 12
streampay --network mainnet --contract <CONTRACT_ID> status --stream-id 12
```

The snapshot contains the contract's full `Stream` state (`id`, sender,
recipient, token, deposit, withdrawn, start/end time, cancelable, status).
Amounts are decimal strings in smallest token units; timestamps are Unix
seconds.

### Watch mode

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

`--interval` is in milliseconds. Values below **1000 ms** are rejected with
exit code 2 so a forgotten flag cannot burn an RPC budget at sub-second
cadence. The default is 5000 ms.
## Profiles

Named profiles store the settings you otherwise repeat on every call.

```bash
# A custom profile: a local sandbox RPC with its own passphrase.
streampay profile set sandbox --network testnet \
  --rpc-url http://localhost:8000/soroban/rpc \
  --passphrase "Standalone Network ; February 2017" \
  --contract <CONTRACT_ID> --signer env --secret-env MY_STELLAR_KEY

streampay profile use sandbox                  # make it the default
streampay claim-all                            # uses the default profile
streampay --profile testnet --contract <ID> --dry-run --signer ledger \
  --source <G...> claim-all                    # another profile, flags still win

streampay profile list | show <name> | remove <name> | resolve
```

`testnet` and `mainnet` are built in and always exist; a profile with the same
name overrides individual settings (`profile remove` reverts it). A profile must
name its `network`; `contract`, `rpc-url`, `passphrase`, `signer`, `source`,
`key-file`, `secret-env` and `password-env` are optional.

**Precedence** for every setting is *flag > profile > built-in default*.
`streampay profile resolve [--profile <name>] [flags]` prints each effective
setting with its source (`flag`, `profile:<name>` or `default`), so you can see
exactly what a command would use. The profile is picked by `--profile`, else the
config's default (`profile use`), else none. A command whose profile has no
contract fails with exit code 2 before any RPC call, as does an unknown profile
(the error lists the known ones) or an invalid setting.

**Secrets are never stored.** A profile holds *references*: the **name** of an
environment variable (`--secret-env`, `--password-env`) or the path of an
encrypted key file (`--key-file`, see `key encrypt`). Anything that looks like a
secret key (a Stellar `S...` seed or a 64-character hex key) is rejected, both
when you save a profile and when the config is loaded, wherever in the file it
appears; so are credentials embedded in an RPC URL and settings named `secret`,
`password`, `seed`, `mnemonic` or `private-key`. The error says how to reference
a secret instead and never repeats it. If a secret ever ends up in the file,
remove it and rotate the key. The config is written atomically, readable only by
you (mode `0600`).

**Config file location** (override with `--config <path>` or
`$STREAMPAY_CONFIG`):

| Platform | Path |
|---|---|
| Linux, macOS | `$XDG_CONFIG_HOME/streampay/config.json`, else `~/.config/streampay/config.json` |
| Windows | `%APPDATA%\streampay\config.json` |

The file is JSON: `{ "version": 1, "defaultProfile": "sandbox", "profiles": { ... } }`.
A malformed config (invalid JSON, wrong version, unknown setting, bad value, a
secret) fails with error code `CONFIG` and exit code 2, names the file, and is
**never overwritten**: fix or delete it. `profile` commands emit the same
`schemaVersion: 1` JSON with `--json`.

## Shell completions

`streampay completion <bash|zsh|fish>` prints a static completion script for
every command, subcommand, and flag, including the `--network` and `--signer`
values. The script is generated from the same command registry the CLI parses,
and it never runs node while completing.

Bash (needs the `bash-completion` package for the user directory):

```bash
mkdir -p ~/.local/share/bash-completion/completions
streampay completion bash > ~/.local/share/bash-completion/completions/streampay
# or, for the current shell only:
source <(streampay completion bash)
```

Zsh:

```zsh
mkdir -p ~/.zfunc
streampay completion zsh > ~/.zfunc/_streampay
# in ~/.zshrc, before compinit:
fpath=(~/.zfunc $fpath)
autoload -Uz compinit && compinit
```

Fish:

```fish
streampay completion fish > ~/.config/fish/completions/streampay.fish
```

Open a new shell afterwards. Regenerate the script after upgrading the CLI.
`completion` prints a shell script, so it refuses `--json` with a `USAGE` error.

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

`--json` emits one JSON object per invocation (watch mode emits one object per
line). The stable schema is
[`json-schema-v1.json`](./json-schema-v1.json), versioned by `schemaVersion: 1`.
Amounts, fees, and deltas are decimal strings to preserve integer precision.
Footprint entries and event payloads are base64 XDR from the successful RPC
simulation. `expectedBalances.changes` contains token-unit deltas decoded from
StreamPay contract events; they are not post-transaction balances. Error
objects use the same `schemaVersion`, with `ok: false` and a stable `error.code`.

Exit codes:

| Code | Meaning |
|---:|---|
| 0 | Success, simulation, preparation, no eligible claims, or a clean SIGINT shutdown of `--watch` |
| 1 | RPC or on-chain submission failure |
| 2 | Invalid command or arguments (including a sub-minimum `--interval`), or an invalid profile/config (`error.code` `USAGE` or `CONFIG`) |
| 3 | Signer or encrypted key failure |
| 4 | Soroban simulation rejected the operation (e.g. `get_stream` on a missing stream) |
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

The `status`/`get` and watch tests use an in-process mocked Soroban RPC and
cover: one line per decoded state change, silence for unchanged polls despite
advancing ledger metadata, SIGINT summary flush with exit 0, snapshot
stability across invocations, the `--interval` floor, and schema validation of
every emitted line against `json-schema-v1.json`.

## PR description

Closes #112