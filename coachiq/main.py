"""CoachIQ — FastAPI application.

Webhook processing pipeline:
  SYNC:  Verify HMAC → Identify client → Format transcript → Write to Drive → Log to DB
  ASYNC: Inject into NotebookLM (failures queued for retry)
"""

import logging
import re
from datetime import datetime, timezone

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from coachiq.config import settings
from coachiq.database import get_db
from coachiq.models import Client, FailedInjection, PendingClient, Session
from coachiq.services.alerting import (
    alert_cookie_expired,
    alert_injection_failed,
    alert_new_pending_client,
)
from coachiq.services.client_registry import (
    NewClientDetected,
    identify_client,
    matches_coaching_filter,
)
from coachiq.services.drive import ensure_client_folder, write_transcript
from coachiq.services.notebooklm import (
    AuthenticationError,
    NotebookLMError,
    SourceLimitError,
    inject_transcript,
)
from coachiq.services.transcript import format_transcript, is_empty_transcript
from coachiq.services.webhook import (
    DuplicateWebhookError,
    SignatureVerificationError,
    parse_webhook_headers,
    verify_signature,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="CoachIQ", version="0.1.0")


@app.on_event("startup")
async def startup():
    from coachiq.database import init_db
    await init_db()


# ─── Webhook endpoint ────────────────────────────────────────────────


