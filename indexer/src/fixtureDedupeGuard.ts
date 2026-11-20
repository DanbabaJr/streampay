import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Drift guard for the indexer event fixture (issue #546).
 *
 * The pipeline test loaded `events-fixture.json` through a tolerant
 * multi-candidate resolver, which let a duplicate copy live under
 * `indexer/test/` and silently satisfy the test even after the canonical
 * `indexer/fixtures/` copy changed. There is now exactly one fixture and this
 * guard fails the build if a second copy ever reappears.
 */
export const CANONICAL_FIXTURE = "indexer/fixtures/events-fixture.json";
const CANONICAL_DIR = "indexer/fixtures";
const FIXTURE_BASENAME = "events-fixture.json";

/**
 * Pure: given repo-relative POSIX paths, return the ones that are duplicate
 * `events-fixture.json` files living outside the canonical directory. Empty
 * array means a single source of truth holds. Splitting this out makes the
 * detector itself unit-testable without touching the filesystem.
 */
export function findDuplicateEventFixtures(paths: string[]): string[] {
  return paths.filter((p) => {
    const posix = p.split(sep).join("/");
    if (!posix.endsWith(`/${FIXTURE_BASENAME}`)) return false;
    return posix !== CANONICAL_FIXTURE;
  });
}

/**
 * Enumerate every file under `root` (an indexer package dir) as a repo-style
 * POSIX path prefixed with `indexer/`, so the results line up with
 * CANONICAL_FIXTURE regardless of the absolute root it was called with.
 */
export function listIndexerFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push("indexer/" + full.slice(root.length + 1).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}
