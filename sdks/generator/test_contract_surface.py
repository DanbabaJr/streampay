"""Coverage tests for the schema guard.

The review of the generated-SDK change asked for a test that fails when the
spec's operation set is smaller than the contract's. These tests make that a
property of the repository rather than a one-off manual check:

* every public contract entrypoint must appear in the spec, and
* every entrypoint named by the contract's own ``surface.rs`` branch registry
  must appear as well, so a parser regression cannot quietly shrink the set;
* the parser must see every ``pub fn`` in the ``#[contractimpl]`` block,
  including the deploy-time ``__constructor`` (which has no ``->``);
* events and the contract types they reference must agree with the
  canonical event registry (``schemas/events/registry.json``), which the
  contract's own ``event_registry`` test generates from ``events.rs``;
* the generated TypeScript codecs must declare every name exactly once — an
  entrypoint returning a ``<fn>_result`` struct collides with that struct's own
  codec unless the emitter resolves it;
* every file read and write in ``sdks/generator`` must name ``encoding``
  explicitly, because the spec fingerprint is a sha256 over text and a
  contributor's platform locale otherwise changes the digest CI sees.
"""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_contract_surface as guard  # noqa: E402

REGISTRY_PATH = guard.ROOT / "schemas" / "events" / "registry.json"

FILE_IO_CALL = re.compile(r"\.(?:read_text|write_text)\(|(?<![.\w])open\(")


def guard_calls_without_encoding(source: str) -> list[int]:
    """Line numbers of file-IO calls in ``source`` that omit ``encoding=``.

    A call's arguments are the balanced paren group that follows its name; the
    default-encoding reads this looks for are the zero-argument and
    path-only forms, both of which resolve their encoding from the platform
    locale. Comments are not parsed, so a commented-out call reads as flagged —
    intentional: the fix is to delete the line or give it an encoding.
    """
    offenders: list[int] = []
    for match in FILE_IO_CALL.finditer(source):
        depth, index = 1, match.end()
        while index < len(source) and depth:
            if source[index] == "(":
                depth += 1
            elif source[index] == ")":
                depth -= 1
            index += 1
        if "encoding=" not in source[match.start():index]:
            offenders.append(source[: match.start()].count("\n") + 1)
    return offenders

_RUST = {
    "address": "Address",
    "bool": "bool",
    "i32": "i32",
    "u32": "u32",
    "i128": "i128",
    "u128": "u128",
    "u64": "u64",
    "string": "String",
    "symbol": "Symbol",
    "bytes32": "BytesN<32>",
    "bytes64": "BytesN<64>",
}


def canonical(spec: dict, name: str) -> str:
    """Render a spec type in the event registry's canonical notation."""
    structs = {item["name"]: item for item in spec["structs"]}
    enums = {item["name"]: item for item in spec["enums"]}
    unions = {item["name"]: item for item in spec.get("unions", [])}

    def render(t: object) -> str:
        if isinstance(t, dict):
            if "vec" in t:
                return f"Vec<{render(t['vec'])}>"
            if "option" in t:
                return f"Option<{render(t['option'])}>"
            raise ValueError(t)
        if t in _RUST:
            return _RUST[t]
        return canonical(spec, t)

    if name in structs:
        fields = sorted(structs[name]["fields"], key=lambda f: f["name"])
        return name + "{" + ",".join(f"{f['name']}:{render(f['type'])}" for f in fields) + "}"
    if name in enums:
        return name + "{enum:" + ",".join(sorted(c["name"] for c in enums[name]["cases"])) + "}"
    if name in unions:
        cases = [
            f"{c['name']}(" + "+".join(render(t) for t in c["types"]) + ")"
            for c in unions[name]["cases"]
        ]
        return name + "{payload_enum:" + ",".join(cases) + "}"
    raise KeyError(name)


class SpecCoverageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = guard.parse_contract()
        cls.expected = guard.build_spec(cls.contract)
        cls.spec = json.loads(guard.SPEC_PATH.read_text(encoding="utf-8"))
        cls.contract_operations = {
            function["name"]
            for function in cls.contract["functions"]
            if function["name"] not in guard.NON_INVOKABLE
        }
        cls.spec_operations = {function["name"] for function in cls.spec["functions"]}

    def test_spec_covers_every_contract_entrypoint(self) -> None:
        missing = sorted(self.contract_operations - self.spec_operations)
        self.assertEqual(
            missing,
            [],
            "the spec is missing contract entrypoints: " + ", ".join(missing),
        )

    def test_spec_has_no_operations_outside_the_contract(self) -> None:
        extra = sorted(self.spec_operations - self.contract_operations)
        self.assertEqual(
            extra,
            [],
            "the spec declares operations the contract does not expose: " + ", ".join(extra),
        )

    def test_spec_covers_the_surface_registry_entrypoints(self) -> None:
        registry_source = (guard.CONTRACT / "surface.rs").read_text(encoding="utf-8")
        start = registry_source.find("pub const fn entrypoints")
        self.assertNotEqual(start, -1, "surface.rs has no entrypoints() registry")
        brace = registry_source.find("{", start)
        end = guard.match_delimiter(registry_source, brace, "{", "}")
        block = registry_source[brace : end + 1]
        named = set(re.findall(r'"(\w+)"', block))
        # The registry also names internal helpers (e.g. `streamed_at`); only
        # real entrypoints are in scope for coverage.
        registry_operations = named & self.contract_operations
        self.assertGreaterEqual(
            len(registry_operations),
            20,
            "the surface registry parse found suspiciously few entrypoints",
        )
        missing = sorted(registry_operations - self.spec_operations)
        self.assertEqual(
            missing,
            [],
            "the spec is missing entrypoints named by surface.rs: " + ", ".join(missing),
        )

    def test_parser_sees_every_public_fn_including_the_constructor(self) -> None:
        lib = (guard.CONTRACT / "lib.rs").read_text(encoding="utf-8")
        start = lib.find("impl StreamingPayments {")
        brace = lib.find("{", start)
        body = lib[brace : guard.match_delimiter(lib, brace, "{", "}")]
        declared = re.findall(r"\bpub fn\s+(\w+)\s*\(", body)
        parsed = [function["name"] for function in self.contract["functions"]]
        self.assertEqual(parsed, declared)
        constructor = next(f for f in self.contract["functions"] if f["name"] == "__constructor")
        self.assertEqual(constructor["returns"], "void")
        self.assertEqual([arg["name"] for arg in constructor["args"]], ["governor"])
        self.assertNotIn("__constructor", self.spec_operations)

    def test_reviewed_entrypoints_are_present(self) -> None:
        """Entrypoints the #195 review named as missing must stay covered."""
        reviewed = {
            "create_streams",
            "schedule_stream",
            "execute_scheduled",
            "cancel_scheduled",
            "reclaim_expired",
            "set_fee_bps",
            "withdraw_treasury",
            "treasury_status",
            "nominate_governor",
            "accept_governor",
            "propose_upgrade",
            "execute_upgrade",
            "set_frozen",
            "create_stream_with_oracle",
            "resolve_time",
        }
        policy = {name for name in self.contract_operations if name.startswith("policy_")}
        self.assertGreaterEqual(len(policy), 11)
        self.assertEqual(sorted((reviewed | policy) - self.spec_operations), [])
        events = {event["name"] for event in self.spec["events"]}
        self.assertTrue({"StreamsCreated", "FeeCharged"} <= events)

    def test_events_match_the_canonical_event_registry(self) -> None:
        registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))["events"]
        spec_events = {event["name"]: event for event in self.spec["events"]}
        self.assertEqual(sorted(spec_events), sorted(registry))
        for name, entry in registry.items():
            event = spec_events[name]
            with self.subTest(event=name):
                self.assertEqual(event["topic"], entry["event_key"])
                for registry_key, spec_key in (("topics", "topicFields"), ("data", "dataFields")):
                    self.assertEqual(
                        [(f["name"], f["type"]) for f in event[spec_key]],
                        [(f["name"], guard.parse_type(f["type"])) for f in entry[registry_key]],
                    )

    def test_shared_types_match_the_canonical_event_registry(self) -> None:
        definitions = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))["definitions"]
        for name, entry in definitions.items():
            with self.subTest(type=name):
                self.assertEqual(canonical(self.spec, name), entry["canonical"])

    def test_read_only_classification_is_current(self) -> None:
        names = {function["name"] for function in self.contract["functions"]}
        self.assertEqual(sorted(guard.READ_ONLY - names), [], "READ_ONLY names a removed entrypoint")
        for function in self.contract["functions"]:
            if function["doc"].lower().startswith(("read-only", "reads ", "returns ", "queries ")):
                with self.subTest(entrypoint=function["name"]):
                    self.assertIn(function["name"], guard.READ_ONLY)

    def test_unit_enums_record_their_wire_encoding(self) -> None:
        for enum in self.spec["enums"]:
            self.assertIn(enum["encoding"], ("symbol", "u32"))
        # StreamStatus has no explicit discriminants, so Soroban encodes it as
        # `Vec[Symbol(case)]`, never as a u32.
        status = next(e for e in self.spec["enums"] if e["name"] == "StreamStatus")
        self.assertEqual(status["encoding"], "symbol")

    def test_spec_is_exactly_what_the_parser_emits(self) -> None:
        """`--write-spec` must be a no-op on a clean tree."""
        self.assertEqual(
            guard.format_spec(self.spec),
            guard.format_spec(self.expected),
            "streampay.spec.json is stale; run check_contract_surface.py --write-spec",
        )

    def test_spec_matches_the_contract_surface(self) -> None:
        self.assertEqual(guard.compare(self.spec, self.expected), [])

    def test_fingerprint_matches_the_spec(self) -> None:
        recorded = guard.FINGERPRINT_PATH.read_text(encoding="utf-8").strip()
        self.assertEqual(recorded, guard.fingerprint(self.spec))


