"""Tests for client identification and pending review queue."""

import pytest

from coachiq.services.client_registry import (
    extract_external_invitees,
    matches_coaching_filter,
)


class TestExtractExternalInvitees:
    def test_filters_coach_email(self):
        invitees = [
            {"email": "todd@growwithcocreate.com", "is_external": False},
            {"email": "dallas@dpaauctions.com", "is_external": True, "name": "Dallas"},
        ]
        result = extract_external_invitees(invitees, "todd@growwithcocreate.com")
        assert len(result) == 1
        assert result[0]["email"] == "dallas@dpaauctions.com"

    def test_multiple_external(self):
        invitees = [
            {"email": "todd@growwithcocreate.com", "is_external": False},
            {"email": "cory@cjwtrust.com", "is_external": True, "name": "Cory"},
            {"email": "jeri@cjwtrust.com", "is_external": True, "name": "Jeri"},
        ]
        result = extract_external_invitees(invitees, "todd@growwithcocreate.com")
        assert len(result) == 2

    def test_no_external(self):
        invitees = [
            {"email": "todd@growwithcocreate.com", "is_external": False},
        ]
        result = extract_external_invitees(invitees, "todd@growwithcocreate.com")
        assert len(result) == 0

    def test_case_insensitive_coach_email(self):
        invitees = [
            {"email": "Todd@GrowWithCocreate.com", "is_external": False},
            {"email": "client@example.com", "is_external": True},
        ]
        result = extract_external_invitees(invitees, "todd@growwithcocreate.com")
        assert len(result) == 1


class TestMatchesCoachingFilter:
    def test_matches_coaching(self):
        assert matches_coaching_filter("Executive Coaching Session", "coaching|session") is True

    def test_matches_session(self):
        assert matches_coaching_filter("Weekly Session - Dallas", "coaching|session") is True

    def test_no_match(self):
        assert matches_coaching_filter("Team Standup", "coaching|session") is False

    def test_case_insensitive(self):
        assert matches_coaching_filter("EXECUTIVE COACHING", "coaching|session") is True

    def test_partial_match(self):
        assert matches_coaching_filter("Pre-coaching check-in", "coaching|session") is True
