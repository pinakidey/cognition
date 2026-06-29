"""Tests for poller.py — session status polling and transitions."""
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

from app.poller import _is_job_stale, _notify_progress, extract_pr_url, poll_active_jobs


# --- extract_pr_url tests ---

def test_extract_pr_url_from_structured_output():
    """Extracts PR URL from structured_output."""
    session_data = {
        "structured_output": {"pr_url": "https://github.com/owner/repo/pull/1"},
        "session_links": [],
    }
    assert extract_pr_url(session_data) == "https://github.com/owner/repo/pull/1"


def test_extract_pr_url_from_pull_request_url_key():
    """Extracts PR URL from alternative structured_output key."""
    session_data = {
        "structured_output": {"pull_request_url": "https://github.com/o/r/pull/2"},
    }
    assert extract_pr_url(session_data) == "https://github.com/o/r/pull/2"


def test_extract_pr_url_from_session_links():
    """Extracts PR URL from session_links list."""
    session_data = {
        "structured_output": None,
        "session_links": [
            "https://app.devin.ai/sessions/abc",
            "https://github.com/owner/repo/pull/3",
        ],
    }
    assert extract_pr_url(session_data) == "https://github.com/owner/repo/pull/3"


def test_extract_pr_url_no_pr():
    """Returns None when no PR URL found."""
    session_data = {"structured_output": None, "session_links": []}
    assert extract_pr_url(session_data) is None

    session_data2 = {"structured_output": {}, "session_links": None}
    assert extract_pr_url(session_data2) is None


# --- poll_active_jobs tests ---

@pytest.fixture(autouse=True)
async def db_setup(init_test_db):
    pass


