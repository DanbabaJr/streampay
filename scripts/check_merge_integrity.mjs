#!/usr/bin/env node
// check_merge_integrity.mjs — structural gate on the source the merges produced.
//
// Every time this repo went red on main for a *build* reason, the cause was a
// merge that git accepted cleanly and no reviewer looked at: two PRs that each
// added an entrypoint to the same `impl` block (`E0592: duplicate definitions
// with name: 'authorize_agent'`), a merge that deleted a closing brace along
// with the line above it and left the next doc comment dangling, a `sed` that
// nested its own replacement. None of those are style problems — they are files
// that are not a program any more, and the only thing that says so is a
// compiler, which takes minutes and reports dozens of downstream errors
// (`97 errors, mostly spec_xdr_*`) that hide the one real cause.
//
// This gate finds the cause directly, in seconds, with no toolchain:
//
//   1. DUPLICATE DEFINITION — the same `fn`/`trait`-item declared twice in the
//      same Rust item scope, or the same top-level `function`/`class`/`const`
//      declared twice in one TypeScript/JavaScript file. Both are hard
//      compiler errors; the Rust case is the one that reaches main most often,
//      because two appended entrypoints collide silently.
//   2. UNBALANCED DELIMITER — a `{`/`(`/`[` with no partner, or a closing one
//      with no opener, computed with a comment- and string-aware scanner so a
//      brace inside a string literal is never counted. This is the deleted-brace
//      class: the file stops parsing, and every error the compiler then prints
//      is a consequence of that one character.
//   3. UNTERMINATED TOKEN — a block comment, string or template literal that
//      runs to the end of the file, which is the other half of the same kind of
//      bad merge (the opener or the closer was on a deleted line).
//   4. CONFLICT MARKER — a leftover `<<<<<<<`/`>>>>>>>` line.
//
// It deliberately does NOT try to be a parser: it reads masked text (comments
// and string contents blanked out) so rules 1 and 2 cannot fire on prose. A
// finding here means the file cannot compile, so the fix is always "repair the
// merge", never "silence the gate" — which is why the message names the line.
//
// Run:
//   node scripts/check_merge_integrity.mjs                 # every tracked file
//   node scripts/check_merge_integrity.mjs --files a.rs b.ts
//   node scripts/check_merge_integrity.mjs --root /tmp/merge-preview
// Tests: node --test scripts/check_merge_integrity.test.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RUST_EXTS = [".rs"];
const JS_EXTS = [".ts", ".mjs", ".cjs", ".js"];
// .tsx/.jsx are deliberately NOT scanned. JSX text is not code — an apostrophe
// in `<p>It's here</p>` is prose, `</button>` is a tag, not a division followed
// by a regex literal — and a scanner without a JSX parser reads those as
// string and regex openers, then reports the frontend's own components as
// broken. A gate that cries wolf gets switched off, so the wolf is left to
// `tsc`, which the Frontend job already runs over every .tsx file.
const UNSCANNED_EXTS = [".tsx", ".jsx"];

const OPENERS = { "{": "}", "(": ")", "[": "]" };
const CLOSERS = { "}": "{", ")": "(", "]": "[" };

function langOf(file) {
  const ext = path.extname(file);
  if (RUST_EXTS.includes(ext)) return "rust";
  if (JS_EXTS.includes(ext)) return "js";
  return null;
}

const isSpace = (c) => c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v";

/**
 * Walk one source file once, producing (a) `masked` — the same text with every
 * comment and string body replaced by spaces, so declaration regexes can run
 * over it without matching prose, and (b) the structural problems.
 *
 * The frame stack models what the scanner is currently inside: code, a block
 * comment, a string, a Rust raw string, a JS template literal (whose `${}`
 * re-enters code), or a JS regex literal.
 */
