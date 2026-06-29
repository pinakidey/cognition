"""Tests for remediation.py — trigger logic, deduplication, race conditions."""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from app.remediation import _issue_locks, build_fix_prompt, trigger_remediation


@pytest.fixture(autouse=True)
async def db_setup(init_test_db):
    """Ensure DB is initialized for all tests."""
    pass


@pytest.fixture(autouse=True)
def clear_locks():
    """Clear per-issue locks between tests."""
    _issue_locks.clear()


def test_build_fix_prompt_contains_issue_details():
    """Prompt includes issue title, body, and repo."""
    issue = {"title": "Fix unsafe deserialization", "body": "Replace pickle.loads at line 88"}
    prompt = build_fix_prompt(issue, "pinakidey/superset", 1)

    assert "pinakidey/superset" in prompt
    assert "Fix unsafe deserialization" in prompt
    assert "Replace pickle.loads at line 88" in prompt
    assert "devin/fix-issue-1" in prompt
    assert "Fixes #1" in prompt


def test_build_fix_prompt_handles_empty_body():
    """Prompt handles None body gracefully."""
    issue = {"title": "Title", "body": None}
    prompt = build_fix_prompt(issue, "owner/repo", 5)
    assert "owner/repo" in prompt
    assert "#5" in prompt


@patch("app.remediation.parse_issue_url")
async def test_trigger_invalid_url(mock_parse):
    """Returns error for unparseable issue URL."""
    mock_parse.return_value = None

    result = await trigger_remediation(
        issue_url="https://not-a-github-url.com/foo",
        triggered_by="user",
    )
    assert result["ok"] is False
    assert "Invalid issue URL" in result["error"]


@patch("app.remediation.is_issue_open", new_callable=AsyncMock)
@patch("app.remediation.parse_issue_url")
@patch("app.remediation.get_job_by_issue_url", new_callable=AsyncMock)
async def test_trigger_duplicate_active_job(mock_get_job, mock_parse, mock_open):
    """Returns error when active job already exists for the issue."""
    mock_parse.return_value = ("owner/repo", 1)
    mock_get_job.return_value = {
        "status": "in_progress",
        "session_url": "https://app.devin.ai/sessions/abc",
    }

    result = await trigger_remediation(
        issue_url="https://github.com/owner/repo/issues/1",
        triggered_by="user",
    )
    assert result["ok"] is False
    assert "Active remediation already exists" in result["error"]


@patch("app.remediation.is_issue_open", new_callable=AsyncMock)
@patch("app.remediation.parse_issue_url")
@patch("app.remediation.get_job_by_issue_url", new_callable=AsyncMock)
async def test_trigger_blocked_job_counts_as_duplicate(mock_get_job, mock_parse, mock_open):
    """Blocked jobs also prevent duplicate triggering."""
    mock_parse.return_value = ("owner/repo", 2)
    mock_get_job.return_value = {"status": "blocked", "session_url": "https://..."}

    result = await trigger_remediation(
        issue_url="https://github.com/owner/repo/issues/2",
        triggered_by="user",
    )
    assert result["ok"] is False
    assert "Active remediation already exists" in result["error"]


@patch("app.remediation.is_issue_open", new_callable=AsyncMock)
@patch("app.remediation.parse_issue_url")
@patch("app.remediation.get_job_by_issue_url", new_callable=AsyncMock)
async def test_trigger_closed_issue(mock_get_job, mock_parse, mock_open):
    """Returns error when issue is closed."""
    mock_parse.return_value = ("owner/repo", 3)
    mock_get_job.return_value = None
    mock_open.return_value = False

    result = await trigger_remediation(
        issue_url="https://github.com/owner/repo/issues/3",
        triggered_by="user",
    )
    assert result["ok"] is False
    assert "not open" in result["error"]


@patch("app.remediation.get_issue_linked_prs", new_callable=AsyncMock)
@patch("app.remediation.is_issue_open", new_callable=AsyncMock)
@patch("app.remediation.parse_issue_url")
@patch("app.remediation.get_job_by_issue_url", new_callable=AsyncMock)
async def test_trigger_existing_pr(mock_get_job, mock_parse, mock_open, mock_prs):
    """Returns error when open PR already exists for the issue."""
    mock_parse.return_value = ("owner/repo", 4)
    mock_get_job.return_value = None
    mock_open.return_value = True
    mock_prs.return_value = [{"html_url": "https://github.com/owner/repo/pull/10"}]

    result = await trigger_remediation(
        issue_url="https://github.com/owner/repo/issues/4",
        triggered_by="user",
    )
    assert result["ok"] is False
    assert "Open PR(s) already exist" in result["error"]


