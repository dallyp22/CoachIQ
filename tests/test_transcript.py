"""Tests for transcript formatting."""

from datetime import datetime, timezone

from coachiq.services.transcript import format_transcript, is_empty_transcript


class TestFormatTranscript:
    def test_normal_transcript_with_timestamps(self):
        result = format_transcript(
            title="Executive Coaching Session",
            client_name="Dallas Polivka",
            recorded_at=datetime(2026, 3, 25, tzinfo=timezone.utc),
            transcript=[
                {
                    "speaker": {"display_name": "Todd Zimbelman"},
                    "timestamp": "00:01:23",
                    "text": "How's the week been?",
                },
                {
                    "speaker": {"display_name": "Dallas Polivka"},
                    "timestamp": "00:01:30",
                    "text": "Busy but productive.",
                },
            ],
            recording_url="https://fathom.video/share/abc123",
        )

        assert "Dallas Polivka" in result
        assert "March 25, 2026" in result
        assert "[00:01:23] Todd Zimbelman: How's the week been?" in result
        assert "[00:01:30] Dallas Polivka: Busy but productive." in result
        assert "https://fathom.video/share/abc123" in result

    def test_empty_transcript_shows_metadata(self):
        result = format_transcript(
            title="Session",
            client_name="Test Client",
            recorded_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            transcript=[],
        )
        assert "Test Client" in result
        assert "NO TRANSCRIPT AVAILABLE" in result

    def test_summary_included(self):
        result = format_transcript(
            title="Session",
            client_name="Client",
            recorded_at=None,
            transcript=[],
            summary={"markdown_formatted": "## Key Topics\n- Hiring"},
        )
        assert "SESSION SUMMARY" in result
        assert "Key Topics" in result

    def test_action_items_included(self):
        result = format_transcript(
            title="Session",
            client_name="Client",
            recorded_at=None,
            transcript=[],
            action_items=[
                {"assignee_name": "Dallas", "description": "Draft proposal"},
                {"assignee_name": "Todd", "description": "Review goals"},
            ],
        )
        assert "[Dallas] Draft proposal" in result
        assert "[Todd] Review goals" in result

    def test_missing_speaker_name_fallback(self):
        result = format_transcript(
            title="Session",
            client_name="Client",
            recorded_at=None,
            transcript=[{"speaker": {}, "timestamp": "00:00", "text": "Hello"}],
        )
        assert "[00:00] Unknown: Hello" in result

    def test_no_recorded_date(self):
        result = format_transcript(
            title="Session",
            client_name="Client",
            recorded_at=None,
            transcript=[],
        )
        assert "Unknown Date" in result


class TestIsEmptyTranscript:
    def test_none_is_empty(self):
        assert is_empty_transcript(None) is True

    def test_empty_list_is_empty(self):
        assert is_empty_transcript([]) is True

    def test_whitespace_only_is_empty(self):
        assert is_empty_transcript([{"text": "  "}, {"text": ""}]) is True

    def test_real_content_is_not_empty(self):
        assert is_empty_transcript([{"text": "Hello"}]) is False
