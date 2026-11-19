#!/usr/bin/env python3
"""
Workflow / CI-integrity gate.

Why this script exists
----------------------
Three separate contributor PRs in October 2026 broke CI in a way no gate could
see, and all three are the same underlying shape: a GitHub Actions file that
GitHub's own parser rejects, or a CI step that quietly stopped existing.

  * #241 re-pinned actions by *inserting* a new `uses:` line above the old one
    instead of replacing it. That is a duplicate mapping key. PyYAML keeps the
    last key and reports no error, so the file looks fine locally; GitHub's
    workflow parser rejects it outright, and Actions answers by creating a run
    *named* `.github/workflows/ci.yml` with zero jobs. Nothing in the repo could
    tell you that, because a file that never parsed cannot report anything.
  * #182 rewrote `mutation.yml` so a flush-left JavaScript template literal
    inside `run: |` ended the block scalar mid-script. YAML then tried to read
    `**Kill Rate:**` as a document node and the whole file failed to parse. That
    workflow only triggers on `schedule:` / `workflow_dispatch:`, so no PR check
    ever went red -- the failure landed on `main` after the merge, silently.
  * #416 deleted twelve named CI steps from `ci.yml` (error-code registry, Wasm
    size budget, duplicate-JSON-key check, LF check, unit tests, the vitest
    ownership suite, vector drift, the Wasm artifact upload and every failure
    explainer) -- 14 insertions against 162 deletions. A deleted step cannot
    fail, so the PR stayed green.

This gate catches all three classes, plus the encoding concealment from #400:
a file stored as UTF-16 prints as "Binary files differ" in `git diff`, so a
reviewer never sees the change at all.

What it checks
--------------
  parse      every workflow under .github/workflows loads as YAML
  triggers   each workflow declares an `on:` section (note: YAML 1.1 reads the
             bare word `on` as boolean True, so both spellings are tested)
  dupkeys    no mapping key is defined twice in the same mapping (nested too)
  steps      every step is a mapping with exactly one of run:/uses:, `with:`
             only accompanies `uses:`, and no action is referenced by the
             moving branches @main / @master
  gates      every named step that existed in --base still exists in the same
             job here, plus everything listed in the must_have inventory of
             .github/ci-gates.json. Retiring a gate is allowed, but only by
             recording it under "retired" with a reason, in the open.
  encoding   no tracked text file is committed as UTF-16, with a UTF-8 BOM, or
             containing a NUL byte

Usage
-----
  python3 scripts/check_ci_integrity.py [--root DIR] [--base REF]
                                        [--checks a,b,c] [--self-test]

With --base (a merge base on a pull_request run) the gate comparison is against
that commit, so a branch that is merely *old* is not accused of deleting gates
it never had, and the encoding scan is limited to files the PR actually touched.
Without --base the inventory in .github/ci-gates.json alone is enforced, which is
what a push to main needs.

Exit status: 0 clean, 1 findings, 2 the checker itself could not run.
"""

import argparse
import collections.abc
import json
import os
import subprocess
import sys
import tempfile

try:
    import yaml
except ImportError:  # pragma: no cover - environment problem, not a finding
    sys.stderr.write(
        "FATAL: PyYAML is required (pip install pyyaml). Refusing to report a "
        "clean run when the parser itself is missing.\n"
    )
    sys.exit(2)

TEXT_EXTENSIONS = (
    ".yml", ".yaml", ".md", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json",
    ".rs", ".toml", ".sh", ".py", ".sql", ".html", ".css", ".txt", ".snap",
    ".example", ".ps1",
)
# A UTF-8 BOM is only tolerated where the toolchain requires it: PowerShell 5.1
# mis-parses non-ASCII characters in a .ps1 file unless the file starts with one.
BOM_TOLERATED_EXTENSIONS = (".ps1",)
SKIP_DIRS = {".git", "node_modules", "target", ".next", "dist", "build",
             "coverage", ".venv", "venv", "__pycache__", ".cargo"}
