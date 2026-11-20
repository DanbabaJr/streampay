import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { schemaError } from "./schema.ts";
import {
  BUILTIN_PROFILES,
  ConfigError,
  configPath,
  listProfiles,
  loadConfig,
  looksLikeSecret,
  resolveSettings,
  getProfile,
  emptyConfig,
} from "../src/profiles.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const CONTRACT_2 = StrKey.encodeContract(Buffer.alloc(32, 7));
const LOCAL_PASSPHRASE = "Standalone Network ; February 2017";

interface Ctx {
  dir: string;
  config: string;
  run: (...args: string[]) => { status: number | null; stdout: string; stderr: string };
  json: (...args: string[]) => { status: number | null; out: Record<string, any> };
}

function withDir(fn: (ctx: Ctx) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "streampay-profiles-"));
    const config = join(dir, "config.json");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir };
    for (const key of ["STREAMPAY_CONFIG", "XDG_CONFIG_HOME", "APPDATA", "STREAMPAY_SECRET_KEY", "STREAMPAY_KEY_PASSWORD"]) {
      delete env[key];
    }
    const run: Ctx["run"] = (...args) => {
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cliPath, "--config", config, ...args], {
        encoding: "utf8",
        env,
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const json: Ctx["json"] = (...args) => {
      const r = run("--json", ...args);
      return { status: r.status, out: JSON.parse(r.stdout) };
    };
    try {
      await fn({ dir, config, run, json });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ── Location ──────────────────────────────────────────────────────────────────

test("config location follows platform conventions", () => {
  const base = { env: {} as NodeJS.ProcessEnv, home: "/home/ada" };
  assert.equal(configPath({ ...base, platform: "linux" }), join("/home/ada", ".config", "streampay", "config.json"));
  assert.equal(
    configPath({ ...base, platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" } }),
    join("/xdg", "streampay", "config.json")
  );
  assert.equal(
    configPath({ ...base, platform: "win32", env: { APPDATA: "C:\\Users\\ada\\AppData\\Roaming" } }),
    join("C:\\Users\\ada\\AppData\\Roaming", "streampay", "config.json")
  );
  assert.equal(
    configPath({ ...base, platform: "win32" }),
    join("/home/ada", "AppData", "Roaming", "streampay", "config.json"),
    "falls back when APPDATA is unset"
  );
  // Overrides: --config beats $STREAMPAY_CONFIG beats the platform default.
  const env = { STREAMPAY_CONFIG: "/etc/sp.json", XDG_CONFIG_HOME: "/xdg" };
  assert.equal(configPath({ ...base, platform: "linux", env }), "/etc/sp.json");
  assert.equal(configPath({ ...base, platform: "linux", env, flag: "/tmp/x.json" }), "/tmp/x.json");
});

test("the default location is used when --config is absent", withDir(({ dir }) => {
  const xdg = join(dir, "xdg");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cliPath, "--json", "profile", "set", "dev", "--network", "testnet"], {
    encoding: "utf8",
    env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: xdg, STREAMPAY_CONFIG: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(xdg, "streampay", "config.json")));
  assert.equal(JSON.parse(r.stdout).configPath, join(xdg, "streampay", "config.json"));
}));

// ── CRUD ──────────────────────────────────────────────────────────────────────

test("a fresh config lists only the built-in profiles", withDir(({ json, config }) => {
  const { status, out } = json("profile", "list");
  assert.equal(status, 0);
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.ok, true);
  assert.equal(out.command, "profile list");
  assert.equal(out.configPath, config);
  assert.equal(out.defaultProfile, null);
  assert.deepEqual(out.profiles, [
    { name: "mainnet", origin: "builtin", fields: { network: "mainnet" } },
    { name: "testnet", origin: "builtin", fields: { network: "testnet" } },
  ]);
  assert.equal(existsSync(config), false, "reading never creates the file");
}));

test("profile set creates, updates and unsets settings", withDir(({ json, config }) => {
  let r = json("profile", "set", "dev", "--network", "testnet", "--rpc-url", "http://127.0.0.1:8000/soroban/rpc",
    "--passphrase", LOCAL_PASSPHRASE, "--contract", CONTRACT);
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.equal(r.out.command, "profile set");
  assert.deepEqual(r.out.profile.fields, {
    network: "testnet",
    "rpc-url": "http://127.0.0.1:8000/soroban/rpc",
    passphrase: LOCAL_PASSPHRASE,
    contract: CONTRACT,
  });

  // Update merges: untouched settings survive.
  r = json("profile", "set", "dev", "--contract", CONTRACT_2, "--signer", "ledger");
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.equal(r.out.profile.fields.contract, CONTRACT_2);
  assert.equal(r.out.profile.fields.signer, "ledger");
  assert.equal(r.out.profile.fields["rpc-url"], "http://127.0.0.1:8000/soroban/rpc");

  r = json("profile", "set", "dev", "--unset", "signer, passphrase");
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.equal(r.out.profile.fields.signer, undefined);
  assert.equal(r.out.profile.fields.passphrase, undefined);

  // On disk: stable, sorted field order, version 1.
  const onDisk = JSON.parse(readFileSync(config, "utf8"));
  assert.equal(onDisk.version, 1);
  assert.deepEqual(Object.keys(onDisk.profiles.dev), ["network", "rpc-url", "contract"]);
}));

test("profile show reports stored fields and the effective network settings", withDir(({ json }) => {
  json("profile", "set", "stage", "--network", "mainnet", "--rpc-url", "https://rpc.example.org");
  const { status, out } = json("profile", "show", "stage");
  assert.equal(status, 0);
  assert.equal(out.profile.name, "stage");
  assert.equal(out.profile.origin, "config");
  assert.equal(out.profile.default, false);
  assert.equal(out.profile.effective.network, "mainnet");
  assert.equal(out.profile.effective.rpcUrl, "https://rpc.example.org");
  assert.match(out.profile.effective.passphrase, /Public Global Stellar Network/);

  const builtin = json("profile", "show", "testnet").out.profile;
  assert.equal(builtin.origin, "builtin");
  assert.equal(builtin.effective.rpcUrl, "https://soroban-testnet.stellar.org");
}));

test("profile use sets the default and profile remove deletes (and clears a dangling default)", withDir(({ json }) => {
  json("profile", "set", "dev", "--network", "testnet");
  assert.equal(json("profile", "use", "dev").out.defaultProfile, "dev");
  const list = json("profile", "list").out;
  assert.equal(list.defaultProfile, "dev");
  assert.equal(json("profile", "show", "dev").out.profile.default, true);

  const removed = json("profile", "remove", "dev");
  assert.equal(removed.status, 0);
  assert.equal(removed.out.name, "dev");
  const after = json("profile", "list").out;
  assert.equal(after.defaultProfile, null, "default follows the removed profile");
  assert.deepEqual(after.profiles.map((p: { name: string }) => p.name), ["mainnet", "testnet"]);
}));

test("built-ins can be overridden, reverted, and never removed outright", withDir(({ json }) => {
  const r = json("profile", "set", "mainnet", "--contract", CONTRACT);
  assert.equal(r.status, 0, JSON.stringify(r.out));
  assert.equal(r.out.profile.origin, "builtin+config");
  assert.equal(r.out.profile.fields.network, "mainnet", "built-in network is kept");

  const reverted = json("profile", "remove", "mainnet");
  assert.equal(reverted.status, 0);
  assert.equal(reverted.out.revertedToBuiltin, true);

  const refused = json("profile", "remove", "mainnet");
  assert.equal(refused.status, 2);
  assert.match(refused.out.error.message, /built-in profile/);
}));

test("text output is readable", withDir(({ run }) => {
  run("profile", "set", "dev", "--network", "testnet", "--contract", CONTRACT);
  const list = run("profile", "list");
  assert.match(list.stdout, /^Config: /m);
  assert.match(list.stdout, /dev \[config\] network=testnet contract=C/);
  assert.match(run("profile", "show", "dev").stdout, /Profile dev \[config\]/);
  assert.match(run("profile", "resolve", "--profile", "dev").stdout, /network: testnet \(profile:dev\)/);
}));

test("every profile subcommand's JSON output validates against the published schema", withDir(({ json }) => {
  const runs = [
    ["profile", "set", "dev", "--network", "testnet", "--contract", CONTRACT],
    ["profile", "list"],
    ["profile", "show", "dev"],
    ["profile", "use", "dev"],
    ["profile", "resolve"],
    ["profile", "remove", "dev"],
  ];
  for (const args of runs) {
    const { status, out } = json(...args);
    assert.equal(status, 0, args.join(" "));
    assert.equal(schemaError(out), null, `${args.join(" ")}: ${JSON.stringify(out)}`);
  }
  // Errors share the existing error envelope.
  const err = json("profile", "show", "ghost");
  assert.equal(schemaError(err.out), null, JSON.stringify(err.out));
}));

// ── Validation ────────────────────────────────────────────────────────────────

test("unknown profile fails with the list of known profiles", withDir(({ json }) => {
  json("profile", "set", "dev", "--network", "testnet");
  for (const args of [["profile", "show", "nope"], ["profile", "use", "nope"], ["profile", "remove", "nope"]]) {
    const { status, out } = json(...args);
    assert.equal(status, 2, args.join(" "));
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "USAGE");
    assert.match(out.error.message, /unknown profile "nope"\. Known profiles: dev, mainnet, testnet/);
  }
}));

