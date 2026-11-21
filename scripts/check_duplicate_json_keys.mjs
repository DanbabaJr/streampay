#!/usr/bin/env node
/**
 * check_duplicate_json_keys.mjs — CI lint for duplicate keys in JSON files.
 *
 * Why this exists: JSON with a repeated key is *not* a syntax error. `JSON.parse`
 * accepts it and silently keeps the last occurrence, npm does the same, so a
 * file can look perfectly fine in an editor, install fine, and ship a script
 * that nobody runs. This repo has been bitten twice by the merge shape that
 * produces it — two branches both append a key at the same place, the merge
 * keeps both lines:
 *
 *   - `frontend/package.json` carried `"test"` twice (`node --test && vitest
 *     run` then `node --test`), so `npm test` quietly dropped the vitest half
 *     and 23 scheduler/fee-series tests stopped running in every CI job while a
 *     step named "scheduler / fee-series simulation" stayed green;
 *   - the same event killed every install on main when `next 16` left duplicate
 *     dependency keys in the file.
 *
 * Neither was visible in a diff review, because both lines are individually
 * correct. A textual duplicate-key check is the only thing that catches it, and
 * it runs in milliseconds with no dependencies.
 *
 * What it checks: every tracked `.json` file in the repo (git-less checkouts
 * fall back to a working-tree scan that skips `node_modules`), reported against
 * the object the key lives in, so the same key repeated in *different* objects
 * — two `scripts.test` entries in two different packages, a `name` in each
 * dependency — is correctly not a finding.
 *
 * Comments and trailing commas are tolerated (TypeScript reads `//` comments in
 * `tsconfig.json`, and npm accepts a trailing comma in `package.json`), so the
 * gate reports only the defect it is about: the same key twice in one object.
 *
 * Every finding is also a GitHub workflow annotation (`::error file=…,line=…::`)
 * naming both lines and the enclosing key path, so a contributor sees the exact
 * second occurrence instead of "npm did something weird".
 *
 * Exit 0 = no duplicate keys anywhere; 1 = at least one, or a file that is not
 * parseable JSON at all.
 *
 * Usage: node scripts/check_duplicate_json_keys.mjs   (repo root as cwd)
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Directories that never carry hand-written JSON we should police: installed
// packages (each with its own package.json) and build output.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".next"]);

/**
 * Collect the files to scan. `git ls-files` is the authority in a real checkout
 * (it skips ignored files, submodules' noise, and build output for free); if git
 * is unavailable or refuses, walk the working tree instead so the gate still
 * runs on an unpacked archive.
 */
function collectFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", "*.json"], {
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    const listed = out
      .toString("utf8")
      .split("\0")
      .filter((p) => p.length > 0)
      .map((p) => join(REPO_ROOT, p));
    if (listed.length > 0) return listed;
  } catch {
    // Not a git checkout (or git not on PATH) — fall through to the scan.
  }
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) found.push(join(dir, entry.name));
    }
  };
  walk(REPO_ROOT);
  return found;
}

/**
 * A deliberately minimal JSON reader: it does not build a value, it only walks
 * the structure far enough to know which object each key sits in and what line
 * it started on. Duplicates are findings; anything that is not readable JSON is
 * a separate finding, because a file the scanner cannot walk is a file npm
 * cannot read either.
 */
