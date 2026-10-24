#!/usr/bin/env node
/**
 * check_docs_links.mjs — CI lint for broken internal links in Markdown docs.
 *
 * Scans the root Markdown files and docs/ for inline links (`[text](target)`)
 * and verifies that:
 *
 *   1. relative file targets exist (after resolving `../` against the link's
 *      own directory), and
 *   2. `#anchor` fragments (same-file or cross-file) match a GitHub-rendered
 *      heading slug in the target file.
 *
 * External URLs, `mailto:`, and pure reference-style links are ignored. Exit
 * code 0 = all internal links resolve; 1 = at least one broken link.
 *
 * Every failure is also emitted as a GitHub workflow annotation (`::error
 * file=…,line=…::`) carrying a "closest files in the same directory" hint, so a
 * contributor sees the exact line and the path to write on the check-run summary
 * instead of having to open the log — the common case is a document that was
 * renamed on main.
 *
 * Usage: node scripts/check_docs_links.mjs   (repo root as cwd)
 */
import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  ...globSync("*.md", { cwd: REPO_ROOT }),
  ...globSync("docs/**/*.md", { cwd: REPO_ROOT }),
].map((p) => join(REPO_ROOT, p));

// GitHub heading slugger (github-slugger rules): lowercase, drop punctuation,
// spaces -> hyphens one-for-one (so "a × b" -> "a--b"), dedupe with -1, -2…
function slugify(headings) {
  const seen = new Map();
  return (raw) => {
    let slug = raw
      .trim()
      .toLowerCase()
      .replace(/<[^>]+>/g, "") // inline html
      .replace(/[`*~]/g, "") // code/emphasis markers
      .replace(/[^\p{L}\p{N}\s_-]/gu, "") // punctuation
      .trim()
      .replace(/ /g, "-"); // one hyphen per space, like GitHub
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count === 0 ? slug : `${slug}-${count}`;
  };
}

function headingsOf(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const makeSlug = slugify();
  const slugs = new Set();
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && m[2]) slugs.add(makeSlug(m[2]));
  }
  return slugs;
}

const slugCache = new Map();
function slugsFor(file) {
  if (!slugCache.has(file)) slugCache.set(file, headingsOf(file));
  return slugCache.get(file);
}

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const IGNORED = /^(https?:\/\/|mailto:|tel:|javascript:)/i;

// ---------------------------------------------------------------------------
// "Did you mean" support.
//
// A dead link is the most common CI failure a contributor hits after a
// maintainer-side rename, and the log line "file not found" alone leaves them
// guessing. These helpers turn each miss into a concrete candidate path, and
// every report is emitted as a GitHub workflow annotation so the same text shows
// up on the check run's summary — not only for whoever opens the raw log.
// ---------------------------------------------------------------------------

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i += 1) {
    const cur = [i];
    for (let j = 1; j < cols; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[cols - 1];
}

function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const shared = Math.min(a.length, b.length);
  let k = 0;
  while (k < shared && a[k] === b[k]) k += 1;
  const ratio = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  // A long shared stem ("errors" vs "error_surface") counts as a strong hint
  // even when the edit distance is large because a suffix was added.
  return Math.max(ratio, k >= 4 ? 0.55 + (k / Math.max(a.length, b.length)) * 0.2 : 0);
}

const dirCache = new Map();
function siblings(dir) {
  if (!dirCache.has(dir)) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(md|mdx|rs|ts|tsx|json|mjs|sh|yml|yaml)$/i.test(e.name))
        .map((e) => e.name);
    } catch {
      entries = [];
    }
    dirCache.set(dir, entries);
  }
  return dirCache.get(dir);
}

// Returns { exactCaseMiss: string|null, suggestions: string[] } for a missing path.
function nearMatches(targetFile) {
  const dir = dirname(targetFile);
  const base = basename(targetFile);
  const entries = siblings(dir);
  const exactCaseMiss = entries.find((n) => n !== base && n.toLowerCase() === base.toLowerCase()) || null;
  const stem = base.replace(/\.[^.]+$/, "").toLowerCase();
  const ext = (base.match(/\.[^.]+$/) || [""])[0].toLowerCase();
  const ranked = entries
    .filter((n) => n !== base && (!ext || n.toLowerCase().endsWith(ext)))
    .map((n) => ({ n, s: similarity(stem, n.replace(/\.[^.]+$/, "").toLowerCase()) }))
    .filter((x) => x.s >= 0.55)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.n);
  return { exactCaseMiss, suggestions: ranked };
}

function relPosix(p) {
  return relative(REPO_ROOT, p).split(/[\\/]/).join("/");
}

function annotate(level, file, line, message) {
  // GitHub renders these on the check-run summary and next to the offending
  // line in the Files tab; the plain console line keeps the log readable.
  const safe = message.replace(/%/g, "%25").replace(/\r?\n/g, " ");
  console.log(`::${level} file=${relPosix(file)},line=${line}::${safe}`);
}

let errors = 0;
let checked = 0;

for (const file of FILES) {
  const text = readFileSync(file, "utf8");
  const rel = relative(REPO_ROOT, file);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(LINK_RE)) {
      let target = m[2];
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      if (IGNORED.test(target)) continue;
      // strip a possible title suffix already handled by regex; drop query strings
      const [pathPart, anchor] = target.split("#");
      // Generated error docs reference code symbols as `path/to/file.rs::symbol`.
      // Resolve the file part and verify the symbol literally appears in it.
      const sep = pathPart.indexOf("::");
      const filePath = sep === -1 ? pathPart : pathPart.slice(0, sep);
      const symbol = sep === -1 ? null : pathPart.slice(sep + 2);
      const cleanPath = filePath.split("?")[0];
      const targetFile = cleanPath === "" ? file : normalize(join(dirname(file), cleanPath));
      const where = `${rel}:${i + 1}`;
      checked += 1;
      if (cleanPath !== "" && !existsSync(targetFile)) {
        errors += 1;
        const missing = relPosix(targetFile);
        const { exactCaseMiss, suggestions } = nearMatches(targetFile);
        const asLink = (name) => {
          const r = relative(dirname(file), join(dirname(targetFile), name)).split(/[\\/]/).join("/");
          return r.startsWith("..") ? r : `./${r}`;
        };
        const parts = [`file not found: ${missing}`];
        if (exactCaseMiss) {
          parts.push(`only a case-insensitive match exists (${asLink(exactCaseMiss)} -> ${relPosix(join(dirname(targetFile), exactCaseMiss))}) and CI runs on case-sensitive Linux, so that is a different document — this repo has had files whose names differ only by case`);
        }
        if (suggestions.length) {
          parts.push(`closest files in the same directory: ${suggestions.map((n) => asLink(n)).join(", ")}`);
        }
        const detail = parts.join("; ");
        console.log(`BROKEN LINK ${where} -> ${target} (${detail})`);
        annotate("error", file, i + 1, `Broken internal link [${m[1]}](${target}) — ${detail}`);
        continue;
      }
      if (symbol !== null && !readFileSync(targetFile, "utf8").includes(symbol)) {
        // Non-fatal: the generated catalog's testRef symbol names can drift from
        // the test file's fn names. The link target itself resolves, which is
        // what this gate promises. Surfaced as a warning for the next regen.
        console.log(`WARN SYMBOL ${where} -> ${target} (no "${symbol}" in ${relPosix(targetFile)})`);
      }
      // Anchors are only verifiable for Markdown targets (GitHub heading
      // slugs). Non-md targets (e.g. source files with #L123 line refs) are
      // link-checked by path only.
      if (anchor && targetFile.endsWith(".md")) {
        const slugs = slugsFor(targetFile);
        if (!slugs.has(anchor)) {
          errors += 1;
          const near = [...slugs]
            .map((s) => ({ s, score: similarity(anchor, s) }))
            .filter((x) => x.score >= 0.55)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map((x) => `#${x.s}`);
          const detail = near.length
            ? `no heading slug "${anchor}" in ${relPosix(targetFile)}; closest headings: ${near.join(", ")}`
            : `no heading slug "${anchor}" in ${relPosix(targetFile)}`;
          console.log(`BROKEN ANCHOR ${where} -> ${target} (${detail})`);
          annotate("error", file, i + 1, `Broken anchor in link [${m[1]}](${target}) — ${detail}`);
        }
      }
    }
  });
}

console.log(`checked ${checked} internal links across ${FILES.length} markdown files`);
if (errors > 0) {
  console.log(`${errors} broken link(s) found`);
  console.log("Each one is listed above as FILE:LINE -> target with the closest valid path.");
  console.log("If a document was renamed on main, merge main into your branch and repoint the link.");
  process.exit(1);
}
console.log("all internal links resolve");
