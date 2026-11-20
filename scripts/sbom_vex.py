#!/usr/bin/env python3
"""CycloneDX SBOM + VEX advisory gate (issue #612).

Runs in CI before a release is considered publishable, and locally as the same
one command. It answers three questions and fails closed on each:

1. **Is every published artifact described by a valid CycloneDX SBOM?**
   Structural checks (bomFormat/specVersion, a component per dependency with a
   real name and version, well-formed hashes), plus an index that binds each
   artifact's *actual* sha256 to the SBOM that describes it.

2. **Has any ingredient changed without the change being reviewed?**
   `--baseline` holds the committed component inventory. A component added,
   removed or version-bumped is drift: regenerate the SBOM deliberately, review
   the diff, and update the baseline with `--write-baseline`.

3. **Has every advisory been triaged in machine-readable VEX?**
   cargo-deny, `npm audit` and `pip-audit` findings are normalised and each one
   must have a CycloneDX VEX entry stating affected / not_affected / fixed /
   under_investigation with a justification, an owner, a reviewed date and an
   expiry. An unreviewed advisory, an expired entry, an entry whose version
   disagrees with the SBOM, or a critical/high advisory left `under_investigation`
   blocks the gate. There is no ignore list: `deny.toml`'s `ignore` entries
   must also exist here as VEX, or this gate reports them as unreviewed.

Exit status: 0 clean, 1 gate failure, 2 usage error.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path

SCHEMA_INDEX = "streampay.sbom-index/v1"
SCHEMA_BASELINE = "streampay.sbom-baseline/v1"
SPEC_VERSIONS = {"1.4", "1.5", "1.6"}
SEVERITIES = {"critical", "high", "medium", "low", "info", "unknown"}
STATES = {"affected", "not_affected", "fixed", "under_investigation"}
BLOCKING_SEVERITIES = {"critical", "high", "unknown"}

PROP_NO_DEPS = "streampay:sbom:no-third-party-dependencies"
PROP_OWNER = "streampay:vex:owner"
PROP_EXPIRES = "streampay:vex:expires"
PROP_REVIEWED = "streampay:vex:reviewed_at"

PURL_RE = re.compile(r"^pkg:(?P<type>[^/]+)/(?P<name>.+?)(?:@(?P<version>[^?#]+))?(?:[?#].*)?$")


class Gate:
    """Collects failures and warnings so one run reports everything at once."""

    def __init__(self) -> None:
        self.failures: list[str] = []
        self.warnings: list[str] = []

    def fail(self, message: str) -> None:
        self.failures.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    @property
    def ok(self) -> bool:
        return not self.failures


def load_json(path: Path, gate: Gate, *, what: str) -> dict | list | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        gate.fail(f"{what}: file not found: {path}")
    except json.JSONDecodeError as exc:
        gate.fail(f"{what}: {path} is not valid JSON ({exc})")
    return None


def load_advisory_report(path: Path, gate: Gate, *, what: str) -> list[object] | None:
    """Advisory reports arrive in more than one JSON *shape*.

    `cargo deny --audit-compatible-output` writes one document, but the bare
    `cargo deny --format json` shape is a stream of one document per finding,
    and any tool that appends rather than rewrites produces a stream too. A
    single `json.loads` rejects the stream, and the cheapest way out of that
    error is to drop the report — which reads as "no advisories". So every
    complete document in the file is accepted, and anything that is not a
    complete stream (truncated, empty, half-written) is a loud failure.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        gate.fail(f"{what}: cannot read {path} ({exc})")
        return None
    if not text.strip():
        gate.fail(f"{what}: {path} is empty; the tool produced no report at all")
        return None
    decoder = json.JSONDecoder()
    documents: list[object] = []
    index = 0
    while index < len(text):
        while index < len(text) and text[index] in " \t\r\n":
            index += 1
        if index >= len(text):
            break
        try:
            document, index = decoder.raw_decode(text, index)
        except json.JSONDecodeError as exc:
            gate.fail(
                f"{what}: {path} is not a complete JSON document stream "
                f"(offset {index}: {exc.msg}); refusing to read it as 'no advisories'"
            )
            return None
        documents.append(document)
    if not documents:
        gate.fail(f"{what}: {path} contains no JSON document")
        return None
    return documents


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_purl(ref: str) -> tuple[str, str | None] | None:
    match = PURL_RE.match(ref)
    if not match:
        return None
    return match.group("name"), match.group("version")