function scan(text, file) {
  const duplicates = [];
  const errors = [];
  const len = text.length;
  let i = 0;
  let line = 1;

  const fail = (message) => {
    errors.push({ file, line, message });
    throw new SyntaxError(message);
  };

  const ws = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";

  function skipTrivia() {
    for (;;) {
      while (i < len && ws(text[i])) {
        if (text[i] === "\n") line++;
        i++;
      }
      if (text[i] === "/" && text[i + 1] === "/") {
        while (i < len && text[i] !== "\n") i++;
        continue;
      }
      if (text[i] === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < len && !(text[i] === "*" && text[i + 1] === "/")) {
          if (text[i] === "\n") line++;
          i++;
        }
        i += 2;
        continue;
      }
      return;
    }
  }

  // Assumes text[i] === '"'. Returns the string and the line it started on.
  function readString() {
    const startLine = line;
    i++; // opening quote
    let value = "";
    const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
    while (i < len) {
      const c = text[i];
      if (c === "\n") fail("unterminated string (a raw newline inside a JSON string)");
      if (c === '"') {
        i++;
        return { value, startLine };
      }
      if (c === "\\") {
        const esc = text[i + 1];
        if (esc === "u") {
          // \uXXXX — decode so two spellings of the same key compare equal.
          const hex = text.slice(i + 2, i + 6);
          const code = Number.parseInt(hex, 16);
          if (Number.isNaN(code)) fail(`bad \\u escape "${hex}"`);
          value += String.fromCharCode(code);
          i += 6;
          continue;
        }
        value += Object.hasOwn(ESCAPES, esc) ? ESCAPES[esc] : esc;
        i += 2;
        continue;
      }
      value += c;
      i++;
    }
    return fail("unterminated string at end of file");
  }

  function parseValue(path) {
    skipTrivia();
    const c = text[i];
    if (c === "{") return parseObject(path);
    if (c === "[") return parseArray(path);
    if (c === '"') {
      readString();
      return;
    }
    if (c === undefined) fail("file ends in the middle of a value");
    // number | true | false | null — anything else here is not JSON.
    if (!/[-0-9a-zA-Z_$]/.test(c)) {
      fail(`unexpected ${JSON.stringify(c)} where a value was expected`);
    }
    while (i < len && !ws(text[i]) && !",]}".includes(text[i])) {
      if (text[i] === "\n") line++;
      i++;
    }
  }

  function parseObject(path) {
    i++; // '{'
    const keys = new Map();
    skipTrivia();
    if (text[i] === "}") {
      i++;
      return;
    }
    for (;;) {
      skipTrivia();
      if (text[i] !== '"') fail(`expected a property name, found ${JSON.stringify(text[i]) ?? "end of file"}`);
      const key = readString();
      const here = path ? `${path}.${key.value}` : key.value;
      skipTrivia();
      if (text[i] !== ":") fail(`expected ':' after "${key.value}"`);
      i++;
      if (keys.has(key.value)) {
        duplicates.push({
          file,
          keyPath: here,
          key: key.value,
          firstLine: keys.get(key.value),
          line: key.startLine,
        });
      } else {
        keys.set(key.value, key.startLine);
      }
      parseValue(here);
      skipTrivia();
      if (text[i] === ",") {
        i++;
        skipTrivia();
        if (text[i] === "}") {
          i++; // trailing comma: npm's own parser accepts it, so we do too.
          return;
        }
        continue;
      }
      if (text[i] === "}") {
        i++;
        return;
      }
      fail(`expected ',' or '}' after "${key.value}"`);
    }
  }

  function parseArray(path) {
    i++; // '['
    skipTrivia();
    if (text[i] === "]") {
      i++;
      return;
    }
    let index = 0;
    for (;;) {
      parseValue(`${path}[${index}]`);
      index++;
      skipTrivia();
      if (text[i] === ",") {
        i++;
        skipTrivia();
        if (text[i] === "]") {
          i++;
          return;
        }
        continue;
      }
      if (text[i] === "]") {
        i++;
        return;
      }
      fail(`expected ',' or ']' in array at ${path}`);
    }
  }

  try {
    parseValue("");
    skipTrivia();
    if (i < len) fail(`trailing content after the top-level value`);
  } catch (err) {
    if (errors.length === 0) errors.push({ file, line, message: err.message });
  }
  return { duplicates, errors };
}

/**
 * `--self-test` — prove the scanner still *finds* things.
 *
 * A gate whose parser stops walking reports "clean" forever, which is worse than
 * no gate because it looks like coverage. These cases pin both directions: the
 * duplicates that must be caught, and the shapes that must NOT be flagged (a key
 * repeated in two sibling objects, or in two array elements, is legitimate JSON
 * and flagging it would get this gate bypassed). Run in CI before the real scan.
 */
