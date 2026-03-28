"""NotebookLM integration via notebooklm-py — direct, no abstraction."""

import asyncio
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class AuthenticationError(Exception):
    """notebooklm-py cookie auth has expired."""
    pass


class NotebookLMError(Exception):
    """General notebooklm-py operation failure."""
    pass


class SourceLimitError(Exception):
    """Notebook has hit the source limit (~50)."""
    pass


async def _get_client(storage_path: str):
    """Create an authenticated NotebookLM client."""
    try:
        from notebooklm_py import NotebookLMClient

        path = Path(storage_path).expanduser()
        if not path.exists():
            raise AuthenticationError(
                f"Storage state not found at {path}. Run 'notebooklm login' first."
            )
        return await NotebookLMClient.from_storage(str(path))
    except ImportError:
        raise NotebookLMError("notebooklm-py is not installed")
    except Exception as e:
        if "auth" in str(e).lower() or "cookie" in str(e).lower():
            raise AuthenticationError(f"NotebookLM auth expired: {e}")
        raise NotebookLMError(f"Failed to create NotebookLM client: {e}")


async def create_notebook(name: str, storage_path: str) -> str:
    """Create a new NotebookLM notebook. Returns notebook ID."""
    client = await _get_client(storage_path)
    try:
        notebook = await client.create_notebook(name)
        notebook_id = notebook.id if hasattr(notebook, "id") else str(notebook)
        logger.info(f"Created NotebookLM notebook: {name} ({notebook_id})")
        return notebook_id
    except Exception as e:
        if "auth" in str(e).lower() or "401" in str(e):
            raise AuthenticationError(f"Cookie expired during notebook creation: {e}")
        raise NotebookLMError(f"Failed to create notebook: {e}")


async def inject_transcript(
    notebook_id: str,
    content: str,
    title: str,
    storage_path: str,
) -> str | None:
    """Inject a transcript as a text source into a notebook. Returns source ID."""
    client = await _get_client(storage_path)
    try:
        # Use the notebook
        notebook = await client.get_notebook(notebook_id)

        # Check source count to warn about limits
        sources = await notebook.get_sources()
        if len(sources) >= 45:
            logger.warning(
                f"Notebook {notebook_id} has {len(sources)} sources — "
                f"approaching limit. Consolidation needed soon."
            )
        if len(sources) >= 50:
            raise SourceLimitError(
                f"Notebook {notebook_id} has {len(sources)} sources — at limit"
            )

        # Add the transcript as a text source
        source = await notebook.add_source(text=content, title=title)
        source_id = source.id if hasattr(source, "id") else str(source)
        logger.info(f"Injected source into {notebook_id}: {title} ({source_id})")
        return source_id

    except SourceLimitError:
        raise
    except Exception as e:
        err = str(e).lower()
        if "auth" in err or "401" in err or "cookie" in err:
            raise AuthenticationError(f"Cookie expired during injection: {e}")
        if "limit" in err or "quota" in err:
            raise SourceLimitError(f"Source limit exceeded: {e}")
        raise NotebookLMError(f"Injection failed: {e}")


async def health_check(storage_path: str) -> bool:
    """Check if notebooklm-py authentication is still valid."""
    try:
        client = await _get_client(storage_path)
        # List notebooks as a health check — if auth is expired, this fails
        await client.list_notebooks()
        return True
    except (AuthenticationError, Exception):
        return False
