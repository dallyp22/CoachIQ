"""Client identification and pending review queue."""

import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from coachiq.config import settings
from coachiq.models import Client, PendingClient


class NewClientDetected(Exception):
    """Raised when no matching client is found — queued for review."""

    def __init__(self, pending_id: str, name: str, email: str):
        self.pending_id = pending_id
        self.name = name
        self.email = email
        super().__init__(f"New client queued for review: {name} ({email})")


@dataclass
class IdentifiedClient:
    client: Client
    match_type: str  # "exact", "additional_email"


def extract_external_invitees(
    invitees: list[dict], coach_email: str
) -> list[dict]:
    """Filter invitees to external participants only."""
    return [
        inv
        for inv in invitees
        if inv.get("is_external", False)
        and inv.get("email", "").lower() != coach_email.lower()
    ]


def matches_coaching_filter(title: str, pattern: str) -> bool:
    """Check if meeting title matches the coaching session filter."""
    return bool(re.search(pattern, title, re.IGNORECASE))


async def identify_client(
    db: AsyncSession,
    invitees: list[dict],
    meeting_title: str,
    fathom_recording_id: str | None = None,
) -> IdentifiedClient:
    """Identify the coaching client from meeting invitees.

    Returns IdentifiedClient if found.
    Raises NewClientDetected if unknown — queued for coach review.
    """
    external = extract_external_invitees(invitees, settings.coach_email)

    if not external:
        # No external participants — can't identify client.
        # Queue with meeting title for manual assignment.
        pending = PendingClient(
            name=f"Unknown (from: {meeting_title})",
            email="unknown@no-invitee",
            meeting_title=meeting_title,
            fathom_recording_id=fathom_recording_id,
        )
        db.add(pending)
        await db.commit()
        raise NewClientDetected(
            pending_id=str(pending.id),
            name=pending.name,
            email=pending.email,
        )

    # Try to match each external email against the client registry
    for inv in external:
        email = inv.get("email", "").lower()
        if not email:
            continue

        # Check primary email
        result = await db.execute(select(Client).where(Client.email == email))
        client = result.scalar_one_or_none()
        if client:
            return IdentifiedClient(client=client, match_type="exact")

        # Check additional emails (comma-separated in SQLite)
        result = await db.execute(
            select(Client).where(Client.additional_emails.contains(email))
        )
        client = result.scalar_one_or_none()
        if client:
            return IdentifiedClient(client=client, match_type="additional_email")

    # No match found — queue for review
    primary = external[0]
    pending = PendingClient(
        name=primary.get("name", primary.get("email", "Unknown")),
        email=primary.get("email", "unknown"),
        meeting_title=meeting_title,
        fathom_recording_id=fathom_recording_id,
    )
    db.add(pending)
    await db.commit()
    raise NewClientDetected(
        pending_id=str(pending.id),
        name=pending.name,
        email=pending.email,
    )
