/**
 * Named network profiles: a small config file so users stop repeating
 * `--network/--rpc-url/--contract/...` on every call.
 *
 * Safety rule: **secret material is never written to, or accepted from, the
 * config.** A profile holds only non-secret settings, plus *references* to
 * secrets (the name of an environment variable, or the path of an encrypted key
 * file). Every value is screened for secret-looking content both when a profile
 * is saved and when the file is loaded, so a hand-edited config cannot smuggle
 * a key in either.
 *
 * Precedence for every setting: command-line flag > profile > built-in default.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Address, Networks } from "@stellar/stellar-sdk";
import { NETWORKS, SIGNER_MODES } from "./registry.ts";

export const DEFAULT_TESTNET_RPC = "https://soroban-testnet.stellar.org";
export const DEFAULT_MAINNET_RPC = "https://mainnet.sorobanrpc.com";

/** Settings a profile may hold. Names match the CLI flags without `--`. */
export const PROFILE_FIELDS = [
  "network",
  "rpc-url",
  "passphrase",
  "contract",
  "signer",
  "source",
  "key-file",
  "secret-env",
  "password-env",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type Profile = Partial<Record<ProfileField, string>>;

export interface ConfigFile {
  version: 1;
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}

/** Profiles that always exist. A config entry with the same name overrides fields. */
export const BUILTIN_PROFILES: Readonly<Record<string, Profile>> = {
  testnet: { network: "testnet" },
  mainnet: { network: "mainnet" },
};

/** `code` is the stable `error.code` the CLI reports (`CONFIG` or `USAGE`). */
export class ConfigError extends Error {
  readonly code: "CONFIG" | "USAGE";

  constructor(message: string, code: "CONFIG" | "USAGE" = "CONFIG") {
    super(message);
    this.code = code;
  }
}

export const SECRET_GUIDANCE =
  "Profiles never store secret material. Keep the key in an environment variable and reference it " +
  "(--secret-env NAME), or use an encrypted key file (`streampay key encrypt`) and reference it " +
  "(--signer file --key-file PATH --password-env NAME).";

// ── Location ──────────────────────────────────────────────────────────────────

/**
 * Where the config lives. Precedence: `--config` > `$STREAMPAY_CONFIG` >
 * the platform default: `%APPDATA%\streampay\config.json` on Windows,
 * `$XDG_CONFIG_HOME/streampay/config.json` (else `~/.config/...`) elsewhere.
 */
export function configPath(input: {
  flag?: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
}): string {
  if (input.flag) return input.flag;
  if (input.env.STREAMPAY_CONFIG) return input.env.STREAMPAY_CONFIG;
  if (input.platform === "win32") {
    const appData = input.env.APPDATA || join(input.home, "AppData", "Roaming");
    return join(appData, "streampay", "config.json");
  }
  const base = input.env.XDG_CONFIG_HOME || join(input.home, ".config");
  return join(base, "streampay", "config.json");
}

// ── Secret screening and validation ───────────────────────────────────────────

/** Config keys that can only mean "a secret goes here". */
const SECRET_KEY_NAMES = /^(secrets?|secret-?key|private-?key|seed|mnemonic|password)$/i;
const STELLAR_SECRET = /S[A-D][A-Z2-7]{54}/;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;

export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  return STELLAR_SECRET.test(v) || HEX_KEY.test(v);
}

/** Throws if `value` looks like key material. `where` names the field for the message. */
export function assertNotSecret(where: string, value: string): void {
  if (looksLikeSecret(value)) {
    throw new ConfigError(`${where} looks like a secret key and was not stored. ${SECRET_GUIDANCE}`, "USAGE");
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME.test(name)) {
    throw new ConfigError(
      `invalid profile name "${name}": use 1-32 letters, digits, "-" or "_", starting with a letter or digit`,
      "USAGE"
    );
  }
}

function fail(code: ConfigError["code"], message: string): never {
  throw new ConfigError(message, code);
}