def parse_pairs(values: list[str] | None) -> dict[str, Path]:
    """`--sbom name=path` and friends."""
    pairs: dict[str, Path] = {}
    for item in values or []:
        name, _, raw = item.partition("=")
        if not name or not raw:
            raise SystemExit(f"expected NAME=PATH, got {item!r}")
        pairs[name] = Path(raw)
    return pairs


# ── SBOM validation ─────────────────────────────────────────────────────────


def component_inventory(sbom: dict, name: str, gate: Gate) -> dict[str, str]:
    """Return {component_name: version} for one SBOM, checking its structure."""
    where = f"SBOM '{name}'"
    if sbom.get("bomFormat") != "CycloneDX":
        gate.fail(f"{where}: bomFormat is {sbom.get('bomFormat')!r}, not 'CycloneDX'")
        return {}
    if str(sbom.get("specVersion")) not in SPEC_VERSIONS:
        gate.fail(f"{where}: unsupported CycloneDX specVersion {sbom.get('specVersion')!r}")

    components = sbom.get("components")
    if not isinstance(components, list) or not components:
        # An empty inventory is either a failed generation or an artifact that
        # genuinely has no third-party dependencies. Only the second is
        # acceptable, and it has to say so explicitly.
        declared = any(
            isinstance(prop, dict)
            and prop.get("name") == PROP_NO_DEPS
            and str(prop.get("value", "")).lower() == "true"
            for prop in (sbom.get("metadata") or {}).get("properties") or []
        )
        if declared:
            gate.warn(f"{where}: declares no third-party dependencies ({PROP_NO_DEPS})")
            return {}
        gate.fail(
            f"{where}: declares no components; an empty SBOM proves nothing unless the artifact "
            f"is stdlib-only and says so with metadata property {PROP_NO_DEPS}=true"
        )
        return {}

    inventory: dict[str, str] = {}
    for index, component in enumerate(components):
        label = f"{where} component #{index + 1}"
        if not isinstance(component, dict):
            gate.fail(f"{label}: not an object")
            continue
        comp_name = component.get("name")
        if not isinstance(comp_name, str) or not comp_name.strip():
            gate.fail(f"{label}: has no name")
            continue
        label = f"{where} component '{comp_name}'"

        version = component.get("version")
        purl_version = None
        purl = component.get("purl")
        if isinstance(purl, str):
            parsed = parse_purl(purl)
            if parsed is None:
                gate.fail(f"{label}: purl {purl!r} is not a package URL")
            else:
                purl_version = parsed[1]
                if comp_name.lower() not in parsed[0].lower() and parsed[0].lower() not in comp_name.lower():
                    gate.warn(f"{label}: purl names {parsed[0]!r}")
        if not isinstance(version, str) or not version.strip():
            version = purl_version
        if not isinstance(version, str) or not version.strip():
            gate.fail(f"{label}: has no version (and no purl binding one)")
            continue
        if version.strip().lower() in {"latest", "unknown", "n/a", "*"}:
            gate.fail(f"{label}: version {version!r} is not a resolved version")
            continue

        hashes = component.get("hashes")
        if hashes is not None:
            if not isinstance(hashes, list) or not hashes:
                gate.warn(f"{label}: empty hash list; omit the field instead")
            for digest in hashes:
                if not isinstance(digest, dict) or not digest.get("alg") or not digest.get("content"):
                    gate.fail(f"{label}: malformed hash entry {digest!r}")
                    break
                content = str(digest["content"])
                expected = {"SHA-256": 64, "SHA-512": 128, "SHA-1": 40, "SHA-384": 96}.get(
                    str(digest["alg"]).upper()
                )
                if expected and not re.fullmatch(rf"[0-9a-fA-F]{{{expected}}}", content):
                    gate.fail(f"{label}: {digest['alg']} hash is not {expected} hex characters")

        previous = inventory.get(comp_name)
        if previous is not None and previous != version:
            # Two versions of one package in one artifact is exactly the kind of
            # thing a VEX entry would silently mis-attribute.
            gate.warn(f"{label}: also appears at version {previous}")
        inventory.setdefault(comp_name, version)
    return inventory


