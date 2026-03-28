"""CoachIQ — Vercel serverless webhook handler.

Pipeline: Fathom webhook → verify HMAC → identify client → Drive write → NotebookLM inject
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import time
from datetime import datetime

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaInMemoryUpload

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("coachiq")

app = FastAPI(title="CoachIQ", version="0.1.0")

# ── Config from env vars ─────────────────────────────────────────────

FATHOM_API_KEY = os.environ.get("COACHIQ_FATHOM_API_KEY", "")
WEBHOOK_SECRET = os.environ.get("COACHIQ_FATHOM_WEBHOOK_SECRET", "")
HEALTH_TOKEN = os.environ.get("COACHIQ_HEALTH_TOKEN", "change-me")
COACH_EMAIL = os.environ.get("COACHIQ_COACH_EMAIL", "todd@growwithcocreate.com")
COACHING_FILTER = os.environ.get("COACHIQ_COACHING_TITLE_FILTER", "coaching|session")
DRIVE_TOKEN_JSON = os.environ.get("COACHIQ_DRIVE_TOKEN_JSON", "")  # full JSON string
NLM_COOKIES_JSON = os.environ.get("COACHIQ_NLM_COOKIES_JSON", "")  # full JSON string
CLIENT_REGISTRY_JSON = os.environ.get("COACHIQ_CLIENT_REGISTRY_JSON", "")  # {email: {name, notebook_id, drive_folder_id}}


# ── Client Registry (from env var JSON) ──────────────────────────────

def _load_registry() -> dict:
    """Load client registry from env var. Returns {email: {name, notebook_id, drive_folder_id}}."""
    if not CLIENT_REGISTRY_JSON:
        return {}
    try:
        return json.loads(CLIENT_REGISTRY_JSON)
    except json.JSONDecodeError:
        logger.error("Failed to parse CLIENT_REGISTRY_JSON")
        return {}


def identify_client(invitees: list[dict]) -> dict | None:
    """Match external invitee email against registry. Returns client dict or None."""
    registry = _load_registry()
    external = [
        inv for inv in invitees
        if inv.get("is_external", False)
        and inv.get("email", "").lower() != COACH_EMAIL.lower()
    ]

    for inv in external:
        email = inv.get("email", "").lower()
        if email in registry:
            return {"email": email, **registry[email]}

    # Unknown client — return info for pending review
    if external:
        primary = external[0]
        return {
            "email": primary.get("email", ""),
            "name": primary.get("name", primary.get("email", "Unknown")),
            "notebook_id": None,
            "drive_folder_id": None,
            "is_new": True,
        }
    return None


# ── Webhook Signature Verification ───────────────────────────────────

def verify_signature(payload: bytes, headers: dict) -> None:
    webhook_id = headers.get("webhook-id")
    timestamp = headers.get("webhook-timestamp")
    signature = headers.get("webhook-signature")

    if not all([webhook_id, timestamp, signature]):
        raise HTTPException(status_code=401, detail="Missing webhook headers")

    try:
        ts = int(timestamp)
    except (ValueError, TypeError):
        raise HTTPException(status_code=401, detail="Invalid timestamp")

    if abs(time.time() - ts) > 300:
        raise HTTPException(status_code=401, detail="Timestamp too old")

    secret = WEBHOOK_SECRET
    if secret.startswith("whsec_"):
        secret = secret[6:]
    secret_decoded = base64.b64decode(secret)

    signed_content = f"{webhook_id}.{timestamp}.".encode() + payload
    expected = hmac.new(secret_decoded, signed_content, hashlib.sha256).digest()
    expected_b64 = base64.b64encode(expected).decode()

    for sig in signature.split(" "):
        sig_value = sig.split(",", 1)[-1]
        if hmac.compare_digest(expected_b64, sig_value):
            return

    raise HTTPException(status_code=401, detail="Signature verification failed")


# ── Google Drive ─────────────────────────────────────────────────────

def _get_drive_service():
    if not DRIVE_TOKEN_JSON:
        return None
    token = json.loads(DRIVE_TOKEN_JSON)
    creds = Credentials(
        token=token["token"],
        refresh_token=token["refresh_token"],
        token_uri=token["token_uri"],
        client_id=token["client_id"],
        client_secret=token["client_secret"],
        scopes=token["scopes"],
    )
    if creds.expired and creds.refresh_token:
        creds.refresh(GoogleRequest())
    return build("drive", "v3", credentials=creds)


def _find_or_create_folder(service, name, parent_id=None):
    query = f"name='{name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    if parent_id:
        query += f" and '{parent_id}' in parents"
    results = service.files().list(q=query, fields="files(id)").execute()
    files = results.get("files", [])
    if files:
        return files[0]["id"]
    metadata = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    if parent_id:
        metadata["parents"] = [parent_id]
    return service.files().create(body=metadata, fields="id").execute()["id"]


def write_to_drive(client_name: str, filename: str, content: str, folder_id: str | None = None) -> str | None:
    service = _get_drive_service()
    if not service:
        logger.warning("Drive not configured — skipping")
        return None

    if not folder_id:
        root_id = _find_or_create_folder(service, "CoachIQ")
        folder_id = _find_or_create_folder(service, client_name, parent_id=root_id)

    media = MediaInMemoryUpload(content.encode("utf-8"), mimetype="text/plain")
    result = service.files().create(
        body={"name": filename, "parents": [folder_id]},
        media_body=media, fields="id",
    ).execute()
    return result["id"]


# ── NotebookLM ───────────────────────────────────────────────────────

async def inject_to_notebooklm(notebook_id: str, content: str, title: str) -> str | None:
    """Inject transcript into NotebookLM via notebooklm-py."""
    if not NLM_COOKIES_JSON or not notebook_id:
        logger.warning("NLM not configured or no notebook_id — skipping injection")
        return None

    try:
        import tempfile
        from pathlib import Path

        # Write cookies to temp file for notebooklm-py
        cookies = json.loads(NLM_COOKIES_JSON)
        storage_path = Path(tempfile.mktemp(suffix=".json"))
        storage_path.write_text(json.dumps(cookies))

        # Write content to temp file (notebooklm source add needs a file)
        content_path = Path(tempfile.mktemp(suffix=".txt"))
        content_path.write_text(content)

        import subprocess
        # Use notebook
        subprocess.run(
            ["notebooklm", "--storage", str(storage_path), "use", notebook_id],
            capture_output=True, text=True, timeout=30,
        )
        # Add source
        result = subprocess.run(
            ["notebooklm", "--storage", str(storage_path), "source", "add", str(content_path)],
            capture_output=True, text=True, timeout=60,
        )

        # Cleanup
        storage_path.unlink(missing_ok=True)
        content_path.unlink(missing_ok=True)

        if result.returncode == 0:
            logger.info(f"NLM injection OK: {title}")
            return "ok"
        else:
            logger.error(f"NLM injection failed: {result.stdout} {result.stderr}")
            return None

    except Exception as e:
        logger.error(f"NLM injection error: {e}")
        return None


# ── Transcript Formatting ────────────────────────────────────────────

def format_transcript(data: dict, client_name: str) -> str:
    lines = []
    title = data.get("title", "Untitled")
    date = data.get("created_at", "")[:10]
    recording_url = data.get("url", "")

    lines.append("COACHING SESSION TRANSCRIPT")
    lines.append(f"Client: {client_name}")
    lines.append(f"Date: {date}")
    lines.append(f"Title: {title}")
    if recording_url:
        lines.append(f"Recording: {recording_url}")
    lines.append("")

    summary = data.get("default_summary")
    if summary:
        md = summary.get("markdown_formatted") or summary.get("text", "")
        if md:
            lines.append("--- SESSION SUMMARY ---")
            lines.append(md.strip())
            lines.append("")

    action_items = data.get("action_items")
    if action_items:
        lines.append("--- ACTION ITEMS ---")
        for item in action_items:
            assignee = item.get("assignee_name", "Unassigned")
            lines.append(f"- [{assignee}] {item.get('description', '')}")
        lines.append("")

    transcript = data.get("transcript")
    if transcript:
        lines.append("--- FULL TRANSCRIPT ---")
        for entry in transcript:
            speaker = entry.get("speaker", {}).get("display_name", "Unknown")
            ts = entry.get("timestamp", "")
            text = entry.get("text", "")
            if text.strip():
                lines.append(f"[{ts}] {speaker}: {text}")
    else:
        lines.append("--- NO TRANSCRIPT AVAILABLE ---")

    return "\n".join(lines)


# ── Routes ───────────────────────────────────────────────────────────

@app.post("/webhook/fathom")
async def handle_webhook(request: Request, background_tasks: BackgroundTasks):
    payload = await request.body()

    # 1. Verify signature
    verify_signature(payload, dict(request.headers))

    # 2. Parse payload
    data = await request.json()
    webhook_id = dict(request.headers).get("webhook-id", "")

    # 3. Filter non-coaching meetings
    title = data.get("title", "")
    if not re.search(COACHING_FILTER, title, re.IGNORECASE):
        logger.info(f"Skipped non-coaching: {title}")
        return {"status": "skipped", "reason": "not coaching"}

    # 4. Identify client
    invitees = data.get("calendar_invitees", [])
    client = identify_client(invitees)

    if not client:
        logger.warning(f"No external invitees: {title}")
        return {"status": "skipped", "reason": "no external invitees"}

    client_name = client["name"]
    is_new = client.get("is_new", False)

    # 5. Format transcript
    transcript_content = format_transcript(data, client_name)

    # 6. Write to Drive (SYNC — data is safe after this)
    recording_id = data.get("recording_id", "unknown")
    date_str = datetime.now().strftime("%Y-%m-%d")
    filename = f"{client_name}_{date_str}_{recording_id}.txt"

    try:
        drive_file_id = write_to_drive(
            client_name, filename, transcript_content, client.get("drive_folder_id")
        )
        logger.info(f"Drive write OK: {filename}")
    except Exception as e:
        logger.error(f"Drive write failed: {e}")
        raise HTTPException(status_code=500, detail="Drive write failed")

    # 7. Inject into NotebookLM (background — best effort)
    notebook_id = client.get("notebook_id")
    if notebook_id and not is_new:
        background_tasks.add_task(
            inject_to_notebooklm, notebook_id, transcript_content, f"{client_name} — {date_str}"
        )

    status = "pending_review" if is_new else "processed"
    return {
        "status": status,
        "client": client_name,
        "drive_file_id": drive_file_id,
        "is_new_client": is_new,
    }


@app.get("/health")
async def health(token: str = ""):
    if token != HEALTH_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid token")

    registry = _load_registry()
    return {
        "status": "HEALTHY",
        "message": "CoachIQ is running",
        "clients_registered": len(registry),
        "drive_configured": bool(DRIVE_TOKEN_JSON),
        "nlm_configured": bool(NLM_COOKIES_JSON),
    }


@app.get("/")
async def root():
    return {"app": "CoachIQ", "version": "0.1.0", "status": "running"}