/** Validates one field value. `code` is how a failure is reported. */
export function validateField(
  profile: string,
  field: string,
  value: unknown,
  code: ConfigError["code"]
): asserts value is string {
  const at = `profile "${profile}" field "${field}"`;
  if (!(PROFILE_FIELDS as readonly string[]).includes(field)) {
    const hint = SECRET_KEY_NAMES.test(field) ? ` ${SECRET_GUIDANCE}` : "";
    fail(code, `${at} is not a profile setting (allowed: ${PROFILE_FIELDS.join(", ")}).${hint}`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, `${at} must be a non-empty string`);
  }
  assertNotSecret(at, value);
  switch (field as ProfileField) {
    case "network":
      if (!(NETWORKS as readonly string[]).includes(value)) {
        fail(code, `${at} must be one of: ${NETWORKS.join(", ")}`);
      }
      break;
    case "signer":
      if (!(SIGNER_MODES as readonly string[]).includes(value)) {
        fail(code, `${at} must be one of: ${SIGNER_MODES.join(", ")}`);
      }
      break;
    case "rpc-url": {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return fail(code, `${at} must be an http(s) URL, got "${value}"`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        fail(code, `${at} must be an http(s) URL, got "${value}"`);
      }
      if (url.username || url.password) {
        fail(code, `${at} must not embed credentials (user:password@); they would be stored in plain text`);
      }
      break;
    }
    case "contract":
    case "source":
      try {
        Address.fromString(value);
      } catch {
        fail(code, `${at} is not a valid Stellar address`);
      }
      break;
    case "secret-env":
    case "password-env":
      if (!ENV_NAME.test(value)) {
        fail(
          code,
          `${at} must be the NAME of an environment variable (letters, digits, "_"), not its value. ${SECRET_GUIDANCE}`
        );
      }
      break;
    case "passphrase":
    case "key-file":
      break;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates a complete profile as stored (a user profile must name its network). */
export function validateProfile(name: string, profile: unknown, code: ConfigError["code"] = "CONFIG"): Profile {
  if (!isPlainObject(profile)) fail(code, `profile "${name}" must be an object`);
  for (const [field, value] of Object.entries(profile)) validateField(name, field, value, code);
  const merged = { ...BUILTIN_PROFILES[name], ...(profile as Profile) };
  if (!merged.network) {
    fail(code, `profile "${name}" is missing required field "network" (${NETWORKS.join(" or ")})`);
  }
  return profile as Profile;
}

// ── Load / save ───────────────────────────────────────────────────────────────

export function emptyConfig(): ConfigFile {
  return { version: 1, profiles: {} };
}

/** Recursively screens every string in parsed JSON, whatever key it is under. */
function scanForSecrets(path: string, value: unknown, trail: string): void {
  if (typeof value === "string") {
    if (looksLikeSecret(value)) {
      throw new ConfigError(
        `config ${path} contains what looks like a secret key at ${trail}. ${SECRET_GUIDANCE} ` +
          "Remove it from the file (and rotate the key if the file was shared or committed).",
        "CONFIG"
      );
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => scanForSecrets(path, item, `${trail}[${i}]`));
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) scanForSecrets(path, v, `${trail}.${k}`);
  }
}

/** Reads and fully validates the config. A missing file is an empty config. */
export function loadConfig(path: string): ConfigFile {
  if (!existsSync(path)) return emptyConfig();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read config ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `config ${path} is not valid JSON (${(error as Error).message}). Fix or delete the file.`
    );
  }
  if (!isPlainObject(parsed)) throw new ConfigError(`config ${path} must be a JSON object`);
  scanForSecrets(path, parsed, "$");

  const unknownTop = Object.keys(parsed).filter((k) => !["version", "defaultProfile", "profiles"].includes(k));
  if (unknownTop.length > 0) {
    throw new ConfigError(`config ${path} has unknown top-level key(s): ${unknownTop.join(", ")}`);
  }
  if (parsed.version !== 1) {
    throw new ConfigError(`config ${path} has unsupported version ${JSON.stringify(parsed.version)} (expected 1)`);
  }
  if (!isPlainObject(parsed.profiles)) {
    throw new ConfigError(`config ${path}: "profiles" must be an object of named profiles`);
  }
  const profiles: Record<string, Profile> = {};
  for (const [name, profile] of Object.entries(parsed.profiles)) {
    try {
      validateProfileName(name);
      profiles[name] = validateProfile(name, profile, "CONFIG");
    } catch (error) {
      if (error instanceof ConfigError) throw new ConfigError(`config ${path}: ${error.message}`);
      throw error;
    }
  }
  const config: ConfigFile = { version: 1, profiles };
  if (parsed.defaultProfile !== undefined) {
    if (typeof parsed.defaultProfile !== "string") {
      throw new ConfigError(`config ${path}: "defaultProfile" must be a string`);
    }
    if (!knownProfileNames(config).includes(parsed.defaultProfile)) {
      throw new ConfigError(
        `config ${path}: defaultProfile "${parsed.defaultProfile}" does not exist (known: ${knownProfileNames(config).join(", ")})`
      );
    }
    config.defaultProfile = parsed.defaultProfile;
  }
  return config;
}