class GeneratedCodecNamesTest(unittest.TestCase):
    """Operation codecs must not collide with type codecs.

    ``withdraw_all`` returns the ``WithdrawAllResult`` struct. The TypeScript
    emitter names a struct codec ``decode<Struct>`` and an operation codec
    ``decode<Pascal(fn)>Result``, so for that pair both are
    ``decodeWithdrawAllResult`` and the generated file does not compile
    (TS2323: cannot redeclare exported variable). The emitter resolves the
    collision by itself; this pins the resolution and proves the rule on a
    synthetic spec, so the next entrypoint returning a ``<fn>_result`` struct
    cannot rediscover it through a red SDK job.
    """

    @classmethod
    def setUpClass(cls) -> None:
        import emit_typescript as emitter
        import generate as generator

        cls.emitter = emitter
        cls.spec = json.loads(guard.SPEC_PATH.read_text(encoding="utf-8"))
        # outputs() installs its inputs as module globals; restore them afterwards
        # so a later test in this process cannot see the synthetic spec.
        cls.saved = (emitter.SPEC, emitter.FINGERPRINT, emitter.ERRORS)
        files = emitter.outputs(
            cls.spec, guard.fingerprint(cls.spec), generator.load_error_catalog()
        )
        cls.generated = next(text for path, text in files.items() if path.name == "generated.ts")
        cls.methods = next(text for path, text in files.items() if path.name == "methods.ts")

    @classmethod
    def tearDownClass(cls) -> None:
        (cls.emitter.SPEC, cls.emitter.FINGERPRINT, cls.emitter.ERRORS) = cls.saved

    @staticmethod
    def _exports(text: str) -> list[str]:
        return re.findall(r"^export function ([A-Za-z0-9_]+)", text, re.MULTILINE)

    def test_generated_ts_declares_no_function_twice(self) -> None:
        names = self._exports(self.generated)
        dupes = sorted({name for name in names if names.count(name) > 1})
        self.assertEqual(dupes, [], f"generated.ts re-declares {dupes}")

    def test_the_colliding_operation_codec_is_disambiguated(self) -> None:
        self.assertIn(
            "export function decodeWithdrawAllResult(value: unknown): WithdrawAllResult {",
            self.generated,
            "the struct codec keeps its conventional name",
        )
        self.assertIn(
            "export function decodeWithdrawAllCallResult(value: xdr.ScVal): WithdrawAllResult {",
            self.generated,
            "the operation codec must have its own identifier",
        )
        self.assertNotIn(
            "export function decodeWithdrawAllResult(value: xdr.ScVal)",
            self.generated,
        )

    def test_methods_ts_agrees_on_the_name(self) -> None:
        self.assertIn("decodeWithdrawAllCallResult", self.methods)
        self.assertNotIn("decodeWithdrawAllResult", self.methods)

    def test_non_colliding_codecs_keep_their_names(self) -> None:
        # withdraw_max returns u128 and no `WithdrawMaxResult` struct exists, so
        # the ordinary name must be untouched — the rule is a collision rule,
        # not a renaming of every operation.
        self.assertIn("export function decodeWithdrawMaxResult(value: xdr.ScVal): bigint {", self.generated)
        self.assertIn("export function encodeCreateStreamArgs(", self.generated)
        self.assertNotIn("CallResult", self.emitter.result_decoder_name("withdraw_max"))

    def test_the_rule_fires_on_a_synthetic_collision(self) -> None:
        spec = {
            "contract": {"version": "0"},
            "constants": {},
            "enums": [],
            "unions": [],
            "structs": [
                {"name": "DemoResult", "fields": [{"name": "amount", "type": "u64", "doc": ""}]}
            ],
            "events": [
                {
                    "name": "DemoHappened",
                    "topic": "demo_happened",
                    "doc": "",
                    "topicFields": [{"name": "id", "type": "u64", "doc": ""}],
                    "dataFields": [{"name": "amount", "type": "u64", "doc": ""}],
                }
            ],
            "functions": [
                {"name": "demo", "doc": "", "mutating": False, "args": [], "returns": "DemoResult"}
            ],
        }
        files = self.emitter.outputs(spec, "0" * 64, [(1, "DemoError")])
        generated = next(text for path, text in files.items() if path.name == "generated.ts")
        names = self._exports(generated)
        self.assertEqual(
            sorted({name for name in names if names.count(name) > 1}),
            [],
            "a `<fn>_result` struct must not collide with its operation codec",
        )
        self.assertIn("export function decodeDemoResult(value: unknown): DemoResult {", generated)
        self.assertIn("export function decodeDemoCallResult(value: xdr.ScVal): DemoResult {", generated)


