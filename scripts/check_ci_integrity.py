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
             recording it under "retired" with a reason, in the open. A job
             that is *re-homed* - folded into another job because the check
             surface is being consolidated, not because the gate is unwanted -
             is recorded under "moved" with its destination and a reason, which
             is checked the same way: every named step it had must be running in
             the destination job here.
  encoding   no tracked text file is committed as UTF-16, with a UTF-8 BOM, or
             containing any C0 control byte (0x00-0x1F) other than tab and LF,
             or a CR that is not part of a CRLF pair
  prcap      ci.yml is the only pull-request workflow and contains exactly the
             six inventoried jobs, with no matrix, reusable-workflow call, or
             write permission
  prmoves    every specialist step folded into ci.yml still has one prefixed
             copy with the same payload, environment, working directory and
             original condition, plus the recorded path guard

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
import ast
import collections.abc
import copy
import json
import os
import re
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
# C0 control bytes (0x00-0x1F) corrupt YAML parsers, shell scripts and diff
# review just as effectively as the NUL byte the gate already rejected, so the
# encoding check rejects all of them. Tab (0x09) and LF (0x0A) are legitimate
# text. CR (0x0D) is legitimate only as the first half of a CRLF pair -- and
# even then only where the line-ending gate permits it:
# scripts/check_line_endings.sh rejects every CRLF file committed to this
# repo, so a CR that passes here is still caught there. This gate refuses to
# bless a lone CR, which no line-ending convention produces, and otherwise
# leaves CRLF to that gate so the two never contradict each other.
C0_NAMES = (
    "NUL", "SOH", "STX", "ETX", "EOT", "ENQ", "ACK", "BEL",
    "BS", "TAB", "LF", "VT", "FF", "CR", "SO", "SI",
    "DLE", "DC1", "DC2", "DC3", "DC4", "NAK", "SYN", "ETB",
    "CAN", "EM", "SUB", "ESC", "FS", "GS", "RS", "US",
)
SKIP_DIRS = {".git", "node_modules", "target", ".next", "dist", "build",
             "coverage", ".venv", "venv", "__pycache__", ".cargo"}
WORKFLOW_DIR = ".github/workflows"
GATES_FILE = ".github/ci-gates.json"
ALL_CHECKS = ("parse", "triggers", "dupkeys", "steps", "paths", "gates", "encoding",
              "prcap", "prmoves")
PR_TRIGGERS = {"pull_request", "pull_request_target", "pull_request_review",
               "pull_request_review_comment"}


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
                    if "working-directory" in step and has_uses and not has_run:
                        # Measured, not inferred. Probe run 45373317235 (a step
                        # with uses:, no run:, and working-directory:) gives a
                        # run named after the file path with 0 jobs and no logs -
                        # GitHub refuses to load the workflow. Its control, probe
                        # run 45373319494 (the same directory set with job-level
                        # `defaults: run: working-directory:`), loads and runs.
                        # So the job-level form is fine and the step-level form
                        # is not. PyYAML accepts both, so nothing else here
                        # notices. A workflow that silently produces no checks is
                        # worse than one that fails loudly: every gate reads green
                        # because no gate ran.
                        problems.append((
                            "steps", rel, 0,
                            f"{where} ({label}): has working-directory: on a step with uses: and no run:. "
                            "GitHub refuses to load the whole workflow file, so the run gets 0 jobs and the "
                            "pull request shows no checks at all. `working-directory` belongs to run: steps; "
                            "pass the destination to the action instead (actions/checkout uses `with: "
                            "path:`) or set it job-wide with `defaults: run: working-directory:`.",
                        ))
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

def tracked_paths(root, ref=None):
    """Every tracked path in the checkout, no extension filter."""
    names = None
    if ref:
        proc = subprocess.run(["git", "ls-tree", "-r", "--name-only", ref], cwd=root,
                              capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        if proc.returncode == 0:
            names = proc.stdout.splitlines()
    if names is None:
        proc = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True,
                              text=True, encoding="utf-8", errors="replace")
        if proc.returncode == 0 and proc.stdout.strip():
            names = proc.stdout.split("\0")
    if names is None:  # not a git checkout: walk instead
        names = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            names.extend(os.path.relpath(os.path.join(dirpath, n), root).replace(os.sep, "/")
                         for n in filenames)
    return {n for n in names if n}


def filter_prefix(pattern):
    """The glob-free leading path of a paths: pattern, or "" if it has none.

    GitHub's filter grammar here is * (within one path segment), ** , ? and a
    bracket class, so the first occurrence of any of those ends the literal
    part. "" means the pattern is not anchored to a directory that could be
    shown to exist or not exist, so nothing may be concluded from it.
    """
    if pattern.startswith("$"):  # an expression, not a path
        return ""
    head = re.split(r"[*?\[]", pattern.lstrip("!"))[0]
    head = head[2:] if head.startswith("./") else head
    return head.rstrip("/")


def can_match(paths, prefix):
    if not prefix or prefix == ".":
        return True
    if prefix in paths:
        return True
    return any(name.startswith(prefix + "/") for name in paths)


def line_of(text, needle):
    for number, line in enumerate(text.splitlines(), 1):
        if needle in line:
            return number
    return 0


def check_path_filters(root, ref=None):
    """paths: / paths-ignore: entries that no file in the repo can satisfy.

    A dead filter is the quiet twin of the parse rejection: the job does not
    fail, it never runs, and the pull request reads green because the only
    evidence that the gate exists is an absent check. infra.yml carried
    "deploy/**" for a directory that has never existed in this repository's
    history (git log --all -- deploy is empty), so its IaC proof silently
    stopped running on any PR that did not also touch infra/ or digests/.
    """
    problems = []
    files = list_workflows(root, ref)
    if files is None:
        return [("paths", WORKFLOW_DIR, 0,
                 f"could not list workflows at ref {ref}, so no filter could be judged")]
    if not files:
        return problems
    paths = tracked_paths(root, ref)
    for rel in files:
        text = read_any(root, ref, rel)
        if text is None:
            continue
        docs, parse_error, _ = parse_yaml(text)
        if parse_error:
            continue  # the parse rule already covers this file
        for doc in docs:
            if not isinstance(doc, dict):
                continue
            triggers = doc.get("on", doc.get(True))
            if not isinstance(triggers, dict):
                continue
            for event, config in triggers.items():
                if not isinstance(config, dict):
                    continue
                for key in ("paths", "paths-ignore"):
                    patterns = config.get(key)
                    if not isinstance(patterns, list):
                        continue
                    for pattern in patterns:
                        if not isinstance(pattern, str):
                            continue
                        prefix = filter_prefix(pattern)
                        if can_match(paths, prefix):
                            continue
                        problems.append((
                            "paths", rel, line_of(text, pattern),
                            f"{event}.{key} pattern {pattern!r} can never match: nothing named "
                            f"{prefix!r} exists in the repository. A job gated only by this pattern "
                            "does not fail, it silently never runs -- which reads as green. Create the "
                            "path, drop the pattern, or (if the directory was renamed) fix every "
                            "workflow still filtering on the old name.",
                        ))
    return problems


def load_inventory(root, ref=None):
    text = read_any(root, ref, GATES_FILE)
    if text is None:
        return {}
    try:
        return json.loads(text)
    except ValueError as exc:
        return {"_error": f"inventory is not valid JSON: {exc}"}


def inventory_pair(root, base, rule):
    here = load_inventory(root)
    before = load_inventory(root, base) if base else here
    problems = []
    for label, inventory in (("here", here), ("base", before)):
        if "_error" in inventory:
            problems.append((rule, GATES_FILE, 0,
                             f"ci-gates.json ({label}): {inventory['_error']}"))
    return (here, before), problems


def workflow_document(text):
    docs, parse_error, _ = parse_yaml(text)
    if parse_error:
        return None, parse_error
    for doc in docs:
        if isinstance(doc, dict):
            return doc, None
    return None, "workflow contains no YAML mapping"


def workflow_triggers(doc):
    return doc.get("on", doc.get(True))


def active_pr_triggers(doc):
    triggers = workflow_triggers(doc)
    if isinstance(triggers, dict):
        return [name for name in triggers if name in PR_TRIGGERS]
    if isinstance(triggers, list):
        return [name for name in triggers if name in PR_TRIGGERS]
    return []


def permission_problem(permissions, where):
    if permissions is None:
        return f"{where} does not declare permissions; PR jobs must explicitly stay read-only"
    if isinstance(permissions, str):
        return None if permissions == "read-all" else f"{where} grants '{permissions}' permissions"
    if not isinstance(permissions, dict):
        return f"{where} permissions is not a mapping or 'read-all'"
    for name, value in permissions.items():
        if value not in ("read", "none"):
            return f"{where} grants '{name}: {value}'; pull-request jobs must stay read-only"
    return None


