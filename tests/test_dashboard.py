"""Tests for dashboard.py — status API, HTML dashboard, and retry endpoint."""
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.database import create_job, init_db, update_job


@pytest.fixture
def client(init_test_db):
    from app.main import app
    return TestClient(app)


async def test_status_empty(client):
    """Status endpoint returns empty stats initially."""
    response = client.get("/status")
    assert response.status_code == 200
    data = response.json()
    assert data["system"] == "devin-remediation-service"
    assert data["active_jobs"] == []
    assert data["recent_completed"] == []


async def test_status_with_jobs(init_test_db):
    """Status endpoint reflects created jobs."""
    from app.main import app
    client = TestClient(app)

    await create_job(
        "https://github.com/o/r/issues/1", 1, "Job 1", "user1"
    )
    job_id = await create_job(
        "https://github.com/o/r/issues/2", 2, "Job 2", "user2"
    )
    await update_job(job_id, status="completed", pr_url="https://github.com/o/r/pull/1")

    response = client.get("/status")
    data = response.json()
    assert data["stats"]["total"] == 2
    assert data["stats"]["prs_created"] == 1
    assert len(data["active_jobs"]) == 1
    assert len(data["recent_completed"]) == 1


async def test_dashboard_html(client):
    """Dashboard returns valid HTML."""
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "Devin Remediation Service" in response.text
    assert "Total Jobs" in response.text


async def test_dashboard_with_jobs_html(init_test_db):
    """Dashboard HTML shows job data."""
    from app.main import app
    client = TestClient(app)

    await create_job(
        "https://github.com/o/r/issues/5", 5, "XSS in dashboard", "slack_user:U1"
    )

    response = client.get("/")
    assert response.status_code == 200
    assert "XSS in dashboard" in response.text
    assert "#5" in response.text


async def test_dashboard_escapes_html(init_test_db):
    """Dashboard properly escapes user content to prevent XSS."""
    from app.main import app
    client = TestClient(app)

    await create_job(
        "https://github.com/o/r/issues/99", 99,
        '<script>alert("xss")</script>', "user"
    )

    response = client.get("/")
    assert "<script>" not in response.text
    assert "&lt;script&gt;" in response.text


# --- /retry/{job_id} endpoint tests ---

@patch("app.remediation.create_session", new_callable=AsyncMock)
@patch("app.remediation.get_issue_linked_prs", new_callable=AsyncMock)
@patch("app.remediation.is_issue_open", new_callable=AsyncMock)
@patch("app.remediation.get_issue", new_callable=AsyncMock)
async def test_retry_failed_job(mock_issue, mock_open, mock_prs, mock_session, init_test_db):
    """Retry endpoint re-triggers a failed job."""
    from app.main import app
    client = TestClient(app)

    job_id = await create_job(
        "https://github.com/owner/repo/issues/5", 5, "Bug fix", "slack_user:U1",
        slack_channel="C0TEST", slack_message_ts="1111.2222",
    )
    await update_job(job_id, status="failed")

    mock_open.return_value = True
    mock_prs.return_value = []
    mock_issue.return_value = {"title": "Bug fix", "body": "Fix it"}
    mock_session.return_value = {"session_id": "sess-retry", "url": "https://app.devin.ai/sessions/sess-retry"}

    response = client.post(f"/retry/{job_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["session_id"] == "sess-retry"


async def test_retry_nonexistent_job(init_test_db):
    """Retry returns 404 for unknown job."""
    from app.main import app
    client = TestClient(app)

    response = client.post("/retry/9999")
    assert response.status_code == 404


async def test_retry_active_job_rejected(init_test_db):
    """Retry returns 400 for jobs that are still active."""
    from app.main import app
    client = TestClient(app)

    job_id = await create_job(
        "https://github.com/owner/repo/issues/6", 6, "Active job", "slack_user:U2",
    )
    # Job is still 'pending' (active) — should not be retryable

    response = client.post(f"/retry/{job_id}")
    assert response.status_code == 400
    assert "pending" in response.json()["error"]


async def test_retry_timed_out_job(init_test_db):
    """Retry endpoint allows retrying timed_out jobs."""
    from app.main import app
    client = TestClient(app)

    job_id = await create_job(
        "https://github.com/owner/repo/issues/7", 7, "Timed out job", "slack_user:U3",
    )
    await update_job(job_id, status="timed_out")

    with patch("app.remediation.is_issue_open", new_callable=AsyncMock, return_value=True), \
         patch("app.remediation.get_issue_linked_prs", new_callable=AsyncMock, return_value=[]), \
         patch("app.remediation.get_issue", new_callable=AsyncMock, return_value={"title": "X", "body": "Y"}), \
         patch("app.remediation.create_session", new_callable=AsyncMock, return_value={"session_id": "s2", "url": "https://app.devin.ai/sessions/s2"}):
        response = client.post(f"/retry/{job_id}")

    assert response.status_code == 200
    assert response.json()["ok"] is True
