"""Google Drive integration — OAuth as Todd, source of truth for all transcripts."""

import json
import logging
import time

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaInMemoryUpload

from coachiq.config import settings

logger = logging.getLogger(__name__)


def _get_drive_service():
    """Build authenticated Drive API client using Todd's OAuth token."""
    token = json.loads(open(settings.drive_token_path).read())
    creds = Credentials(
        token=token["token"],
        refresh_token=token["refresh_token"],
        token_uri=token["token_uri"],
        client_id=token["client_id"],
        client_secret=token["client_secret"],
        scopes=token["scopes"],
    )

    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        token["token"] = creds.token
        with open(settings.drive_token_path, "w") as f:
            json.dump(token, f, indent=2)

    return build("drive", "v3", credentials=creds)


def _find_or_create_folder(service, name: str, parent_id: str | None = None) -> str:
    """Find a folder by name (under parent) or create it. Returns folder ID."""
    query = f"name='{name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    if parent_id:
        query += f" and '{parent_id}' in parents"

    results = service.files().list(q=query, spaces="drive", fields="files(id)").execute()
    files = results.get("files", [])

    if files:
        return files[0]["id"]

    metadata = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
    }
    if parent_id:
        metadata["parents"] = [parent_id]

    folder = service.files().create(body=metadata, fields="id").execute()
    logger.info(f"Created Drive folder: {name} ({folder['id']})")
    return folder["id"]


def ensure_client_folder(client_name: str) -> str:
    """Ensure CoachIQ/ClientName folder exists in Drive. Returns folder ID."""
    service = _get_drive_service()
    root_id = _find_or_create_folder(service, settings.drive_root_folder_name)
    client_folder_id = _find_or_create_folder(service, client_name, parent_id=root_id)
    return client_folder_id


def write_transcript(
    client_name: str,
    filename: str,
    content: str,
    folder_id: str | None = None,
    max_retries: int = 3,
) -> str:
    """Write formatted transcript to Drive. Returns file ID."""
    service = _get_drive_service()

    if not folder_id:
        folder_id = ensure_client_folder(client_name)

    metadata = {
        "name": filename,
        "parents": [folder_id],
        "mimeType": "text/plain",
    }
    media = MediaInMemoryUpload(
        content.encode("utf-8"), mimetype="text/plain", resumable=False
    )

    for attempt in range(max_retries):
        try:
            result = service.files().create(
                body=metadata, media_body=media, fields="id"
            ).execute()
            logger.info(f"Drive write OK: {filename} ({result['id']})")
            return result["id"]
        except HttpError as e:
            if e.resp.status == 429 and attempt < max_retries - 1:
                wait = (attempt + 1) * 5
                logger.warning(f"Drive quota hit, retrying in {wait}s...")
                time.sleep(wait)
                continue
            raise

    raise RuntimeError(f"Drive write failed after {max_retries} retries: {filename}")