test("a transaction command with an unknown profile fails before any RPC call", withDir(({ json }) => {
  json("profile", "set", "dev", "--network", "testnet");
  const { status, out } = json("--profile", "prod", "--contract", CONTRACT, "--signer", "ledger", "--source", Keypair.random().publicKey(), "claim-all");
  assert.equal(status, 2);
  assert.match(out.error.message, /unknown profile "prod"\. Known profiles: dev, mainnet, testnet/);
}));

test("a custom profile must name its network; values are validated when saved", withDir(({ json, config }) => {
  const cases: Array<[string[], RegExp]> = [
    [["profile", "set", "custom", "--contract", CONTRACT], /missing required field "network"/],
    [["profile", "set", "x", "--network", "devnet"], /must be one of: testnet, mainnet/],
    [["profile", "set", "x", "--network", "testnet", "--rpc-url", "not a url"], /must be an http\(s\) URL/],
    [["profile", "set", "x", "--network", "testnet", "--rpc-url", "ftp://rpc.example.org"], /must be an http\(s\) URL/],
    [["profile", "set", "x", "--network", "testnet", "--rpc-url", "https://user:pw@rpc.example.org"], /must not embed credentials/],
    [["profile", "set", "x", "--network", "testnet", "--contract", "GARBAGE"], /not a valid Stellar address/],
    [["profile", "set", "x", "--network", "testnet", "--signer", "carrier-pigeon"], /must be one of: env, file, ledger/],
    [["profile", "set", "x", "--network", "testnet", "--secret-env", "not an env name"], /NAME of an environment variable/],
    [["profile", "set", "bad name!", "--network", "testnet"], /invalid profile name/],
    [["profile", "set", "x"], /nothing to change/],
    [["profile", "set", "x", "--network", "testnet", "--unset", "bogus"], /cannot unset "bogus"/],
    [["profile", "set"], /needs a profile name/],
  ];
  for (const [args, expected] of cases) {
    const { status, out } = json(...args);
    assert.equal(status, 2, args.join(" "));
    assert.match(out.error.message, expected, args.join(" "));
  }
  assert.equal(existsSync(config), false, "a rejected set writes nothing");
}));

