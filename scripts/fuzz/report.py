#!/usr/bin/env python3
"""Campaign statistics and reports.

  report.py slice  --target T --slice N --seconds S --logs w1.log w2.log --new-crashes K
      Parse one slice's libFuzzer worker logs into a JSON line (stdout).

  report.py render --campaign DIR --fuzz FUZZ_DIR
      Render DIR/runs.jsonl (+ triage index, + source coverage if present)
      as the campaign report in Markdown.

Coverage % is libFuzzer's own measure: edges covered (`cov:`) over the
instrumented edges in the binary (`inline 8-bit counters`). It needs no extra
toolchain, so every run reports it. The binary links the Soroban host and SDK,
so the denominator is far larger than the contract alone; read it as a trend.
Source-level line coverage of the contract comes from coverage.sh when the
toolchain has llvm-tools, and is added here when present.
"""
import argparse
import glob
import json
import os
import re
import sys

STAT = re.compile(r"^stat::(\w+):\s+(\d+)")
STATUS = re.compile(r"cov: (\d+) ft: (\d+) corp: (\d+)/")
EDGES = re.compile(r"Loaded \d+ modules\s+\((\d+) inline 8-bit counters\)")
PANIC = re.compile(r"(DIVERGENCE[^\n]*|panicked at [^\n]*)")


def parse_log(path):
    out = {"execs": 0, "eps": 0, "cov": 0, "ft": 0, "corpus": 0, "edges": 0, "panics": []}
    with open(path, errors="replace") as f:
        lines = f.readlines()
    for i, line in enumerate(lines):
        if m := STAT.match(line):
            if m.group(1) == "number_of_executed_units":
                out["execs"] = int(m.group(2))
            elif m.group(1) == "average_exec_per_sec":
                out["eps"] = int(m.group(2))
        if m := STATUS.search(line):
            out["cov"], out["ft"], out["corpus"] = (int(g) for g in m.groups())
        if m := EDGES.search(line):
            out["edges"] = int(m.group(1))
        if m := PANIC.search(line):
            text = m.group(1)
            # "panicked at file:line:col:" is followed by the message line.
            if text.startswith("panicked at") and i + 1 < len(lines):
                text = lines[i + 1].strip()
            out["panics"].append(text)
    # A crashed worker prints no final stats; take the last status line's count.
    if out["execs"] == 0:
        for line in reversed(lines):
            if m := re.match(r"^#(\d+)\s", line):
                out["execs"] = int(m.group(1))
                break
    return out


def cmd_slice(a):
    logs = [parse_log(p) for p in a.logs]
    record = {
        "target": a.target,
        "slice": a.slice,
        "seconds": a.seconds,
        "workers": len(logs),
        "execs": sum(l["execs"] for l in logs),
        "execs_per_sec": sum(l["eps"] for l in logs),
        "cov": max((l["cov"] for l in logs), default=0),
        "features": max((l["ft"] for l in logs), default=0),
        "corpus": max((l["corpus"] for l in logs), default=0),
        "edges_total": max((l["edges"] for l in logs), default=0),
        "new_crashes": a.new_crashes,
        "panics": sorted({p for l in logs for p in l["panics"]}),
    }
    print(json.dumps(record))


def pct(n, d):
    return f"{100 * n / d:.2f}%" if d else "n/a"