# ── lockfile cross-check ───────────────────────────────────────────────────


def lockfile_components(path: Path, gate: Gate) -> dict[str, str]:
    """Resolved packages from a Cargo.lock or package-lock.json.

    The lockfile is the ground truth for what a build actually installs, so
    comparing the SBOM against it is drift detection that needs no committed
    baseline: an SBOM that disagrees with the lock is either stale (it hides a
    dependency from advisory review) or hand-edited.
    """
    if not path.is_file():
        gate.fail(f"lockfile: file not found: {path}")
        return {}
    resolved: dict[str, str] = {}
    if path.name.endswith("package-lock.json") or path.suffix == ".json":
        document = load_json(path, gate, what=f"lockfile {path}")
        if not isinstance(document, dict):
            return {}
        packages = document.get("packages")
        if isinstance(packages, dict):
            for key, meta in packages.items():
                if not key or not isinstance(meta, dict) or not meta.get("version"):
                    continue
                name = meta.get("name") or key.rsplit("node_modules/", 1)[-1]
                resolved[str(name)] = str(meta["version"])
            return resolved
        dependencies = document.get("dependencies")
        if isinstance(dependencies, dict):
            for name, meta in dependencies.items():
                if isinstance(meta, dict) and meta.get("version"):
                    resolved[str(name)] = str(meta["version"])
        return resolved

    # Cargo.lock: a TOML subset, read with a regex rather than a TOML parser so
    # the gate keeps running on the CI image's stock python3.
    text = path.read_text(encoding="utf-8")
    for block in re.split(r"^\s*\[\[package\]\]\s*$", text, flags=re.MULTILINE)[1:]:
        name = re.search(r'^\s*name\s*=\s*"([^"]+)"', block, flags=re.MULTILINE)
        version = re.search(r'^\s*version\s*=\s*"([^"]+)"', block, flags=re.MULTILINE)
        if name and version:
            resolved[name.group(1)] = version.group(1)
    return resolved


def check_lockfile(sbom_name: str, comps: dict[str, str], lock_path: Path, gate: Gate) -> None:
    resolved = lockfile_components(lock_path, gate)
    if not resolved:
        return
    for name, version in sorted(resolved.items()):
        shipped = comps.get(name)
        if shipped is None:
            gate.fail(
                f"SBOM drift: {lock_path.name} resolves '{name}@{version}' but SBOM '{sbom_name}' "
                f"does not list it; an unlisted dependency is invisible to advisory review"
            )
        elif shipped != version:
            gate.fail(
                f"SBOM drift: SBOM '{sbom_name}' says '{name}@{shipped}', {lock_path.name} resolves {version}"
            )


# ── advisory normalisation ─────────────────────────────────────────────────


def normalize_severity(raw: object) -> str:
    value = str(raw or "").strip().lower()
    if value in SEVERITIES:
        return value
    return "unknown"


def severity_from_cvss(score: object) -> str:
    try:
        value = float(score)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "unknown"
    if value >= 9.0:
        return "critical"
    if value >= 7.0:
        return "high"
    if value >= 4.0:
        return "medium"
    if value > 0:
        return "low"
    return "unknown"