@app.post("/webhook/fathom")
async def handle_fathom_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Process a Fathom webhook.

    Pipeline:
      1. Verify HMAC signature
      2. Check idempotency (webhook_id)
      3. Filter by calendar title
      4. Identify client (or queue for review)
      5. Format transcript
      6. Write to Google Drive (SYNC — data is safe)
      7. Log to DB
      8. Inject into NotebookLM (ASYNC — best effort)
    """
    payload = await request.body()

    # 1. Verify signature
    try:
        headers = parse_webhook_headers(dict(request.headers))
        verify_signature(payload, headers, settings.fathom_webhook_secret)
    except SignatureVerificationError as e:
        logger.warning(f"Webhook signature failed: {e}")
        raise HTTPException(status_code=401, detail=str(e))

    # Parse payload
    data = await request.json()
    webhook_id = dict(request.headers).get("webhook-id", "")

    # 2. Idempotency check
    existing = await db.execute(
        select(Session).where(Session.webhook_id == webhook_id)
    )
    if existing.scalar_one_or_none():
        logger.info(f"Duplicate webhook skipped: {webhook_id}")
        return {"status": "duplicate", "webhook_id": webhook_id}

    # 3. Calendar title filter
    title = data.get("title", "")
    if not matches_coaching_filter(title, settings.coaching_title_filter):
        logger.info(f"Non-coaching meeting skipped: {title}")
        return {"status": "skipped", "reason": "not a coaching session"}

    # 4. Identify client
    invitees = data.get("calendar_invitees", [])
    recording_id = str(data.get("recording_id", ""))
    recording_url = data.get("url", "")

    try:
        identified = await identify_client(
            db, invitees, title, fathom_recording_id=recording_id
        )
        client = identified.client
    except NewClientDetected as e:
        alert_new_pending_client(e.name, e.email, title)
        logger.info(f"New client queued: {e.name} ({e.email})")
        # Still save transcript to Drive under a "Pending" folder
        transcript_content = format_transcript(
            title=title,
            client_name=e.name,
            recorded_at=_parse_datetime(data.get("recording_start_time")),
            transcript=data.get("transcript") or [],
            summary=data.get("default_summary"),
            action_items=data.get("action_items"),
            recording_url=recording_url,
        )
        try:
            write_transcript(
                client_name="_Pending Review",
                filename=f"{e.name}_{recording_id}.txt",
                content=transcript_content,
            )
        except Exception as drive_err:
            logger.error(f"Drive write failed for pending client: {drive_err}")

        return {"status": "pending_review", "name": e.name, "email": e.email}

    # 5. Format transcript
    transcript_data = data.get("transcript") or []
    empty = is_empty_transcript(transcript_data)

    transcript_content = format_transcript(
        title=title,
        client_name=client.name,
        recorded_at=_parse_datetime(data.get("recording_start_time")),
        transcript=transcript_data,
        summary=data.get("default_summary"),
        action_items=data.get("action_items"),
        recording_url=recording_url,
    )

    # 6. Write to Google Drive (SYNC — data is safe after this)
    date_str = datetime.now().strftime("%Y-%m-%d")
    filename = f"{client.name}_{date_str}_{recording_id}.txt"

    try:
        drive_file_id = write_transcript(
            client_name=client.name,
            filename=filename,
            content=transcript_content,
            folder_id=client.drive_folder_id,
        )
    except Exception as e:
        logger.error(f"Drive write failed: {e}")
        raise HTTPException(status_code=500, detail="Drive write failed — Fathom will retry")

    # 7. Log to DB
    session_record = Session(
        client_id=client.id,
        webhook_id=webhook_id,
        fathom_recording_id=recording_id,
        recording_url=recording_url,
        title=title,
        drive_file_id=drive_file_id,
        transcript_length=len(transcript_data),
        nlm_injected=False,
        recorded_at=_parse_datetime(data.get("recording_start_time")),
    )
    db.add(session_record)
    client.session_count += 1
    if not client.drive_folder_id:
        client.drive_folder_id = ensure_client_folder(client.name)
    await db.commit()

    # 8. Inject into NotebookLM (ASYNC — best effort)
    if not empty and client.notebook_id:
        background_tasks.add_task(
            _inject_to_notebooklm,
            session_id=str(session_record.id),
            notebook_id=client.notebook_id,
            content=transcript_content,
            title=f"{client.name} — {date_str}",
            client_name=client.name,
            webhook_id=webhook_id,
            client_id=str(client.id),
            drive_path=f"CoachIQ/{client.name}/{filename}",
        )

    return {"status": "processed", "client": client.name, "drive_file_id": drive_file_id}


async def _inject_to_notebooklm(
    session_id: str,
    notebook_id: str,
    content: str,
    title: str,
    client_name: str,
    webhook_id: str,
    client_id: str,
    drive_path: str,
):
    """Background task: inject transcript into NotebookLM."""
    try:
        source_id = await inject_transcript(
            notebook_id=notebook_id,
            content=content,
            title=title,
            storage_path=settings.notebooklm_storage_path,
        )

        # Update session record with source ID
        async with get_db().__anext__() as db:
            result = await db.execute(
                select(Session).where(Session.id == session_id)
            )
            session = result.scalar_one_or_none()
            if session:
                session.notebooklm_source_id = source_id
                session.nlm_injected = True
                await db.commit()

        logger.info(f"NLM injection OK: {title} → {source_id}")

    except AuthenticationError as e:
        logger.error(f"NLM auth expired: {e}")
        alert_cookie_expired()
        await _queue_failed_injection(webhook_id, client_id, drive_path, str(e))

    except SourceLimitError as e:
        logger.warning(f"NLM source limit: {e}")
        await _queue_failed_injection(webhook_id, client_id, drive_path, str(e))

    except (NotebookLMError, Exception) as e:
        logger.error(f"NLM injection failed: {e}")
        alert_injection_failed(client_name, str(e))
        await _queue_failed_injection(webhook_id, client_id, drive_path, str(e))


async def _queue_failed_injection(
    webhook_id: str, client_id: str, drive_path: str, reason: str
):
    """Queue a failed injection for later retry."""
    from coachiq.database import async_session

    async with async_session() as db:
        failed = FailedInjection(
            webhook_id=webhook_id,
            client_id=client_id,
            transcript_drive_path=drive_path,
            failure_reason=reason,
        )
        db.add(failed)
        await db.commit()


# ─── Health dashboard ─────────────────────────────────────────────────


@app.get("/health")
async def health_dashboard(
    token: str = "",
    db: AsyncSession = Depends(get_db),
):
    """Health dashboard — requires URL token auth."""
    if token != settings.health_token:
        raise HTTPException(status_code=403, detail="Invalid token")

    # Gather stats
    client_count = await db.scalar(select(func.count(Client.id)))
    session_count = await db.scalar(select(func.count(Session.id)))
    pending_count = await db.scalar(
        select(func.count(PendingClient.id)).where(PendingClient.reviewed == False)
    )
    failed_count = await db.scalar(
        select(func.count(FailedInjection.id)).where(FailedInjection.archived == False)
    )

    last_session = await db.scalar(
        select(Session.created_at).order_by(Session.created_at.desc()).limit(1)
    )
    last_injected = await db.scalar(
        select(Session.created_at)
        .where(Session.nlm_injected == True)
        .order_by(Session.created_at.desc())
        .limit(1)
    )

    # Cookie health (cached — actual check is done by daily cron)
    from coachiq.services.notebooklm import health_check

    cookie_healthy = await health_check(settings.notebooklm_storage_path)

    # Determine overall status
    now = datetime.now(timezone.utc)
    if not cookie_healthy and failed_count > 0:
        status = "DOWN"
        status_msg = f"NotebookLM auth expired. {failed_count} sessions queued for retry."
    elif not cookie_healthy or failed_count > 0:
        status = "DEGRADED"
        issues = []
        if not cookie_healthy:
            issues.append("NotebookLM auth expired")
        if failed_count > 0:
            issues.append(f"{failed_count} failed injections queued")
        status_msg = ". ".join(issues) + "."
    else:
        status = "HEALTHY"
        status_msg = "All systems operational."

    return {
        "status": status,
        "message": status_msg,
        "pipeline": {
            "last_webhook": last_session.isoformat() if last_session else None,
            "last_drive_write": last_session.isoformat() if last_session else None,
            "last_nlm_injection": last_injected.isoformat() if last_injected else None,
        },
        "notebooklm": {
            "cookie_healthy": cookie_healthy,
            "failed_queue_size": failed_count,
        },
        "registry": {
            "clients": client_count,
            "total_sessions": session_count,
            "pending_review": pending_count,
        },
    }


# ─── Cron endpoints (triggered by Cloud Scheduler) ───────────────────


@app.post("/cron/health-check")
async def cron_health_check():
    """Daily cookie health check — called by Cloud Scheduler."""
    from coachiq.cron.health_check import run_health_check

    return await run_health_check()


@app.post("/cron/retry-failed")
async def cron_retry_failed(db: AsyncSession = Depends(get_db)):
    """Daily retry of failed NotebookLM injections."""
    from coachiq.cron.retry_failed import run_retry

    return await run_retry(db)


@app.post("/cron/backup")
async def cron_backup():
    """Daily database backup to Drive."""
    from coachiq.cron.backup import run_backup

    return await run_backup()


# ─── Helpers ──────────────────────────────────────────────────────────


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
