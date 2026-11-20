/**
 * The CLI's command and flag registry. `parseArgs`, the command dispatch check, enum validation,
 * and the shell completion scripts all read from here, so completions cannot drift from the
 * commands the CLI actually accepts.
 */

export type OptionKind = "value" | "flag" | "enum" | "file";

export interface OptionSpec {
  /** Long name without the leading `--`. */
  readonly name: string;
  readonly kind: OptionKind;
  readonly description: string;
  /** Allowed values for `enum` options. */
  readonly values?: readonly string[];
}

export interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly options: readonly OptionSpec[];
  /** Nested subcommands (`key encrypt`). */
  readonly subcommands?: readonly CommandSpec[];
  /** Allowed values for a single positional argument (`completion bash`). */
  readonly positional?: { readonly name: string; readonly values: readonly string[] };
}

export const NETWORKS = ["testnet", "mainnet"] as const;
export const SIGNER_MODES = ["env", "file", "ledger"] as const;
export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;

export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { name: "contract", kind: "value", description: "StreamPay contract id" },
  { name: "network", kind: "enum", values: NETWORKS, description: "Stellar network (default: testnet)" },
  { name: "rpc-url", kind: "value", description: "Soroban RPC endpoint" },
  { name: "passphrase", kind: "value", description: "Override the network passphrase" },
  { name: "signer", kind: "enum", values: SIGNER_MODES, description: "Signer mode" },
  { name: "source", kind: "value", description: "Source address for ledger handoff or dry-run" },
  { name: "key-file", kind: "file", description: "Encrypted signer file (file mode)" },
  { name: "secret-env", kind: "value", description: "Env var holding the signing secret" },
  { name: "password-env", kind: "value", description: "Env var holding the key file password" },
  { name: "dry-run", kind: "flag", description: "Simulate, report footprint and do not submit" },
  { name: "signed-xdr", kind: "file", description: "Submit a ledger-signed transaction XDR file" },
  { name: "json", kind: "flag", description: "Emit JSON schema v1" },
  { name: "help", kind: "flag", description: "Show usage" },
];

const STREAM_ID: OptionSpec = { name: "stream-id", kind: "value", description: "Stream id" };
const AMOUNT: OptionSpec = { name: "amount", kind: "value", description: "Amount in smallest token units" };
const WATCH: OptionSpec = { name: "watch", kind: "flag", description: "Poll and emit JSON Lines, one line per state change" };
const INTERVAL: OptionSpec = { name: "interval", kind: "value", description: "Watch poll interval in milliseconds (default 5000, minimum 1000)" };

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "create",
    description: "Create a stream",
    options: [
      { name: "token", kind: "value", description: "Token contract id" },
      { name: "recipient", kind: "value", description: "Recipient address" },
      { name: "deposit", kind: "value", description: "Deposit in smallest token units" },
      { name: "days", kind: "value", description: "Stream duration in days" },
      { name: "cancelable", kind: "flag", description: "Allow the sender to cancel" },
    ],
  },
  { name: "withdraw", description: "Withdraw from a stream", options: [STREAM_ID, AMOUNT] },
  { name: "cancel", description: "Cancel a stream", options: [STREAM_ID] },
  { name: "top-up", description: "Top up a stream", options: [STREAM_ID, AMOUNT] },
  { name: "claim-all", description: "Withdraw every claimable recipient stream", options: [] },
  { name: "status", description: "Read and print one decoded stream snapshot", options: [STREAM_ID, WATCH, INTERVAL] },
  { name: "get", description: "Alias for status", options: [STREAM_ID, WATCH, INTERVAL] },
  {
    name: "key",
    description: "Manage encrypted signer keys",
    options: [],
    subcommands: [
      {
        name: "encrypt",
        description: "Write an encrypted signer key file",
        options: [
          { name: "out", kind: "file", description: "Output key file" },
          { name: "secret-env", kind: "value", description: "Env var holding the signing secret" },
          { name: "password-env", kind: "value", description: "Env var holding the key file password" },
          { name: "force", kind: "flag", description: "Overwrite an existing key file" },
        ],
      },
    ],
  },
  {
    name: "completion",
    description: "Print a shell completion script",
    options: [],
    positional: { name: "shell", values: COMPLETION_SHELLS },
  },
  { name: "help", description: "Show usage", options: [] },
];

/** Commands that run a StreamPay contract transaction. */
export const TRANSACTION_COMMANDS: readonly string[] = ["create", "withdraw", "cancel", "top-up", "claim-all"];

/** Read-only commands: one decoded `get_stream` snapshot, optionally watched. */
export const READ_COMMANDS: readonly string[] = ["status", "get"];

function allCommandSpecs(commands: readonly CommandSpec[] = COMMANDS): CommandSpec[] {
  return commands.flatMap((command) => [command, ...allCommandSpecs(command.subcommands ?? [])]);
}

/** Every option the parser knows, global and per-command, by long name (no duplicates). */
export function allOptions(): OptionSpec[] {
  const byName = new Map<string, OptionSpec>();
  for (const option of [...GLOBAL_OPTIONS, ...allCommandSpecs().flatMap((command) => command.options)]) {
    if (!byName.has(option.name)) byName.set(option.name, option);
  }
  return [...byName.values()];
}

/** `--name` for every option that takes no value. */
export function booleanFlags(): Set<string> {
  return new Set(allOptions().filter((option) => option.kind === "flag").map((option) => `--${option.name}`));
}

export function commandNames(): string[] {
  return COMMANDS.map((command) => command.name);
}

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}