export function scanSource(text, lang) {
  const problems = [];
  const masked = text.split("");
  const blank = (from, to) => {
    for (let k = from; k < to && k < masked.length; k++) {
      if (masked[k] !== "\n") masked[k] = " ";
    }
  };

  const frames = [{ kind: "code", brace: 0, line: 1 }];
  const braceLines = [];
  const delimStack = [];
  let i = 0;
  let line = 1;
  let prevSig = "";
  let prevWord = "";

  // A shebang is not code: `#!/usr/bin/env node` read as JavaScript opens a
  // regex literal on the first slash and mis-parses the rest of the file.
  if (text.startsWith("#!")) {
    const eol = text.indexOf("\n");
    const end = eol === -1 ? text.length : eol;
    blank(0, end);
    i = end;
  }

  const regexAllowed = () => {
    if (prevWord && /^(return|typeof|instanceof|in|of|new|delete|do|else|case|yield|await|void|throw)$/.test(prevWord)) return true;
    if (!prevSig) return true;
    return !/[A-Za-z0-9_$)\]'"`]/.test(prevSig);
  };

  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];

    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (isSpace(c)) {
      i++;
      continue;
    }

    const f = frames[frames.length - 1];

    if (f.kind === "block") {
      if (c === "*" && n === "/") {
        f.nest--;
        blank(i, i + 2);
        i += 2;
        if (f.nest === 0) frames.pop();
        continue;
      }
      if (c === "/" && n === "*" && lang === "rust") {
        f.nest++;
        blank(i, i + 2);
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i++;
      continue;
    }

    if (f.kind === "raw") {
      if (text.startsWith(f.end, i)) {
        blank(i, i + f.end.length);
        i += f.end.length;
        frames.pop();
        prevSig = '"';
        continue;
      }
      blank(i, i + 1);
      i++;
      continue;
    }

    if (f.kind === "string") {
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === f.quote) {
        blank(i, i + 1);
        i++;
        frames.pop();
        prevSig = f.quote;
        continue;
      }
      blank(i, i + 1);
      i++;
      continue;
    }

    if (f.kind === "template") {
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        blank(i, i + 1);
        i++;
        frames.pop();
        prevSig = "`";
        continue;
      }
      if (c === "$" && n === "{") {
        blank(i, i + 2);
        i += 2;
        frames.push({ kind: "code", brace: 0, line, fromTemplate: true });
        continue;
      }
      blank(i, i + 1);
      i++;
      continue;
    }

    if (f.kind === "regex") {
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "[") f.inClass = true;
      else if (c === "]") f.inClass = false;
      else if (c === "/" && !f.inClass) {
        i++;
        blank(i - 1, i);
        frames.pop();
        prevSig = "/";
        while (i < text.length && /[a-z]/.test(text[i])) i++;
        continue;
      }
      blank(i, i + 1);
      i++;
      continue;
    }

    // --- code frame ---
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") {
        blank(i, i + 1);
        i++;
      }
      continue;
    }
    if (c === "/" && n === "*") {
      frames.push({ kind: "block", nest: 1, line });
      blank(i, i + 2);
      i += 2;
      continue;
    }
    if (lang === "rust" && (c === "r" || (c === "b" && n === "r"))) {
      const start = c === "b" ? i + 1 : i;
      if (start === i || text[i - 1] === undefined || !/[A-Za-z0-9_]/.test(text[i - 1])) {
        let k = start + 1;
        let hashes = 0;
        while (text[k] === "#") {
          k++;
          hashes++;
        }
        if (text[k] === '"' && (c === "r" || n === "r")) {
          const end = '"' + "#".repeat(hashes);
          frames.push({ kind: "raw", end, line });
          blank(i, k + 1);
          i = k + 1;
          continue;
        }
      }
    }
    if (c === '"') {
      frames.push({ kind: "string", quote: '"', line });
      blank(i, i + 1);
      i++;
      continue;
    }
    if (c === "'") {
      if (lang === "rust") {
        const m = /^'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'/.exec(text.slice(i, i + 12));
        if (m) {
          blank(i, i + m[0].length);
          i += m[0].length;
          prevSig = "'";
          continue;
        }
        // A lifetime (`'a`, `'de`, `'_`): leave it in the masked text.
        masked[i] = "'";
        i++;
        prevSig = "'";
        continue;
      }
      frames.push({ kind: "string", quote: "'", line });
      blank(i, i + 1);
      i++;
      continue;
    }
    if (lang === "js" && c === "`") {
      frames.push({ kind: "template", line });
      blank(i, i + 1);
      i++;
      continue;
    }
    if (lang === "js" && c === "/" && regexAllowed()) {
      frames.push({ kind: "regex", inClass: false, line });
      blank(i, i + 1);
      i++;
      continue;
    }

    if (c === "{") {
      f.brace++;
      braceLines.push(line);
      masked[i] = "{";
      i++;
      prevSig = c;
      continue;
    }
    if (c === "}") {
      if (f.brace > 0) {
        f.brace--;
        braceLines.pop();
        masked[i] = "}";
        i++;
        prevSig = c;
        continue;
      }
      if (f.fromTemplate && frames.length > 1) {
        frames.pop();
        blank(i, i + 1);
        i++;
        prevSig = "}";
        continue;
      }
      problems.push({ line, rule: "UNBALANCED", detail: `stray '}' with no matching '{'` });
      masked[i] = "}";
      i++;
      prevSig = c;
      continue;
    }
    if (OPENERS[c]) {
      delimStack.push({ c, line });
      masked[i] = c;
      i++;
      prevSig = c;
      continue;
    }
    if (CLOSERS[c]) {
      const top = delimStack[delimStack.length - 1];
      if (top && top.c === CLOSERS[c]) {
        delimStack.pop();
      } else {
        problems.push({
          line,
          rule: "UNBALANCED",
          detail: top
            ? `'${c}' closes ')' / ']' / '}' out of order — innermost open is '${top.c}' from line ${top.line}`
            : `stray '${c}' with no matching '${CLOSERS[c]}'`,
        });
      }
      masked[i] = c;
      i++;
      prevSig = c;
      continue;
    }

    masked[i] = c;
    if (/[A-Za-z0-9_$]/.test(c)) {
      prevWord = (/[A-Za-z0-9_$]/.test(text[i - 1] ?? "") ? prevWord : "") + c;
    } else {
      prevWord = "";
    }
    prevSig = c;
    i++;
  }

  for (const open of delimStack) {
    problems.push({ line: open.line, rule: "UNCLOSED", detail: `'${open.c}' opened here and never closed` });
  }
  // A `{` left open at end of file is the other half of the deleted-brace class:
  // the closer was on the line the merge dropped, so no stray `}` ever appears.
  for (const openLine of braceLines) {
    problems.push({ line: openLine, rule: "UNCLOSED", detail: "'{' opened here and never closed" });
  }
  for (let k = 1; k < frames.length; k++) {
    const f = frames[k];
    const what = { block: "block comment", string: "string", raw: "raw string", template: "template literal", regex: "regex literal" }[f.kind];
    problems.push({ line: f.line, rule: "UNTERMINATED", detail: `${what} opened here and never closed` });
  }

  return { masked: masked.join(""), problems };
}

