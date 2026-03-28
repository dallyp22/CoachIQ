"""Fathom webhook signature verification and payload processing."""

import base64
import hashlib
import hmac
import time
from dataclasses import dataclass


class SignatureVerificationError(Exception):
    pass


class DuplicateWebhookError(Exception):
    pass


@dataclass
class WebhookHeaders:
    webhook_id: str
    timestamp: str
    signature: str


def parse_webhook_headers(headers: dict) -> WebhookHeaders:
    """Extract and validate Fathom webhook verification headers."""
    webhook_id = headers.get("webhook-id")
    timestamp = headers.get("webhook-timestamp")
    signature = headers.get("webhook-signature")

    if not all([webhook_id, timestamp, signature]):
        raise SignatureVerificationError(
            "Missing required webhook headers: webhook-id, webhook-timestamp, webhook-signature"
        )

    return WebhookHeaders(
        webhook_id=webhook_id,
        timestamp=timestamp,
        signature=signature,
    )


def verify_signature(
    payload: bytes,
    headers: WebhookHeaders,
    secret: str,
    tolerance_seconds: int = 300,
) -> None:
    """Verify Fathom webhook HMAC-SHA256 signature.

    Raises SignatureVerificationError if verification fails.
    """
    # Check timestamp is within tolerance (replay protection)
    try:
        ts = int(headers.timestamp)
    except (ValueError, TypeError):
        raise SignatureVerificationError("Invalid webhook timestamp")

    if abs(time.time() - ts) > tolerance_seconds:
        raise SignatureVerificationError(
            f"Webhook timestamp too old (>{tolerance_seconds}s)"
        )

    # Construct the signed content: "msg_id.timestamp.body"
    signed_content = f"{headers.webhook_id}.{headers.timestamp}.".encode() + payload

    # Decode the secret (Fathom prefixes with "whsec_")
    secret_bytes = secret
    if secret_bytes.startswith("whsec_"):
        secret_bytes = secret_bytes[6:]
    secret_decoded = base64.b64decode(secret_bytes)

    # Compute expected signature
    expected = hmac.new(
        secret_decoded, signed_content, hashlib.sha256
    ).digest()
    expected_b64 = base64.b64encode(expected).decode()

    # Compare against provided signatures (may be space-separated, versioned)
    provided_sigs = headers.signature.split(" ")
    for sig in provided_sigs:
        # Strip version prefix (e.g., "v1,")
        parts = sig.split(",", 1)
        sig_value = parts[-1]
        if hmac.compare_digest(expected_b64, sig_value):
            return

    raise SignatureVerificationError("Webhook signature verification failed")