test("a profile missing its contract fails before any RPC call, naming the profile", withDir(({ json }) => {
  json("profile", "set", "nocontract", "--network", "testnet", "--signer", "ledger", "--source", Keypair.random().publicKey());
  const { status, out } = json("--profile", "nocontract", "claim-all");
  assert.equal(status, 2);
  assert.equal(out.error.code, "USAGE");
  assert.match(out.error.message, /profile "nocontract" has no contract/);
  assert.match(out.error.message, /profile set nocontract --contract/);
}));

// ── Precedence: flag > profile > default ─────────────────────────────────────

test("precedence: flag over profile over built-in default", withDir(({ json }) => {
  json("profile", "set", "dev", "--network", "mainnet", "--rpc-url", "https://rpc.dev.example.org", "--contract", CONTRACT);

  // Profile beats defaults.
  let s = json("profile", "resolve", "--profile", "dev").out.settings;
  assert.deepEqual(s.network, { value: "mainnet", source: "profile:dev" });
  assert.deepEqual(s["rpc-url"], { value: "https://rpc.dev.example.org", source: "profile:dev" });
  assert.equal(s.passphrase.source, "default", "unset in the profile -> default for the network");
  assert.match(s.passphrase.value, /Public Global Stellar Network/);

  // Flag beats profile, per setting; the rest still come from the profile.
  s = json("profile", "resolve", "--profile", "dev", "--network", "testnet", "--rpc-url", "https://flag.example.org").out.settings;
  assert.deepEqual(s.network, { value: "testnet", source: "flag" });
  assert.deepEqual(s["rpc-url"], { value: "https://flag.example.org", source: "flag" });
  assert.deepEqual(s.contract, { value: CONTRACT, source: "profile:dev" });
  assert.match(s.passphrase.value, /Test SDF Network/, "default follows the *effective* network");

  // No profile at all: defaults.
  s = json("profile", "resolve").out.settings;
  assert.deepEqual(s.network, { value: "testnet", source: "default" });
  assert.deepEqual(s["rpc-url"], { value: "https://soroban-testnet.stellar.org", source: "default" });
}));