/**
 * Scope labels for every line: the text that introduced the enclosing `{`.
 * `impl StreamContract` / `mod tests` / `trait X` are item scopes where a
 * duplicated `fn` is a compiler error; a `{` opened by a closure is not, so
 * rule 1 only runs where the label looks like an item.
 *
 * A line belongs to the scope that was already open when it started, so an
 * entrypoint written `pub fn f() {` on one line is attributed to its `impl`,
 * not to its own body.
 */
export function lineScopes(masked) {
  const labels = [];
  const stack = [];
  let header = "";
  let line = 1;
  let current = "<file>";
  let atLineStart = "<file>";
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "\n") {
      labels[line] = atLineStart;
      line++;
      atLineStart = current;
      continue;
    }
    if (c === "{") {
      stack.push(normalizeLabel(header));
      header = "";
      current = stack[stack.length - 1];
      continue;
    }
    if (c === "}") {
      stack.pop();
      header = "";
      current = stack[stack.length - 1] ?? "<file>";
      continue;
    }
    if (c === ";") header = "";
    else header += c;
  }
  labels[line] = atLineStart;
  return { labels, depthOf: (l) => labels[l] };
}

const LEADING_ATTR = /^\s*#!?\[[^\]]*\]/;

function normalizeLabel(raw) {
  let t = raw;
  while (LEADING_ATTR.test(t)) t = t.replace(LEADING_ATTR, " ");
  t = t.replace(/\s+/g, " ").trim();
  const m = /^(pub(\([^)]*\)\s+)?)*(unsafe\s+)?(async\s+)?(extern[\s\S]*?\s+)?(impl\b.*|trait\s+\w+|mod\s+\w+|enum\s+\w+|struct\s+\w+|fn\s+\w+|const\s+\w+)/.exec(t);
  if (m) return m[0].replace(/\s+/g, " ").trim();
  const item = /\b(impl\b[^{}]*|trait\s+\w+|mod\s+\w+|enum\s+\w+|struct\s+\w+)/.exec(t);
  if (item) return item[0].replace(/\s+/g, " ").trim();
  return t.slice(0, 60) || "<block>";
}

const RUST_ITEM_SCOPE = /^(impl|trait|mod|enum|struct)\b/;
const CLASS_SCOPE = /^(\w+\s+)*class\s+\w+/;