def ci_path_flags(root):
    rel = "scripts/ci_changed_paths.py"
    text = read_work_tree(root, rel)
    if text is None:
        raise RuntimeError(f"{rel} is missing")
    try:
        tree = ast.parse(text, filename=rel)
    except SyntaxError as exc:
        raise RuntimeError(f"{rel} does not parse: {exc}") from exc
    values = {}
    for node in tree.body:
        targets = []
        value = None
        if isinstance(node, ast.Assign):
            targets = node.targets
            value = node.value
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
            value = node.value
        for target in targets:
            if isinstance(target, ast.Name) and target.id in ("PATH_GROUPS", "COMMON_PATHS"):
                values[target.id] = ast.literal_eval(value)
    groups = values.get("PATH_GROUPS")
    if not isinstance(groups, dict):
        raise RuntimeError(f"{rel}: PATH_GROUPS is not defined as a mapping")
    common = values.get("COMMON_PATHS")
    if not isinstance(common, (tuple, list)) or not all(isinstance(path, str) for path in common):
        raise RuntimeError(f"{rel}: COMMON_PATHS is not defined as a sequence of paths")
    required_common = {
        ".github/workflows/ci.yml",
        "scripts/ci_changed_paths.py",
        "tests/ci_changed_paths_test.py",
    }
    missing = sorted(required_common - set(common))
    if missing:
        raise RuntimeError(f"{rel}: COMMON_PATHS omits required CI inputs {missing}")
    return set(groups)


def default_run_dir(mapping):
    if not isinstance(mapping, dict):
        return {}
    defaults = mapping.get("defaults")
    if not isinstance(defaults, dict):
        return {}
    run = defaults.get("run")
    return run if isinstance(run, dict) else {}


def effective_working_directory(workflow, job, step):
    if "run" not in step:
        return "."
    for mapping in (step, default_run_dir(job), default_run_dir(workflow)):
        if isinstance(mapping, dict) and "working-directory" in mapping:
            return str(mapping["working-directory"]).strip()
    return "."


def effective_environment(workflow, job, step):
    environment = {}
    for mapping in (workflow.get("env"), job.get("env"), step.get("env")):
        if isinstance(mapping, dict):
            environment.update(mapping)
    return environment


def executable_payload(step):
    return {key: value for key, value in step.items()
            if key not in ("name", "if", "working-directory")}


def condition_terms(condition):
    if condition is None:
        return set()
    text = str(condition).strip()
    if text.startswith("${{") and text.endswith("}}"):
        text = text[3:-2].strip()
    text = re.sub(r"\s+", " ", text)
    return {term.strip() for term in text.split("&&") if term.strip()}


def is_root_checkout(step):
    if not str(step.get("uses", "")).startswith("actions/checkout@"):
        return False
    with_block = step.get("with")
    path = ""
    if isinstance(with_block, dict):
        path = str(with_block.get("path") or "").strip().strip("/")
    return path in ("", ".")


def checkout_depth(step):
    with_block = step.get("with")
    raw = with_block.get("fetch-depth", 1) if isinstance(with_block, dict) else 1
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def path_detector_problems(job, rel, job_id):
    problems = []
    steps = job.get("steps") if isinstance(job, dict) else None
    candidates = [step for step in (steps or [])
                  if isinstance(step, dict) and step.get("id") == "paths"]
    if len(candidates) != 1:
        problems.append(("prmoves", rel, 0,
                         f"job '{job_id}' must have exactly one changed-path detector step with id 'paths'"))
        return problems
    detector = candidates[0]
    if "scripts/ci_changed_paths.py" not in str(detector.get("run", "")):
        problems.append(("prmoves", rel, 0,
                         f"job '{job_id}' path detector does not run scripts/ci_changed_paths.py"))
    environment = detector.get("env")
    expected_base = "${{ github.event.pull_request.base.sha }}"
    if not isinstance(environment, dict) or environment.get("PR_BASE_SHA") != expected_base:
        problems.append(("prmoves", rel, 0,
                         f"job '{job_id}' path detector does not receive the PR base SHA"))
    if "github.event_name == 'pull_request'" not in condition_terms(detector.get("if")):
        problems.append(("prmoves", rel, 0,
                         f"job '{job_id}' path detector is not restricted to pull_request events"))
    return problems


def pr_cap_problems(root, base=None):
    """Enforce one PR workflow, six jobs, no matrices/reusable jobs/write access."""
    problems = []
    inventories, inventory_errors = inventory_pair(root, base, "prcap")
    problems.extend(inventory_errors)
    if inventory_errors:
        return problems

    saw_contract = False
    maxima = []
    expected = {}
    expected_by_label = {"here": set(), "base": set()}
    for label, inventory in (("here", inventories[0]), ("base", inventories[1])):
        contract = inventory.get("pr_checks")
        if contract is None:
            if label == "base" and inventories[0].get("pr_checks") is not None:
                continue
            problems.append(("prcap", GATES_FILE, 0,
                             f"ci-gates.json ({label}): pr_checks is missing"))
            continue
        saw_contract = True
        if not isinstance(contract, dict):
            problems.append(("prcap", GATES_FILE, 0,
                             f"ci-gates.json ({label}): pr_checks is not a mapping"))
            continue
        maximum = contract.get("max")
        if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 1:
            problems.append(("prcap", GATES_FILE, 0,
                             f"ci-gates.json ({label}): pr_checks.max must be a positive integer"))
        else:
            maxima.append(maximum)
            if maximum > 6:
                problems.append(("prcap", GATES_FILE, 0,
                                 f"ci-gates.json ({label}): pr_checks.max is {maximum}, above the hard cap of 6"))
        expected_map = contract.get("expected")
        if not isinstance(expected_map, dict) or not expected_map:
            problems.append(("prcap", GATES_FILE, 0,
                             f"ci-gates.json ({label}): pr_checks.expected must name the PR jobs"))
            continue
        for workflow, jobs in expected_map.items():
            if workflow != "ci.yml":
                problems.append(("prcap", GATES_FILE, 0,
                                 f"pr_checks expects jobs in '{workflow}'; ci.yml must be the only PR workflow"))
            if not isinstance(jobs, list) or not jobs or not all(isinstance(job, str) and job for job in jobs):
                problems.append(("prcap", GATES_FILE, 0,
                                 f"pr_checks.expected.{workflow} must be a nonempty list of job ids"))
                continue
            if len(jobs) != len(set(jobs)):
                problems.append(("prcap", GATES_FILE, 0,
                                 f"pr_checks.expected.{workflow} declares a job id more than once"))
            if len(set(jobs)) != 6:
                problems.append(("prcap", GATES_FILE, 0,
                                 f"pr_checks.expected.{workflow} names {len(set(jobs))} jobs; "
                                 "the consolidated PR contract requires exactly six"))
            expected.setdefault(workflow, set()).update(jobs)
            if workflow == "ci.yml":
                expected_by_label[label].update(jobs)
    removed_expected = sorted(expected_by_label["base"] - expected_by_label["here"])
    if removed_expected:
        problems.append(("prcap", GATES_FILE, 0,
                         f"pr_checks.expected.ci.yml removes inventoried jobs {removed_expected}; "
                         "a PR cannot lower the six-check contract"))
    if not saw_contract:
        problems.append(("prcap", GATES_FILE, 0,
                         "ci-gates.json does not define pr_checks; the PR check cap is unenforced"))
        return problems

    maximum = min(maxima) if maxima else 6
    files = list_workflows(root)
    if files is None:
        problems.append(("prcap", WORKFLOW_DIR, 0, "could not list workflows"))
        return problems
    pr_files = []
    documents = {}
    for rel in files:
        text = read_work_tree(root, rel)
        if text is None:
            continue
        doc, parse_error = workflow_document(text)
        if parse_error:
            problems.append(("prcap", rel, 0,
                             f"cannot enforce the PR cap because the workflow does not parse: {parse_error}"))
            continue
        documents[rel] = doc
        if active_pr_triggers(doc):
            pr_files.append(rel)
    expected_file = f"{WORKFLOW_DIR}/ci.yml"
    for rel in pr_files:
        if rel != expected_file:
            problems.append(("prcap", rel, 0,
                             f"workflow declares {', '.join(active_pr_triggers(documents[rel]))}; "
                             "ci.yml must be the only pull-request workflow"))
    if expected_file not in pr_files:
        problems.append(("prcap", expected_file, 0,
                         "ci.yml does not declare a pull_request trigger"))

    doc = documents.get(expected_file)
    if doc is None:
        return problems
    permission_issue = permission_problem(doc.get("permissions"), "ci.yml workflow permissions")
    if permission_issue:
        problems.append(("prcap", expected_file, 0, permission_issue))
    jobs = doc.get("jobs")
    if not isinstance(jobs, dict):
        problems.append(("prcap", expected_file, 0, "ci.yml jobs is not a mapping"))
        return problems
    expected_jobs = expected.get("ci.yml", set())
    actual_jobs = set(jobs)
    if actual_jobs != expected_jobs:
        missing = sorted(expected_jobs - actual_jobs)
        extra = sorted(actual_jobs - expected_jobs)
        problems.append(("prcap", expected_file, 0,
                         f"ci.yml jobs do not match pr_checks.expected "
                         f"(missing={missing or 'none'}, unexpected={extra or 'none'})"))
    if len(actual_jobs) > maximum:
        problems.append(("prcap", expected_file, 0,
                         f"ci.yml defines {len(actual_jobs)} jobs, above pr_checks.max={maximum}"))
    for job_id, job in jobs.items():
        if not isinstance(job, dict):
            continue
        if "strategy" in job:
            problems.append(("prcap", expected_file, line_of(read_work_tree(root, expected_file), f"  {job_id}:"),
                             f"job '{job_id}' declares a strategy; matrices can multiply PR check runs"))
        if "uses" in job:
            problems.append(("prcap", expected_file, line_of(read_work_tree(root, expected_file), f"  {job_id}:"),
                             f"job '{job_id}' calls a reusable workflow; PR checks must be visible in ci.yml"))
        if "permissions" in job:
            issue = permission_problem(job.get("permissions"), f"job '{job_id}' permissions")
            if issue:
                problems.append(("prcap", expected_file, 0, issue))
    return problems