/** Writes the config atomically with owner-only permissions. Re-validates first. */
export function saveConfig(path: string, config: ConfigFile): void {
  scanForSecrets(path, config, "$");
  for (const [name, profile] of Object.entries(config.profiles)) {
    validateProfileName(name);
    validateProfile(name, profile, "USAGE");
  }
  const ordered: ConfigFile = { version: 1, profiles: {} };
  if (config.defaultProfile) ordered.defaultProfile = config.defaultProfile;
  for (const name of Object.keys(config.profiles).sort()) {
    const stored = config.profiles[name] ?? {};
    const entry: Profile = {};
    for (const field of PROFILE_FIELDS) if (stored[field] !== undefined) entry[field] = stored[field];
    ordered.profiles[name] = entry;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// ── Resolution ────────────────────────────────────────────────────────────────

export type Origin = "builtin" | "config" | "builtin+config";

export interface KnownProfile {
  name: string;
  origin: Origin;
  /** The fields as they will be applied: built-in values overlaid with the config's. */
  fields: Profile;
}

export function knownProfileNames(config: ConfigFile): string[] {
  return [...new Set([...Object.keys(BUILTIN_PROFILES), ...Object.keys(config.profiles)])].sort();
}

export function listProfiles(config: ConfigFile): KnownProfile[] {
  return knownProfileNames(config).map((name) => {
    const builtin = BUILTIN_PROFILES[name];
    const user = config.profiles[name];
    const origin: Origin = builtin && user ? "builtin+config" : builtin ? "builtin" : "config";
    return { name, origin, fields: { ...builtin, ...user } };
  });
}

/** Looks a profile up, or fails listing the profiles that do exist. */
export function getProfile(config: ConfigFile, name: string): KnownProfile {
  const found = listProfiles(config).find((p) => p.name === name);
  if (!found) {
    throw new ConfigError(`unknown profile "${name}". Known profiles: ${knownProfileNames(config).join(", ")}`, "USAGE");
  }
  return found;
}

export function networkDefaults(network: string): { rpcUrl: string; passphrase: string } {
  return network === "mainnet"
    ? { rpcUrl: DEFAULT_MAINNET_RPC, passphrase: Networks.PUBLIC }
    : { rpcUrl: DEFAULT_TESTNET_RPC, passphrase: Networks.TESTNET };
}

export type Source = "flag" | `profile:${string}` | "default";
export interface Setting {
  value: string;
  source: Source;
}

/**
 * The effective setting for each field: flag > profile > built-in default.
 * `network`, `rpc-url` and `passphrase` always resolve (to the testnet
 * defaults at worst); the others are present only when something sets them.
 */
export function resolveSettings(
  flags: ReadonlyMap<string, string>,
  profile?: KnownProfile
): Partial<Record<ProfileField, Setting>> {
  const out: Partial<Record<ProfileField, Setting>> = {};
  for (const field of PROFILE_FIELDS) {
    const flag = flags.get(field);
    if (flag !== undefined) out[field] = { value: flag, source: "flag" };
    else if (profile?.fields[field] !== undefined) {
      out[field] = { value: profile.fields[field]!, source: `profile:${profile.name}` };
    }
  }
  const network = out.network?.value ?? "testnet";
  const defaults = networkDefaults(network);
  out.network ??= { value: network, source: "default" };
  out["rpc-url"] ??= { value: defaults.rpcUrl, source: "default" };
  out.passphrase ??= { value: defaults.passphrase, source: "default" };
  return out;
}
