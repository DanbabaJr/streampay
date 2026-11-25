#!/usr/bin/env python3
"""Audit docs/WHITEPAPER.md's claim-to-code traceability table.

For every row between <!-- claims:begin --> and <!-- claims:end -->:
  - the cited file exists,
  - the cited line or range lies inside the file,
  - the anchor snippet appears within the cited lines (whitespace-insensitive).
And across the document:
  - every [Cn] cited in the text has a row,
  - every row is cited at least once in the text,
  - ids are unique.

A failing row means the code moved under the paper: fix the location, and
re-read the claim while you are there — a moved line is how a claim goes stale.

  python3 scripts/check_whitepaper_claims.py [path/to/WHITEPAPER.md] [--fix]

--fix rewrites each row's line numbers to where its anchor actually sits now
(the occurrence nearest the number already cited, so a row that points at the
second `Branch::StreamNotActive` stays on the second one). It only moves
numbers: claims, anchors, ids and row order are never touched, and a row whose
anchor has vanished from the file is reported instead of guessed at.
"""
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

ARGS = [a for a in sys.argv[1:] if a != "--fix"]
FIX = "--fix" in sys.argv[1:]
DOC = ARGS[0] if ARGS else os.path.join(ROOT, "docs", "WHITEPAPER.md")

ROW = re.compile(r"^\|\s*(C\d+)\s*\|(.+?)\|\s*`([^`:]+):(\d+)(?:-(\d+))?`\s*\|\s*`(.+)`\s*\|\s*$")
CITE = re.compile(r"\[(C\d+)\]")


def squash(text: str) -> str:
    return re.sub(r"\s+", "", text)


def occurrences(lines, anchor):
    """Every (first_line, last_line) span where `anchor` occurs, whitespace-insensitive."""
    chars, char_lines = [], []
    for number, line in enumerate(lines, 1):
        for ch in line:
            if not ch.isspace():
                chars.append(ch)
                char_lines.append(number)
    haystack, needle = "".join(chars), squash(anchor)
    spans, i = [], 0
    while needle:
        j = haystack.find(needle, i)
        if j < 0:
            break
        spans.append((char_lines[j], char_lines[j + len(needle) - 1]))
        i = j + 1
    return spans


def rewrite_location(raw_line, path, start, end, new_start, new_end):
    """Swap the line numbers of one row's Location cell, leaving the rest byte-identical."""
    old = f"`{path}:{start}`" if start == end else f"`{path}:{start}-{end}`"
    new = f"`{path}:{new_start}`" if new_start == new_end else f"`{path}:{new_start}-{new_end}`"
    return raw_line.replace(old, new, 1)


def check(doc_text):
    """Return (errors, rows_by_id) for the claims table in `doc_text`."""
    try:
        body, rest = doc_text.split("<!-- claims:begin -->", 1)
        table, _ = rest.split("<!-- claims:end -->", 1)
    except ValueError:
        return [f"{DOC}: claims markers not found"], {}

    errors, rows = [], {}
    for line in table.splitlines():
        if not line.startswith("| C"):
            continue
        m = ROW.match(line)
        if not m:
            errors.append(f"not a well-formed claim row: {line[:80]}")
            continue
        cid, _claim, path, start, end, anchor = m.groups()
        start, end = int(start), int(end or start)
        if cid in rows:
            errors.append(f"{cid}: duplicate id")
            continue
        rows[cid] = (path, start, end, anchor)

        full = os.path.join(ROOT, path)
        if not os.path.isfile(full):
            errors.append(f"{cid}: {path} does not exist")
            continue
        with open(full, encoding="utf-8") as src:
            src_lines = src.read().splitlines()
        if not (1 <= start <= end <= len(src_lines)):
            errors.append(f"{cid}: {path}:{start}-{end} is outside the file ({len(src_lines)} lines)")
            continue
        if squash(anchor) not in squash("\n".join(src_lines[start - 1 : end])):
            errors.append(f"{cid}: anchor `{anchor}` not found in {path}:{start}-{end}")

    cited = set(CITE.findall(body))
    for cid in sorted(cited - rows.keys(), key=lambda c: int(c[1:])):
        errors.append(f"{cid}: cited in the text but has no row")
    for cid in sorted(rows.keys() - cited, key=lambda c: int(c[1:])):
        errors.append(f"{cid}: has a row but is never cited in the text")
    return errors, rows


def apply_fixes(doc_text):
    """Move each drifted row inside the claims table onto its anchor's real lines."""
    try:
        head, rest = doc_text.split("<!-- claims:begin -->", 1)
        table, tail = rest.split("<!-- claims:end -->", 1)
    except ValueError:
        return doc_text, 0, [], ["claims markers not found"]

    moved, unfixable, ambiguous = 0, [], []
    out_lines = []
    for line in table.split("\n"):
        if not line.startswith("| C"):
            out_lines.append(line)
            continue
        m = ROW.match(line)
        if not m:
            out_lines.append(line)
            continue
        cid, _claim, path, start, end, anchor = m.groups()
        start, end = int(start), int(end or start)
        full = os.path.join(ROOT, path)
        if not os.path.isfile(full):
            unfixable.append(f"{cid}: {path} does not exist")
            out_lines.append(line)
            continue
        with open(full, encoding="utf-8") as src:
            src_lines = src.read().splitlines()
        spans = occurrences(src_lines, anchor)
        if not spans:
            unfixable.append(f"{cid}: anchor `{anchor}` is not in {path} at all - re-read the claim")
            out_lines.append(line)
            continue
        new_start, new_end = min(spans, key=lambda s: (abs(s[0] - start), s[0]))
        fixed = rewrite_location(line, path, start, end, new_start, new_end)
        if fixed == line:
            out_lines.append(line)
            continue
        if f"`{path}:{new_start}" not in fixed:
            unfixable.append(f"{cid}: could not rewrite the location cell of {line[:60]}")
            out_lines.append(line)
            continue
        out_lines.append(fixed)
        moved += 1
        if len(spans) > 1:
            ambiguous.append(cid)
    return head + "<!-- claims:begin -->" + "\n".join(out_lines) + "<!-- claims:end -->" + tail, moved, unfixable, ambiguous


def main() -> int:
    with open(DOC, encoding="utf-8") as f:
        doc = f.read()

    errors, rows = check(doc)
    if errors and FIX:
        doc, moved, unfixable, ambiguous = apply_fixes(doc)
        for msg in unfixable:
            print(f"  - cannot fix: {msg}", file=sys.stderr)
        if moved:
            with open(DOC, "w", encoding="utf-8", newline="") as f:
                f.write(doc)
            print(f"rewrote {moved} row(s) onto their current anchor lines")
        if ambiguous:
            print(
                f"  {len(ambiguous)} of them have an anchor that occurs more than once in the file, "
                f"so they were placed on the nearest site: {', '.join(sorted(ambiguous, key=lambda c: int(c[1:])))} - re-read those rows",
                file=sys.stderr,
            )
        errors, rows = check(doc)

    if errors:
        print(f"{len(errors)} traceability error(s) in {os.path.relpath(DOC, ROOT)}:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        if not FIX and any("not found in" in e for e in errors):
            print(
                "\nIf the anchor still exists in the same file, the code simply moved: run\n"
                "  python3 scripts/check_whitepaper_claims.py --fix\n"
                "and commit the rewritten line numbers. Re-read any claim whose anchor is gone.",
                file=sys.stderr,
            )
        return 1
    print(f"OK: {len(rows)} claims verified against the code; all cited, all present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