test("the default profile applies without --profile, and --profile overrides it", withDir(({ json }) => {
  json("profile", "set", "a", "--network", "testnet", "--contract", CONTRACT);
  json("profile", "set", "b", "--network", "mainnet", "--contract", CONTRACT_2);
  json("profile", "use", "a");
  assert.equal(json("profile", "resolve").out.settings.contract.source, "profile:a");
  const b = json("profile", "resolve", "--profile", "b").out;
  assert.equal(b.profile, "b");
  assert.equal(b.settings.contract.value, CONTRACT_2);
}));

test("a transaction command takes its contract and RPC from the profile (no flags)", withDir(({ json }) => {
  // Port 1 refuses connections: reaching the RPC (exit 1) proves every
  // validation passed and the profile supplied the contract and endpoint.
  json("profile", "set", "dead", "--network", "testnet", "--rpc-url", "http://127.0.0.1:1", "--contract", CONTRACT,
    "--signer", "ledger", "--source", Keypair.random().publicKey());
  const { status, out } = json("--profile", "dead", "claim-all");
  assert.equal(status, 1, JSON.stringify(out));
  assert.equal(out.error.code, "RPC");

  // Same invocation with a flag overriding the profile's contract with garbage: usage error, not RPC.
  const bad = json("--profile", "dead", "--contract", "GARBAGE", "claim-all");
  assert.equal(bad.status, 2);
  assert.match(bad.out.error.message, /invalid contract address/);
}));

test("read-only status/get use the profile too, and fail fast without a contract", withDir(({ json }) => {
  json("profile", "set", "dead", "--network", "testnet", "--rpc-url", "http://127.0.0.1:1", "--contract", CONTRACT);
  // The profile supplies contract and endpoint: reaching the (refused) RPC is exit 1, not a usage error.
  const ok = json("--profile", "dead", "status", "--stream-id", "1");
  assert.equal(ok.status === 1 || ok.status === 4, true, JSON.stringify(ok.out));
  assert.notEqual(ok.out.error.code, "USAGE");

  json("profile", "set", "nocontract", "--network", "testnet");
  const missing = json("--profile", "nocontract", "get", "--stream-id", "1");
  assert.equal(missing.status, 2);
  assert.match(missing.out.error.message, /profile "nocontract" has no contract/);

  const unknown = json("--profile", "ghost", "status", "--stream-id", "1");
  assert.equal(unknown.status, 2);
  assert.match(unknown.out.error.message, /unknown profile "ghost"/);
}));

// ── Secrets are never stored ─────────────────────────────────────────────────

test("looksLikeSecret recognises Stellar secret seeds and raw hex keys", () => {
  const secret = Keypair.random().secret();
  assert.equal(looksLikeSecret(secret), true);
  assert.equal(looksLikeSecret(`  ${secret}\n`), true);
  assert.equal(looksLikeSecret(`prefix-${secret}-suffix`), true);
  assert.equal(looksLikeSecret("a".repeat(64)), true);
  assert.equal(looksLikeSecret(Keypair.random().publicKey()), false, "a public key is fine");
  assert.equal(looksLikeSecret(CONTRACT), false);
  assert.equal(looksLikeSecret("STREAMPAY_SECRET_KEY"), false, "an env var name is the point");
  assert.equal(looksLikeSecret("https://soroban-testnet.stellar.org"), false);
});