/** Rule 1: the same item declared twice inside one scope. */
export function duplicateDeclarations(masked, lang) {
  const found = [];
  const { labels } = lineScopes(masked);
  const lines = masked.split("\n");
  const seen = new Map();

  const record = (lineNo, scope, kind, name) => {
    const key = `${scope}|${kind}|${name}`;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, lineNo);
    else found.push({ line: lineNo, rule: "DUPLICATE", detail: `duplicate ${kind} '${name}' in ${scope} — already declared on line ${first}` });
  };

  for (let l = 0; l < lines.length; l++) {
    const text = lines[l];
    const lineNo = l + 1;
    const scope = labels[lineNo] ?? "<file>";
    if (lang === "rust") {
      if (!RUST_ITEM_SCOPE.test(scope)) continue;
      for (const m of text.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) record(lineNo, scope, "fn", m[1]);
      for (const m of text.matchAll(/\b(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (scope === "<file>") record(lineNo, scope, "type", m[1]);
      }
      continue;
    }
    if (scope !== "<file>") {
      if (!CLASS_SCOPE.test(scope)) continue;
      // A class body line that opens a block with a `name(...)` signature is a
      // method declaration; a duplicate one is TS2393 on the class itself.
      const sig = /^\s*(?:(?:public|private|protected|readonly|static|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)/.exec(text);
      if (sig && text.trimEnd().endsWith("{")) record(lineNo, scope, "method", sig[1]);
      continue;
    }
    for (const m of text.matchAll(/(?:^|[\s;}])function\s+([A-Za-z_$][\w$]*)/g)) record(lineNo, scope, "function", m[1]);
    for (const m of text.matchAll(/(?:^|[\s;}])class\s+([A-Za-z_$][\w$]*)/g)) record(lineNo, scope, "class", m[1]);
    for (const m of text.matchAll(/(?:^|[\s;}])(?:export\s+)?(?:default\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
      record(lineNo, scope, "binding", m[1]);
    }
  }
  return found;
}

const CONFLICT = /^(<<<<<<<|>>>>>>>)/m;

export function checkFile(absolutePath, relPath) {
  const lang = langOf(relPath);
  if (!lang) return [];
  const text = readFileSync(absolutePath, "utf8");
  const { masked, problems } = scanSource(text, lang);
  const out = problems.map((p) => ({ ...p, file: relPath }));
  for (const p of duplicateDeclarations(masked, lang)) out.push({ ...p, file: relPath });
  const marker = CONFLICT.exec(text);
  if (marker) {
    out.push({
      file: relPath,
      line: text.slice(0, marker.index).split("\n").length,
      rule: "CONFLICT MARKER",
      detail: `unresolved merge marker '${marker[1]}'`,
    });
  }
  return out;
}

export function trackedSourceFiles(root) {
  let names = null;
  try {
    names = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } catch {
    // Not a checkout (an unpacked merge-preview archive, a release tarball):
    // walk the tree instead so the gate still has an answer there.
    names = walkUnder(root);
  }
  return names.filter((f) => langOf(f) && !UNSCANNED_EXTS.includes(path.extname(f)) && !f.endsWith(".d.ts"));
}

function walkUnder(root, dir = "") {
  const out = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      // Third-party and generated trees are not this repo's source.
      if (["node_modules", "target", "dist", "build", "out", "__screenshots__"].includes(entry.name)) continue;
      out.push(...walkUnder(root, path.join(dir, entry.name)));
    } else if (entry.isFile()) {
      out.push(path.relative(root, path.join(root, dir, entry.name)).split(path.sep).join("/"));
    }
  }
  return out;
}

export function run(root, files) {
  const findings = [];
  for (const rel of files) {
    try {
      findings.push(...checkFile(path.join(root, rel), rel));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }
  return findings;
}

function main() {
  const argv = process.argv.slice(2);
  let root = REPO_ROOT;
  let list = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = path.resolve(argv[++i]);
    else if (argv[i] === "--files") list = argv.slice(i + 1).filter((a) => !a.startsWith("--"));
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: node scripts/check_merge_integrity.mjs [--root DIR] [--files f1 f2 ...]");
      return;
    }
  }
  const files = list ?? trackedSourceFiles(root);
  const findings = run(root, files);

  console.log(`merge-integrity: ${files.length} source file(s) scanned under ${path.relative(process.cwd(), root) || "."}`);
  if (findings.length > 0) {
    console.error(`\nfindings (${findings.length}):`);
    for (const f of findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.error(`  FAIL  ${f.file}:${f.line}  ${f.rule} — ${f.detail}`);
    }
    console.error(
      "\nThese are merge artifacts, not style: the files listed cannot compile.\n" +
        "Repair the merge (restore the deleted brace/closer, or collapse the\n" +
        "duplicated definition to one) and re-run this script."
    );
    process.exit(1);
  }
  console.log("PASSED: every scanned file is structurally sound");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
