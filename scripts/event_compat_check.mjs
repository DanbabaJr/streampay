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
// A deletion is survivable only when nothing published can be holding it: the
// shape must be absent from every release tag's registry AND the removal must
// carry a grant in `schemas/events/removals.json`, which the removing PR adds
// (an unused grant is itself a failure, so a grant can never be left behind for
// a later PR to reuse). That is what lets a revert of never-released work go
// through CI without switching the gate off. A shape that did ship has no hatch:
// it needs the governed v1 + v2 migration.
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
export const REMOVALS_PATH = "schemas/events/removals.json";

function fieldMap(fields) {
  const map = new Map();
  for (const f of fields ?? []) map.set(f.name, f.type);
  return map;
}

/** Every deletable unit of a registry document, as `event:` / `definition:` tokens. */
export function shapeTokens(doc) {
  const tokens = new Set();
  for (const [name, event] of Object.entries(doc?.events ?? {})) {
    tokens.add(`event:${name}`);
    for (const t of event.topics ?? []) tokens.add(`event:${name}#topic:${t.name}`);
    for (const f of event.data ?? []) tokens.add(`event:${name}#data:${f.name}`);
  }
  for (const [name, def] of Object.entries(doc?.definitions ?? {})) {
    tokens.add(`definition:${name}`);
    for (const f of def.fields ?? []) tokens.add(`definition:${name}#field:${f.name}`);
    for (const v of def.variants ?? []) tokens.add(`definition:${name}#variant:${v}`);
  }
  return tokens;
}

/**
 * Compare two parsed registry documents.
 *
 * @param {object} base previous registry (merge base)
 * @param {object} head candidate registry (PR head)
 * @param {string} changelog contents of schemas/events/CHANGELOG.md at head
 * @param {{authorizedRemovals?: Array<{shape: string, reason: string, pr?: string}>,
 *          released?: {available: boolean, tags?: string[],
 *                      shapes?: Map<string, Set<string>>}} [options]
 *        `authorizedRemovals` is the parsed removals.json, `released.shapes`
 *        maps each deletable shape token to the release tags whose registry
 *        contained it. Both default to the strictest state: no grants, and no
 *        proof that anything is unreleased.
 * @returns {{errors: string[], warnings: string[], additions: number}}
 */