test("storing a raw secret key is rejected with guidance, and nothing is written", withDir(({ json, config }) => {
  const secret = Keypair.random().secret();
  const attempts: string[][] = [
    ["profile", "set", "x", "--network", "testnet", "--secret-env", secret],
    ["profile", "set", "x", "--network", "testnet", "--password-env", secret],
    ["profile", "set", "x", "--network", "testnet", "--source", secret],
    ["profile", "set", "x", "--network", "testnet", "--key-file", secret],
    ["profile", "set", "x", "--network", "testnet", "--passphrase", secret],
    ["profile", "set", "x", "--network", "testnet", "--rpc-url", `https://rpc.example.org/?key=${secret}`],
  ];
  for (const args of attempts) {
    const { status, out } = json(...args);
    assert.equal(status, 2, args.join(" ").replace(secret, "<secret>"));
    assert.equal(out.error.code, "USAGE");
    assert.match(out.error.message, /looks like a secret key/);
    assert.match(out.error.message, /--secret-env NAME/, "points at the supported flow");
    assert.match(out.error.message, /key encrypt/);
    assert.ok(!out.error.message.includes(secret), "the message must not echo the secret");
  }
  assert.equal(existsSync(config), false);
}));

test("secret-named settings are rejected as not profile settings", withDir(({ json }) => {
  const secret = Keypair.random().secret();
  for (const flag of ["--secret", "--password", "--seed", "--private-key", "--mnemonic"]) {
    const { status, out } = json("profile", "set", "x", "--network", "testnet", flag, secret);
    assert.equal(status, 2, flag);
    assert.match(out.error.message, /is not a profile setting/);
    assert.match(out.error.message, /Profiles never store secret material/);
  }
}));

test("references to secrets are stored, the secrets themselves never are", withDir(({ dir, json, config }) => {
  const secret = Keypair.random().secret();
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cliPath, "--config", config, "--json",
    "profile", "set", "signer-env", "--network", "testnet", "--signer", "env", "--secret-env", "MY_STELLAR_KEY"], {
    encoding: "utf8",
    env: { ...process.env, HOME: dir, MY_STELLAR_KEY: secret, STREAMPAY_SECRET_KEY: secret },
  });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(config, "utf8");
  assert.ok(!text.includes(secret), "the secret value must not appear in the config");
  assert.equal(JSON.parse(text).profiles["signer-env"]["secret-env"], "MY_STELLAR_KEY");
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret));

  const file = json("profile", "set", "signer-file", "--network", "testnet", "--signer", "file", "--key-file", "/home/ada/streampay.key", "--password-env", "MY_KEY_PASSWORD");
  assert.equal(file.status, 0, JSON.stringify(file.out));
}));

test("the config file is private to the owner", { skip: process.platform === "win32" }, withDir(({ json, config }) => {
  json("profile", "set", "dev", "--network", "testnet");
  assert.equal(statSync(config).mode & 0o777, 0o600);
}));

test("a hand-edited config containing a secret is refused, wherever it hides", withDir(({ config, json }) => {
  const secret = Keypair.random().secret();
  const bodies = [
    { version: 1, profiles: { dev: { network: "testnet", "secret-env": secret } } },
    { version: 1, profiles: { dev: { network: "testnet", note: `use ${secret}` } } },
    { version: 1, profiles: { dev: { network: "testnet", nested: { deep: [secret] } } } },
    { version: 1, notes: secret, profiles: {} },
    { version: 1, profiles: { dev: { network: "testnet", secret } } },
  ];
  for (const body of bodies) {
    writeFileSync(config, JSON.stringify(body));
    for (const args of [["profile", "list"], ["--profile", "dev", "--contract", CONTRACT, "claim-all"]]) {
      const { status, out } = json(...args);
      assert.equal(status, 2, JSON.stringify(body).replace(secret, "<secret>"));
      assert.equal(out.error.code, "CONFIG");
      assert.match(out.error.message, /secret key|not a profile setting/);
      assert.ok(!JSON.stringify(out).includes(secret), "the error must not echo the secret");
    }
  }
}));

