#!/usr/bin/env node
// Event-schema compatibility gate (issue #213).
//
// Diffs the committed event registry (`schemas/events/registry.json`) across a
// merge base and fails on any change to a shape an existing consumer already
// decodes:
//   * an event removed
//   * an event's topic layout changed (renamed, removed, re-ordered, re-typed)
//   * a data field removed or re-typed
//   * an event key (the snake_case topic symbol) changed
//   * a referenced contract struct field or enum variant broken
// Additive-only evolution is enforced: new events/fields/variants WARN, and
// every addition must be recorded in `schemas/events/CHANGELOG.md` or the gate
// fails. A base with no registry at all (the PR that introduces it) exits 0
// with a note — there is nothing to be compatible with yet.
//
// Usage:
//   node scripts/event_compat_check.mjs --base <git-ref>
//       compares <ref>:schemas/events/registry.json against the working tree.
//   node scripts/event_compat_check.mjs --base-file <path> --changelog <path>
//
// The pure core (`checkRegistries`) is exported for unit tests; the seeded
// break demo in scripts/event_compat_check.test.mjs shows the CI output for a
// renamed event field.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REGISTRY_PATH = "schemas/events/registry.json";
export const CHANGELOG_PATH = "schemas/events/CHANGELOG.md";

function fieldMap(fields) {
  const map = new Map();
  for (const f of fields ?? []) map.set(f.name, f.type);
  return map;
}

/**
 * Compare two parsed registry documents.
 *
 * @param {object} base previous registry (merge base)
 * @param {object} head candidate registry (PR head)
 * @param {string} changelog contents of schemas/events/CHANGELOG.md at head
 * @returns {{errors: string[], warnings: string[], additions: number}}
 */
export function checkRegistries(base, head, changelog) {
  const errors = [];
  const warnings = [];
  let additions = 0;
  const log = changelog ?? "";

  if ((head.registry_version ?? 0) < (base.registry_version ?? 0)) {
    errors.push(
      `registry_version went backwards: ${base.registry_version} -> ${head.registry_version}`
    );
  }

  const baseEvents = base.events ?? {};
  const headEvents = head.events ?? {};

  for (const [name, prev] of Object.entries(baseEvents)) {
    const next = headEvents[name];
    if (!next) {
      errors.push(
        `REMOVED event ${name} (key "${prev.event_key}") — event shapes are a public interface; deletions are breaking`
      );
      continue;
    }
    if (prev.event_key !== next.event_key) {
      errors.push(
        `RENAMED event key for ${name}: "${prev.event_key}" -> "${next.event_key}" — consumers decode the topic symbol`
      );
    }
    // Topics are positional XDR: order is part of the wire format.
    const baseTopics = prev.topics ?? [];
    const headTopics = next.topics ?? [];
    baseTopics.forEach((t, i) => {
      const n = headTopics[i];
      if (!n) {
        errors.push(`REMOVED topic field ${name}.${t.name} (position ${i})`);
      } else if (n.name !== t.name) {
        errors.push(
          `EVENT ${name}: topic at position ${i} changed name "${t.name}" -> "${n.name}"`
        );
      } else if (n.type !== t.type) {
        errors.push(`TYPE CHANGE ${name}.${t.name}: ${t.type} -> ${n.type}`);
      }
    });
    if (headTopics.length > baseTopics.length) {
      for (const t of headTopics.slice(baseTopics.length)) {
        warnings.push(`ADDED topic ${name}.${t.name}: ${t.type}`);
        additions++;
        if (!log.includes(name) || !log.includes(t.name)) {
          errors.push(
            `MISSING CHANGELOG: added topic ${name}.${t.name} must be recorded in ${CHANGELOG_PATH} (mention the event \`${name}\` and the field \`${t.name}\`)`
          );
        }
      }
    }

    const prevData = fieldMap(prev.data);
    const nextData = fieldMap(next.data);
    for (const [field, type] of prevData) {
      if (!nextData.has(field)) {
        errors.push(
          `REMOVED data field ${name}.${field}: ${type} — consumers decode it by name`
        );
      } else if (nextData.get(field) !== type) {
        errors.push(
          `TYPE CHANGE ${name}.${field}: ${type} -> ${nextData.get(field)}`
        );
      }
    }
    for (const [field, type] of nextData) {
      if (!prevData.has(field)) {
        warnings.push(`ADDED data field ${name}.${field}: ${type}`);
        additions++;
        if (!log.includes(name) || !log.includes(field)) {
          errors.push(
            `MISSING CHANGELOG: added field ${name}.${field} must be recorded in ${CHANGELOG_PATH} (mention the event \`${name}\` and the field \`${field}\`)`
          );
        }
      }
    }
  }

  for (const [name, next] of Object.entries(headEvents)) {
    if (baseEvents[name]) continue;
    warnings.push(`ADDED event ${name} (key "${next.event_key}")`);
    additions++;
    if (!log.includes(name)) {
      errors.push(
        `MISSING CHANGELOG: new event ${name} must be recorded in ${CHANGELOG_PATH}`
      );
    }
  }

  // Referenced contract types: an event field typed `StreamPolicy` or
  // `OwnershipRole` inherits the definition, so breaking it breaks every event
  // that references it.
  const baseDefs = base.definitions ?? {};
  const headDefs = head.definitions ?? {};
  for (const [name, prev] of Object.entries(baseDefs)) {
    const next = headDefs[name];
    if (!next) {
      errors.push(`REMOVED definition ${name} — events reference it field-for-field`);
      continue;
    }
    const prevKind = prev.kind ?? "struct";
    const nextKind = next.kind ?? "struct";
    if (prevKind !== nextKind) {
      errors.push(`KIND CHANGE definition ${name}: ${prevKind} -> ${nextKind}`);
      continue;
    }
    if (prev.fingerprint === next.fingerprint) continue;
    if (nextKind === "enum") {
      const prevVariants = new Set(prev.variants ?? []);
      const nextVariants = new Set(next.variants ?? []);
      for (const variant of prevVariants) {
        if (!nextVariants.has(variant)) {
          errors.push(
            `REMOVED variant ${name}.${variant} — events encode it as a symbol, so consumers break`
          );
        }
      }
      for (const variant of nextVariants) {
        if (!prevVariants.has(variant)) {
          warnings.push(`ADDED variant ${name}.${variant}`);
          additions++;
          if (!log.includes(name) || !log.includes(variant)) {
            errors.push(
              `MISSING CHANGELOG: added variant ${name}.${variant} must be recorded in ${CHANGELOG_PATH} (mention the enum \`${name}\` and the variant \`${variant}\`)`
            );
          }
        }
      }
      continue;
    }
    const prevFields = fieldMap(prev.fields);
    const nextFields = fieldMap(next.fields);
    for (const [field, type] of prevFields) {
      if (!nextFields.has(field)) {
        errors.push(`REMOVED field ${name}.${field}: ${type} (referenced by events)`);
      } else if (nextFields.get(field) !== type) {
        errors.push(`TYPE CHANGE ${name}.${field}: ${type} -> ${nextFields.get(field)}`);
      }
    }
    for (const [field, type] of nextFields) {
      if (!prevFields.has(field)) {
        warnings.push(`ADDED field ${name}.${field}: ${type}`);
        additions++;
        if (!log.includes(name) || !log.includes(field)) {
          errors.push(
            `MISSING CHANGELOG: added field ${name}.${field} must be recorded in ${CHANGELOG_PATH}`
          );
        }
      }
    }
  }
  for (const name of Object.keys(headDefs)) {
    if (!baseDefs[name]) {
      warnings.push(`ADDED definition ${name}`);
    }
  }

  return { errors, warnings, additions };
}