def migration_records(inventories, section, rule, problems):
    records = {}
    by_label = {"here": {}, "base": {}}
    for label, inventory in (("here", inventories[0]), ("base", inventories[1])):
        entries = inventory.get(section)
        if entries is None:
            if label == "base" and inventories[0].get(section) is not None:
                continue
            problems.append((rule, GATES_FILE, 0,
                             f"ci-gates.json ({label}): {section} is missing"))
            continue
        if not isinstance(entries, dict):
            problems.append((rule, GATES_FILE, 0,
                             f"ci-gates.json ({label}): {section} is not a mapping"))
            continue
        for source, jobs in entries.items():
            source_key = os.path.basename(str(source))
            if not isinstance(jobs, dict):
                problems.append((rule, GATES_FILE, 0,
                                 f"{section}.{source_key} is not a mapping"))
                continue
            for job_id, entry in jobs.items():
                key = (source_key, str(job_id))
                if not isinstance(entry, dict):
                    problems.append((rule, GATES_FILE, 0,
                                     f"{section} entry '{source_key}' / '{job_id}' is not a mapping"))
                    continue
                by_label[label][key] = entry
                if key in records and records[key] != entry:
                    problems.append((rule, GATES_FILE, 0,
                                     f"{section} entry '{source_key}' / '{job_id}' differs between base and head; "
                                     "review the migration change explicitly"))
                else:
                    records[key] = entry
    if isinstance(inventories[0].get(section), dict):
        for source_key, job_id in sorted(by_label["base"].keys() - by_label["here"].keys()):
            problems.append((rule, GATES_FILE, 0,
                             f"{section} entry '{source_key}' / '{job_id}' existed at the base and is "
                             "missing here; a PR cannot silently unenforce a relocated gate"))
    return records


def source_workflow_problems(root, source_key, source_job_id, cache, problems):
    rel = f"{WORKFLOW_DIR}/{source_key}"
    if rel not in cache:
        text = read_work_tree(root, rel)
        if text is None:
            cache[rel] = (None, None, "workflow is missing")
        else:
            doc, parse_error = workflow_document(text)
            cache[rel] = (doc, parse_error, text)
    doc, parse_error, _ = cache[rel]
    if parse_error:
        problems.append(("prmoves", rel, 0,
                         f"cannot verify relocated gates: {parse_error}"))
        return None, None
    triggers = active_pr_triggers(doc)
    if triggers:
        problems.append(("prmoves", rel, 0,
                         f"source workflow still declares {', '.join(triggers)}; its PR steps belong in ci.yml"))
    jobs = doc.get("jobs")
    job = jobs.get(source_job_id) if isinstance(jobs, dict) else None
    if not isinstance(job, dict):
        problems.append(("prmoves", rel, 0,
                         f"source job '{source_job_id}' is missing"))
        return doc, None
    return doc, job


def shared_checkout_problems(root, source_step, destination_steps, source_rel, dest_rel,
                             source_job_id, dest_job_id):
    problems = []
    roots = [step for step in destination_steps if isinstance(step, dict) and is_root_checkout(step)]
    if len(roots) != 1:
        problems.append(("prmoves", dest_rel, 0,
                         f"job '{dest_job_id}' must have one repository-root checkout to replace "
                         f"the shared checkout from '{source_rel}' / '{source_job_id}'"))
        return problems
    destination = roots[0]
    if source_step.get("uses") != destination.get("uses"):
        problems.append(("prmoves", dest_rel, 0,
                         f"job '{dest_job_id}' shared checkout action differs from the source"))
    source_with = source_step.get("with") if isinstance(source_step.get("with"), dict) else {}
    destination_with = destination.get("with") if isinstance(destination.get("with"), dict) else {}
    for key in sorted((set(source_with) | set(destination_with)) - {"fetch-depth", "path"}):
        if source_with.get(key) != destination_with.get(key):
            problems.append(("prmoves", dest_rel, 0,
                             f"job '{dest_job_id}' shared checkout option '{key}' differs from the source"))
    source_depth = checkout_depth(source_step)
    destination_depth = checkout_depth(destination)
    if source_depth is None or destination_depth is None:
        problems.append(("prmoves", dest_rel, 0,
                         f"job '{dest_job_id}' shared checkout has an unreadable fetch-depth"))
    elif source_depth < 0 or destination_depth < 0:
        problems.append(("prmoves", dest_rel, 0,
                         f"job '{dest_job_id}' shared checkout has a negative fetch-depth"))
    elif destination_depth != 0 and (source_depth == 0 or destination_depth < source_depth):
        problems.append(("prmoves", dest_rel, 0,
                         f"job '{dest_job_id}' checkout depth {destination_depth} is shallower than "
                         f"the source depth {source_depth}"))
    return problems