def advisory(ident: str, package: str | None, version: str | None, severity: str, source: str) -> dict:
    return {
        "id": ident,
        "package": package,
        "version": version,
        "severity": normalize_severity(severity),
        "source": source,
    }


RUSTSEC_RE = re.compile(r"RUSTSEC-\d{4}-\d{4,}")


def advisories_from_cargo_deny(report: object, raw: str = "") -> list[dict]:
    """cargo-deny advisory findings.

    Two output shapes have existed and both appear in the wild: the table form
    (`{"advisories": {"found": [...]}}`, also what `cargo audit --json` puts
    under `vulnerabilities.list`) and the diagnostic stream cargo-deny emits for
    `--format json`. Rather than pin one and silently parse nothing against the
    other — which would make this gate green while reporting zero advisories —
    the structured shapes are tried first and the raw document is scanned for
    RUSTSEC ids as the fallback. An id can only be over-reported that way, never
    missed, and an over-reported id needs a VEX entry, which is the safe error.
    """
    found: list[dict] = []
    if isinstance(report, dict):
        sections = []
        if isinstance(report.get("advisories"), dict):
            sections.append(report["advisories"])
        if isinstance(report.get("vulnerabilities"), dict):
            sections.append(report["vulnerabilities"])
        for section in sections:
            for key in ("found", "list"):
                for entry in section.get(key) or []:
                    if not isinstance(entry, dict):
                        continue
                    adv = entry.get("advisory") or {}
                    pkg = entry.get("package") or {}
                    ident = adv.get("id")
                    if not ident:
                        continue
                    severity = adv.get("severity")
                    if severity in (None, "", "none"):
                        severity = severity_from_cvss(adv.get("cvss"))
                    found.append(
                        advisory(
                            str(ident),
                            pkg.get("name") or adv.get("package"),
                            pkg.get("version"),
                            str(severity or "unknown"),
                            "cargo-deny",
                        )
                    )
    if not found:
        for ident in sorted(set(RUSTSEC_RE.findall(raw))):
            found.append(advisory(ident, None, None, "unknown", "cargo-deny"))
    return found


GHSA_RE = re.compile(r"(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|CVE-\d{4}-\d+)", re.IGNORECASE)


def advisories_from_npm_audit(report: object, raw: str = "") -> list[dict]:
    """`npm audit --json`, v7+ shape. `via` strings are transitive aggregates."""
    found: list[dict] = []
    if not isinstance(report, dict):
        return found
    for pkg_name, entry in (report.get("vulnerabilities") or {}).items():
        if not isinstance(entry, dict):
            continue
        for via in entry.get("via") or []:
            if not isinstance(via, dict):
                continue
            ident = via.get("source")
            if isinstance(ident, str):
                ident = str(ident)
            elif isinstance(ident, int):
                ident = f"npm-{ident}"
            else:
                ident = None
            if not ident:
                match = GHSA_RE.search(str(via.get("url") or "") + " " + str(via.get("title") or ""))
                ident = match.group(1) if match else None
            if not ident:
                continue
            found.append(
                advisory(
                    ident,
                    str(via.get("name") or pkg_name),
                    None,
                    str(via.get("severity") or entry.get("severity") or "unknown"),
                    "npm-audit",
                )
            )
    return found


def advisories_from_pip_audit(report: object, raw: str = "") -> list[dict]:
    """`pip-audit --format json`, both the list and the {"dependencies"} shape."""
    found: list[dict] = []
    dependencies = report.get("dependencies") if isinstance(report, dict) else report
    if not isinstance(dependencies, list):
        return found
    for dep in dependencies:
        if not isinstance(dep, dict):
            continue
        for vuln in dep.get("vulns") or []:
            if not isinstance(vuln, dict) or not vuln.get("id"):
                continue
            found.append(
                advisory(
                    str(vuln["id"]),
                    dep.get("name"),
                    dep.get("version"),
                    str(vuln.get("severity") or "unknown"),
                    "pip-audit",
                )
            )
    return found


