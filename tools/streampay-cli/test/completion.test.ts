import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { completionScript } from "../src/completion.ts";
import {
  COMMANDS,
  COMPLETION_SHELLS,
  GLOBAL_OPTIONS,
  NETWORKS,
  SIGNER_MODES,
  allOptions,
} from "../src/registry.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const snapshotDir = new URL("./__snapshots__/", import.meta.url);
const update = process.env.UPDATE_SNAPSHOTS === "1";

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cliPath, ...args], {
    encoding: "utf8",
  });
}

for (const shell of COMPLETION_SHELLS) {
  test(`${shell} completion script matches its snapshot`, () => {
    const file = new URL(`completion.${shell}`, snapshotDir);
    const script = completionScript(shell);
    if (update || !existsSync(file)) {
      mkdirSync(snapshotDir, { recursive: true });
      writeFileSync(file, script);
    }
    assert.equal(script, readFileSync(file, "utf8"), `run with UPDATE_SNAPSHOTS=1 to refresh completion.${shell}`);
  });

  test(`${shell} completion names every registered command, subcommand and flag (drift guard)`, () => {
    const script = completionScript(shell);
    for (const command of COMMANDS) {
      assert.match(script, new RegExp(`\\b${command.name}\\b`), `${shell} is missing command ${command.name}`);
      for (const sub of command.subcommands ?? []) {
        assert.match(script, new RegExp(`\\b${sub.name}\\b`), `${shell} is missing ${command.name} ${sub.name}`);
      }
      for (const value of command.positional?.values ?? []) {
        assert.ok(script.includes(value), `${shell} is missing ${command.name} ${value}`);
      }
    }
    for (const option of allOptions()) {
      const spelled = shell === "fish" ? `-l ${option.name} ` : `--${option.name}`;
      assert.ok(script.includes(spelled), `${shell} is missing --${option.name}`);
    }
    for (const value of [...NETWORKS, ...SIGNER_MODES]) {
      assert.ok(script.includes(value), `${shell} is missing enum value ${value}`);
    }
  });

  test(`streampay completion ${shell} prints the static script`, () => {
    const result = runCli("completion", shell);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, completionScript(shell));
    assert.doesNotMatch(result.stdout, /\bnode\b/, "completion must not call node at completion time");
  });
}

test("every option the CLI reads is in the registry (drift guard)", () => {
  const source = readFileSync(cliPath, "utf8");
  const read = new Set(
    [...source.matchAll(/(?:getOption|required)\(options, "([a-z-]+)"\)/g)].map((match) => match[1]!)
  );
  for (const flag of source.matchAll(/flags\.has\("--([a-z-]+)"\)/g)) read.add(flag[1]!);
  const known = new Set(allOptions().map((option) => option.name));
  for (const name of read) assert.ok(known.has(name), `--${name} is parsed by cli.ts but missing from the registry`);
});

test("every registered command is accepted by the CLI dispatch", () => {
  for (const command of COMMANDS) {
    if (command.subcommands || command.positional || command.name === "help") continue;
    const result = runCli("--json", command.name);
    const output = JSON.parse(result.stdout) as { ok: boolean; error?: { message: string } };
    assert.doesNotMatch(output.error?.message ?? "", /unknown command/, `${command.name} is not dispatched`);
  }
});

test("usage lists every registered command and global option", () => {
  const result = runCli("--help");
  assert.equal(result.status, 0, result.stderr);
  for (const command of COMMANDS) {
    if (command.name === "help") continue;
    assert.ok(result.stdout.includes(command.name), `usage is missing ${command.name}`);
  }
  for (const option of GLOBAL_OPTIONS) {
    if (["help", "passphrase", "secret-env", "password-env"].includes(option.name)) continue;
    assert.ok(result.stdout.includes(`--${option.name}`), `usage is missing --${option.name}`);
  }
});

test("completion rejects a missing or unknown shell and --json, keeping the JSON error contract", () => {
  for (const args of [["completion"], ["completion", "powershell"]]) {
    const result = runCli(...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /bash, zsh, fish/);
  }
  const json = runCli("--json", "completion", "bash");
  assert.equal(json.status, 2);
  const output = JSON.parse(json.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(output).sort(), ["error", "ok", "schemaVersion"]);
  assert.equal(output.ok, false);
  assert.deepEqual(output.error, { code: "USAGE", message: "completion prints a shell script; drop --json" });
});
