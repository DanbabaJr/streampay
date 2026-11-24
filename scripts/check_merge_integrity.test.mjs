#!/usr/bin/env node
// Tests for scripts/check_merge_integrity.mjs.
//
// Every rule is proven with a POSITIVE fixture first (a broken file that must
// be flagged) before any negative test is worth anything — a scanner that never
// fires passes every "no false positives" test by accident. The positives are
// transcribed from the real failures this gate was written for.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanSource, duplicateDeclarations, lineScopes, checkFile, run } from "./check_merge_integrity.mjs";

const rules = (text, lang) => scanSource(text, lang).problems.map((p) => p.rule);
const problems = (text, lang) => scanSource(text, lang).problems;
const dups = (text, lang) => duplicateDeclarations(scanSource(text, lang).masked, lang);

// ---------------------------------------------------------------- rule 1: DUPLICATE

test("rust: an entrypoint duplicated inside one impl is flagged", () => {
  // The shape of main's E0592: two PRs each append `authorize_agent` to the
  // same impl block, git merges them both, and the contract stops compiling.
  const src = [
    "#[contractimpl]",
    "impl StreamingPayments {",
    "    pub fn authorize_agent(env: Env, owner: Address, agent: Address) {",
    "        env.storage().persistent().set(&agent, &true);",
    "    }",
    "",
    "    pub fn authorize_agent(env: Env, agent: Address) {",
    "        env.storage().persistent().set(&agent, &true);",
    "    }",
    "}",
    "",
  ].join("\n");
  const found = dups(src, "rust");
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].rule, "DUPLICATE");
  assert.equal(found[0].line, 7);
  assert.match(found[0].detail, /duplicate fn 'authorize_agent'/);
  assert.match(found[0].detail, /already declared on line 3/);
});

test("rust: attributes before impl do not hide the scope", () => {
  // Regression: `#[contractimpl]` used to become the scope label, so the rule
  // never recognised the impl and main's duplicates slipped through.
  const src = [
    "#![allow(clippy::all)]",
    "#[cfg(test)]",
    "mod tests {",
    "    use super::*;",
    "    fn helper() {}",
    "    fn helper() {}",
    "}",
    "",
  ].join("\n");
  assert.equal(dups(src, "rust").length, 1);
});

test("rust: the same fn name in two different impls is fine", () => {
  const src = [
    "impl Alpha {",
    "    pub fn withdraw(env: Env) {}",
    "}",
    "impl Beta {",
    "    pub fn withdraw(env: Env) {}",
    "}",
  ].join("\n");
  assert.deepEqual(dups(src, "rust"), []);
});

test("rust: distinct generic trait impls are distinct scopes", () => {
  // sdks/rust/src/lib.rs has `fn from` in `impl<E> From<EncodeError> for …` and
  // in `impl<E> From<DecodeError> for …` — legal, so the impl's own text,
  // generics and target included, is the scope key.
  const src = [
    "impl<E> From<EncodeError> for CallError<E> {",
    "    fn from(error: EncodeError) -> Self {",
    "        Self::Encode(error)",
    "    }",
    "}",
    "impl<E> From<DecodeError> for CallError<E> {",
    "    fn from(error: DecodeError) -> Self {",
    "        Self::Decode(error)",
    "    }",
    "}",
  ].join("\n");
  assert.deepEqual(dups(src, "rust"), []);
});

test("rust: nested fns and closures are not compared to their outer item", () => {
  const src = ["impl A {", "    pub fn run(env: Env) {", "        let go = || {};", "        go();", "    }", "}"].join("\n");
  assert.deepEqual(dups(src, "rust"), []);
});

test("ts: a duplicated top-level function, class and const are flagged", () => {
  const src = [
    "export function decode(line: string): string {",
    "  return line;",
    "}",
    "export function decode(line: string, alt: number): string {",
    "  return line + alt;",
    "}",
    "class Store {}",
    "class Store {}",
    "const budget = 1;",
    "const budget = 2;",
  ].join("\n");
  const found = dups(src, "js");
  const kinds = found.map((f) => f.rule).sort();
  assert.deepEqual(kinds, ["DUPLICATE", "DUPLICATE", "DUPLICATE"]);
  assert.deepEqual(
    found.map((f) => f.detail.match(/duplicate (\w+)/)[1]).sort(),
    ["binding", "class", "function"],
  );
});