// ── Malformed config ─────────────────────────────────────────────────────────

test("malformed config files fail clearly and are never overwritten", withDir(({ config, json }) => {
  const cases: Array<[string, RegExp]> = [
    ["{ not json", /is not valid JSON/],
    ["", /is not valid JSON/],
    ["[]", /must be a JSON object/],
    ['"text"', /must be a JSON object/],
    ["{}", /unsupported version undefined/],
    ['{"version":2,"profiles":{}}', /unsupported version 2/],
    ['{"version":1}', /"profiles" must be an object/],
    ['{"version":1,"profiles":[]}', /"profiles" must be an object/],
    ['{"version":1,"profiles":{},"extra":1}', /unknown top-level key\(s\): extra/],
    ['{"version":1,"profiles":{"dev":"testnet"}}', /profile "dev" must be an object/],
    ['{"version":1,"profiles":{"dev":{}}}', /missing required field "network"/],
    ['{"version":1,"profiles":{"dev":{"network":"devnet"}}}', /must be one of: testnet, mainnet/],
    ['{"version":1,"profiles":{"dev":{"network":"testnet","rpc-url":5}}}', /must be a non-empty string/],
    ['{"version":1,"profiles":{"dev":{"network":"testnet","colour":"red"}}}', /"colour" is not a profile setting/],
    ['{"version":1,"profiles":{"bad name":{"network":"testnet"}}}', /invalid profile name/],
    ['{"version":1,"defaultProfile":"ghost","profiles":{}}', /defaultProfile "ghost" does not exist/],
    ['{"version":1,"defaultProfile":7,"profiles":{}}', /"defaultProfile" must be a string/],
  ];
  for (const [body, expected] of cases) {
    writeFileSync(config, body);
    for (const args of [["profile", "list"], ["profile", "set", "ok", "--network", "testnet"], ["--profile", "testnet", "--contract", CONTRACT, "claim-all"]]) {
      const { status, out } = json(...args);
      assert.equal(status, 2, `${JSON.stringify(body)} :: ${args.join(" ")}`);
      assert.equal(out.error.code, "CONFIG");
      assert.match(out.error.message, expected, JSON.stringify(body));
      assert.ok(out.error.message.includes(config), "names the config file");
    }
    assert.equal(readFileSync(config, "utf8"), body, "a broken config is left untouched for the user to fix");
  }
}));

test("loadConfig: a missing file is an empty config, and errors are ConfigErrors", () => {
  const dir = mkdtempSync(join(tmpdir(), "streampay-profiles-unit-"));
  try {
    assert.deepEqual(loadConfig(join(dir, "absent.json")), emptyConfig());
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "nope");
    assert.throws(() => loadConfig(bad), ConfigError);
    // A directory where the file should be is an error, not a crash.
    mkdirSync(join(dir, "isdir"));
    assert.throws(() => loadConfig(join(dir, "isdir")), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Pure resolution ──────────────────────────────────────────────────────────

test("resolveSettings: flag > profile > default, per field", () => {
  const config = { version: 1 as const, profiles: { dev: { network: "mainnet", contract: CONTRACT, "rpc-url": "https://p.example.org" } } };
  const dev = getProfile(config, "dev");
  const s = resolveSettings(new Map([["rpc-url", "https://f.example.org"]]), dev);
  assert.deepEqual(s["rpc-url"], { value: "https://f.example.org", source: "flag" });
  assert.deepEqual(s.contract, { value: CONTRACT, source: "profile:dev" });
  assert.equal(s.network?.source, "profile:dev");
  assert.equal(s.signer, undefined, "unset settings stay unset");
});

test("built-in profiles are always listed and overlaid by the config", () => {
  assert.deepEqual(Object.keys(BUILTIN_PROFILES).sort(), ["mainnet", "testnet"]);
  const merged = listProfiles({ version: 1, profiles: { testnet: { contract: CONTRACT } as never } });
  const testnet = merged.find((p) => p.name === "testnet")!;
  assert.equal(testnet.origin, "builtin+config");
  assert.deepEqual(testnet.fields, { network: "testnet", contract: CONTRACT });
});