@patch("app.poller.post_thread_reply", new_callable=AsyncMock)
@patch("app.poller.comment_on_issue", new_callable=AsyncMock)
@patch("app.poller.get_session", new_callable=AsyncMock)
@patch("app.poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_finished_with_pr(mock_jobs, mock_session, mock_comment, mock_slack):
    """Completed session with PR updates job and notifies."""
    mock_jobs.return_value = [{
        "id": 1,
        "session_id": "sess-1",
        "issue_url": "https://github.com/owner/repo/issues/1",
        "issue_number": 1,
        "status": "in_progress",
        "session_url": "https://app.devin.ai/sessions/sess-1",
        "slack_channel": "C0TEST",
        "slack_message_ts": "1234.5678",
    }]
    mock_session.return_value = {
        "status_enum": "finished",
        "structured_output": {"pr_url": "https://github.com/owner/repo/pull/5"},
        "session_links": [],
    }
    mock_comment.return_value = True
    mock_slack.return_value = True

    await poll_active_jobs()

    mock_comment.assert_called_once()
    assert "Remediation complete" in mock_comment.call_args[0][2]
    mock_slack.assert_called_once()
    slack_msg = mock_slack.call_args[0][2]
    assert "PR ready" in slack_msg
    # No triggered_by → no dangling mention text
    assert "please review" not in slack_msg
    assert "cc " not in slack_msg


@patch("app.poller.post_thread_reply", new_callable=AsyncMock)
@patch("app.poller.comment_on_issue", new_callable=AsyncMock)
@patch("app.poller.get_session", new_callable=AsyncMock)
@patch("app.poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_finished_no_pr(mock_jobs, mock_session, mock_comment, mock_slack):
    """Finished session without PR sends warning notification."""
    mock_jobs.return_value = [{
        "id": 2,
        "session_id": "sess-2",
        "issue_url": "https://github.com/owner/repo/issues/2",
        "issue_number": 2,
        "status": "in_progress",
        "session_url": "https://app.devin.ai/sessions/sess-2",
        "slack_channel": "C0TEST",
        "slack_message_ts": "2345.6789",
    }]
    mock_session.return_value = {
        "status_enum": "finished",
        "structured_output": None,
        "session_links": [],
    }
    mock_comment.return_value = True
    mock_slack.return_value = True

    await poll_active_jobs()

    assert "no PR was created" in mock_comment.call_args[0][2]


@patch("app.poller.post_thread_reply", new_callable=AsyncMock)
@patch("app.poller.update_job", new_callable=AsyncMock)
@patch("app.poller.get_session", new_callable=AsyncMock)
@patch("app.poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_blocked_transition(mock_jobs, mock_session, mock_update, mock_slack):
    """Session becoming blocked updates status and notifies."""
    mock_jobs.return_value = [{
        "id": 3,
        "session_id": "sess-3",
        "issue_url": "https://github.com/owner/repo/issues/3",
        "issue_number": 3,
        "status": "in_progress",
        "last_notified_status": "running",
        "session_url": "https://app.devin.ai/sessions/sess-3",
        "slack_channel": "C0TEST",
        "slack_message_ts": "3456.7890",
    }]
    mock_session.return_value = {"status_enum": "blocked"}
    mock_slack.return_value = True

    await poll_active_jobs()

    mock_update.assert_called_once_with(3, status="blocked", last_notified_status="blocked")
    mock_slack.assert_called_once()
    assert "blocked" in mock_slack.call_args[0][2]


@patch("app.poller.post_thread_reply", new_callable=AsyncMock)
@patch("app.poller.update_job", new_callable=AsyncMock)
@patch("app.poller.get_session", new_callable=AsyncMock)
@patch("app.poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_unblocked_transition(mock_jobs, mock_session, mock_update, mock_slack):
    """Session transitioning from blocked back to running sends single 'resumed' message."""
    mock_jobs.return_value = [{
        "id": 4,
        "session_id": "sess-4",
        "issue_url": "https://github.com/owner/repo/issues/4",
        "issue_number": 4,
        "status": "blocked",
        "last_notified_status": "blocked",
        "session_url": "https://app.devin.ai/sessions/sess-4",
        "slack_channel": "C0TEST",
        "slack_message_ts": "4444.5555",
    }]
    mock_session.return_value = {"status_enum": "running"}
    mock_slack.return_value = True

    await poll_active_jobs()

    # Only one update_job call (no duplicate from _notify_progress)
    mock_update.assert_called_once_with(4, status="in_progress", last_notified_status="running")
    # Only one Slack message (the "resumed" message, not a duplicate "actively working")
    mock_slack.assert_called_once()
    assert "resumed" in mock_slack.call_args[0][2]


@patch("app.poller.post_thread_reply", new_callable=AsyncMock)
@patch("app.poller.update_job", new_callable=AsyncMock)
@patch("app.poller.get_session", new_callable=AsyncMock)
@patch("app.poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_error_status(mock_jobs, mock_session, mock_update, mock_slack):
    """Session with error status marks job as failed."""
    mock_jobs.return_value = [{
        "id": 5,
        "session_id": "sess-5",
        "issue_url": "https://github.com/owner/repo/issues/5",
        "issue_number": 5,
        "status": "in_progress",
        "last_notified_status": "running",
        "session_url": "https://app.devin.ai/sessions/sess-5",
        "slack_channel": "C0TEST",
        "slack_message_ts": "5678.1234",
    }]
    mock_session.return_value = {"status_enum": "error"}
    mock_slack.return_value = True

    await poll_active_jobs()

    mock_update.assert_called_once_with(5, status="failed", last_notified_status="error")
    mock_slack.assert_called_once()
    assert "failed" in mock_slack.call_args[0][2]


@patch("app.poller.get_session", new_callable=AsyncMock)
@patch("app.poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_skips_jobs_without_session_id(mock_jobs, mock_session):
    """Jobs without session_id are skipped."""
    mock_jobs.return_value = [{
        "id": 6,
        "session_id": None,
        "issue_url": "https://github.com/owner/repo/issues/6",
        "issue_number": 6,
        "status": "pending",
    }]

    await poll_active_jobs()

    mock_session.assert_not_called()


@patch("app.poller.get_session", new_callable=AsyncMock)
@patch("app.poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_handles_api_error_gracefully(mock_jobs, mock_session):
    """API errors don't crash the poller."""
    mock_jobs.return_value = [{
        "id": 7,
        "session_id": "sess-7",
        "issue_url": "https://github.com/owner/repo/issues/7",
        "issue_number": 7,
        "status": "in_progress",
    }]
    mock_session.side_effect = Exception("Network error")

    # Should not raise
    await poll_active_jobs()


# --- _notify_progress tests ---

@patch("app.poller.update_job", new_callable=AsyncMock)
@patch("app.poller.post_thread_reply", new_callable=AsyncMock)
async def test_notify_progress_sends_on_new_status(mock_slack, mock_update):
    """Sends progress message when status differs from last_notified_status."""
    job = {
        "id": 10,
        "issue_number": 42,
        "last_notified_status": "started",
        "slack_channel": "C0TEST",
        "slack_message_ts": "9999.0000",
    }
    mock_slack.return_value = True

    await _notify_progress(job, "running", "https://app.devin.ai/sessions/s1")

    mock_slack.assert_called_once()
    assert "actively working" in mock_slack.call_args[0][2]
    mock_update.assert_called_once_with(10, last_notified_status="running")


@patch("app.poller.update_job", new_callable=AsyncMock)
@patch("app.poller.post_thread_reply", new_callable=AsyncMock)
async def test_notify_progress_skips_if_already_notified(mock_slack, mock_update):
    """Does not re-send if status matches last_notified_status."""
    job = {
        "id": 11,
        "issue_number": 43,
        "last_notified_status": "running",
        "slack_channel": "C0TEST",
        "slack_message_ts": "9999.1111",
    }

    await _notify_progress(job, "running", "https://app.devin.ai/sessions/s2")

    mock_slack.assert_not_called()
    mock_update.assert_not_called()


@patch("app.poller.update_job", new_callable=AsyncMock)
@patch("app.poller.post_thread_reply", new_callable=AsyncMock)
async def test_notify_progress_skips_without_slack_info(mock_slack, mock_update):
    """Does not attempt notification without Slack channel/ts."""
    job = {
        "id": 12,
        "issue_number": 44,
        "last_notified_status": None,
        "slack_channel": None,
        "slack_message_ts": None,
    }

    await _notify_progress(job, "running", "https://app.devin.ai/sessions/s3")

    mock_slack.assert_not_called()


@patch("app.poller.post_thread_reply", new_callable=AsyncMock)
@patch("app.poller.update_job", new_callable=AsyncMock)
@patch("app.poller.get_session", new_callable=AsyncMock)
@patch("app.poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_running_sends_progress(mock_jobs, mock_session, mock_update, mock_slack):
    """Running session sends progress update on first detection."""
    mock_jobs.return_value = [{
        "id": 13,
        "session_id": "sess-13",
        "issue_url": "https://github.com/owner/repo/issues/13",
        "issue_number": 13,
        "status": "in_progress",
        "last_notified_status": "started",
        "session_url": "https://app.devin.ai/sessions/sess-13",
        "slack_channel": "C0TEST",
        "slack_message_ts": "1111.2222",
    }]
    mock_session.return_value = {"status_enum": "running"}
    mock_slack.return_value = True

    await poll_active_jobs()

    mock_slack.assert_called_once()
    assert "actively working" in mock_slack.call_args[0][2]


# --- _is_job_stale tests ---

def test_is_job_stale_true(monkeypatch):
    """Job older than timeout is stale."""
    monkeypatch.setattr("app.config.settings.job_timeout_minutes", 60)
    old_time = (datetime.now(timezone.utc) - timedelta(minutes=90)).isoformat()
    job = {"created_at": old_time}
    assert _is_job_stale(job) is True


def test_is_job_stale_false(monkeypatch):
    """Recent job is not stale."""
    monkeypatch.setattr("app.config.settings.job_timeout_minutes", 60)
    recent_time = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    job = {"created_at": recent_time}
    assert _is_job_stale(job) is False


def test_is_job_stale_no_created_at():
    """Job without created_at is not stale."""
    assert _is_job_stale({}) is False


# --- _format_user_mention tests ---

def test_format_user_mention_slack_user():
    """Formats Slack user ID as @-mention."""
    from app.poller import _format_user_mention
    assert _format_user_mention("slack_user:U12345ABC") == "<@U12345ABC>"


def test_format_user_mention_retry():
    """Retry-triggered jobs have no mention."""
    from app.poller import _format_user_mention
    assert _format_user_mention("retry(job_id=5)") == ""


def test_format_user_mention_none():
    """None triggered_by returns empty string."""
    from app.poller import _format_user_mention
    assert _format_user_mention(None) == ""


# --- stale job handling in poller ---

@patch("app.poller.comment_on_issue", new_callable=AsyncMock)
@patch("app.poller.post_thread_reply", new_callable=AsyncMock)
@patch("app.poller.update_job", new_callable=AsyncMock)
@patch("app.poller.get_session", new_callable=AsyncMock)
@patch("app.poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_handles_stale_job(mock_jobs, mock_session, mock_update, mock_slack, mock_comment, monkeypatch):
    """Stale jobs get timed_out status and notification."""
    monkeypatch.setattr("app.config.settings.job_timeout_minutes", 60)
    old_time = (datetime.now(timezone.utc) - timedelta(minutes=90)).isoformat()

    mock_jobs.return_value = [{
        "id": 20,
        "session_id": "sess-20",
        "issue_url": "https://github.com/owner/repo/issues/20",
        "issue_number": 20,
        "status": "in_progress",
        "last_notified_status": "running",
        "session_url": "https://app.devin.ai/sessions/sess-20",
        "slack_channel": "C0TEST",
        "slack_message_ts": "2222.3333",
        "created_at": old_time,
    }]

    await poll_active_jobs()

    # Should NOT poll the session API (skipped because stale)
    mock_session.assert_not_called()
    # Should mark as timed_out
    mock_update.assert_called_once_with(20, status="timed_out", last_notified_status="timed_out")
    # Should notify in Slack
    mock_slack.assert_called_once()
    assert "timed out" in mock_slack.call_args[0][2]


# --- PR ready mentions user ---

@patch("app.poller.post_thread_reply", new_callable=AsyncMock)
@patch("app.poller.comment_on_issue", new_callable=AsyncMock)
@patch("app.poller.get_session", new_callable=AsyncMock)
@patch("app.poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_finished_mentions_user(mock_jobs, mock_session, mock_comment, mock_slack):
    """PR-ready notification @-mentions the triggering user."""
    mock_jobs.return_value = [{
        "id": 30,
        "session_id": "sess-30",
        "issue_url": "https://github.com/owner/repo/issues/30",
        "issue_number": 30,
        "status": "in_progress",
        "session_url": "https://app.devin.ai/sessions/sess-30",
        "slack_channel": "C0TEST",
        "slack_message_ts": "3333.4444",
        "triggered_by": "slack_user:U99ENGINEER",
    }]
    mock_session.return_value = {
        "status_enum": "finished",
        "structured_output": {"pr_url": "https://github.com/owner/repo/pull/99"},
        "session_links": [],
    }
    mock_comment.return_value = True
    mock_slack.return_value = True

    await poll_active_jobs()

    mock_slack.assert_called_once()
    slack_msg = mock_slack.call_args[0][2]
    assert "<@U99ENGINEER>" in slack_msg
    assert "please review" in slack_msg
