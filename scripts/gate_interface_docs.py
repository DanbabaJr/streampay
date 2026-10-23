#!/usr/bin/env python3
"""Gate `///` docs of contract-interface items behind cfg_attr (issue #58, Technique 1).

soroban-sdk-macros copies the `#[doc]` text of interface items into the wasm's
`contractspecv0` section. Interface items are:

  * every item annotated #[contracttype] / #[contracterror] / #[contractevent]
    (including the fields and variants inside it),
  * every `pub fn` inside a #[contractimpl] block.

Each of their `///` lines becomes

    #[cfg_attr(not(target_family = "wasm"), doc = "<original text>")]

so the wasm build sees no doc attributes for them while host builds (tests,
rustdoc) expand back to identical documentation. Idempotent. Test-only files
are never touched.

  python3 scripts/gate_interface_docs.py [files...]            # dry run
  python3 scripts/gate_interface_docs.py [files...] --verbose  # list the groups
  python3 scripts/gate_interface_docs.py [files...] --apply    # rewrite them
  python3 scripts/gate_interface_docs.py --check               # CI form: fails on findings
"""
import glob
import os
import re
import sys

DOC = re.compile(r"^(\s*)///(.*)$")
ATTR = re.compile(r"^\s*#")
IFACE_ATTR = ("#[contracttype]", "#[contracterror]", "#[contractevent]")
IMPL_ATTR = "#[contractimpl]"
FN_SIG = re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|union|impl|fn|const|static|type|mod|use)\b")
PUB_FN = re.compile(r"^\s*pub(?:\([^)]*\))?\s+fn\b")
TEST_FILE = re.compile(r"(^|[\\/])(?:test\.rs|test_client\.rs|.*_test\.rs|differential\w*\.rs|cei_trace\.rs)$")


def code_only(line):
    """Strip strings, chars and non-doc comments so brace counting is safe."""
    out, i, n = [], 0, len(line)
    while i < n:
        c = line[i]
        if c == "/" and line[i : i + 2] == "//":
            break
        if c == '"':
            i += 1
            while i < n:
                if line[i] == "\\":
                    i += 2
                    continue
                if line[i] == '"':
                    i += 1
                    break
                i += 1
            out.append('""')
            continue
        if c == "'":
            j = i + 1
            if j < n and line[j] == "\\":
                j += 2
            elif j + 1 < n and line[j + 1] == "'":
                j += 2
            else:
                out.append(c)
                i += 1
                continue
            out.append("''")
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out)


class Model:
    def __init__(self, lines):
        self.lines = lines
        self.depth = [0] * len(lines)
        d = 0
        for idx, line in enumerate(lines):
            code = "" if line.lstrip().startswith(("//", "/*", "*")) else code_only(line)
            self.depth[idx] = d
            code = code_only(line) if not line.lstrip().startswith(("//", "/*", "*")) else ""
            for c in code:
                if c == "{":
                    d += 1
                elif c == "}":
                    d -= 1
        self.deltas = []
        for idx, line in enumerate(lines):
            if line.lstrip().startswith("//"):
                self.deltas.append(0)
            else:
                code = code_only(line)
                self.deltas.append(code.count("{") - code.count("}"))


def gated(content):
    text = content.replace("\\", "\\\\").replace('"', '\\"')
    return '#[cfg_attr(not(target_family = "wasm"), doc = "%s")]' % text


def sig_index(model, i):
    """From line i (a doc or attribute line), walk past attributes/gated docs/blanks
    and return the index of the item signature line."""
    lines = model.lines
    j = i
    while j < len(lines):
        s = lines[j].strip()
        if ATTR.match(lines[j]) or not s or s.startswith("//"):
            j += 1
            continue
        return j
    return j


