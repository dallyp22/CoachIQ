"""CoachIQ configuration — loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Fathom
    fathom_api_key: str
    fathom_webhook_secret: str

    # NotebookLM (notebooklm-py)
    notebooklm_storage_path: str = "~/.notebooklm/storage_state.json"

    # Database (SQLite)
    database_url: str = "sqlite+aiosqlite:///./data/coachiq.db"

    # Google Drive (OAuth as Todd)
    drive_token_path: str = "./todd_drive_token.json"
    drive_oauth_client_path: str = "./oauth_client.json"
    drive_root_folder_name: str = "CoachIQ"

    # Health dashboard
    health_token: str = "change-me-in-production"

    # Coach info
    coach_email: str = "todd@growwithcocreate.com"
    coach_name: str = "Todd Zimbelman"

    # Calendar title filter
    coaching_title_filter: str = "coaching|executive coaching|session"

    model_config = {"env_prefix": "COACHIQ_", "env_file": ".env"}


settings = Settings()
