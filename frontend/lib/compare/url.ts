// Shareable parameter URL. Format: ?c=<item>~<item>... with
// item = <kind>.<deposit>.<durationSeconds>.<label-encoded>, and optional
// fee params tx, w, bps. Parsing is strict: anything malformed is dropped
// (never thrown) so a hostile link cannot break the page.
import { DEFAULT_FEES, type FeeAssumptions } from "./fees";
import { MAX_ITEMS, type CompareItem } from "./model";
import { MAX_DURATION_SECONDS } from "./simulator";

const UINT = /^[0-9]{1,30}$/;
const MAX_LABEL = 40;

export interface CompareState {
  items: CompareItem[];
  fees: FeeAssumptions;
}

export function encodeState(s: CompareState): string {
  const p = new URLSearchParams();
  p.set(
    "c",
    s.items
      .map((i) =>
        [i.kind === "stream" ? "s" : "h", i.deposit.toString(), i.duration.toString(), encodeURIComponent(i.label), encodeURIComponent(i.key)].join("."),
      )
      .join("~"),
  );
  p.set("tx", s.fees.txFee.toString());
  p.set("w", s.fees.withdrawals.toString());
  p.set("bps", s.fees.protocolFeeBps.toString());
  return p.toString();
}

function uint(v: string | null, fallback: bigint, max: bigint): bigint {
  if (v === null || !UINT.test(v)) return fallback;
  const n = BigInt(v);
  return n > max ? fallback : n;
}

export function decodeState(query: string): CompareState {
  const p = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const items: CompareItem[] = [];
  const seen = new Set<string>();
  for (const part of (p.get("c") ?? "").split("~")) {
    if (items.length >= MAX_ITEMS) break;
    const f = part.split(".");
    if (f.length !== 5) continue;
    const [k, dep, dur, rawLabel, rawKey] = f;
    if ((k !== "s" && k !== "h") || !UINT.test(dep) || !UINT.test(dur)) continue;
    const duration = BigInt(dur);
    const deposit = BigInt(dep);
    if (duration < 1n || duration > MAX_DURATION_SECONDS || deposit < 1n) continue;
    let label: string;
    let key: string;
    try {
      label = decodeURIComponent(rawLabel).slice(0, MAX_LABEL);
      key = decodeURIComponent(rawKey).slice(0, MAX_LABEL);
    } catch {
      continue;
    }
    if (!/^[sh]:[A-Za-z0-9_-]{1,30}$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    items.push({ key, label, kind: k === "s" ? "stream" : "hypothetical", deposit, duration });
  }
  return {
    items,
    fees: {
      txFee: uint(p.get("tx"), DEFAULT_FEES.txFee, 10n ** 12n),
      withdrawals: uint(p.get("w"), DEFAULT_FEES.withdrawals, 1000n),
      protocolFeeBps: uint(p.get("bps"), DEFAULT_FEES.protocolFeeBps, 10_000n),
    },
  };
}