export function checkRegistries(base, head, changelog, options = {}) {
  const errors = [];
  const warnings = [];
  let additions = 0;
  const log = changelog ?? "";
  const released = options.released ?? { available: false };

  // A shape token names one deletable unit of the public interface:
  //   event:VoteCast            event:VoteCast#data:recipient
  //   definition:StreamPolicy   definition:StreamPolicy#field:min_rate
  //   definition:Role#variant:Sender
  const SHAPE = /^(event|definition):[^#]+(#(data|topic|field|variant):[^#]+)?$/;
  const grants = new Map();
  for (const entry of options.authorizedRemovals ?? []) {
    if (!SHAPE.test(entry?.shape ?? "")) {
      errors.push(
        `INVALID ${REMOVALS_PATH} ENTRY: ${JSON.stringify(entry)} — \`shape\` must look like ` +
          `"event:VoteCast" or "definition:StreamPolicy#field:min_rate"`
      );
      continue;
    }
    if (!String(entry.reason ?? "").trim()) {
      errors.push(
        `INVALID ${REMOVALS_PATH} ENTRY ${entry.shape}: a non-empty reason is required — ` +
          "the grant is an audit record, not a switch"
      );
      continue;
    }
    grants.set(entry.shape, entry);
  }

  /**
   * A deletion is a hard break unless the exact shape is provably absent from
   * every release tag AND granted by this change in removals.json. Returns the
   * error text, or null when the deletion is authorized.
   */
  function deletion(token, description) {
    const shippedIn = [...(released.shapes?.get(token) ?? [])].sort();
    if (shippedIn.length > 0) {
      return `${description} — released in ${shippedIn.join(", ")}, so a published consumer can be ` +
        "decoding it; deletions of shipped shapes are breaking (see the v1 + v2 migration in schemas/events/README.md)";
    }
    const grant = grants.get(token);
    if (!grant) {
      return `${description} — event shapes are a public interface; deletions are breaking ` +
        `(if this shape never reached a release tag, grant the deletion in ${REMOVALS_PATH})`;
    }
    if (!released.available) {
      errors.push(
        `REMOVAL GRANT ${token} cannot be honored: no release tags are readable in this clone, so ` +
          "the gate cannot prove the shape was never released. CI needs a full-history checkout " +
          "(actions/checkout with fetch-depth: 0)."
      );
      return null;
    }
    const where = grant.pr ? `${grant.reason} (${grant.pr})` : grant.reason;
    warnings.push(`AUTHORIZED REMOVAL ${token} — absent from every release tag; ${where}`);
    return null;
  }

  /**
   * A grant that authorizes nothing this change deletes is either a mistake or
   * an attempt to park permission for a later PR, so the shape surviving in both
   * registries fails. A grant for a shape the base no longer has is the normal
   * state after the deletion it authorized merged, so it only warns.
   */
  function checkGrantsUsed(baseShapes, headShapes) {
    for (const token of grants.keys()) {
      if (!baseShapes.has(token)) {
        warnings.push(
          `STALE REMOVAL GRANT ${token} — not in the base registry, so this change needs it for nothing; ` +
            `drop it from ${REMOVALS_PATH} once the deletion it was written for has landed`
        );
      } else if (headShapes.has(token)) {
        errors.push(
          `UNUSED REMOVAL GRANT ${token} — the shape is still in the registry; a grant has to be added by ` +
            `the PR that performs the deletion, otherwise the next PR could reuse it (${REMOVALS_PATH})`
        );
      }
    }
  }

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
      const error = deletion(`event:${name}`, `REMOVED event ${name} (key "${prev.event_key}")`);
      if (error) errors.push(error);
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
        const error = deletion(
          `event:${name}#topic:${t.name}`,
          `REMOVED topic field ${name}.${t.name} (position ${i})`
        );
        if (error) errors.push(error);
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
        const error = deletion(
          `event:${name}#data:${field}`,
          `REMOVED data field ${name}.${field}: ${type} — consumers decode it by name`
        );
        if (error) errors.push(error);
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
      const error = deletion(
        `definition:${name}`,
        `REMOVED definition ${name} — events reference it field-for-field`
      );
      if (error) errors.push(error);
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
          const error = deletion(
            `definition:${name}#variant:${variant}`,
            `REMOVED variant ${name}.${variant} — events encode it as a symbol, so consumers break`
          );
          if (error) errors.push(error);
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
        const error = deletion(
          `definition:${name}#field:${field}`,
          `REMOVED field ${name}.${field}: ${type} (referenced by events)`
        );
        if (error) errors.push(error);
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

  checkGrantsUsed(shapeTokens(base), shapeTokens(head));

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

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

function gitHas(spec) {
  try {
    // `git cat-file -e` so the checks do not depend on git's phrasing for a
    // missing path (it differs between "no such path" and "no such object").
    execFileSync("git", ["cat-file", "-e", spec], { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Map every shape token to the release tags whose registry carried it. A
 * shallow clone cannot answer this, so it reports itself unavailable and the
 * checker refuses to honor any grant instead of assuming nothing shipped.
 */
function releasedShapes() {
  const shapes = new Map();
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    return { available: false, tags: [], shapes };
  }
  const tags = git(["tag", "--list"]).trim().split("\n").filter(Boolean);
  const readable = [];
  for (const tag of tags) {
    if (!gitHas(`${tag}:${REGISTRY_PATH}`)) continue;
    let doc;
    try {
      doc = JSON.parse(git(["show", `${tag}:${REGISTRY_PATH}`]));
    } catch (error) {
      console.error(`${REMOVALS_PATH}: ${tag}:${REGISTRY_PATH} is not readable JSON: ${error.message}`);
      process.exit(1);
    }
    readable.push(tag);
    for (const token of shapeTokens(doc)) {
      if (!shapes.has(token)) shapes.set(token, []);
      shapes.get(token).push(tag);
    }
  }
  return { available: true, tags: readable, shapes };
}

function loadRemovals() {
  let raw;
  try {
    raw = readFileSync(path.join(REPO_ROOT, REMOVALS_PATH), "utf8");
  } catch {
    return [];
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    console.error(`${REMOVALS_PATH} is not valid JSON: ${error.message}`);
    process.exit(1);
  }
  if (!Array.isArray(doc?.removals)) {
    console.error(`${REMOVALS_PATH} must be an object with a "removals" array`);
    process.exit(1);
  }
  return doc.removals;
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
    baseText = git(["show", `${args.base}:${REGISTRY_PATH}`]);
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

  const authorizedRemovals = loadRemovals();
  // Only consulted when a grant exists: the common PR changes nothing and the
  // release-tag scan is a no-op for it.
  const released = authorizedRemovals.length > 0 ? releasedShapes() : { available: false, shapes: new Map() };

  const { errors, warnings, additions } = checkRegistries(
    JSON.parse(baseText),
    JSON.parse(headText),
    changelog,
    { authorizedRemovals, released }
  );

  console.log(`event-registry compatibility: ${source} -> ${REGISTRY_PATH} (working tree)`);
  if (authorizedRemovals.length > 0) {
    console.log(
      `deletion grants: ${authorizedRemovals.length} in ${REMOVALS_PATH}; released shapes checked ` +
        `against ${released.available ? (released.tags.join(", ") || "no tag with a registry") : "UNAVAILABLE (shallow clone)"}`
    );
  }
  if (warnings.length > 0) {
    console.log(`\ncompatible additions (${warnings.length}):`);
    for (const w of warnings) console.log(`  warn  ${w}`);
  }
  if (errors.length > 0) {
    console.error(`\nincompatible changes (${errors.length}):`);
    for (const e of errors) console.error(`  FAIL  ${e}`);
    console.error(
      "\nEvent shapes are additive-only. To delete one, it must never have reached\n" +
        "a release tag and the PR that deletes it must add a reasoned grant to\n" +
        `${REMOVALS_PATH}; a shape that did ship needs the migration procedure in\n` +
        "schemas/events/README.md (v1 + v2 coexistence).\n" +
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