@patch("app.remediation.post_thread_reply", new_callable=AsyncMock)
@patch("app.remediation.comment_on_issue", new_callable=AsyncMock)
@patch("app.remediation.create_session", new_callable=AsyncMock)
@patch("app.remediation.get_issue", new_callable=AsyncMock)
@patch("app.remediation.get_issue_linked_prs", new_callable=AsyncMock)
@patch("app.remediation.is_issue_open", new_callable=AsyncMock)
@patch("app.remediation.parse_issue_url")
@patch("app.remediation.get_job_by_issue_url", new_callable=AsyncMock)
async def test_trigger_success(
    mock_get_job, mock_parse, mock_open, mock_prs,
    mock_get_issue, mock_create_session, mock_comment, mock_slack
):
    """Successful trigger creates session and returns ok."""
    mock_parse.return_value = ("owner/repo", 5)
    mock_get_job.return_value = None
    mock_open.return_value = True
    mock_prs.return_value = []
    mock_get_issue.return_value = {"title": "Test Issue", "body": "Fix this"}
    mock_create_session.return_value = {
        "session_id": "sess-abc",
        "url": "https://app.devin.ai/sessions/sess-abc",
    }
    mock_comment.return_value = True
    mock_slack.return_value = True

    result = await trigger_remediation(
        issue_url="https://github.com/owner/repo/issues/5",
        triggered_by="slack_user:U123",
        slack_channel="C0TEST",
        slack_message_ts="1234.5678",
    )

    assert result["ok"] is True
    assert result["session_id"] == "sess-abc"
    assert result["session_url"] == "https://app.devin.ai/sessions/sess-abc"
    mock_create_session.assert_called_once()
    mock_comment.assert_called_once()
    mock_slack.assert_called_once()


@patch("app.remediation.post_thread_reply", new_callable=AsyncMock)
@patch("app.remediation.comment_on_issue", new_callable=AsyncMock)
@patch("app.remediation.create_session", new_callable=AsyncMock)
@patch("app.remediation.get_issue", new_callable=AsyncMock)
@patch("app.remediation.get_issue_linked_prs", new_callable=AsyncMock)
@patch("app.remediation.is_issue_open", new_callable=AsyncMock)
@patch("app.remediation.parse_issue_url")
@patch("app.remediation.get_job_by_issue_url", new_callable=AsyncMock)
async def test_trigger_session_creation_failure(
    mock_get_job, mock_parse, mock_open, mock_prs,
    mock_get_issue, mock_create_session, mock_comment, mock_slack
):
    """Returns error and marks job failed if session creation throws."""
    mock_parse.return_value = ("owner/repo", 6)
    mock_get_job.return_value = None
    mock_open.return_value = True
    mock_prs.return_value = []
    mock_get_issue.return_value = {"title": "Fail", "body": ""}
    mock_create_session.side_effect = Exception("API timeout")

    result = await trigger_remediation(
        issue_url="https://github.com/owner/repo/issues/6",
        triggered_by="user",
    )

    assert result["ok"] is False
    assert "API timeout" in result["error"]


@patch("app.remediation.post_thread_reply", new_callable=AsyncMock)
@patch("app.remediation.comment_on_issue", new_callable=AsyncMock)
@patch("app.remediation.create_session", new_callable=AsyncMock)
@patch("app.remediation.get_issue", new_callable=AsyncMock)
@patch("app.remediation.get_issue_linked_prs", new_callable=AsyncMock)
@patch("app.remediation.is_issue_open", new_callable=AsyncMock)
@patch("app.remediation.parse_issue_url")
@patch("app.remediation.get_job_by_issue_url", new_callable=AsyncMock)
async def test_race_condition_serialization(
    mock_get_job, mock_parse, mock_open, mock_prs,
    mock_get_issue, mock_create_session, mock_comment, mock_slack
):
    """Concurrent triggers for same issue are serialized by lock."""
    mock_parse.return_value = ("owner/repo", 7)
    mock_open.return_value = True
    mock_prs.return_value = []
    mock_get_issue.return_value = {"title": "Race", "body": "test"}

    call_count = 0

    async def mock_get_job_side_effect(url):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return None
        # Second call sees the job already created
        return {"status": "in_progress", "session_url": "url"}

    mock_get_job.side_effect = mock_get_job_side_effect
    mock_create_session.return_value = {"session_id": "s1", "url": "u1"}
    mock_comment.return_value = True
    mock_slack.return_value = True

    results = await asyncio.gather(
        trigger_remediation("https://github.com/owner/repo/issues/7", "user1"),
        trigger_remediation("https://github.com/owner/repo/issues/7", "user2"),
    )

    # One should succeed, one should be blocked by dedup
    ok_results = [r for r in results if r["ok"]]
    fail_results = [r for r in results if not r["ok"]]
    assert len(ok_results) == 1
    assert len(fail_results) == 1
    assert "Active remediation already exists" in fail_results[0]["error"]
