"""Transcript formatting — single function used by both webhook processing and backfill."""

from datetime import datetime


def format_transcript(
    title: str,
    client_name: str,
    recorded_at: datetime | None,
    transcript: list[dict],
    summary: dict | None = None,
    action_items: list[dict] | None = None,
    recording_url: str | None = None,
) -> str:
    """Format a Fathom transcript into a structured document for Drive + NotebookLM.

    Preserves Fathom recording URLs and per-utterance timestamps for deep linking.
    """
    lines = []

    # Header
    date_str = recorded_at.strftime("%B %d, %Y") if recorded_at else "Unknown Date"
    lines.append(f"COACHING SESSION TRANSCRIPT")
    lines.append(f"Client: {client_name}")
    lines.append(f"Date: {date_str}")
    lines.append(f"Title: {title}")
    if recording_url:
        lines.append(f"Recording: {recording_url}")
    lines.append("")

    # Summary (from Fathom AI)
    if summary:
        md = summary.get("markdown_formatted") or summary.get("text", "")
        if md:
            lines.append("--- SESSION SUMMARY ---")
            lines.append(md.strip())
            lines.append("")

    # Action items
    if action_items:
        lines.append("--- ACTION ITEMS ---")
        for item in action_items:
            assignee = item.get("assignee_name", "Unassigned")
            desc = item.get("description", "")
            lines.append(f"- [{assignee}] {desc}")
        lines.append("")

    # Full transcript with timestamps and speaker labels
    if transcript:
        lines.append("--- FULL TRANSCRIPT ---")
        for entry in transcript:
            speaker = entry.get("speaker", {})
            display_name = speaker.get("display_name", "Unknown")
            timestamp = entry.get("timestamp", "")
            text = entry.get("text", "")

            if text.strip():
                lines.append(f"[{timestamp}] {display_name}: {text}")
    else:
        lines.append("--- NO TRANSCRIPT AVAILABLE ---")
        lines.append("(Session recorded but transcript was empty)")

    return "\n".join(lines)


def is_empty_transcript(transcript: list[dict] | None) -> bool:
    """Check if a transcript has no meaningful content."""
    if not transcript:
        return True
    return all(not entry.get("text", "").strip() for entry in transcript)