def span_end(model, k):
    """End line index (inclusive) of the item whose signature starts at line k."""
    lines = model.lines
    base = model.depth[k]
    bal = 0
    j = k
    while j < len(lines):
        code = "" if lines[j].lstrip().startswith("//") else code_only(lines[j])
        bal += code.count("{") - code.count("}")
        if j > k or "{" in code:
            if bal <= 0 and ("{" in "".join(code_only(x) for x in lines[k : j + 1])):
                return j
        if ";" in code and "{" not in "".join(code_only(x) for x in lines[k : j + 1]):
            return j
        j += 1
    return j


def collect(model):
    """Return list of doc groups to gate; each group is [(line, indent, content)]."""
    lines = model.lines
    iface_sig = set()
    iface_end = {}
    impl_zones = []
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith(IMPL_ATTR):
            k = sig_index(model, i)
            if k < len(lines):
                impl_zones.append((k + 1, span_end(model, k), model.depth[k] + 1))
            continue
        if s.startswith(IFACE_ATTR):
            k = sig_index(model, i)
            if k >= len(lines):
                continue
            iface_sig.add(k)
            iface_end[k] = max(iface_end.get(k, k), span_end(model, k))

    def in_iface_body(idx):
        for k in iface_sig:
            if k < idx <= iface_end[k]:
                return True
        return False

    def in_impl_member(idx):
        for start, end, body in impl_zones:
            if start <= idx <= end and model.depth[idx] == body:
                return True
        return False

    groups = []
    used = set()
    i = 0
    while i < len(lines):
        if i in used:
            i += 1
            continue
        dm = DOC.match(lines[i])
        if not dm:
            i += 1
            continue
        grp = []
        j = i
        while j < len(lines):
            dm = DOC.match(lines[j])
            if not dm:
                break
            grp.append((j, dm.group(1), dm.group(2)))
            j += 1
        used.update(idx for idx, _, _ in grp)
        sig = sig_index(model, j)
        gate = False
        run = [lines[x].strip() for x in range(j, min(sig + 1, len(lines)))]
        if any(any(r.startswith(a) for a in IFACE_ATTR) for r in run):
            gate = True
        elif in_iface_body(i) or in_iface_body(sig):
            gate = True
        elif in_impl_member(i) and sig < len(lines) and PUB_FN.match(lines[sig]):
            gate = True
        if gate:
            groups.append(grp)
        i = j
    return groups


def convert(path, apply):
    with open(path, encoding="utf-8", newline="") as fh:
        raw = fh.read()
    newline = "\r\n" if "\r\n" in raw else "\n"
    lines = raw.split(newline)
    model = Model(lines)
    groups = [g for g in collect(model) if any(DOC.match(lines[i]) for i, _, _ in g)]
    report = []
    for grp in groups:
        sig = sig_index(model, grp[-1][0] + 1)
        head = lines[sig].strip()[:70] if sig < len(lines) else "<eof>"
        report.append((grp[0][0] + 1, len(grp), head))
    if not groups:
        return []
    if apply:
        mark = {}
        for grp in groups:
            for idx, indent, content in grp:
                mark[idx] = f"{indent}{gated(content)}"
        out = [mark.get(idx, line) for idx, line in enumerate(lines)]
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(newline.join(out))
    return report


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    apply = "--apply" in sys.argv
    verbose = "--verbose" in sys.argv
    if not args:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        args = sorted(glob.glob(os.path.join(root, "contracts", "*", "src", "*.rs")))
    total = 0
    for path in args:
        if TEST_FILE.search(path.replace("\\", "/")):
            continue
        report = convert(path, apply)
        if report:
            print(f"{os.path.basename(path)}: {len(report)} doc groups {'gated' if apply else 'to gate'}")
            if verbose:
                for ln, n, head in report:
                    print(f"    L{ln} ({n} lines) -> {head}")
        total += len(report)
    print(f"total: {total} doc groups{' (applied)' if apply else ' (dry run)'}")
    if "--check" in sys.argv and total:
        print("Interface items still carry doc strings that ship in contractspecv0"
              " — run with --apply (issue #58, Technique 1).", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
