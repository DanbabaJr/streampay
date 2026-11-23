import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_TEST_FILE = path.join(
  REPO_ROOT,
  "sdks/typescript/dist/test/conformance.test.js"
);

export function runSdkConformanceBenchmark(testFile = DEFAULT_TEST_FILE) {
  const durations = [];
  for (let run = 0; run < 3; run++) {
    const start = performance.now();
    execFileSync(process.execPath, ["--test", testFile], {
      cwd: REPO_ROOT,
      stdio: "ignore"
    });
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  return durations[1];
}