WORKFLOW_DIR = ".github/workflows"
GATES_FILE = ".github/ci-gates.json"
ALL_CHECKS = ("parse", "triggers", "dupkeys", "steps", "gates", "encoding")


class DupKeyLoader(yaml.SafeLoader):
    """SafeLoader that records duplicate mapping keys instead of dropping them."""


def _construct_mapping(loader, node, deep=False):
    seen = {}
    mapping = {}
    loader.flatten_mapping(node)
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        value = loader.construct_object(value_node, deep=deep)
        if not isinstance(key, collections.abc.Hashable):
            key = repr(key)
        if key in seen:
            loader.duplicates.append((key, key_node.start_mark.line + 1, seen[key]))
        seen[key] = key_node.start_mark.line + 1
        mapping[key] = value
    return mapping


DupKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping
)


def parse_yaml(text):
    """Return (documents, parse_error_or_None, [(key, line, first_line)])."""
    loader = DupKeyLoader(text)
    loader.duplicates = []
    docs = []
    try:
        while loader.check_data():
            docs.append(loader.get_data())
    except yaml.YAMLError as exc:
        lines = [ln for ln in str(exc).splitlines() if ln.strip()]
        return docs, " ".join(lines[:2])[:220], list(loader.duplicates)
    return docs, None, list(loader.duplicates)


def read_work_tree(root, rel):
    path = os.path.join(root, rel.replace("/", os.sep))
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as handle:
        return handle.read().decode("utf-8", errors="replace")