ADVISORY_PARSERS = {
    "cargo-deny": advisories_from_cargo_deny,
    "npm-audit": advisories_from_npm_audit,
    "pip-audit": advisories_from_pip_audit,
}


# ── VEX validation ──────────────────────────────────────────────────────────


def vex_properties(entry: dict) -> dict[str, str]:
    props: dict[str, str] = {}
    for prop in entry.get("properties") or []:
        if isinstance(prop, dict) and prop.get("name"):
            props[str(prop["name"])] = str(prop.get("value", ""))
    return props


def parse_date(value: str) -> dt.date | None:
    try:
        return dt.date.fromisoformat(value.strip())
    except (AttributeError, ValueError):
        return None


def validate_vex(vex: object, today: dt.date, gate: Gate) -> dict[str, dict]:
    """Validate the document and return {advisory_id: entry}."""
    entries: dict[str, dict] = {}
    if not isinstance(vex, dict):
        gate.fail("VEX: document is not a JSON object")
        return entries
    if vex.get("bomFormat") != "CycloneDX":
        gate.fail("VEX: bomFormat must be 'CycloneDX'")
    if str(vex.get("specVersion")) not in SPEC_VERSIONS:
        gate.fail(f"VEX: unsupported specVersion {vex.get('specVersion')!r}")
    vulnerabilities = vex.get("vulnerabilities")
    if not isinstance(vulnerabilities, list):
        gate.fail("VEX: no vulnerabilities array; an empty VEX is not a review")
        return entries

    for entry in vulnerabilities:
        if not isinstance(entry, dict):
            gate.fail("VEX: vulnerability entry is not an object")
            continue
        ident = entry.get("id")
        if not isinstance(ident, str) or not ident.strip():
            gate.fail("VEX: vulnerability entry has no id")
            continue
        where = f"VEX entry {ident}"
        if ident in entries:
            gate.fail(f"{where}: declared twice")
            continue

        analysis = entry.get("analysis") or {}
        state = str(analysis.get("state") or "").strip()
        if state not in STATES:
            gate.fail(f"{where}: analysis.state {state!r} is not one of {sorted(STATES)}")
            continue
        if not str(analysis.get("detail") or "").strip():
            gate.fail(f"{where}: analysis.detail is empty; state '{state}' without a rationale is a silent suppression")
        if state == "not_affected" and not str(analysis.get("justification") or "").strip():
            gate.fail(f"{where}: not_affected requires a CycloneDX justification (e.g. code_not_reachable)")

        props = vex_properties(entry)
        owner = props.get(PROP_OWNER, "").strip()
        if not owner:
            gate.fail(f"{where}: missing {PROP_OWNER} property (who owns this triage)")
        reviewed = parse_date(props.get(PROP_REVIEWED, ""))
        if reviewed is None:
            gate.fail(f"{where}: missing or invalid {PROP_REVIEWED} (YYYY-MM-DD)")
        elif reviewed > today:
            gate.fail(f"{where}: {PROP_REVIEWED} is in the future ({reviewed})")
        expires = parse_date(props.get(PROP_EXPIRES, ""))
        if expires is None:
            gate.fail(f"{where}: missing or invalid {PROP_EXPIRES} (YYYY-MM-DD)")
        elif expires < today:
            gate.fail(
                f"{where}: VEX expired on {expires}; re-review the advisory and extend "
                f"{PROP_EXPIRES} or, better, drop it once the dependency is gone"
            )

        affects = entry.get("affects")
        if not isinstance(affects, list) or not affects:
            gate.fail(f"{where}: has no affects[] ref, so it binds to no component")
        else:
            for affect in affects:
                ref = affect.get("ref") if isinstance(affect, dict) else None
                parsed = parse_purl(ref) if isinstance(ref, str) else None
                if parsed is None:
                    gate.fail(f"{where}: affects ref {ref!r} is not a package URL (pkg:type/name@version)")
                elif not parsed[1]:
                    gate.fail(f"{where}: affects ref {ref!r} does not pin a version")

        if state == "under_investigation":
            # The one loophole a severity gate must not have: "we are looking at
            # it" is not a decision, and it never expires on its own.
            gate.warn(f"{where}: under_investigation; the advisory still has to be decided before expiry")

        normalized = dict(entry)
        normalized["_state"] = state
        normalized["_package"], normalized["_version"] = (None, None)
        if isinstance(affects, list) and affects and isinstance(affects[0], dict):
            parsed = parse_purl(str(affects[0].get("ref", "")))
            if parsed:
                normalized["_package"], normalized["_version"] = parsed
        entries[ident] = normalized
    return entries