function parseArgs(argv) {
  const args = { changelog: null, base: null, baseFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") args.base = argv[++i];
    else if (argv[i] === "--base-file") args.baseFile = argv[++i];
    else if (argv[i] === "--changelog") args.changelog = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let baseText;
  let source;
  if (args.baseFile) {
    baseText = readFileSync(args.baseFile, "utf8");
    source = args.baseFile;
  } else {
    if (!args.base) {
      console.error("usage: event_compat_check.mjs --base <git-ref> [--changelog <path>]");
      process.exit(2);
    }
    // `git cat-file -e` so the checks do not depend on git's phrasing for a
    // missing path (it differs between "no such path" and "no such object").
    const gitHas = (spec) => {
      try {
        execFileSync("git", ["cat-file", "-e", spec], { cwd: REPO_ROOT, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };
    if (!gitHas(`${args.base}^{commit}`)) {
      console.error(
        `event-registry compatibility: ${args.base} is not a commit available in this clone. ` +
          "CI needs a full-history checkout (actions/checkout with fetch-depth: 0) to read the merge base."
      );
      process.exit(1);
    }
    if (!gitHas(`${args.base}:${REGISTRY_PATH}`)) {
      // The registry is being introduced by this change: there is no published
      // shape for a consumer to have depended on yet, so there is nothing to
      // stay compatible with. From the next PR onward, `main` has a baseline
      // and every diff is measured against it.
      console.log(
        `event-registry compatibility: ${args.base} has no ${REGISTRY_PATH}, so this ` +
          "change introduces the registry — there is no published shape a consumer has " +
          "depended on yet. From the next PR onward, main is the baseline."
      );
      process.exit(0);
    }
    baseText = execFileSync(
      "git",
      ["show", `${args.base}:${REGISTRY_PATH}`],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    source = `${args.base}:${REGISTRY_PATH}`;
  }

  const headPath = path.join(REPO_ROOT, REGISTRY_PATH);
  const headText = readFileSync(headPath, "utf8");
  const changelogPath = path.join(REPO_ROOT, args.changelog ?? CHANGELOG_PATH);
  let changelog = "";
  try {
    changelog = readFileSync(changelogPath, "utf8");
  } catch {
    console.log(`(no ${changelogPath} in the working tree)`);
  }

  const { errors, warnings, additions } = checkRegistries(
    JSON.parse(baseText),
    JSON.parse(headText),
    changelog
  );

  console.log(`event-registry compatibility: ${source} -> ${REGISTRY_PATH} (working tree)`);
  if (warnings.length > 0) {
    console.log(`\ncompatible additions (${warnings.length}):`);
    for (const w of warnings) console.log(`  warn  ${w}`);
  }
  if (errors.length > 0) {
    console.error(`\nincompatible changes (${errors.length}):`);
    for (const e of errors) console.error(`  FAIL  ${e}`);
    console.error(
      "\nEvent shapes are additive-only. If this change is intentional, follow\n" +
        "the migration procedure in schemas/events/README.md (v1 + v2 coexistence).\n" +
        "For additions, record them in schemas/events/CHANGELOG.md."
    );
    process.exit(1);
  }
  console.log(
    `\nPASSED: ${additions === 0 ? "no shape changes" : `${additions} additive change(s), all documented`}`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
