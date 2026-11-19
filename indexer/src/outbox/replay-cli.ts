import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { StreamStore } from "../store.js";
import { OutboxDispatcher } from "./dispatcher.js";
import { OutboxMetrics } from "./metrics.js";
import { httpPushTransport } from "./http-transport.js";
import { formatReplaySummary, replayDeadLetters, type DeadLetterFilter } from "./replay.js";

const USAGE = `Usage: npm run outbox:replay -- [options]

Lists dead-lettered outbox intents and (optionally) replays them through the
normal dispatcher. Dry-run is the default: nothing changes without --execute.

Options:
  --db <path>         SQLite database (default: $DATABASE_PATH or ./data/streampay.sqlite)
  --consumer <id>     Only entries for this consumer
  --event <id>        Only this event id (repeatable)
  --intent <id>       Only this intent id (repeatable)
  --reason <reason>   Only this dead_reason (e.g. max_attempts, reorg_retracted)
  --limit <n>         Max entries (default 100, max 1000)
  --execute           Actually replay (default is dry-run)
  --json              Machine-readable output
  -h, --help          Show this help
`;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** Parses argv, runs the replay, returns a process exit code. Exported for tests. */
export async function runReplayCli(
  argv: string[],
  io: CliIo = { out: console.log, err: console.error },
  deps: { transport?: typeof httpPushTransport; env?: NodeJS.ProcessEnv } = {}
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        db: { type: "string" },
        consumer: { type: "string" },
        event: { type: "string", multiple: true },
        intent: { type: "string", multiple: true },
        reason: { type: "string" },
        limit: { type: "string" },
        execute: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(USAGE);
    return 0;
  }

  const filter: DeadLetterFilter = {
    consumerId: values.consumer,
    eventIds: values.event,
    reason: values.reason,
  };
  if (values.intent) {
    const ids = values.intent.map(Number);
    if (ids.some((n) => !Number.isInteger(n) || n < 1)) {
      io.err("--intent must be a positive integer");
      return 2;
    }
    filter.intentIds = ids;
  }
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (!Number.isInteger(n) || n < 1) {
      io.err("--limit must be a positive integer");
      return 2;
    }
    filter.limit = n;
  }

  const env = deps.env ?? process.env;
  const dbPath = values.db ?? env.DATABASE_PATH ?? "./data/streampay.sqlite";
  const store = new StreamStore(dbPath);
  try {
    const dispatcher = values.execute
      ? new OutboxDispatcher(store.outbox, deps.transport ?? httpPushTransport, new OutboxMetrics(), {
          batchSize: Math.min(1000, Number(env.OUTBOX_BATCH_SIZE ?? 200) || 200),
        })
      : undefined;
    const summary = await replayDeadLetters(store.outbox, { filter, execute: values.execute, dispatcher });
    io.out(values.json ? JSON.stringify(summary, null, 2) : formatReplaySummary(summary));
    // Non-zero when a replayed entry dead-lettered again, so scripts notice.
    return summary.dead > 0 ? 1 : 0;
  } finally {
    store.close();
  }
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReplayCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  );
}
