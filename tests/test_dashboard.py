"""Tests for dashboard.py — status API and HTML dashboard."""
import pytest
from fastapi.testclient import TestClient

from database import create_job, init_db, update_job


@pytest.fixture
def client(init_test_db):
    from main import app
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
    from main import app
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
    from main import app
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
    from main import app
    client = TestClient(app)

    await create_job(
        "https://github.com/o/r/issues/99", 99,
        '<script>alert("xss")</script>', "user"
    )

    response = client.get("/")
    assert "<script>" not in response.text
    assert "&lt;script&gt;" in response.text
