"""SQLAlchemy models for CoachIQ — SQLite compatible."""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import DeclarativeBase, relationship


def _uuid_str():
    return str(uuid4())


class Base(DeclarativeBase):
    pass


class Client(Base):
    """Approved coaching client."""

    __tablename__ = "clients"

    id = Column(String(36), primary_key=True, default=_uuid_str)
    name = Column(String(255), nullable=False)
    email = Column(String(255), unique=True, nullable=False, index=True)
    additional_emails = Column(Text, default="")  # comma-separated emails
    notebook_id = Column(String(255), nullable=True)
    drive_folder_id = Column(String(255), nullable=True)
    session_count = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    sessions = relationship("Session", back_populates="client")

    def get_additional_emails(self) -> list[str]:
        if not self.additional_emails:
            return []
        return [e.strip() for e in self.additional_emails.split(",") if e.strip()]

    def set_additional_emails(self, emails: list[str]):
        self.additional_emails = ",".join(emails)


class PendingClient(Base):
    """Unknown participant queued for coach review."""

    __tablename__ = "pending_clients"

    id = Column(String(36), primary_key=True, default=_uuid_str)
    name = Column(String(255), nullable=False)
    email = Column(String(255), nullable=False, index=True)
    meeting_title = Column(String(500), nullable=True)
    fathom_recording_id = Column(String(255), nullable=True)
    reviewed = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())


class Session(Base):
    """A processed coaching session."""

    __tablename__ = "sessions"

    id = Column(String(36), primary_key=True, default=_uuid_str)
    client_id = Column(String(36), ForeignKey("clients.id"), nullable=False)
    webhook_id = Column(String(255), unique=True, nullable=False, index=True)
    fathom_recording_id = Column(String(255), nullable=True)
    recording_url = Column(String(500), nullable=True)
    title = Column(String(500), nullable=True)
    drive_file_id = Column(String(255), nullable=True)
    notebooklm_source_id = Column(String(255), nullable=True)
    transcript_length = Column(Integer, default=0)
    nlm_injected = Column(Boolean, default=False)
    recorded_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, server_default=func.now())

    client = relationship("Client", back_populates="sessions")


class FailedInjection(Base):
    """NotebookLM injections that failed and need retry."""

    __tablename__ = "failed_injections"

    id = Column(String(36), primary_key=True, default=_uuid_str)
    webhook_id = Column(String(255), nullable=False)
    client_id = Column(String(36), nullable=False)
    transcript_drive_path = Column(String(500), nullable=False)
    failure_reason = Column(Text, nullable=True)
    retry_count = Column(Integer, default=0, index=True)
    archived = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())
    last_retry_at = Column(DateTime, nullable=True)