test("ts: a method duplicated inside one class is flagged", () => {
  // The store.ts shape: two PRs both add `projectEvent` to the class body, and
  // the same happens to `fold`.
  const src = [
    "export class Store {",
    "  projectEvent(event: unknown): { duplicate: boolean } {",
    "    return { duplicate: false };",
    "  }",
    "",
    "  fold(stream: unknown): void {",
    "    return;",
    "  }",
    "",
    "  projectEvent(event: unknown): { duplicate: boolean } {",
    "    return { duplicate: true };",
    "  }",
    "",
    "  fold(stream: unknown): void {",
    "    return;",
    "  }",
    "}",
  ].join("\n");
  const found = dups(src, "js");
  assert.equal(found.length, 2, JSON.stringify(found));
  assert.deepEqual(found.map((f) => f.line), [10, 14]);
  assert.match(found[0].detail, /duplicate method 'projectEvent'/);
  assert.match(found[0].detail, /already declared on line 2/);
});

test("ts: locals in different functions, and calls, are not declarations", () => {
  const src = [
    "function a() {",
    "  const total = 1;",
    "  return total;",
    "}",
    "function b() {",
    "  const total = 2;",
    "  return total;",
    "}",
    "const value = 3;",
    "const other = { value: 4 };",
    "log(value);",
    "function log(x: unknown) {}",
  ].join("\n");
  assert.deepEqual(dups(src, "js"), []);
});

// ---------------------------------------------------------------- rule 2: UNBALANCED

test("delimiters: a stray closing brace is reported at its line", () => {
  // main's indexer/src/store.ts: the merge deleted the `}` closing `projectEvent`
  // along with the blank line above it, so a later `}` had nothing to close.
  const src = ["class A {", "  m(): void {", "    return;", "  }", "}", "}"].join("\n");
  const found = problems(src, "js");
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].rule, "UNBALANCED");
  assert.equal(found[0].line, 6);
});

test("delimiters: an unclosed opener is reported where it opened", () => {
  // scripts/key_rotation_drill.ts: `new TransactionBuilder(source, {` lost its
  // closer, which the TS compiler only surfaced ~200 lines later.
  const src = ["const tx = new TransactionBuilder(source, {", "  fee: \"100000\",", "", "const y = 1;"].join("\n");
  const found = problems(src, "js");
  assert.ok(
    found.some((p) => p.rule === "UNCLOSED" && p.line === 1),
    JSON.stringify(found),
  );
  assert.ok(
    found.some((p) => p.rule === "UNCLOSED" && p.line === 1 && p.detail.includes("'('")),
    JSON.stringify(found),
  );
  assert.ok(
    found.some((p) => p.rule === "UNCLOSED" && p.detail.includes("'{'")),
    JSON.stringify(found),
  );
});

test("delimiters: a deleted brace inside a class body is still detected", () => {
  // The harder store.ts shape: one opener is missing, so every later closer is
  // absorbed by the wrong frame and only the file-level count reveals it.
  const src = [
    "class Store {",
    "  projectEvent(event: unknown): Result {",
    "    return this.db.transaction(() => this.ingest(event))();",
    "",
    "  fold(stream: unknown): void {",
    "    return;",
    "  }",
    "}",
  ].join("\n");
  const found = problems(src, "js");
  assert.ok(found.length > 0, "expected a finding for the missing '}'");
  assert.ok(found.every((p) => p.rule === "UNCLOSED" || p.rule === "UNBALANCED"), JSON.stringify(found));
});

test("delimiters: braces inside strings, chars and comments are not counted", () => {
  const js = 'const s = "function(){ { {";  // } } }\n' + "const t = `a { ${1 + 1} b}`;\n";
  assert.deepEqual(rules(js, "js"), []);
  const rs = `fn f() {
    let s = "{{{";
    let c = '{';
    let l = 'a;
    /* } ) ] nested /* deeper */ still */
    let m = a.map(|x| x + 1);
}
`;
  assert.deepEqual(rules(rs, "rust"), []);
});

