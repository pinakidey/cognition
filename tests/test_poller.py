"""Tests for poller.py — session status polling and transitions."""
from unittest.mock import AsyncMock, patch

import pytest

from poller import extract_pr_url, poll_active_jobs


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


@patch("poller.post_thread_reply", new_callable=AsyncMock)
@patch("poller.comment_on_issue", new_callable=AsyncMock)
@patch("poller.get_session", new_callable=AsyncMock)
@patch("poller.get_active_jobs", new_callable=AsyncMock)
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
    assert "PR ready" in mock_slack.call_args[0][2]


@patch("poller.post_thread_reply", new_callable=AsyncMock)
@patch("poller.comment_on_issue", new_callable=AsyncMock)
@patch("poller.get_session", new_callable=AsyncMock)
@patch("poller.get_active_jobs", new_callable=AsyncMock)
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


@patch("poller.post_thread_reply", new_callable=AsyncMock)
@patch("poller.update_job", new_callable=AsyncMock)
@patch("poller.get_session", new_callable=AsyncMock)
@patch("poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_blocked_transition(mock_jobs, mock_session, mock_update, mock_slack):
    """Session becoming blocked updates status and notifies."""
    mock_jobs.return_value = [{
        "id": 3,
        "session_id": "sess-3",
        "issue_url": "https://github.com/owner/repo/issues/3",
        "issue_number": 3,
        "status": "in_progress",
        "session_url": "https://app.devin.ai/sessions/sess-3",
        "slack_channel": "C0TEST",
        "slack_message_ts": "3456.7890",
    }]
    mock_session.return_value = {"status_enum": "blocked"}
    mock_slack.return_value = True

    await poll_active_jobs()

    mock_update.assert_called_once_with(3, status="blocked")
    mock_slack.assert_called_once()
    assert "blocked" in mock_slack.call_args[0][2]


@patch("poller.update_job", new_callable=AsyncMock)
@patch("poller.get_session", new_callable=AsyncMock)
@patch("poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_unblocked_transition(mock_jobs, mock_session, mock_update):
    """Session transitioning from blocked back to running updates status."""
    mock_jobs.return_value = [{
        "id": 4,
        "session_id": "sess-4",
        "issue_url": "https://github.com/owner/repo/issues/4",
        "issue_number": 4,
        "status": "blocked",
        "session_url": "https://app.devin.ai/sessions/sess-4",
        "slack_channel": None,
        "slack_message_ts": None,
    }]
    mock_session.return_value = {"status_enum": "running"}

    await poll_active_jobs()

    mock_update.assert_called_once_with(4, status="in_progress")


@patch("poller.post_thread_reply", new_callable=AsyncMock)
@patch("poller.update_job", new_callable=AsyncMock)
@patch("poller.get_session", new_callable=AsyncMock)
@patch("poller.get_active_jobs", new_callable=AsyncMock)
async def test_poll_error_status(mock_jobs, mock_session, mock_update, mock_slack):
    """Session with error status marks job as failed."""
    mock_jobs.return_value = [{
        "id": 5,
        "session_id": "sess-5",
        "issue_url": "https://github.com/owner/repo/issues/5",
        "issue_number": 5,
        "status": "in_progress",
        "session_url": "https://app.devin.ai/sessions/sess-5",
        "slack_channel": "C0TEST",
        "slack_message_ts": "5678.1234",
    }]
    mock_session.return_value = {"status_enum": "error"}
    mock_slack.return_value = True

    await poll_active_jobs()

    mock_update.assert_called_once_with(5, status="failed")
    mock_slack.assert_called_once()
    assert "failed" in mock_slack.call_args[0][2]


@patch("poller.get_session", new_callable=AsyncMock)
@patch("poller.get_active_jobs", new_callable=AsyncMock)
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


@patch("poller.get_session", new_callable=AsyncMock)
@patch("poller.get_active_jobs", new_callable=AsyncMock)
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
