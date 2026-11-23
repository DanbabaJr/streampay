import hashlib
import hmac
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "test_fixtures" / "webhook-signature.json"
TOLERANCE_SEC = 300


def verify(header: str, raw_body: bytes, secret: str, now_sec: int) -> bool:
    timestamp = None
    signatures = []

    for part in header.split(","):
        key, separator, value = part.strip().partition("=")
        if separator and key == "t":
            try:
                timestamp = int(value)
            except ValueError:
                return False
        elif separator and key == "v1" and value:
            signatures.append(value.strip())

    if timestamp is None or not signatures:
        return False
    if abs(now_sec - timestamp) > TOLERANCE_SEC:
        return False

    message = f"{timestamp}.".encode("utf-8") + raw_body
    expected = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()

    for signature in signatures:
        if len(signature) != len(expected):
            continue
        if hmac.compare_digest(expected, signature.lower()):
            return True
    return False


fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
raw_body = fixture["raw_body"].encode("utf-8")

if not verify(fixture["header"], raw_body, fixture["secret"], fixture["timestamp"]):
    raise SystemExit("fixture verification failed")

if verify(fixture["header"], raw_body, "wrong_secret", fixture["timestamp"]):
    raise SystemExit("wrong-secret verification unexpectedly passed")

if verify(
    fixture["header"],
    fixture["raw_body"].replace("evt_fixture_535", "evt_tampered").encode("utf-8"),
    fixture["secret"],
    fixture["timestamp"],
):
    raise SystemExit("tampered-body verification unexpectedly passed")

print("Python fixture verification passed")