def pr_moves_problems(root, base=None):
    """Prove every path-gated specialist step has one equivalent ci.yml copy."""
    problems = []
    inventories, inventory_errors = inventory_pair(root, base, "prmoves")
    problems.extend(inventory_errors)
    if inventory_errors:
        return problems
    moves = migration_records(inventories, "pr_moves", "prmoves", problems)
    replacements = migration_records(inventories, "pr_replacements", "prmoves", problems)
    try:
        flags = ci_path_flags(root)
    except RuntimeError as exc:
        problems.append(("prmoves", "scripts/ci_changed_paths.py", 0, str(exc)))
        flags = set()

    ci_rel = f"{WORKFLOW_DIR}/ci.yml"
    ci_text = read_work_tree(root, ci_rel)
    ci_doc = None
    if ci_text is None:
        problems.append(("prmoves", ci_rel, 0, "ci.yml is missing"))
    else:
        ci_doc, parse_error = workflow_document(ci_text)
        if parse_error:
            problems.append(("prmoves", ci_rel, 0,
                             f"cannot verify relocated gates: {parse_error}"))
    ci_jobs = ci_doc.get("jobs") if isinstance(ci_doc, dict) else None
    if not isinstance(ci_jobs, dict):
        ci_jobs = {}

    source_cache = {}
    detector_checked = set()
    for (source_key, source_job_id), entry in sorted(moves.items()):
        reason = str(entry.get("reason") or "").strip()
        if not reason:
            problems.append(("prmoves", GATES_FILE, 0,
                             f"pr_moves entry '{source_key}' / '{source_job_id}' has no reason"))
        destination = str(entry.get("to") or "")
        match = re.fullmatch(r"ci\.yml:([A-Za-z0-9_-]+)", destination)
        if not match:
            problems.append(("prmoves", GATES_FILE, 0,
                             f"pr_moves entry '{source_key}' / '{source_job_id}' has invalid destination "
                             f"'{destination}'; expected ci.yml:<job>"))
            continue
        dest_job_id = match.group(1)
        if "path_flag" not in entry:
            problems.append(("prmoves", GATES_FILE, 0,
                             f"pr_moves entry '{source_key}' / '{source_job_id}' has no path_flag "
                             "(use null for an every-PR gate)"))
        path_flag = entry.get("path_flag")
        if path_flag is not None:
            if not isinstance(path_flag, str) or path_flag not in flags:
                problems.append(("prmoves", GATES_FILE, 0,
                                 f"pr_moves entry '{source_key}' / '{source_job_id}' names unknown "
                                 f"path_flag {path_flag!r}"))
        source_doc, source_job = source_workflow_problems(
            root, source_key, source_job_id, source_cache, problems)
        if source_doc is None or source_job is None:
            continue
        dest_job = ci_jobs.get(dest_job_id)
        if not isinstance(dest_job, dict):
            problems.append(("prmoves", ci_rel, 0,
                             f"destination job '{dest_job_id}' for '{source_key}' / '{source_job_id}' is missing"))
            continue
        destination_steps = dest_job.get("steps")
        if not isinstance(destination_steps, list):
            problems.append(("prmoves", ci_rel, 0,
                             f"destination job '{dest_job_id}' steps is not a list"))
            continue
        if path_flag is not None and dest_job_id not in detector_checked:
            problems.extend(path_detector_problems(dest_job, ci_rel, dest_job_id))
            detector_checked.add(dest_job_id)

        source_steps = source_job.get("steps")
        if not isinstance(source_steps, list):
            problems.append(("prmoves", f"{WORKFLOW_DIR}/{source_key}", 0,
                             f"source job '{source_job_id}' steps is not a list"))
            continue
        source_label = os.path.splitext(source_key)[0]
        prefix = f"[{source_label}:{source_job_id}] "
        for index, source_step in enumerate(source_steps, 1):
            if not isinstance(source_step, dict):
                problems.append(("prmoves", f"{WORKFLOW_DIR}/{source_key}", 0,
                                 f"source job '{source_job_id}' step {index} is not a mapping"))
                continue
            if is_root_checkout(source_step):
                problems.extend(shared_checkout_problems(
                    root, source_step, destination_steps, f"{WORKFLOW_DIR}/{source_key}", ci_rel,
                    source_job_id, dest_job_id))
                continue
            source_name = str(source_step.get("name") or "").strip()
            if not source_name:
                problems.append(("prmoves", f"{WORKFLOW_DIR}/{source_key}", 0,
                                 f"source job '{source_job_id}' step {index} has no name, so its "
                                 "relocated copy cannot be identified"))
                continue
            expected_name = prefix + source_name
            copies = [step for step in destination_steps
                      if isinstance(step, dict) and step.get("name") == expected_name]
            if len(copies) != 1:
                problems.append(("prmoves", ci_rel, 0,
                                 f"expected exactly one copy of '{source_key}' / '{source_job_id}' / "
                                 f"'{source_name}' named '{expected_name}', found {len(copies)}"))
                continue
            destination_step = copies[0]
            if executable_payload(source_step) != executable_payload(destination_step):
                problems.append(("prmoves", ci_rel, 0,
                                 f"relocated step '{expected_name}' executable payload differs from its source"))
            source_directory = effective_working_directory(source_doc, source_job, source_step)
            destination_directory = effective_working_directory(ci_doc, dest_job, destination_step)
            if source_directory != destination_directory:
                problems.append(("prmoves", ci_rel, 0,
                                 f"relocated step '{expected_name}' working directory is "
                                 f"'{destination_directory}', expected '{source_directory}'"))
            source_environment = effective_environment(source_doc, source_job, source_step)
            destination_environment = effective_environment(ci_doc, dest_job, destination_step)
            for key, value in source_environment.items():
                if key not in destination_environment or destination_environment[key] != value:
                    problems.append(("prmoves", ci_rel, 0,
                                     f"relocated step '{expected_name}' environment '{key}' differs from its source"))
            required_terms = {"always()", "!cancelled()", "github.event_name == 'pull_request'"}
            if path_flag is not None:
                required_terms.add(f"steps.paths.outputs.{path_flag} == 'true'")
            required_terms.update(condition_terms(source_step.get("if")))
            actual_terms = condition_terms(destination_step.get("if"))
            if actual_terms != required_terms:
                problems.append(("prmoves", ci_rel, 0,
                                 f"relocated step '{expected_name}' condition differs from the required "
                                 f"source + resilience + path guard (missing={sorted(required_terms - actual_terms)}, "
                                 f"unexpected={sorted(actual_terms - required_terms)})"))

    for (source_key, source_job_id), entry in sorted(replacements.items()):
        reason = str(entry.get("reason") or "").strip()
        if not reason:
            problems.append(("prmoves", GATES_FILE, 0,
                             f"pr_replacements entry '{source_key}' / '{source_job_id}' has no reason"))
        target = str(entry.get("to") or "")
        match = re.fullmatch(r"scripts/ci_changed_paths\.py:([A-Za-z0-9_-]+)", target)
        if not match:
            problems.append(("prmoves", GATES_FILE, 0,
                             f"pr_replacements entry '{source_key}' / '{source_job_id}' has invalid target '{target}'"))
            continue
        path_flag = match.group(1)
        if entry.get("path_flag") != path_flag:
            problems.append(("prmoves", GATES_FILE, 0,
                             f"pr_replacements entry '{source_key}' / '{source_job_id}' path_flag must be "
                             f"'{path_flag}'"))
        if path_flag not in flags:
            problems.append(("prmoves", GATES_FILE, 0,
                             f"pr_replacements entry '{source_key}' / '{source_job_id}' names unknown "
                             f"path_flag {path_flag!r}"))
        source_doc, source_job = source_workflow_problems(
            root, source_key, source_job_id, source_cache, problems)
        if source_doc is None or source_job is None:
            continue
        guard = f"steps.paths.outputs.{path_flag} == 'true'"
        users = []
        for job_id, job in ci_jobs.items():
            if not isinstance(job, dict):
                continue
            if any(guard in condition_terms(step.get("if"))
                   for step in (job.get("steps") or []) if isinstance(step, dict)):
                users.append(job_id)
        if not users:
            problems.append(("prmoves", ci_rel, 0,
                             f"replacement path flag '{path_flag}' is not used by any ci.yml step"))
        for job_id in users:
            problems.extend(path_detector_problems(ci_jobs[job_id], ci_rel, job_id))
    return problems


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

    # "moved": a job folded into another job, with its steps still expected to
    # run there. Consolidating the check surface is a legitimate change; the
    # point of this gate is that a gate cannot quietly vanish, and a move is
    # only a move if the destination really carries everything. A PR that
    # invents a destination is caught by the existence test below, and one that
    # moves a job and drops a step on the way is caught exactly as a deletion
    # would be.
    moved = {}
    for inv in (inventory_base, inventory_here):
        for workflow, jobs in (inv.get("moved") or {}).items():
            key = os.path.basename(workflow)
            for old_job, entry in (jobs or {}).items():
                dest = entry.get("to") if isinstance(entry, dict) else entry
                reason = entry.get("reason") if isinstance(entry, dict) else ""
                if not dest:
                    problems.append(("gates", GATES_FILE, 0,
                                     f"moved entry '{key}' / '{old_job}' names no destination job. "
                                     "Record where the steps went, in the open."))
                    continue
                if not str(reason or "").strip():
                    problems.append(("gates", GATES_FILE, 0,
                                     f"moved entry '{key}' / '{old_job}' -> '{dest}' has no reason. "
                                     "A move needs the same justification a retirement does."))
                moved.setdefault(key, {})[old_job] = str(dest)
    for key, pairs in moved.items():
        for old_job, dest in pairs.items():
            if old_job == dest:
                problems.append(("gates", GATES_FILE, 0,
                                 f"moved entry '{key}' / '{old_job}' points at itself"))
            elif dest in pairs:
                problems.append(("gates", GATES_FILE, 0,
                                 f"moved entry '{key}' / '{old_job}' -> '{dest}', which is itself a move. "
                                 "Chains are not followed: point at the job that runs the steps now."))
            present, _ = steps_here(f"{WORKFLOW_DIR}/{key}")
            if present is not None and dest not in present:
                problems.append(("gates", GATES_FILE, 0,
                                 f"moved entry '{key}' / '{old_job}' -> '{dest}', but no job '{dest}' "
                                 "exists in this branch's workflow. The steps went nowhere."))

    def home(key, job_id, present):
        """The job a base job's steps must be found in here, after any move."""
        dest = moved.get(key, {}).get(job_id, job_id)
        return dest, dest in present

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
        key = os.path.basename(workflow)
        allowed = retired.get(key, {})
        for job_id, names in (jobs or {}).items():
            dest, dest_present = home(key, job_id, present)
            for name in names:
                if name in allowed.get(job_id, set()):
                    continue
                if not dest_present:
                    problems.append(("gates", workflow, 0,
                                     f"job '{job_id}' is gone, so its required step '{name}' cannot run"
                                     + (f" (it is recorded as moved to '{dest}', which does not exist)"
                                        if dest != job_id else "")))
                elif name.strip() not in present[dest]:
                    problems.append((
                        "gates", workflow, 0,
                        f"job '{dest}' no longer runs the required step '{name}'"
                        + (f" it took over from '{job_id}'" if dest != job_id else "")
                        + ". A removed gate cannot "
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
                dest, _ = home(workflow, job_id, head_jobs)
                # Only compare against the merge base, so steps main added after
                # this branch forked are never blamed on the branch.
                for name in names:
                    if name in allowed:
                        continue
                    if dest not in head_jobs:
                        problems.append(("gates", rel, 0,
                                         f"job '{job_id}' existed at the merge base and is gone"
                                         + (f", and its recorded move to '{dest}' does not exist here"
                                            if dest != job_id else "")))
                    elif name not in head_jobs[dest]:
                        problems.append((
                            "gates", rel, 0,
                            f"job '{dest}' dropped the step '{name}' that existed at the merge base"
                            + (f" (taken over from '{job_id}')" if dest != job_id else "")
                            + ". Deleted gates do not fail -- they disappear. Restore it, or retire it in "
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


def first_forbidden_control(data):
    """(offset, byte) of the first C0 control byte that is not allowed, else None.

    Tab and LF are allowed. CR is allowed only as part of a CRLF pair; a CR
    at end of file or followed by anything but LF is a lone CR. DEL (0x7F)
    is not a C0 byte and is out of scope here.
    """
    for offset, byte in enumerate(data):
        if byte >= 0x20 or byte in (0x09, 0x0A):
            continue
        if byte == 0x0D and offset + 1 < len(data) and data[offset + 1] == 0x0A:
            continue
        return offset, byte
    return None


def check_encodings(root, base=None):
    problems = []
    for rel, path in tracked_text_files(root, base):
        try:
            with open(path, "rb") as handle:
                data = handle.read()
        except OSError as exc:
            problems.append(("encoding", rel, 0, f"could not read: {exc}"))
            continue
        # The whole file is read, not just the first 8 KiB: a control byte
        # past the head is just as unreviewable as one at the top.
        if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
            problems.append((
                "encoding", rel, 0,
                "is stored as UTF-16. git then treats it as a binary blob: `git diff` prints \"Binary "
                "files differ\", the change is unreviewable, and a CI file can be gutted without "
                "showing up in the diff. Re-save as UTF-8 without a BOM.",
            ))
        elif b"\x00" in data:
            problems.append((
                "encoding", rel, 0,
                f"contains a NUL byte (0x00) at offset {data.index(b'\x00')}, so git and every text tool "
                "treat it as binary. Remove the NUL byte and re-save as UTF-8 without a BOM.",
            ))
        elif data[:3] == b"\xef\xbb\xbf" and not rel.lower().endswith(BOM_TOLERATED_EXTENSIONS):
            problems.append((
                "encoding", rel, 0,
                "starts with a UTF-8 BOM. Tools that read the file as UTF-8 see \\ufeff before the first "
                "token, so a shebang or a YAML document marker stops matching. Save without a BOM "
                "(.ps1 is exempt because PowerShell needs it).",
            ))
        else:
            found = first_forbidden_control(data)
            if found is not None:
                offset, byte = found
                if byte == 0x0D:
                    problems.append((
                        "encoding", rel, 0,
                        f"contains a lone carriage return (CR, 0x0D) at offset {offset}, not followed "
                        "by LF. A CR on its own is not a line ending in any convention this repo uses: "
                        "re-save the file with LF line endings (see scripts/check_line_endings.sh).",
                    ))
                else:
                    problems.append((
                        "encoding", rel, 0,
                        f"contains C0 control byte 0x{byte:02x} ({C0_NAMES[byte]}) at offset {offset}. "
                        "Control bytes corrupt YAML parsers and shell scripts and make diffs "
                        "unreviewable, the same way a NUL byte does. Remove the control character "
                        "and re-save the file as UTF-8 without a BOM.",
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
        # Probe run 45373317235: this step makes GitHub refuse to load the file,
        # so the workflow reports zero checks instead of a failure.
        "      - name: wd-on-uses\n        uses: actions/checkout@v7\n"
        "        working-directory: frontend\n"
        "  b:\n    runs-on: ubuntu-latest\n    needs: nonexistent\n    steps:\n      - run: echo x\n"
        # Prefix stripping must not make the detector blind: the checkout dir is
        # real, the action inside it is not.
        "  c:\n    runs-on: ubuntu-latest\n    steps:\n"
        "      - name: checkout into head-repo\n        uses: actions/checkout@v7\n"
        "        with:\n          path: head-repo\n"
        "      - name: lost under the checkout dir\n        uses: ./head-repo/.github/actions/nope\n"
        # Probe run 45373319494: the job-level spelling of the same thing loads
        # and runs, so the detector has to stay quiet about it. A rule that fires
        # on legal YAML is a rule that keeps CI permanently red.
        "  d:\n    runs-on: ubuntu-latest\n"
        "    defaults:\n      run:\n        working-directory: frontend\n"
        "    steps:\n"
        "      - name: defaults control uses\n        uses: actions/checkout@v7\n"
        "      - name: defaults control run\n        run: pwd\n",
    ),
    "triggers": (
        "notriggers.yml",
        "name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    ),
    # Dead path filters, the shape infra.yml carried as "deploy/**" for a
    # directory no commit in this repository has ever had. Two of the five
    # pull_request patterns below are legal and must stay quiet, so this fixture
    # pins the rule in both directions like every other one here.
    "paths": (
        "deadfilter.yml",
        "name: dead\n'on':\n  pull_request:\n    paths:\n      - \"deploy/**\"\n"
        "      - \"infra/**\"\n      - \"**/*.md\"\n      - \"scripts/nope.py\"\n"
        "      - \".github/workflows/deadfilter.yml\"\n"
        "  push:\n    paths-ignore:\n      - \"docs/**\"\n"
        "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n",
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
        messages = " || ".join(message for _, _, _, message in problems)
        if "does not resolve" not in messages:
            failures.append("steps detector did not report a local action path that does not resolve")
        if "head-repo/.github/actions/nope" not in messages:
            failures.append("steps detector stopped reporting a local action that is missing under a "
                            "`with: path:` checkout directory")
        wd = [message for _, rel, _, message in problems
              if "working-directory" in message and rel.endswith("shape.yml")]
        if not any("wd-on-uses" in message for message in wd):
            failures.append("steps detector no longer reports working-directory: on a uses:/run-less step, "
                            "the construct that makes GitHub load nothing (probe run 45373317235)")
        if any("defaults control" in message for message in wd):
            failures.append("steps detector reported the job-level `defaults: run: working-directory:` "
                            "control, which GitHub loads and runs (probe run 45373319494) - a rule that "
                            "fires on legal YAML keeps CI permanently red")
        # A detector that fires on everything would keep CI permanently red, so
        # a valid workflow has to come back clean.
        for kind, rel, _, message in problems:
            if rel.endswith(VALID_WORKFLOW[0]) or rel.endswith(VALID_SUBDIR_WORKFLOW[0]):
                failures.append(f"false positive on the valid fixture {rel}: [{kind}] {message}")

        # paths: only the infra/ directory and the fixture's own workflow file
        # exist here, which is what makes the other four patterns dead.
        os.makedirs(os.path.join(tmp, "infra"))
        with open(os.path.join(tmp, "infra", "main.tf"), "w", encoding="utf-8", newline="") as handle:
            handle.write("resource \"null_resource\" \"fixture\" {}\n")
        path_problems = check_path_filters(tmp)
        reported = " || ".join(message for _, _, _, message in path_problems)
        for pattern in ("deploy/**", "scripts/nope.py", "docs/**"):
            if pattern not in reported:
                failures.append(f"paths detector no longer reports the dead pattern {pattern!r} "
                                "(deploy/** is the one infra.yml shipped with)")
        for pattern in ("infra/**", "**/*.md", ".github/workflows/deadfilter.yml"):
            if pattern in reported:
                failures.append(f"paths detector reported the satisfiable pattern {pattern!r} - a rule "
                                "that fires on a working filter keeps CI red for the wrong reason")
        for kind, rel, _, message in path_problems:
            if rel.endswith(VALID_WORKFLOW[0]) or rel.endswith(VALID_SUBDIR_WORKFLOW[0]):
                failures.append(f"false positive from the paths detector on {rel}: {message}")
        kinds = kinds | {kind for kind, _, _, _ in path_problems}
        # Every fixture in the table has to be caught by the detector it is
        # named for; a fixture nobody fires on means the rule is decorative.
        for rule in FIXTURES:
            if rule not in kinds:
                failures.append(f"{rule} detector reported nothing on its own fixture")

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

        # gates/moved: consolidating the check surface re-homes a job's steps in
        # another job. That has to be allowed, or the gate would block every
        # honest cleanup - and a step lost on the way still has to be reported,
        # or "moved" is just a deletion loophole.
        mrepo = os.path.join(tmp, "moved-repo")
        os.makedirs(mrepo)
        mrun = lambda *a: subprocess.run(a, cwd=mrepo, capture_output=True, text=True,
                                         encoding="utf-8", errors="replace")
        mrun("git", "init", "-q")
        mrun("git", "config", "user.email", "self-test@example.invalid")
        mrun("git", "config", "user.name", "self-test")
        MOVE_BASE_YML = (
            "name: x\n'on': push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n"
            "      - name: Kept step\n        run: echo x\n"
            "  b:\n    runs-on: ubuntu-latest\n    steps:\n"
            "      - name: Relocated step\n        run: echo y\n"
            "      - name: Dropped step\n        run: echo z\n"
        )
        MOVE_HEAD_YML = (
            "name: x\n'on': push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n"
            "      - name: Kept step\n        run: echo x\n"
            "      - name: Relocated step\n        run: echo y\n"
        )
        MOVE_BASE_INV = {"version": 1,
                         "must_have": {"gate-ci.yml": {"b": ["Relocated step", "Dropped step"]}},
                         "retired": {}}
        MOVE_HEAD_INV = {"version": 1,
                         "must_have": MOVE_BASE_INV["must_have"],
                         "retired": {},
                         "moved": {"gate-ci.yml": {
                             "b": {"to": "a", "reason": "self-test fixture: folded into a"},
                             "c": {"to": "ghost", "reason": "self-test fixture: destination is not there"},
                             "d": {"to": "a"},
                         }}}

        def commit_files(repo, run, files, message):
            for rel, body in files:
                path = os.path.join(repo, rel.replace("/", os.sep))
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8", newline="") as handle:
                    handle.write(body)
            run("git", "add", "-A")
            run("git", "commit", "-qm", message)

        wf_dir = f"{WORKFLOW_DIR}/gate-ci.yml"
        commit_files(mrepo, mrun, [(wf_dir, MOVE_BASE_YML),
                                   (GATES_FILE, json.dumps(MOVE_BASE_INV))], "base")
        commit_files(mrepo, mrun, [(wf_dir, MOVE_HEAD_YML),
                                   (GATES_FILE, json.dumps(MOVE_HEAD_INV))], "head")
        mbase = mrun("git", "rev-parse", "HEAD~1").stdout.strip()
        if not mbase:
            failures.append("self-test could not build a base commit for the moved-job check")
        else:
            found = [message for _, _, _, message in gate_problems(mrepo, mbase)]
            if [m for m in found if "Relocated step" in m]:
                failures.append("gates detector reported a step whose job moved and carried it over: "
                                + " || ".join(m for m in found if "Relocated step" in m))
            if not [m for m in found if "Dropped step" in m]:
                failures.append("gates detector let a step vanish behind a recorded job move")
            if not [m for m in found if "ghost" in m]:
                failures.append("gates detector accepted a move to a destination job that does not exist")
            if not [m for m in found if "'d' -> 'a' has no reason" in m]:
                failures.append("gates detector accepted a move recorded without a reason")

        def write_yaml_fixture(repo, rel, doc):
            path = os.path.join(repo, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="") as handle:
                handle.write(yaml.safe_dump(doc, sort_keys=False))

        def write_json_fixture(repo, rel, doc):
            path = os.path.join(repo, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="") as handle:
                handle.write(json.dumps(doc))

        cap_repo = os.path.join(tmp, "cap-repo")
        cap_jobs = ["contract", "frontend", "data-plane", "storybook-visual",
                    "supply-chain", "docs"]
        cap_workflow = {
            "name": "CI",
            "on": {"pull_request": None},
            "permissions": {"contents": "read"},
            "jobs": {
                job_id: {
                    "runs-on": "ubuntu-latest",
                    "steps": [{"name": "Check", "run": "true"}],
                }
                for job_id in cap_jobs
            },
        }
        cap_inventory = {
            "version": 1,
            "pr_checks": {"max": 6, "expected": {"ci.yml": cap_jobs}},
        }
        cap_ci_rel = f"{WORKFLOW_DIR}/ci.yml"
        cap_extra_rel = f"{WORKFLOW_DIR}/extra-pr.yml"
        write_yaml_fixture(cap_repo, cap_ci_rel, cap_workflow)
        write_json_fixture(cap_repo, GATES_FILE, cap_inventory)
        write_yaml_fixture(cap_repo, f"{WORKFLOW_DIR}/specialist.yml", {
            "name": "Specialist", "on": {"workflow_dispatch": None},
            "jobs": {"special": {"runs-on": "ubuntu-latest",
                                 "steps": [{"name": "Check", "run": "true"}]}},
        })
        baseline = pr_cap_problems(cap_repo)
        if baseline:
            failures.append("prcap detector reported a valid six-job PR workflow: "
                            + " || ".join(message for _, _, _, message in baseline))

        def expect_cap_failure(label, mutate, needle):
            workflow = copy.deepcopy(cap_workflow)
            inventory = copy.deepcopy(cap_inventory)
            extra = os.path.join(cap_repo, cap_extra_rel.replace("/", os.sep))
            if os.path.exists(extra):
                os.remove(extra)
            mutate(workflow, inventory)
            write_yaml_fixture(cap_repo, cap_ci_rel, workflow)
            write_json_fixture(cap_repo, GATES_FILE, inventory)
            found = [message for _, _, _, message in pr_cap_problems(cap_repo)]
            if not any(needle in message for message in found):
                failures.append(f"prcap detector did not report {label}: {' || '.join(found)}")

        def add_matrix(workflow, _):
            workflow["jobs"]["contract"]["strategy"] = {"matrix": {"os": ["ubuntu-latest"]}}

        def add_reusable_job(workflow, _):
            workflow["jobs"]["contract"] = {
                "uses": "owner/repo/.github/workflows/reusable.yml@v1"
            }

        def add_write_permission(workflow, _):
            workflow["permissions"]["contents"] = "write"

        def add_job_write_permission(workflow, _):
            workflow["jobs"]["contract"]["permissions"] = {"contents": "write"}

        def remove_permissions(workflow, _):
            workflow.pop("permissions")

        def add_extra_pr_workflow(workflow, _):
            write_yaml_fixture(cap_repo, cap_extra_rel, {
                "name": "Extra", "on": {"pull_request": None},
                "jobs": {"extra": {"runs-on": "ubuntu-latest",
                                   "steps": [{"name": "Check", "run": "true"}]}},
            })

        def reduce_contract(workflow, inventory):
            workflow["jobs"] = {"contract": workflow["jobs"]["contract"]}
            inventory["pr_checks"]["max"] = 1
            inventory["pr_checks"]["expected"]["ci.yml"] = ["contract"]

        def duplicate_expected_job(_, inventory):
            inventory["pr_checks"]["expected"]["ci.yml"].append("contract")

        def exceed_maximum(_, inventory):
            inventory["pr_checks"]["max"] = 7

        expect_cap_failure("a removed job", lambda w, _: w["jobs"].pop("docs"), "missing=['docs']")
        expect_cap_failure("a matrix", add_matrix, "declares a strategy")
        expect_cap_failure("a reusable workflow job", add_reusable_job, "calls a reusable workflow")
        expect_cap_failure("workflow write permission", add_write_permission, "grants 'contents: write'")
        expect_cap_failure("job write permission", add_job_write_permission, "job 'contract' permissions")
        expect_cap_failure("implicit permissions", remove_permissions, "does not declare permissions")
        expect_cap_failure("a second PR workflow", add_extra_pr_workflow,
                           "ci.yml must be the only pull-request workflow")
        expect_cap_failure("a reduced six-check contract", reduce_contract,
                           "consolidated PR contract requires exactly six")
        expect_cap_failure("a duplicate expected job", duplicate_expected_job,
                           "declares a job id more than once")
        expect_cap_failure("a maximum above six", exceed_maximum, "above the hard cap of 6")

        def init_git_fixture(repo):
            os.makedirs(repo, exist_ok=True)
            proc = lambda *args: subprocess.run(
                args, cwd=repo, capture_output=True, text=True,
                encoding="utf-8", errors="replace")
            proc("git", "init", "-q")
            proc("git", "config", "user.email", "self-test@example.invalid")
            proc("git", "config", "user.name", "self-test")
            return proc

        write_yaml_fixture(cap_repo, cap_ci_rel, cap_workflow)
        write_json_fixture(cap_repo, GATES_FILE, cap_inventory)
        cap_extra = os.path.join(cap_repo, cap_extra_rel.replace("/", os.sep))
        if os.path.exists(cap_extra):
            os.remove(cap_extra)
        cap_git = init_git_fixture(cap_repo)
        cap_git("git", "add", "-A")
        cap_git("git", "commit", "-qm", "base")
        cap_base = cap_git("git", "rev-parse", "HEAD").stdout.strip()
        if not cap_base:
            failures.append("self-test could not build a base commit for the PR-cap check")
        else:
            write_json_fixture(cap_repo, GATES_FILE, {"version": 1})
            found = [message for _, _, _, message in pr_cap_problems(cap_repo, cap_base)]
            if not any("(here): pr_checks is missing" in message for message in found):
                failures.append("prcap detector let a PR delete the inventoried check contract")
            reduced = copy.deepcopy(cap_workflow)
            reduced["jobs"].pop("docs")
            reduced_inventory = copy.deepcopy(cap_inventory)
            reduced_inventory["pr_checks"]["expected"]["ci.yml"].remove("docs")
            write_yaml_fixture(cap_repo, cap_ci_rel, reduced)
            write_json_fixture(cap_repo, GATES_FILE, reduced_inventory)
            found = [message for _, _, _, message in pr_cap_problems(cap_repo, cap_base)]
            if not any("removes inventoried jobs ['docs']" in message for message in found):
                failures.append("prcap detector let a PR lower the base branch's job contract")

        intro_repo = os.path.join(tmp, "intro-repo")
        intro_git = init_git_fixture(intro_repo)
        write_yaml_fixture(intro_repo, cap_ci_rel, cap_workflow)
        write_json_fixture(intro_repo, GATES_FILE, {"version": 1})
        intro_git("git", "add", "-A")
        intro_git("git", "commit", "-qm", "before consolidation")
        intro_base = intro_git("git", "rev-parse", "HEAD").stdout.strip()
        write_json_fixture(intro_repo, GATES_FILE, cap_inventory)
        found = [message for _, _, _, message in pr_cap_problems(intro_repo, intro_base)]
        if found:
            failures.append("prcap detector blocked the initial introduction of the check contract: "
                            + " || ".join(found))

        moves_repo = os.path.join(tmp, "moves-repo")
        guard = ("always() && !cancelled() && github.event_name == 'pull_request' "
                 "&& steps.paths.outputs.sdk == 'true'")
        source_workflow = {
            "name": "Specialist",
            "on": {"workflow_dispatch": None},
            "env": {"SHARED": "source"},
            "jobs": {
                "special": {
                    "runs-on": "ubuntu-latest",
                    "defaults": {"run": {"working-directory": "packages/sdk"}},
                    "env": {"JOB_ENV": "same"},
                    "steps": [
                        {"name": "Checkout repository", "uses": "actions/checkout@v7",
                         "with": {"fetch-depth": 2, "persist-credentials": False}},
                        {"name": "Prepare", "run": "echo prepare", "env": {"STEP_ENV": "same"}},
                        {"name": "Setup", "uses": "actions/setup-node@v7",
                         "with": {"node-version": "22"}},
                        {"name": "Report", "if": "always()", "run": "echo report"},
                    ],
                },
            },
        }
        destination_workflow = {
            "name": "CI",
            "on": {"pull_request": None},
            "permissions": {"contents": "read"},
            "env": {"SHARED": "source"},
            "jobs": {
                "contract": {
                    "runs-on": "ubuntu-latest",
                    "defaults": {"run": {"working-directory": "packages/sdk"}},
                    "env": {"JOB_ENV": "same"},
                    "steps": [
                        {"name": "Detect changed paths", "id": "paths",
                         "if": "github.event_name == 'pull_request'",
                         "env": {"PR_BASE_SHA": "${{ github.event.pull_request.base.sha }}"},
                         "run": "python3 scripts/ci_changed_paths.py"},
                        {"name": "Checkout repository", "uses": "actions/checkout@v7",
                         "with": {"fetch-depth": 0, "persist-credentials": False}},
                        {"name": "[specialist:special] Prepare", "if": guard,
                         "run": "echo prepare", "env": {"STEP_ENV": "same"}},
                        {"name": "[specialist:special] Setup", "if": guard,
                         "uses": "actions/setup-node@v7", "with": {"node-version": "22"}},
                        {"name": "[specialist:special] Report",
                         "if": guard + " && always()", "run": "echo report"},
                        {"name": "Indexer image gate", "if": guard.replace("sdk", "indexer_image"),
                         "run": "true"},
                    ],
                },
            },
        }
        moves_inventory = {
            "version": 1,
            "pr_moves": {
                "specialist.yml": {
                    "special": {"to": "ci.yml:contract", "path_flag": "sdk",
                                "reason": "self-test fixture"},
                },
            },
            "pr_replacements": {
                "infra.yml": {
                    "docker-changes": {
                        "to": "scripts/ci_changed_paths.py:indexer_image",
                        "path_flag": "indexer_image", "reason": "self-test fixture",
                    },
                },
            },
        }

        def write_moves_fixture(source, destination, inventory):
            write_yaml_fixture(moves_repo, f"{WORKFLOW_DIR}/specialist.yml", source)
            write_yaml_fixture(moves_repo, f"{WORKFLOW_DIR}/infra.yml", {
                "name": "Infra", "on": {"workflow_dispatch": None},
                "jobs": {"docker-changes": {"runs-on": "ubuntu-latest",
                                             "steps": [{"name": "Detect", "run": "true"}]}}},
            )
            write_yaml_fixture(moves_repo, cap_ci_rel, destination)
            write_json_fixture(moves_repo, GATES_FILE, inventory)
            script = os.path.join(moves_repo, "scripts", "ci_changed_paths.py")
            os.makedirs(os.path.dirname(script), exist_ok=True)
            with open(script, "w", encoding="utf-8", newline="") as handle:
                handle.write('PATH_GROUPS = {"sdk": ("sdks/**",), '
                             '"indexer_image": ("infra/docker/**",)}\n'
                             'COMMON_PATHS = (".github/workflows/ci.yml", '
                             '"scripts/ci_changed_paths.py", "tests/ci_changed_paths_test.py")\n')

        write_moves_fixture(source_workflow, destination_workflow, moves_inventory)
        baseline = pr_moves_problems(moves_repo)
        if baseline:
            failures.append("prmoves detector reported a valid relocation: "
                            + " || ".join(message for _, _, _, message in baseline))

        def expect_moves_failure(label, mutate, needle):
            source = copy.deepcopy(source_workflow)
            destination = copy.deepcopy(destination_workflow)
            inventory = copy.deepcopy(moves_inventory)
            mutate(source, destination, inventory)
            write_moves_fixture(source, destination, inventory)
            found = [message for _, _, _, message in pr_moves_problems(moves_repo)]
            if not any(needle in message for message in found):
                failures.append(f"prmoves detector did not report {label}: {' || '.join(found)}")

        def destination_step(destination, name):
            return next(step for step in destination["jobs"]["contract"]["steps"]
                        if step.get("name") == name)

        def wrong_prefix(_, destination, __):
            destination_step(destination, "[specialist:special] Prepare")["name"] = "Prepare"

        def changed_payload(_, destination, __):
            destination_step(destination, "[specialist:special] Prepare")["run"] = "echo changed"

        def changed_directory(_, destination, __):
            destination_step(destination, "[specialist:special] Prepare")["working-directory"] = "frontend"

        def changed_environment(_, destination, __):
            destination_step(destination, "[specialist:special] Prepare")["env"]["STEP_ENV"] = "changed"

        def missing_resilience(_, destination, __):
            step = destination_step(destination, "[specialist:special] Prepare")
            step["if"] = step["if"].replace("always() && ", "")

        def wrong_path_guard(_, destination, __):
            step = destination_step(destination, "[specialist:special] Prepare")
            step["if"] = step["if"].replace("outputs.sdk", "outputs.fuzz")

        def duplicate_copy(_, destination, __):
            destination["jobs"]["contract"]["steps"].append(
                copy.deepcopy(destination_step(destination, "[specialist:special] Prepare")))

        def shallow_checkout(source, destination, __):
            source["jobs"]["special"]["steps"][0]["with"]["fetch-depth"] = 3
            destination["jobs"]["contract"]["steps"][1]["with"]["fetch-depth"] = 2

        def changed_checkout_action(_, destination, __):
            destination["jobs"]["contract"]["steps"][1]["uses"] = "actions/checkout@v6"

        def source_pr_trigger(source, _, __):
            source["on"]["pull_request"] = None

        def missing_detector(_, destination, __):
            destination["jobs"]["contract"]["steps"].pop(0)

        def wrong_base_sha(_, destination, __):
            destination["jobs"]["contract"]["steps"][0]["env"]["PR_BASE_SHA"] = "HEAD"

        def unknown_flag(_, __, inventory):
            inventory["pr_moves"]["specialist.yml"]["special"]["path_flag"] = "missing"

        def missing_reason(_, __, inventory):
            inventory["pr_moves"]["specialist.yml"]["special"].pop("reason")

        def unnamed_source_step(source, _, __):
            source["jobs"]["special"]["steps"][1].pop("name")

        def unused_replacement(_, destination, __):
            destination["jobs"]["contract"]["steps"] = [
                step for step in destination["jobs"]["contract"]["steps"]
                if step.get("name") != "Indexer image gate"
            ]

        expect_moves_failure("a changed provenance prefix", wrong_prefix, "expected exactly one copy")
        expect_moves_failure("a changed executable payload", changed_payload, "executable payload differs")
        expect_moves_failure("a changed working directory", changed_directory, "working directory is")
        expect_moves_failure("a changed step environment", changed_environment, "environment 'STEP_ENV' differs")
        expect_moves_failure("a missing always() guard", missing_resilience, "condition differs")
        expect_moves_failure("a wrong path guard", wrong_path_guard, "condition differs")
        expect_moves_failure("a duplicate relocated step", duplicate_copy, "found 2")
        expect_moves_failure("a shallow shared checkout", shallow_checkout, "is shallower than")
        expect_moves_failure("a changed checkout action", changed_checkout_action,
                             "shared checkout action differs")
        expect_moves_failure("a source PR trigger", source_pr_trigger, "source workflow still declares")
        expect_moves_failure("a missing path detector", missing_detector, "exactly one changed-path detector")
        expect_moves_failure("a wrong PR base SHA", wrong_base_sha, "does not receive the PR base SHA")
        expect_moves_failure("an unknown path flag", unknown_flag, "names unknown path_flag")
        expect_moves_failure("a missing migration reason", missing_reason, "has no reason")
        expect_moves_failure("an unnamed source step", unnamed_source_step, "has no name")
        expect_moves_failure("an unused replacement flag", unused_replacement, "is not used by any ci.yml step")

        write_moves_fixture(source_workflow, destination_workflow, moves_inventory)
        moves_git = init_git_fixture(moves_repo)
        moves_git("git", "add", "-A")
        moves_git("git", "commit", "-qm", "base")
        moves_base = moves_git("git", "rev-parse", "HEAD").stdout.strip()
        if not moves_base:
            failures.append("self-test could not build a base commit for the relocation check")
        else:
            missing_section = copy.deepcopy(moves_inventory)
            missing_section.pop("pr_moves")
            write_moves_fixture(source_workflow, destination_workflow, missing_section)
            found = [message for _, _, _, message in pr_moves_problems(moves_repo, moves_base)]
            if not any("(here): pr_moves is missing" in message for message in found):
                failures.append("prmoves detector let a PR delete the relocation inventory")
            missing_entry = copy.deepcopy(moves_inventory)
            missing_entry["pr_moves"]["specialist.yml"].pop("special")
            write_moves_fixture(source_workflow, destination_workflow, missing_entry)
            found = [message for _, _, _, message in pr_moves_problems(moves_repo, moves_base)]
            if not any("existed at the base and is missing here" in message for message in found):
                failures.append("prmoves detector let a PR unenforce one relocated gate")
            changed_entry = copy.deepcopy(moves_inventory)
            changed_entry["pr_moves"]["specialist.yml"]["special"]["path_flag"] = "indexer_image"
            write_moves_fixture(source_workflow, destination_workflow, changed_entry)
            found = [message for _, _, _, message in pr_moves_problems(moves_repo, moves_base)]
            if not any("differs between base and head" in message for message in found):
                failures.append("prmoves detector accepted a changed relocation record")

        write_moves_fixture(source_workflow, destination_workflow, moves_inventory)
        script = os.path.join(moves_repo, "scripts", "ci_changed_paths.py")
        with open(script, "w", encoding="utf-8", newline="") as handle:
            handle.write('PATH_GROUPS = {"sdk": ("sdks/**",), '
                         '"indexer_image": ("infra/docker/**",)}\n'
                         'COMMON_PATHS = ()\n')
        found = [message for _, _, _, message in pr_moves_problems(moves_repo)]
        if not any("COMMON_PATHS omits required CI inputs" in message for message in found):
            failures.append("prmoves detector let the path detector stop selecting every specialist "
                            "group when CI configuration changes")

        # encoding: UTF-16 and a UTF-8 BOM must both be reported.
        with open(os.path.join(repo, "notes.md"), "wb") as handle:
            handle.write("# StreamPay\nsecond line\n".encode("utf-16"))
        with open(os.path.join(repo, "bom.rs"), "wb") as handle:
            handle.write(b"\xef\xbb\xbffn main() {}\n")
        # C0 controls: one fixture per forbidden byte, so a detector that
        # only catches NUL cannot stay green while e.g. ESC slips through.
        # NUL (0x00) gets its own fixture too -- the old check had none.
        # A lone CR is its own class: CR is only legitimate inside CRLF.
        c0_bytes = ([0x00] + list(range(0x01, 0x09)) + [0x0B, 0x0C]
                    + list(range(0x0E, 0x20)))
        for byte in c0_bytes:
            with open(os.path.join(repo, f"c0-{byte:02x}.md"), "wb") as handle:
                handle.write(b"clean text " + bytes([byte]) + b" more text\n")
        with open(os.path.join(repo, "c0-0d-lone.md"), "wb") as handle:
            handle.write(b"first line\rsecond line\n")
        # A control byte past the first 8 KiB must still be caught: the old
        # check only read the head of each file.
        with open(os.path.join(repo, "c0-deep.md"), "wb") as handle:
            handle.write(b"x" * 9000 + b"\x07\n")
        # Tab, LF and CR-as-CRLF are legitimate and must stay quiet here.
        # (CRLF itself is still rejected, by scripts/check_line_endings.sh --
        # this gate only refuses to bless a lone CR, it does not own CRLF.)
        with open(os.path.join(repo, "c0-clean.md"), "wb") as handle:
            handle.write(b"tab\there\r\ncrlf above\n")
        run("git", "add", "-A")
        run("git", "commit", "-qm", "encoding")
        enc = [(rel, message) for _, rel, _, message in check_encodings(repo)]
        if not [m for _, m in enc if "UTF-16" in m]:
            failures.append("encoding detector reported nothing on a UTF-16 file")
        if not [m for _, m in enc if "BOM" in m]:
            failures.append("encoding detector reported nothing on a UTF-8 BOM file")
        for byte in c0_bytes:
            rel = f"c0-{byte:02x}.md"
            found = [m for r, m in enc if r.endswith(rel)]
            if not found or f"0x{byte:02x}" not in found[0]:
                failures.append(f"encoding detector did not report C0 byte 0x{byte:02x} in {rel}")
        lone = [m for r, m in enc if r.endswith("c0-0d-lone.md")]
        if not lone or "0x0d" not in lone[0].lower() or "lone" not in lone[0].lower():
            failures.append("encoding detector did not report a lone CR")
        deep = [m for r, m in enc if r.endswith("c0-deep.md")]
        if not deep or "offset 9000" not in deep[0]:
            failures.append("encoding detector missed a C0 byte past the first 8 KiB")
        if [r for r, _ in enc if r.endswith("c0-clean.md")]:
            failures.append("encoding detector fired on tab / LF / CRLF, which are legitimate")

    if failures:
        for message in failures:
            print(f"SELF-TEST FAIL: {message}")
        return 1
    print("self-test: workflow, path, gate, encoding, PR-cap and relocation detectors each "
          "fired on deliberate faults and stayed quiet on valid fixtures. The checker is "
          "capable of failing.")
    return 0


# ---------------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Fail loudly on workflows GitHub's parser would reject, on CI gates that "
                    "quietly disappeared, and on text files committed as binary-looking UTF-16 "
                    "or carrying C0 control bytes.")
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
    if "paths" in rules:
        problems += check_path_filters(root)
    if "encoding" in rules:
        problems += check_encodings(root, base)
    if "prcap" in rules:
        problems += pr_cap_problems(root, base)
    if "prmoves" in rules:
        problems += pr_moves_problems(root, base)

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
