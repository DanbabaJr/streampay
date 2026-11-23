import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from streampay.xdr import (  # noqa: E402
    ScVal,
    XdrError,
    address_to_scval,
    build_invoke_envelope,
    encode_scval,
    native,
    read_envelope_b64,
    read_scval,
    Reader,
    scval_to_address,
    scval_to_i128,
    scval_to_struct,
    symbol_to_scval,
    u64_to_scval,
)

CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK3IM"
ACCOUNT = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57"


class XdrTest(unittest.TestCase):
    def roundtrip(self, value: ScVal) -> ScVal:
        reader = Reader(encode_scval(value))
        decoded = read_scval(reader)
        self.assertEqual(reader.offset, len(reader.data))
        return decoded

    def test_strkey_addresses_roundtrip(self):
        for address in (CONTRACT, ACCOUNT):
            decoded = self.roundtrip(address_to_scval(address))
            self.assertEqual(scval_to_address(decoded), address)

    def test_negative_i128_roundtrips(self):
        decoded = self.roundtrip(ScVal("i128", -(2**100)))
        self.assertEqual(scval_to_i128(decoded), -(2**100))

    def test_struct_maps_expose_symbol_fields(self):
        value = ScVal(
            "map",
            [
                (symbol_to_scval("id"), u64_to_scval(7)),
                (symbol_to_scval("status"), ScVal("u32", 2)),
            ],
        )
        fields = scval_to_struct(self.roundtrip(value))
        self.assertEqual(native(fields["id"]), 7)
        self.assertEqual(native(fields["status"]), 2)

    def test_unsigned_envelope_carries_the_invocation(self):
        envelope = build_invoke_envelope(
            source=ACCOUNT,
            contract=CONTRACT,
            function="withdraw_max",
            args=[u64_to_scval(3)],
            fee=100,
            sequence=42,
        )
        invocation = read_envelope_b64(envelope)
        self.assertEqual(invocation.contract, CONTRACT)
        self.assertEqual(invocation.function, "withdraw_max")
        self.assertEqual(invocation.source, ACCOUNT)
        self.assertEqual(invocation.fee, 100)
        self.assertEqual(invocation.sequence, 42)
        self.assertEqual(native(invocation.args[0]), 3)

    def test_truncated_xdr_is_rejected(self):
        encoded = encode_scval(u64_to_scval(1))
        with self.assertRaises(XdrError):
            read_scval(Reader(encoded[:-2]))


if __name__ == "__main__":
    unittest.main()
