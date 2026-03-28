"""Daily database backup — copy SQLite file to Google Drive."""

import logging
import shutil
from datetime import datetime
from pathlib import Path

from coachiq.config import settings
from coachiq.services.drive import write_transcript

logger = logging.getLogger(__name__)


async def run_backup():
    """Copy SQLite database file and upload to Drive."""
    db_path = settings.database_url.replace("sqlite+aiosqlite:///", "")
    if db_path.startswith("./"):
        db_path = db_path[2:]

    source = Path(db_path)
    if not source.exists():
        logger.warning("Database file not found — nothing to back up")
        return {"status": "skipped", "reason": "no database file"}

    date_str = datetime.now().strftime("%Y-%m-%d_%H%M")
    filename = f"coachiq_backup_{date_str}.db"

    try:
        content = source.read_bytes()
        file_id = write_transcript(
            client_name="_Backups",
            filename=filename,
            content=content.decode("latin-1"),  # binary-safe encoding for Drive text upload
        )
        logger.info(f"Backup uploaded: {filename} ({file_id})")
        return {"status": "ok", "file_id": file_id, "filename": filename}

    except Exception as e:
        logger.error(f"Backup failed: {e}")
        return {"status": "error", "reason": str(e)}
