"""Tests for Fathom webhook signature verification."""

import base64
import hashlib
import hmac
import time

import pytest

from coachiq.services.webhook import (
    SignatureVerificationError,
    WebhookHeaders,
    parse_webhook_headers,
    verify_signature,
)


def _sign(payload: bytes, secret: str, webhook_id: str, timestamp: int) -> str:
    """Create a valid Fathom webhook signature."""
    secret_bytes = secret
    if secret_bytes.startswith("whsec_"):
        secret_bytes = secret_bytes[6:]
    secret_decoded = base64.b64decode(secret_bytes)

    signed_content = f"{webhook_id}.{timestamp}.".encode() + payload
    sig = hmac.new(secret_decoded, signed_content, hashlib.sha256).digest()
    return f"v1,{base64.b64encode(sig).decode()}"


SECRET = "whsec_" + base64.b64encode(b"test-secret-key-1234567890").decode()
PAYLOAD = b'{"title":"Coaching Session","recording_id":123}'


class TestParseHeaders:
    def test_valid_headers(self):
        h = parse_webhook_headers({
            "webhook-id": "msg_123",
            "webhook-timestamp": "1711111111",
            "webhook-signature": "v1,abc123",
        })
        assert h.webhook_id == "msg_123"

    def test_missing_id_raises(self):
        with pytest.raises(SignatureVerificationError, match="Missing"):
            parse_webhook_headers({
                "webhook-timestamp": "1711111111",
                "webhook-signature": "v1,abc123",
            })

    def test_missing_all_raises(self):
        with pytest.raises(SignatureVerificationError):
            parse_webhook_headers({})


class TestVerifySignature:
    def test_valid_signature_passes(self):
        ts = int(time.time())
        sig = _sign(PAYLOAD, SECRET, "msg_1", ts)
        headers = WebhookHeaders(webhook_id="msg_1", timestamp=str(ts), signature=sig)
        verify_signature(PAYLOAD, headers, SECRET)

    def test_invalid_signature_raises(self):
        ts = int(time.time())
        headers = WebhookHeaders(
            webhook_id="msg_1", timestamp=str(ts), signature="v1,invalid"
        )
        with pytest.raises(SignatureVerificationError, match="verification failed"):
            verify_signature(PAYLOAD, headers, SECRET)

    def test_stale_timestamp_raises(self):
        ts = int(time.time()) - 600  # 10 minutes ago
        sig = _sign(PAYLOAD, SECRET, "msg_1", ts)
        headers = WebhookHeaders(webhook_id="msg_1", timestamp=str(ts), signature=sig)
        with pytest.raises(SignatureVerificationError, match="too old"):
            verify_signature(PAYLOAD, headers, SECRET)

    def test_tampered_payload_raises(self):
        ts = int(time.time())
        sig = _sign(PAYLOAD, SECRET, "msg_1", ts)
        headers = WebhookHeaders(webhook_id="msg_1", timestamp=str(ts), signature=sig)
        with pytest.raises(SignatureVerificationError):
            verify_signature(b"tampered", headers, SECRET)

    def test_invalid_timestamp_raises(self):
        headers = WebhookHeaders(
            webhook_id="msg_1", timestamp="not-a-number", signature="v1,abc"
        )
        with pytest.raises(SignatureVerificationError, match="Invalid"):
            verify_signature(PAYLOAD, headers, SECRET)