# ── the gate ────────────────────────────────────────────────────────────────


def run_gate(args: argparse.Namespace) -> int:
    gate = Gate()
    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()
    sboms = parse_pairs(args.sbom)
    artifacts = parse_pairs(args.artifact)

    if not sboms and not args.self_check:
        gate.fail("no --sbom inputs: the gate has nothing to gate")

    # 1. SBOM structure + inventory.
    inventory: dict[str, dict[str, str]] = {}
    for name, path in sboms.items():
        if not path.is_file():
            gate.fail(f"SBOM '{name}': file not found: {path}")
            continue
        document = load_json(path, gate, what=f"SBOM '{name}'")
        if isinstance(document, dict):
            inventory[name] = component_inventory(document, name, gate)

    # 2. Artifact-level binding: the bytes an SBOM describes must be the bytes
    #    being published, and the SBOM index records both digests.
    index_artifacts = []
    for name, path in artifacts.items():
        if not path.is_file():
            gate.fail(f"artifact '{name}': file not found: {path}")
            continue
        sbom_name = args.sbom_for.get(name) if args.sbom_for else None
        matching = [key for key in sboms if key == name or key.startswith(f"{name}-") or key.endswith(f"-{name}")]
        if not sbom_name and not matching:
            gate.fail(
                f"artifact '{name}': no SBOM covers it (pass --sbom-for {name}=<sbom name>); "
                "an artifact shipped without a component inventory cannot be audited"
            )
            continue
        sbom_key = sbom_name or matching[0]
        sbom_path = sboms[sbom_key]
        index_artifacts.append(
            {
                "name": name,
                "path": str(path),
                "sha256": sha256_file(path),
                "sbom": str(sbom_path),
                "sbom_sha256": sha256_file(sbom_path) if sbom_path.is_file() else None,
                "components": len(inventory.get(sbom_key, {})),
            }
        )

    # 3. Baseline drift: an ingredient changed without a deliberate review.
    if args.baseline:
        baseline_path = Path(args.baseline)
        if args.write_baseline:
            baseline = {
                "schema": SCHEMA_BASELINE,
                "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "sboms": {name: dict(sorted(comp.items())) for name, comp in sorted(inventory.items())},
            }
            baseline_path.parent.mkdir(parents=True, exist_ok=True)
            baseline_path.write_text(json.dumps(baseline, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(f"baseline written: {baseline_path}")
        else:
            baseline = load_json(baseline_path, gate, what="baseline") or {}
            if isinstance(baseline, dict) and baseline and baseline.get("schema") != SCHEMA_BASELINE:
                gate.fail(f"baseline: schema is {baseline.get('schema')!r}, not {SCHEMA_BASELINE!r}")
            committed = baseline.get("sboms", {}) if isinstance(baseline, dict) else {}
            for name, comps in inventory.items():
                if name not in committed:
                    gate.fail(
                        f"SBOM drift: '{name}' has no committed baseline entry. "
                        f"Review the SBOM, then run with --write-baseline."
                    )
                    continue
                expected = {str(k): str(v) for k, v in (committed[name] or {}).items()}
                added = sorted(set(comps) - set(expected))
                removed = sorted(set(expected) - set(comps))
                changed = sorted(k for k in set(comps) & set(expected) if comps[k] != expected[k])
                for key in added:
                    gate.fail(f"SBOM drift: '{name}' gained component '{key}@{comps[key]}' (not in baseline)")
                for key in removed:
                    gate.fail(f"SBOM drift: '{name}' lost component '{key}' (in baseline at {expected[key]})")
                for key in changed:
                    gate.fail(
                        f"SBOM drift: '{name}' component '{key}' is {comps[key]}, baseline says {expected[key]}"
                    )

    # 3b. Lockfile cross-check: the SBOM must describe what the build installs.
    for item in args.lock or []:
        sbom_name, _, lock_raw = item.partition("=")
        if not sbom_name or not lock_raw:
            gate.fail(f"--lock expects SBOM_NAME=PATH, got {item!r}")
            continue
        if sbom_name not in inventory:
            gate.fail(f"--lock names SBOM '{sbom_name}', which was not passed to --sbom")
            continue
        check_lockfile(sbom_name, inventory[sbom_name], Path(lock_raw), gate)

    # 4. Advisory review through VEX.
    # `--advisories` may name the same tool more than once (one report per npm
    # package), so it is kept as a list rather than a dict.
    advisory_reports: list[tuple[str, Path]] = []
    for item in args.advisories or []:
        tool, _, raw = item.partition("=")
        if not tool or not raw:
            gate.fail(f"--advisories expects TOOL=PATH, got {item!r}")
            continue
        advisory_reports.append((tool, Path(raw)))

    vex_entries: dict[str, dict] = {}
    if args.vex:
        document = load_json(Path(args.vex), gate, what="VEX")
        if document is not None:
            vex_entries = validate_vex(document, today, gate)

    reported: list[dict] = []
    for tool, path in advisory_reports:
        parser = ADVISORY_PARSERS.get(tool)
        if parser is None:
            gate.fail(f"advisories: unknown tool {tool!r}; expected one of {sorted(ADVISORY_PARSERS)}")
            continue
        if not path.is_file():
            gate.fail(f"advisories '{tool}': file not found: {path}")
            continue
        documents = load_advisory_report(path, gate, what=f"advisories '{tool}'")
        if documents is None:
            continue
        before = len(reported)
        for document in documents:
            reported.extend(parser(document))
        if len(reported) == before:
            # No document matched the structured shapes. Scan the raw text for
            # identifiers instead, so an unfamiliar-but-real report still names
            # what it found rather than passing as clean.
            raw = path.read_text(encoding="utf-8", errors="replace")
            reported.extend(parser(None, raw))

    seen: set[str] = set()
    for item in reported:
        ident = item["id"]
        if ident in seen:
            continue
        seen.add(ident)
        entry = vex_entries.get(ident)
        where = f"advisory {ident}" + (f" ({item['package']})" if item.get("package") else "")
        if entry is None:
            message = (
                f"{where}: reported by {item['source']} at {item['severity']} severity and has no VEX entry. "
                "Triage it in security/vex/vex.json (see security/vex/README.md); an unexplained "
                "advisory is not the same as an accepted one."
            )
            # Issue #612 scopes the *blocking* rule to critical/high; anything
            # else is still reported by name so it can never be suppressed
            # silently, but does not stop a release on its own.
            if item["severity"] in BLOCKING_SEVERITIES:
                gate.fail(message)
            else:
                gate.warn(message)
            continue
        if item["severity"] in BLOCKING_SEVERITIES and entry["_state"] == "under_investigation":
            gate.fail(
                f"{where}: {item['severity']} severity is still under_investigation; "
                "decide affected / not_affected / fixed before releasing"
            )
        # Version drift: the VEX decided about one version, the SBOM now ships
        # another. The old decision does not apply to the new bytes.
        if entry.get("_package") and item.get("package") and entry["_package"].lower() != str(item["package"]).lower():
            gate.warn(f"{where}: VEX affects '{entry['_package']}', the report names '{item['package']}'")
        if entry.get("_package"):
            for comps in inventory.values():
                shipped = comps.get(entry["_package"]) or comps.get(str(entry["_package"]).replace("_", "-"))
                if shipped and entry.get("_version") and shipped != entry["_version"]:
                    gate.fail(
                        f"{where}: VEX is written for {entry['_package']}@{entry['_version']} "
                        f"but the SBOM ships {shipped}; re-triage against the shipped version"
                    )
                    break

    for ident in sorted(set(vex_entries) - seen):
        if advisory_reports:
            gate.warn(f"VEX entry {ident}: no longer reported by any advisory source (stale review)")

    # 5. Publish the index that ties artifacts, SBOMs and the VEX together.
    if args.index_out:
        index = {
            "schema": SCHEMA_INDEX,
            "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "vex": (
                {"path": str(args.vex), "sha256": sha256_file(Path(args.vex))}
                if args.vex and Path(args.vex).is_file()
                else None
            ),
            "artifacts": index_artifacts,
        }
        out = Path(args.index_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(index, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"index written: {out}")

    # 6. Report.
    for warning in gate.warnings:
        print(f"warning: {warning}")
    for failure in gate.failures:
        print(f"error: {failure}")
    if gate.failures:
        print(f"\nSBOM/VEX gate failed: {len(gate.failures)} problem(s), {len(gate.warnings)} warning(s)")
        return 1
    components = sum(len(comps) for comps in inventory.values())
    print(
        f"SBOM/VEX gate passed: {len(inventory)} SBOM(s), {components} component(s), "
        f"{len(vex_entries)} VEX entr{'y' if len(vex_entries) == 1 else 'ies'}, "
        f"{len(reported)} advisory finding(s), {len(gate.warnings)} warning(s)"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="CycloneDX SBOM + VEX advisory gate (issue #612)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--sbom", action="append", metavar="NAME=PATH", help="CycloneDX SBOM per artifact")
    parser.add_argument("--artifact", action="append", metavar="NAME=PATH", help="published artifact to bind")
    parser.add_argument(
        "--sbom-for",
        action="append",
        metavar="ARTIFACT=SBOM",
        help="explicit artifact-to-SBOM mapping when names do not match",
    )
    parser.add_argument(
        "--advisories",
        action="append",
        metavar="TOOL=PATH",
        help=f"advisory report: {', '.join(sorted(ADVISORY_PARSERS))}",
    )
    parser.add_argument(
        "--lock",
        action="append",
        metavar="SBOM=LOCKFILE",
        help="cross-check an SBOM against Cargo.lock / package-lock.json (drift detection)",
    )
    parser.add_argument("--vex", metavar="PATH", help="CycloneDX VEX document")
    parser.add_argument("--baseline", metavar="PATH", help="committed SBOM inventory baseline")
    parser.add_argument("--write-baseline", action="store_true", help="rewrite the baseline from these SBOMs")
    parser.add_argument("--index-out", metavar="PATH", help="write the signed SBOM index here")
    parser.add_argument("--today", metavar="YYYY-MM-DD", help="evaluate VEX expiry against this date")
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="validate the gate's own inputs only (no SBOMs required)",
    )
    args = parser.parse_args(argv)
    args.sbom_for = dict((item.split("=", 1) for item in args.sbom_for or []))
    if args.write_baseline and not args.baseline:
        parser.error("--write-baseline requires --baseline")
    return run_gate(args)


if __name__ == "__main__":
    sys.exit(main())
