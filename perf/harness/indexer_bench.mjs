import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

export async function runIndexerBenchmark(runs = 3) {
  const fixturePath = path.join(REPO_ROOT, "perf/fixtures/indexer-archive-fixture.json");
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Archive fixture not found at ${fixturePath}`);
  }

  const rawEvents = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  
  // Dynamically import compiled store and decoder from indexer. `pathToFileURL`
  // because a Windows absolute path is not a valid ESM specifier.
  const { StreamStore } = await import(pathToFileURL(path.join(REPO_ROOT, "indexer/dist/store.js")).href);
  const { decodeEvent } = await import(pathToFileURL(path.join(REPO_ROOT, "indexer/dist/decoder.js")).href);

  const durations = [];
  const eventCount = rawEvents.length;

  for (let r = 0; r < runs; r++) {
    const tempDb = path.join(REPO_ROOT, `perf/temp-bench-${Date.now()}-${r}.sqlite`);
    if (fs.existsSync(tempDb)) fs.unlinkSync(tempDb);

    try {
      const store = new StreamStore(tempDb);
      const start = performance.now();

      // Ingest archive in realistic chunks of 50 events per page
      const pageSize = 50;
      for (let i = 0; i < rawEvents.length; i += pageSize) {
        const page = rawEvents.slice(i, i + pageSize);
        const decoded = page.map(decodeEvent);
        const cursor = String(100 + i + page.length);
        const lastLedger = 100 + i + page.length;
        store.ingestPage(decoded, cursor, lastLedger);
      }

      const elapsed = performance.now() - start;
      durations.push(elapsed);
    } finally {
      const cleanFiles = [tempDb, `${tempDb}-wal`, `${tempDb}-shm`];
      for (const f of cleanFiles) {
        if (fs.existsSync(f)) {
          try { fs.unlinkSync(f); } catch {}
        }
      }
    }
  }

  // Median of 3 runs
  durations.sort((a, b) => a - b);
  const medianDuration = durations[Math.floor(durations.length / 2)];
  const throughput = (eventCount / (medianDuration / 1000));

  return {
    runs,
    eventCount,
    durations,
    catchup_duration_ms: Math.round(medianDuration * 100) / 100,
    ingest_throughput_eps: Math.round(throughput)
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runIndexerBenchmark().then(res => {
    console.log("Indexer Benchmark Result:", JSON.stringify(res, null, 2));
  }).catch(err => {
    console.error("Indexer benchmark failed:", err);
    process.exit(1);
  });
}
