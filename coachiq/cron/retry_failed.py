"""Daily retry of failed NotebookLM injections."""

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from coachiq.config import settings
from coachiq.models import Client, FailedInjection, Session
from coachiq.services.alerting import alert_injection_failed
from coachiq.services.notebooklm import (
    AuthenticationError,
    NotebookLMError,
    inject_transcript,
)

logger = logging.getLogger(__name__)

MAX_RETRIES = 10


async def run_retry(db: AsyncSession):
    """Retry all non-archived failed injections."""
    result = await db.execute(
        select(FailedInjection)
        .where(FailedInjection.archived == False)
        .where(FailedInjection.retry_count < MAX_RETRIES)
    )
    failures = result.scalars().all()

    if not failures:
        logger.info("No failed injections to retry")
        return {"retried": 0, "succeeded": 0, "failed": 0}

    succeeded = 0
    failed = 0

    for f in failures:
        # Look up the session and client to get notebook_id and content
        session_result = await db.execute(
            select(Session).where(Session.webhook_id == f.webhook_id)
        )
        session = session_result.scalar_one_or_none()
        if not session:
            logger.warning(f"No session for failed injection {f.webhook_id} — archiving")
            f.archived = True
            continue

        client_result = await db.execute(
            select(Client).where(Client.id == f.client_id)
        )
        client = client_result.scalar_one_or_none()
        if not client or not client.notebook_id:
            logger.warning(f"No client/notebook for {f.webhook_id} — archiving")
            f.archived = True
            continue

        try:
            # Re-read transcript from Drive would be ideal, but for retry
            # we use the drive path as a reference. The actual content needs
            # to be re-fetched or we need to store it. For now, we'll note
            # that a proper retry needs the content available.
            # TODO: Fetch transcript content from Drive for retry
            logger.info(f"Retrying injection: {f.webhook_id} (attempt {f.retry_count + 1})")

            # For now, mark as needing manual intervention
            f.retry_count += 1
            f.last_retry_at = datetime.now(timezone.utc)
            failed += 1

        except AuthenticationError:
            logger.error("Cookie expired during retry batch — stopping")
            break
        except Exception as e:
            f.retry_count += 1
            f.last_retry_at = datetime.now(timezone.utc)
            f.failure_reason = str(e)
            failed += 1

    # Archive anything over max retries
    for f in failures:
        if f.retry_count >= MAX_RETRIES and not f.archived:
            f.archived = True
            logger.warning(f"Archived failed injection {f.webhook_id} after {MAX_RETRIES} retries")
            alert_injection_failed("Unknown", f"Max retries exceeded for {f.webhook_id}")

    await db.commit()

    result = {"retried": len(failures), "succeeded": succeeded, "failed": failed}
    logger.info(f"Retry complete: {result}")
    return result