function selfTest() {
  const cases = [
    {
      name: "same key twice in one object",
      text: '{\n  "a": 1,\n  "a": 2\n}',
      duplicates: ["a"],
      error: false,
    },
    {
      name: "the real bug: two `test` entries in scripts",
      text: '{"scripts":{"test":"node --test && vitest run","test:accrual":"x","test":"node --test"}}',
      duplicates: ["scripts.test"],
      error: false,
    },
    {
      name: "same key in sibling objects is fine",
      text: '{"a":{"k":1},"b":{"k":2}}',
      duplicates: [],
      error: false,
    },
    {
      name: "same key in two array elements is fine",
      text: '{"items":[{"a":1},{"a":2},{"a":3}]}',
      duplicates: [],
      error: false,
    },
    {
      name: "duplicate inside an array element is caught, with its path",
      text: '{"items":[{"a":1},{"a":2,"a":3}]}',
      duplicates: ["items[1].a"],
      error: false,
    },
    {
      name: "comments and trailing commas do not confuse it (tsconfig/npm style)",
      text: '{\n  // leading comment\n  "a": 1, /* inline */\n  "a": 2,\n}',
      duplicates: ["a"],
      error: false,
    },
    {
      name: "strings and escapes are read as values, not structure",
      text: '{"a":"} not an object ,","a":"still a string"}',
      duplicates: ["a"],
      error: false,
    },
    {
      name: "keys containing quotes",
      text: '{"a\\"b":1,"a\\"b":2}',
      duplicates: ['a"b'],
      error: false,
    },
    {
      name: "empty object and empty array",
      text: '{"a":{},"b":[]}',
      duplicates: [],
      error: false,
    },
    {
      name: "a key spelled with \\u escapes equals the literal one",
      text: '{"café":1,"caf\\u00e9":2}',
      duplicates: ["café"],
      error: false,
    },
    {
      name: "nested objects keep their own key sets",
      text: '{"x":{"y":{"z":1}},"w":{"z":2}}',
      duplicates: [],
      error: false,
    },
    {
      name: "unreadable JSON is a finding of its own",
      text: '{"a": }',
      duplicates: [],
      error: true,
    },
    {
      name: "trailing junk after the document",
      text: '{"a":1}\n{"b":2}',
      duplicates: [],
      error: true,
    },
  ];

  let failed = 0;
  for (const testCase of cases) {
    const { duplicates, errors } = scan(testCase.text, "<self-test>");
    const found = duplicates.map((d) => d.keyPath).sort();
    const expected = [...testCase.duplicates].sort();
    const dupOk = found.length === expected.length && found.every((k, n) => k === expected[n]);
    const errOk = errors.length > 0 === testCase.error;
    if (dupOk && errOk) {
      console.log(`ok   ${testCase.name}`);
    } else {
      failed++;
      console.log(
        `FAIL ${testCase.name}: expected duplicates [${expected.join(", ")}]${testCase.error ? " + parse error" : ""}, got [${found.join(", ")}]${errors.length ? " + parse error" : ""}`
      );
    }
  }
  if (failed > 0) {
    console.log(`\nself-test: ${failed}/${cases.length} case(s) failed — the scanner no longer measures what the gate claims.`);
    process.exit(1);
  }
  console.log(`\nself-test: ${cases.length}/${cases.length} cases behaved as specified.`);
}

if (process.argv.includes("--self-test")) selfTest();

const files = collectFiles();
const duplicates = [];
const errors = [];
for (const abs of files) {
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue; // a tracked path that is not a readable file is not this gate's problem
  }
  // BOM-tolerant: a UTF-16/BOM'd JSON file is a separate bug and shows up as a
  // parse error below, but the BOM itself must not defeat the key scan.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rel = relative(REPO_ROOT, abs).replaceAll("\\", "/");
  const result = scan(text, rel);
  duplicates.push(...result.duplicates);
  errors.push(...result.errors);
}

for (const e of errors) {
  console.log(`::error file=${e.file},line=${e.line}::${e.file}:${e.line} is not readable JSON (${e.message}) — npm/Node will refuse to parse it, so nothing that depends on it runs.`);
  console.log(`ERROR ${e.file}:${e.line}: ${e.message}`);
}
for (const d of duplicates) {
  console.log(
    `::error file=${d.file},line=${d.line}::Duplicate key "${d.key}" in ${d.keyPath} (${d.file} lines ${d.firstLine} and ${d.line}). JSON parsers keep the LAST one and the file is still valid syntax, so the first is silently dead — delete one (merge the two values if both were meant to apply). If this is a script entry, check that CI still runs what its step name promises.`
  );
  console.log(
    `ERROR ${d.file}:${d.line}: duplicate key "${d.key}" in ${d.keyPath} — also declared on line ${d.firstLine}; the line ${d.firstLine} value is unreachable.`
  );
}

if (duplicates.length > 0 || errors.length > 0) {
  console.log(
    `\nScanned ${files.length} JSON file(s): ${duplicates.length} duplicate key(s), ${errors.length} unreadable.`
  );
  process.exit(1);
}

console.log(`JSON keys: ${files.length} file(s) scanned, no duplicate keys, all readable.`);
