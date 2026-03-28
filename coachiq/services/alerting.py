"""Email alerting for operational events."""

import logging
import smtplib
from email.mime.text import MIMEText

from coachiq.config import settings

logger = logging.getLogger(__name__)


def send_alert(subject: str, body: str, to: str | None = None) -> bool:
    """Send an alert email. Returns True on success."""
    to = to or settings.alert_email_to
    if not to or not settings.smtp_user:
        logger.warning(f"Alert not sent (no email config): {subject}")
        return False

    msg = MIMEText(body, "plain")
    msg["Subject"] = f"[CoachIQ] {subject}"
    msg["From"] = settings.alert_email_from
    msg["To"] = to

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
            server.starttls()
            server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)
        logger.info(f"Alert sent: {subject} → {to}")
        return True
    except Exception as e:
        logger.error(f"Failed to send alert: {e}")
        return False


def alert_cookie_expired():
    """Alert builder that notebooklm-py auth has expired."""
    send_alert(
        subject="NotebookLM auth expired — re-authenticate",
        body=(
            "The notebooklm-py session cookies have expired.\n\n"
            "Sessions continue saving to Google Drive (zero data loss).\n"
            "NotebookLM sync is paused until you re-authenticate.\n\n"
            "To fix: Run 'notebooklm login' and update the storage_state.json.\n"
            "This takes about 30 seconds."
        ),
    )


def alert_new_pending_client(name: str, email: str, meeting_title: str):
    """Alert coach about a new participant queued for review."""
    send_alert(
        subject=f"New participant detected: {name}",
        body=(
            f"A new participant was detected in a coaching session:\n\n"
            f"  Name: {name}\n"
            f"  Email: {email}\n"
            f"  Meeting: {meeting_title}\n\n"
            "Their session transcript has been saved to Google Drive.\n"
            "To add them as a client, approve them in the CoachIQ admin.\n"
        ),
        to=settings.coach_email,
    )


def alert_injection_failed(client_name: str, reason: str):
    """Alert builder about a failed NotebookLM injection."""
    send_alert(
        subject=f"NotebookLM injection failed for {client_name}",
        body=(
            f"A transcript injection into NotebookLM failed.\n\n"
            f"  Client: {client_name}\n"
            f"  Reason: {reason}\n\n"
            "The transcript is safe in Google Drive.\n"
            "The injection has been queued for automatic retry.\n"
        ),
    )
