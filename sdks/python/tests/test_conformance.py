import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from streampay import SPEC_FINGERPRINT, StreamPayError, decode_event_xdr  # noqa: E402
from streampay.conformance import decode_vector  # noqa: E402

VECTORS = Path(__file__).resolve().parents[2] / "vectors"


class ConformanceTest(unittest.TestCase):
    def test_vector_suite_exists(self):
        self.assertGreaterEqual(len(list(VECTORS.glob("*.json"))), 5)

    def test_every_vector_matches_recorded_expectation(self):
        for path in sorted(VECTORS.glob("*.json")):
            with self.subTest(vector=path.name):
                vector = json.loads(path.read_text())
                self.assertEqual(vector["specFingerprint"], SPEC_FINGERPRINT)
                self.assertEqual(decode_vector(vector), vector["expected"])

    def test_events_decode_to_typed_fields(self):
        vector = json.loads((VECTORS / "create-stream.json").read_text())
        event = decode_event_xdr(vector["eventsXdr"][0])
        self.assertIsNotNone(event)
        self.assertEqual(event.stream_id, 1)
        self.assertEqual(event.deposit, 10_000_000_000)
        self.assertFalse(event.cancelable)

    def test_malformed_event_is_a_decode_error(self):
        with self.assertRaises(StreamPayError) as caught:
            decode_event_xdr("not-xdr")
        self.assertEqual(caught.exception.kind.value, "decode")


if __name__ == "__main__":
    unittest.main()