def read_ref(root, ref, rel):
    """Blob from another commit, or None when the path does not exist there."""
    proc = subprocess.run(["git", "show", f"{ref}:{rel}"], cwd=root,
                          capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    return proc.stdout if proc.returncode == 0 else None


def read_any(root, ref, rel):
    return read_ref(root, ref, rel) if ref else read_work_tree(root, rel)


def list_workflows(root, ref=None):
    if ref:
        proc = subprocess.run(["git", "ls-tree", "-r", "--name-only", ref],
                              cwd=root, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            return None
        return [p for p in proc.stdout.split("\n")
                if p.startswith(WORKFLOW_DIR + "/") and p.endswith((".yml", ".yaml"))]
    wf_dir = os.path.join(root, WORKFLOW_DIR.replace("/", os.sep))
    if not os.path.isdir(wf_dir):
        return []
    return [f"{WORKFLOW_DIR}/{name}" for name in sorted(os.listdir(wf_dir))
            if name.endswith((".yml", ".yaml"))]


def named_steps_per_job(text):
    """{job_id: [step name, ...]} in file order, from a workflow's YAML."""
    docs, parse_error, _ = parse_yaml(text)
    jobs = {}
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        for job_id, job in (doc.get("jobs") or {}).items():
            if not isinstance(job, dict):
                continue
            names = jobs.setdefault(job_id, [])
            for step in job.get("steps") or []:
                if isinstance(step, dict) and isinstance(step.get("name"), str):
                    names.append(step["name"].strip())
    return jobs, parse_error


# ---------------------------------------------------------------------------
# workflow structure
# ---------------------------------------------------------------------------

def check_workflows(root, ref=None):
    """Run parse / triggers / dupkeys / steps over every workflow."""
    problems = []
    files = list_workflows(root, ref)
    if files is None:
        return [("parse", WORKFLOW_DIR, 0,
                 f"could not list workflows at ref {ref} (is it a fetched commit?)")], False
    for rel in files:
        text = read_any(root, ref, rel)
        if text is None:
            problems.append(("parse", rel, 0, "workflow is listed but could not be read"))
            continue
        docs, parse_error, duplicates = parse_yaml(text)

        if parse_error:
            problems.append(("parse", rel, 0,
                             f"YAML PARSE ERROR: {parse_error}. GitHub's workflow parser rejects the "
                             "whole file, so Actions creates a run named after the workflow with 0 jobs "
                             "and no step can report anything."))
            # Nothing else is knowable about a file that will not load.
            continue

        for key, line, first in duplicates:
            problems.append((
                "dupkeys", rel, line,
                f"duplicate mapping key '{key}:' (line {line}, first defined at line {first}). PyYAML "
                "keeps the last one and stays quiet; GitHub's workflow parser rejects the whole file, "
                "which shows up as a run named after the workflow with 0 jobs. Replace the value, do "
                "not insert a second line.",
            ))

        for doc in docs:
            if not isinstance(doc, dict):
                continue
            if "on" not in doc and True not in doc:
                problems.append(("triggers", rel, 0,
                                 "workflow has no 'on:' trigger section, so it can never run"))
            jobs = doc.get("jobs")
            if jobs is None:
                continue
            if not isinstance(jobs, dict):
                problems.append(("steps", rel, 0, "jobs: is not a mapping"))
                continue
            for job_id, job in jobs.items():
                if not isinstance(job, dict):
                    continue
                needs = job.get("needs")
                if isinstance(needs, str):
                    needs = [needs]
                if isinstance(needs, list):
                    for dep in needs:
                        if isinstance(dep, str) and dep not in jobs:
                            problems.append(("steps", rel, 0,
                                             f"job {job_id}: needs '{dep}', which is not a job in this workflow"))
                steps = job.get("steps")
                if steps is None:
                    continue
                if not isinstance(steps, list):
                    problems.append(("steps", rel, 0, f"job {job_id}: steps is not a list"))
                    continue
                # GitHub resolves a local `uses: ./path` against the runner
                # workspace, and a `with: path:` checkout moves the repository
                # into a subdirectory of it. #131 checks the repo out twice
                # (`head-repo`, `base-repo`) and calls `./head-repo/.github/
                # actions/wasm-diff`, and that step passes in CI, so the
                # destinations have to be stripped before the path is judged
                # unresolvable. Measured behaviour, not a guess: reporting it
                # would fail a workflow that works.
                checkout_dirs = []
                for step in steps:
                    if not isinstance(step, dict) or not str(step.get("uses", "")).startswith("actions/checkout"):
                        continue
                    with_block = step.get("with")
                    dest = ""
                    if isinstance(with_block, dict):
                        dest = str(with_block.get("path") or "").strip().strip("/")
                    if dest and dest != ".":
                        checkout_dirs.append(dest)
                for index, step in enumerate(steps, 1):
                    where = f"job {job_id} step {index}"
                    if not isinstance(step, dict):
                        problems.append(("steps", rel, 0, f"{where}: is not a mapping"))
                        continue
                    label = step.get("name") or step.get("id") or step.get("uses") or "(unnamed)"
                    has_uses, has_run = "uses" in step, "run" in step
                    if has_uses and has_run:
                        problems.append((
                            "steps", rel, 0,
                            f"{where} ({label}): has BOTH run: and uses:. A step is either a shell step "
                            f"or an action step, and GitHub rejects the file. uses: was {step['uses']!r}; "
                            "split it into two steps.",
                        ))
                    if not has_uses and not has_run:
                        problems.append(("steps", rel, 0,
                                         f"{where} ({label}): has neither run: nor uses: (keys={sorted(step)})"))
                    if "with" in step and not has_uses:
                        problems.append(("steps", rel, 0,
                                         f"{where} ({label}): has with: but no uses: to pass it to"))
                    if has_uses:
                        ref_text = str(step["uses"])
                        if ref_text.startswith("./"):
                            # A local action needs no ref, but the path has to
                            # resolve to an action file or the job dies at
                            # "Unable to resolve action" with nothing to show.
                            target = ref_text[2:].rstrip("/")
                            candidates = [target]
                            for dest in checkout_dirs:
                                if target == dest:
                                    candidates.append("")
                                elif target.startswith(dest + "/"):
                                    candidates.append(target[len(dest) + 1:])
                            options = []
                            for cand in candidates:
                                if cand:
                                    options += [f"{cand}/action.yml", f"{cand}/action.yaml", f"{cand}.yml"]
                                else:
                                    options += ["action.yml", "action.yaml"]
                            if not any(read_work_tree(root, opt) is not None for opt in options):
                                problems.append((
                                    "steps", rel, 0,
                                    f"{where} ({label}): uses: '{ref_text}' does not resolve - none of "
                                    f"{', '.join(sorted(set(options)))} exists in the repository (a local "
                                    "action path is relative to the repository root, or to the directory "
                                    "a `with: path:` checkout placed it in).",
                                ))
                        elif "@" not in ref_text:
                            problems.append(("steps", rel, 0,
                                             f"{where} ({label}): uses: '{ref_text}' has no version ref"))
                        elif ref_text.rsplit("@", 1)[1] in ("main", "master"):
                            problems.append(("steps", rel, 0,
                                             f"{where} ({label}): '{ref_text}' points at a moving branch; "
                                             "pin a release tag (or the commit SHA of that release) so the "
                                             "step cannot change underneath the review that approved it."))
    return problems, True


# ---------------------------------------------------------------------------
# required gates
# ---------------------------------------------------------------------------

def load_inventory(root, ref=None):
    text = read_any(root, ref, GATES_FILE)
    if text is None:
        return {}
    try:
        return json.loads(text)
    except ValueError as exc:
        return {"_error": f"inventory is not valid JSON: {exc}"}


def gate_problems(root, base=None):
    """Named steps that existed at --base, plus the must_have inventory."""
    problems = []
    inventory_here = load_inventory(root)
    inventory_base = load_inventory(root, base) if base else inventory_here
    for label, inv in (("here", inventory_here), ("base", inventory_base)):
        if "_error" in inv:
            problems.append(("gates", GATES_FILE, 0, f"ci-gates.json ({label}): {inv['_error']}"))
    if any(p[1] == GATES_FILE for p in problems):
        return problems

    retired = {}
    for inv in (inventory_base, inventory_here):
        for workflow, jobs in (inv.get("retired") or {}).items():
            key = os.path.basename(workflow)
            for job_id, reasons in (jobs or {}).items():
                for name, reason in (reasons or {}).items():
                    retired.setdefault(key, {}).setdefault(job_id, set()).add(name)
                    if not str(reason).strip():
                        problems.append(("gates", GATES_FILE, 0,
                                         f"retired entry '{key}' / '{job_id}' / '{name}' has no reason. "
                                         "Retiring a gate is allowed; doing it silently is not."))

    steps_cache = {}

    def steps_here(workflow):
        """( {job: [names]}, parse_error ) for the checked-out copy of a workflow."""
        rel = workflow if "/" in workflow else f"{WORKFLOW_DIR}/{workflow}"
        if rel not in steps_cache:
            text = read_work_tree(root, rel)
            steps_cache[rel] = (None, None) if text is None else named_steps_per_job(text)
        return steps_cache[rel]

    # 1. must_have: the curated floor. The inventory itself is read from --base,
    #    so a pull request cannot lower it; the steps are verified here.
    for workflow, jobs in (inventory_base.get("must_have") or {}).items():
        present, parse_error = steps_here(workflow)
        if present is None:
            problems.append(("gates", workflow, 0,
                             "required workflow is missing: .github/workflows/"
                             f"{os.path.basename(workflow)}"))
            continue
        if parse_error:
            problems.append(("gates", workflow, 0,
                             f"cannot verify the required steps, the workflow does not parse: {parse_error}"))
            continue
        allowed = retired.get(os.path.basename(workflow), {})
        for job_id, names in (jobs or {}).items():
            for name in names:
                if name in allowed.get(job_id, set()):
                    continue
                if job_id not in present:
                    problems.append(("gates", workflow, 0,
                                     f"job '{job_id}' is gone, so its required step '{name}' cannot run"))
                elif name.strip() not in present[job_id]:
                    problems.append((
                        "gates", workflow, 0,
                        f"job '{job_id}' no longer runs the required step '{name}'. A removed gate cannot "
                        "fail, so the PR that removed it stays green. Restore the step, or retire it in "
                        f"{GATES_FILE} under \"retired\" with a reason.",
                    ))

    # 2. merge-base diff: no named step may disappear without being retired.
    if base:
        base_files = list_workflows(root, base) or []
        head_files = set(list_workflows(root) or [])
        for rel in base_files:
            if rel not in head_files:
                problems.append(("gates", rel, 0,
                                 "workflow existed at the merge base and is gone from this branch"))
                continue
            base_text = read_ref(root, base, rel)
            head_text = read_work_tree(root, rel)
            if base_text is None or head_text is None:
                continue
            base_jobs, base_err = named_steps_per_job(base_text)
            head_jobs, head_err = named_steps_per_job(head_text)
            if base_err or head_err:
                continue  # already reported by the parse check
            workflow = rel.split("/")[-1]
            for job_id, names in base_jobs.items():
                allowed = retired.get(workflow, {}).get(job_id, set())
                # Only compare against the merge base, so steps main added after
                # this branch forked are never blamed on the branch.
                for name in names:
                    if name in allowed:
                        continue
                    if job_id not in head_jobs:
                        problems.append(("gates", rel, 0,
                                         f"job '{job_id}' existed at the merge base and is gone"))
                    elif name not in head_jobs[job_id]:
                        problems.append((
                            "gates", rel, 0,
                            f"job '{job_id}' dropped the step '{name}' that existed at the merge base. "
                            f"Deleted gates do not fail -- they disappear. Restore it, or retire it in "
                            f"{GATES_FILE} with a reason.",
                        ))
    return problems


# ---------------------------------------------------------------------------
# text / encoding
# ---------------------------------------------------------------------------

def tracked_text_files(root, base=None):
    """Tracked text files, optionally limited to those the PR changed."""
    names = None
    if base:
        proc = subprocess.run(["git", "diff", "--name-only", f"{base}...HEAD"], cwd=root,
                              capture_output=True, text=True, encoding="utf-8", errors="replace")
        if proc.returncode == 0:
            names = proc.stdout.split("\n")
    if names is None:
        proc = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True,
                              text=True, encoding="utf-8", errors="replace")
        names = proc.stdout.split("\0") if proc.returncode == 0 and proc.stdout.strip() else None
    if names is None:  # not a git checkout: walk instead
        names = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            names.extend(os.path.relpath(os.path.join(dirpath, n), root).replace(os.sep, "/")
                         for n in filenames)
    out = []
    for rel in names:
        if not rel or not rel.lower().endswith(TEXT_EXTENSIONS):
            continue
        path = os.path.join(root, rel.replace("/", os.sep))
        if os.path.isfile(path):
            out.append((rel, path))
    return out


def check_encodings(root, base=None):
    problems = []
    for rel, path in tracked_text_files(root, base):
        try:
            with open(path, "rb") as handle:
                head = handle.read(8192)
        except OSError as exc:
            problems.append(("encoding", rel, 0, f"could not read: {exc}"))
            continue
        if head[:2] in (b"\xff\xfe", b"\xfe\xff"):
            problems.append((
                "encoding", rel, 0,
                "is stored as UTF-16. git then treats it as a binary blob: `git diff` prints \"Binary "
                "files differ\", the change is unreviewable, and a CI file can be gutted without "
                "showing up in the diff. Re-save as UTF-8 without a BOM.",
            ))
        elif b"\x00" in head:
            problems.append(("encoding", rel, 0,
                             "contains a NUL byte, so git and every text tool treat it as binary"))
        elif head[:3] == b"\xef\xbb\xbf" and not rel.lower().endswith(BOM_TOLERATED_EXTENSIONS):
            problems.append((
                "encoding", rel, 0,
                "starts with a UTF-8 BOM. Tools that read the file as UTF-8 see \\ufeff before the first "
                "token, so a shebang or a YAML document marker stops matching. Save without a BOM "
                "(.ps1 is exempt because PowerShell needs it).",
            ))
    return problems


# ---------------------------------------------------------------------------
# self-test: prove each detector can fail, so a broken checker is never green
# ---------------------------------------------------------------------------

VALID_WORKFLOW = (
    "clean-ok.yml",
    "name: ok\n'on': push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n"
    "      - name: do it\n        uses: actions/checkout@v7\n"
    "      - name: local\n        uses: ./.github/actions/exists\n"
    "      - name: say it\n        run: echo ok\n",
)

# The #131 shape: the repository is checked out into a subdirectory and the
# job's own action is addressed through it. That workflow runs green, so the
# checker has to accept it.
VALID_SUBDIR_WORKFLOW = (
    "clean-subdir.yml",
    "name: ok2\n'on': push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n"
    "      - name: checkout into head-repo\n        uses: actions/checkout@v7\n"
    "        with:\n          path: head-repo\n"
    "      - name: local through the checkout dir\n        uses: ./head-repo/.github/actions/exists\n",
)

FIXTURES = {
    # A flush-left JS template literal inside `run: |` ends the block scalar,
    # exactly the shape that made #182's mutation.yml unparseable.
    "parse": (
        "broken.yml",
        "name: x\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n"
        "      - name: comment\n        run: |\n          node -e \"`\n"
        "**Kill Rate:** 90%\n`\n\"\n      - name: after\n        run: echo x\n",
    ),
    # #241's shape: a pinned line inserted above the tag line, so one step
    # mapping carries `uses:` twice.
    "dupkeys": (
        "dup.yml",
        "name: x\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n"
        "      - name: checkout\n        uses: actions/checkout@v7\n        uses: actions/checkout@v4\n"
        "        with:\n          fetch-depth: 0\n",
    ),
    "steps": (
        "shape.yml",
        "name: x\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n"
        "      - name: both\n        uses: EmbarkStudios/cargo-deny-action@v2\n        run: node scripts/x.mjs\n"
        "      - name: bare\n        with:\n          foo: bar\n"
        "      - name: branch\n        uses: some/action@main\n"
        "      - name: lost\n        uses: ./does-not-exist\n"
        "  b:\n    runs-on: ubuntu-latest\n    needs: nonexistent\n    steps:\n      - run: echo x\n"
        # Prefix stripping must not make the detector blind: the checkout dir is
        # real, the action inside it is not.
        "  c:\n    runs-on: ubuntu-latest\n    steps:\n"
        "      - name: checkout into head-repo\n        uses: actions/checkout@v7\n"
        "        with:\n          path: head-repo\n"
        "      - name: lost under the checkout dir\n        uses: ./head-repo/.github/actions/nope\n",
    ),
    "triggers": (
        "notriggers.yml",
        "name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    ),
}

GATE_BASE = (
    "gate-ci.yml",
    "name: x\n'on': push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n"
    "      - name: Kept step\n        run: echo x\n"
    "      - name: Removed step\n        run: echo y\n"
    "      - name: Retired step\n        run: echo z\n",
)
GATE_HEAD = (
    "gate-ci.yml",
    "name: x\n'on': push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n"
    "      - name: Kept step\n        run: echo x\n"
    "      - name: Added step\n        run: echo new\n",
)


def self_test():
    failures = []
    with tempfile.TemporaryDirectory() as tmp:
        wf = os.path.join(tmp, WORKFLOW_DIR.replace("/", os.sep))
        os.makedirs(wf)

        def write(name, body):
            with open(os.path.join(wf, name), "w", encoding="utf-8", newline="") as handle:
                handle.write(body)

        write(VALID_WORKFLOW[0], VALID_WORKFLOW[1])
        write(VALID_SUBDIR_WORKFLOW[0], VALID_SUBDIR_WORKFLOW[1])
        for name, body in FIXTURES.values():
            write(name, body)
        # The valid fixture references a local action, so it has to resolve.
        local = os.path.join(tmp, ".github", "actions", "exists")
        os.makedirs(local)
        with open(os.path.join(local, "action.yml"), "w", encoding="utf-8", newline="") as handle:
            handle.write("name: exists\ndescription: fixture\nruns:\n  using: composite\n  steps: []\n")

        problems, ok = check_workflows(tmp)
        if not ok:
            failures.append("work-tree workflow listing returned nothing")
        kinds = {kind for kind, _, _, _ in problems}
        for rule in FIXTURES:
            if rule not in kinds:
                failures.append(f"{rule} detector reported nothing on its own fixture")
        messages = " || ".join(message for _, _, _, message in problems)
        if "does not resolve" not in messages:
            failures.append("steps detector did not report a local action path that does not resolve")
        if "head-repo/.github/actions/nope" not in messages:
            failures.append("steps detector stopped reporting a local action that is missing under a "
                            "`with: path:` checkout directory")
        # A detector that fires on everything would keep CI permanently red, so
        # a valid workflow has to come back clean.
        for kind, rel, _, message in problems:
            if rel.endswith(VALID_WORKFLOW[0]) or rel.endswith(VALID_SUBDIR_WORKFLOW[0]):
                failures.append(f"false positive on the valid fixture {rel}: [{kind}] {message}")

        # gates: a step present at the base and absent here must be reported, a
        # step that is still present must not be, and a documented retirement is
        # allowed. Needs a real commit, so build a throwaway repo.
        repo = os.path.join(tmp, "repo")
        os.makedirs(repo)
        run = lambda *a: subprocess.run(a, cwd=repo, capture_output=True, text=True,
                                        encoding="utf-8", errors="replace")
        run("git", "init", "-q")
        run("git", "config", "user.email", "self-test@example.invalid")
        run("git", "config", "user.name", "self-test")
        os.makedirs(os.path.join(repo, WORKFLOW_DIR.replace("/", os.sep)))
        gates = {"version": 1,
                 "must_have": {"gate-ci.yml": {"a": ["Kept step", "Removed step"]}},
                 "retired": {"gate-ci.yml": {"a": {"Retired step": "self-test fixture"}}}}
        for rel, body in ((GATES_FILE, json.dumps(gates)),
                          (f"{WORKFLOW_DIR}/{GATE_BASE[0]}", GATE_BASE[1])):
            path = os.path.join(repo, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="") as handle:
                handle.write(body)
        run("git", "add", "-A")
        run("git", "commit", "-qm", "base")
        with open(os.path.join(repo, WORKFLOW_DIR.replace("/", os.sep), GATE_HEAD[0]),
                  "w", encoding="utf-8", newline="") as handle:
            handle.write(GATE_HEAD[1])
        run("git", "add", "-A")
        run("git", "commit", "-qm", "head")
        base = run("git", "rev-parse", "HEAD~1").stdout.strip()
        if not base:
            failures.append("self-test could not build a base commit for the gates check")
        else:
            found = [message for _, _, _, message in gate_problems(repo, base)]
            must_have = [m for m in found if "required step 'Removed step'" in m]
            if not must_have:
                failures.append("gates detector did not report a removed must_have step")
            if not [m for m in found if "merge base" in m and "Removed step" in m]:
                failures.append("gates detector did not report a step removed versus the merge base")
            if [m for m in found if "Kept step" in m]:
                failures.append("gates detector reported a step that is still present")
            if [m for m in found if "Added step" in m]:
                failures.append("gates detector complained about a step the PR added")
            if [m for m in found if "Retired step" in m]:
                failures.append("gates detector reported a step that ci-gates.json retires on purpose")

        # encoding: UTF-16 and a UTF-8 BOM must both be reported.
        with open(os.path.join(repo, "notes.md"), "wb") as handle:
            handle.write("# StreamPay\nsecond line\n".encode("utf-16"))
        with open(os.path.join(repo, "bom.rs"), "wb") as handle:
            handle.write(b"\xef\xbb\xbffn main() {}\n")
        run("git", "add", "-A")
        run("git", "commit", "-qm", "encoding")
        enc = [message for _, _, _, message in check_encodings(repo)]
        if not [m for m in enc if "UTF-16" in m]:
            failures.append("encoding detector reported nothing on a UTF-16 file")
        if not [m for m in enc if "BOM" in m]:
            failures.append("encoding detector reported nothing on a UTF-8 BOM file")

    if failures:
        for message in failures:
            print(f"SELF-TEST FAIL: {message}")
        return 1
    print(f"self-test: {len(FIXTURES) + 2} detectors each fired on their own fixture and stayed "
          "quiet on a valid one; retired/added steps are handled. The checker is capable of failing.")
    return 0


# ---------------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Fail loudly on workflows GitHub's parser would reject, on CI gates that "
                    "quietly disappeared, and on text files committed as binary-looking UTF-16.")
    parser.add_argument("--root", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        help="repository root (default: the repo containing this script)")
    parser.add_argument("--base", default=None,
                        help="commit to compare against on a PR run (usually the merge base with main)")
    parser.add_argument("--checks", default=",".join(ALL_CHECKS),
                        help="comma-separated subset of " + ",".join(ALL_CHECKS))
    parser.add_argument("--self-test", action="store_true",
                        help="run each detector against a deliberately broken fixture")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    rules = [r.strip() for r in args.checks.split(",") if r.strip()]
    unknown = [r for r in rules if r not in ALL_CHECKS]
    if unknown:
        print(f"FATAL: unknown check(s): {', '.join(unknown)}; valid: {', '.join(ALL_CHECKS)}")
        return 2

    root = os.path.abspath(args.root)
    base = None
    if args.base:
        probe = subprocess.run(["git", "rev-parse", "--verify", f"{args.base}^{{commit}}"],
                               cwd=root, capture_output=True, text=True,
                               encoding="utf-8", errors="replace")
        if probe.returncode != 0:
            print(f"FATAL: --base {args.base} is not a commit here. Refusing to run the gate "
                  "comparison silently; fetch the base branch first.")
            return 2
        base = probe.stdout.strip()

    problems = []
    workflow_rules = [r for r in rules if r in ("parse", "triggers", "dupkeys", "steps")]
    if workflow_rules:
        found, _ = check_workflows(root)
        problems += [p for p in found if p[0] in workflow_rules]
    if "gates" in rules:
        problems += gate_problems(root, base)
    if "encoding" in rules:
        problems += check_encodings(root, base)

    counts = {rule: sum(1 for p in problems if p[0] == rule) for rule in rules}
    summary = ", ".join(f"{rule}={counts[rule]}" for rule in rules)
    in_gh = os.environ.get("GITHUB_ACTIONS") == "true"

    for rule, rel, line, message in problems:
        location = f"{rel}:{line}: " if line else f"{rel}: "
        print(f"{location}[{rule}] {message}")
        if in_gh:
            where = f" file={rel},line={line}" if line else f" file={rel}"
            print(f"::error{where}::{rule}: {message}")

    if problems:
        print(f"\nCI integrity: {len(problems)} problem(s) ({summary})"
              + (f" compared against {base[:8]}" if base else ""))
        print("Fix the file itself. If a CI gate was deliberately retired, record it in "
              ".github/ci-gates.json under \"retired\" with a reason in the same PR -- that keeps "
              "the deletion in the diff where a reviewer can see it.")
        return 1

    workflow_count = len(list_workflows(root) or [])
    text_count = len(tracked_text_files(root, base))
    print(f"CI integrity: 0 problems across {workflow_count} workflow(s) and {text_count} "
          f"tracked text file(s) ({summary})" + (f", compared against {base[:8]}" if base else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