def cmd_render(a):
    runs = [json.loads(l) for l in open(os.path.join(a.campaign, "runs.jsonl")) if l.strip()]
    meta = json.load(open(os.path.join(a.campaign, "meta.json")))
    finished = os.path.join(a.campaign, "finished.json")
    end = json.load(open(finished))["finished"] if os.path.exists(finished) else "(running)"

    targets = {}
    for r in runs:
        t = targets.setdefault(r["target"], {"seconds": 0, "execs": 0, "slices": 0, "crashes": 0,
                                            "cov": 0, "edges": 0, "features": 0, "corpus": 0,
                                            "first_cov": None, "panics": set()})
        t["seconds"] += r["seconds"]
        t["execs"] += r["execs"]
        t["slices"] += 1
        t["crashes"] += r["new_crashes"]
        if t["first_cov"] is None:
            t["first_cov"] = r["cov"]
        t["cov"] = max(t["cov"], r["cov"])
        t["edges"] = max(t["edges"], r["edges_total"])
        t["features"] = max(t["features"], r["features"])
        t["corpus"] = r["corpus"] or t["corpus"]
        t["panics"].update(r["panics"])

    for name, t in targets.items():
        d = os.path.join(a.fuzz, "corpus", name)
        if os.path.isdir(d):
            t["corpus"] = len(os.listdir(d))
    wall = sum(t["seconds"] for t in targets.values())
    execs = sum(t["execs"] for t in targets.values())
    out = []
    out.append("# Fuzz campaign report\n")
    out.append(f"- **Window:** {meta['started']} → {end} ({wall / 3600:.2f} h of fuzzing, "
               f"budget {meta['hours']} h)")
    out.append(f"- **Commit:** `{meta['commit']}`")
    out.append(f"- **Host:** {meta['host']}, {meta['cores']} cores, {meta['jobs']} workers per slice; {meta['rustc']}")
    out.append(f"- **Targets (round-robin, {meta['slice_min']} min slices):** {meta['targets']}")
    out.append(f"- **Total executions:** {execs:,} ({execs / wall if wall else 0:,.0f}/s across all workers)\n")

    out.append("## Per target\n")
    out.append("| Target | Fuzzing time | Executions | Runs/sec | Edge coverage | Gained after first slice | Corpus after merge | New crashers |")
    out.append("|---|---|---|---|---|---|---|---|")
    for name, t in targets.items():
        rate = t["execs"] / t["seconds"] if t["seconds"] else 0
        out.append(f"| `{name}` | {t['seconds'] / 3600:.2f} h | {t['execs']:,} | {rate:,.0f} | "
                   f"{t['cov']:,} / {t['edges']:,} ({pct(t['cov'], t['edges'])}) | "
                   f"+{t['cov'] - (t['first_cov'] or 0):,} edges | {t['corpus']:,} | {t['crashes']} |")

    out.append("\n## Crashes\n")
    index_path = os.path.join(a.fuzz, "triage", "INDEX.json")
    index = json.load(open(index_path)) if os.path.exists(index_path) else {}
    any_crash = False
    for name, t in targets.items():
        for p in sorted(t["panics"]):
            any_crash = True
            entry = next((e for e in index.values() if e.get("message") == p), None)
            status = f"{entry['status']} — `{entry['dir']}`" if entry else "untriaged — run scripts/fuzz/triage.sh"
            out.append(f"- `{name}`: {p}\n  - **Status:** {status}")
    if not any_crash:
        out.append("No crashers. No divergence between the contract and the reference model "
                   "(`campaign`, `differential`), and no broken property (`conservation`, `streamed_at`).")
    out.append("\nKnown divergences suppressed during this run (see docs/FUZZ_CAMPAIGN.md): "
               "KD-1, unless the run set STREAMPAY_FUZZ_STRICT.")

    cov_path = os.path.join(a.campaign, "coverage-summary.json")
    if os.path.exists(cov_path):
        cov = json.load(open(cov_path))
        out.append("\n## Source coverage of the contract (llvm-cov)\n")
        out.append("| Target | Lines | Functions | Regions |")
        out.append("|---|---|---|---|")
        for name, c in cov.items():
            out.append(f"| `{name}` | {c['lines']} | {c['functions']} | {c['regions']} |")

    print("\n".join(out))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("slice")
    s.add_argument("--target", required=True)
    s.add_argument("--slice", type=int, required=True)
    s.add_argument("--seconds", type=int, required=True)
    s.add_argument("--logs", nargs="+", required=True)
    s.add_argument("--new-crashes", type=int, default=0)
    r = sub.add_parser("render")
    r.add_argument("--campaign", required=True)
    r.add_argument("--fuzz", required=True)
    a = p.parse_args()
    {"slice": cmd_slice, "render": cmd_render}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