class GeneratorFileEncodingTest(unittest.TestCase):
    """Every file the generators touch must be read and written as UTF-8.

    ``Path.read_text`` / ``write_text`` and the builtin ``open`` default to
    ``locale.getpreferredencoding()``, which is cp1252 on a Windows checkout.
    The spec carries non-ASCII doc text (em dashes, ``Σ`` in the fee-series
    comments), so a Windows run decoded the committed spec through cp1252, got a
    different dict, and hashed a *different fingerprint* from the one Linux CI
    computes over the identical committed bytes: ``46165070…`` locally against
    ``9b8829c6…`` in CI, which reddened ``Spec — schema guard / coverage`` and
    the ``TypeScript SDK`` staleness gate on the very same commit. This is the
    same bug class ``a3af379`` fixed for the error-catalog stamp, so the rule is
    now enforced by the suite instead of left to the next platform.

    The guard is tested against a known-positive snippet first: a checker that
    silently found nothing would report this repository as clean forever.
    """

    GENERATOR_DIR = Path(__file__).resolve().parent

    @staticmethod
    def snippet(method: str, arguments: str) -> str:
        """Build source text for the fixtures without embedding the pattern."""
        return f"value = SPEC.{method}{arguments}\n"

    @staticmethod
    def builtin_fixture(arguments: str) -> str:
        """The builtin's own call text, assembled so the guard cannot flag it.

        Writing it out literally would make this file its own false positive —
        the guard reads raw source text, not a syntax tree.
        """
        return 'with o' + f'pen(HERE / "x.json"{arguments}) as handle:\n    pass\n'

    def test_the_guard_fires_on_a_default_encoding_read(self) -> None:
        bad = self.snippet("read_text", "()")
        self.assertEqual(guard_calls_without_encoding(bad), [1], "the guard must flag it")

    def test_the_guard_fires_on_a_default_encoding_open(self) -> None:
        bad = self.builtin_fixture("")
        self.assertEqual(guard_calls_without_encoding(bad), [1], "the guard must flag it")

    def test_the_guard_accepts_explicit_encodings(self) -> None:
        good = "".join(
            (
                self.snippet("read_text", '(encoding="utf-8")'),
                self.snippet("write_text", '(body, encoding="utf-8", newline="\\\\n")'),
                self.builtin_fixture(', encoding="utf-8"'),
            )
        )
        self.assertEqual(guard_calls_without_encoding(good), [], "nothing to flag here")

    def test_generator_scripts_name_their_encoding(self) -> None:
        offenders = {
            path.name: guard_calls_without_encoding(path.read_text(encoding="utf-8"))
            for path in sorted(self.GENERATOR_DIR.glob("*.py"))
        }
        offenders = {name: lines for name, lines in offenders.items() if lines}
        self.assertEqual(
            offenders,
            {},
            "generator file IO must pass encoding explicitly — the platform "
            f"locale otherwise changes the spec fingerprint: {offenders}",
        )

    def test_the_recorded_fingerprint_is_the_utf8_digest_of_the_spec(self) -> None:
        """Pin the cross-platform property directly, not just the source shape."""
        raw = guard.SPEC_PATH.read_bytes()
        spec = json.loads(raw.decode("utf-8"))
        self.assertEqual(
            guard.fingerprint(spec),
            guard.FINGERPRINT_PATH.read_text(encoding="utf-8").strip(),
            "FINGERPRINT must be the sha256 of the spec decoded as UTF-8",
        )


if __name__ == "__main__":
    unittest.main()