test("delimiters: a template literal interpolation re-enters code", () => {
  assert.deepEqual(rules("const x = `${ a ? 1 : 2 }`;\n", "js"), []);
  assert.deepEqual(rules("const x = `${ \"unbalanced (\" }`;\n", "js"), []);
});

test("delimiters: regex literals are not divisions or brace openers", () => {
  assert.deepEqual(rules("const re = /^[a-z)]{2,3}$/;\nconst n = 4 / 2;\n", "js"), []);
});

test("delimiters: a shebang line is not parsed as code", () => {
  // `#!/usr/bin/env node` used to open a regex frame on the first slash and
  // report every following `/` as an unterminated literal.
  const src = "#!/usr/bin/env node\nimport fs from \"node:fs\";\nconst a = 1 / 2;\n";
  assert.deepEqual(rules(src, "js"), []);
});

// ---------------------------------------------------------------- rule 3: UNTERMINATED

test("tokens: an unterminated block comment, string and template are flagged", () => {
  assert.ok(rules("/**\n * dangling\n\nfn f() {}\n", "rust").includes("UNTERMINATED"));
  assert.ok(rules("const s = \"oops;\nconst t = 1;\n", "js").includes("UNTERMINATED"));
  assert.ok(rules("const s = `oops\nstill going\n", "js").includes("UNTERMINATED"));
});

test("tokens: an unterminated rust raw string is flagged", () => {
  assert.ok(rules(`const s = r#"never closed\nfn f() {}\n`, "rust").includes("UNTERMINATED"));
  assert.deepEqual(rules(`const s = r#"a " quote } still open"#;\n`, "rust"), []);
});

// ---------------------------------------------------------------- rule 4: CONFLICT MARKER

test("conflict: leftover markers are flagged, prose is not", () => {
  const bad = "fn f() {\n<<<<<<< HEAD\n    1\n=======\n    2\n>>>>>>> branch\n}\n";
  const findings = checkFileOn(bad, "a.rs");
  assert.ok(findings.some((f) => f.rule === "CONFLICT MARKER"), JSON.stringify(findings));
  assert.deepEqual(checkFileOn("fn f() {\n    // git prints <<<< when diverging\n    1\n}\n", "a.rs"), []);
});

function checkFileOn(text, name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mi-"));
  try {
    const abs = path.join(dir, name);
    writeFileSync(abs, text, "utf8");
    return checkFile(abs, name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- wiring

test("checkFile: non-source extensions and .d.ts are skipped", () => {
  assert.deepEqual(checkFileOn("this {{{ is not (code\n", "README.md"), []);
  assert.deepEqual(checkFileOn("export declare const x: { a: string };\n", "types.d.ts"), []);
});

test("run: reports file paths and passes on a sound tree", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mi-"));
  try {
    writeFileSync(path.join(dir, "good.rs"), "impl A {\n    pub fn f(env: Env) {}\n}\n", "utf8");
    writeFileSync(path.join(dir, "bad.rs"), "impl A {\n    pub fn f() {}\n    pub fn f() {}\n}\n", "utf8");
    const findings = run(dir, ["good.rs", "bad.rs", "missing.rs"]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].file, "bad.rs");
    assert.equal(findings[0].rule, "DUPLICATE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lineScopes: labels the file scope, the item scope and the fn body", () => {
  const src = "struct S;\n#[contractimpl]\nimpl C {\n    pub fn f() {\n        let g = || { 1 };\n    }\n}\n";
  const { labels } = lineScopes(scanSource(src, "rust").masked);
  assert.equal(labels[1], "<file>");
  assert.equal(labels[4], "impl C");
  // Inside a fn body the scope is the fn, which rule 1 skips on purpose: a
  // closure named like an item is legal, a second `fn` in an impl is not.
  assert.equal(labels[5], "pub fn f()");
});
