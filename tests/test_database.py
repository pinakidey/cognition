"""Tests for database.py — job CRUD and queries."""
import pytest

from database import (
    create_job,
    get_active_jobs,
    get_all_jobs,
    get_job_by_issue_url,
    get_job_stats,
    init_db,
    update_job,
)


@pytest.fixture(autouse=True)
async def db_setup(init_test_db):
    """Ensure DB is initialized for all tests in this module."""
    pass


async def test_init_db_creates_table(init_test_db):
    """init_db creates the remediation_jobs table."""
    from database import get_db
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='remediation_jobs'"
        )
        row = await cursor.fetchone()
        assert row is not None
    finally:
        await db.close()


async def test_create_job():
    """create_job inserts a new job and returns an ID."""
    job_id = await create_job(
        issue_url="https://github.com/test/repo/issues/1",
        issue_number=1,
        issue_title="Test Issue",
        triggered_by="slack_user:U123",
        slack_message_ts="1234567890.123456",
        slack_channel="C0TEST",
    )
    assert job_id is not None
    assert job_id > 0


async def test_get_job_by_issue_url():
    """get_job_by_issue_url retrieves the most recent job."""
    url = "https://github.com/test/repo/issues/2"
    await create_job(url, 2, "First", "user1")
    await create_job(url, 2, "Second", "user2")

    job = await get_job_by_issue_url(url)
    assert job is not None
    assert job["triggered_by"] == "user2"


async def test_get_job_by_issue_url_not_found():
    """Returns None for nonexistent issue URL."""
    job = await get_job_by_issue_url("https://github.com/no/exist/issues/999")
    assert job is None


async def test_update_job():
    """update_job modifies specified fields."""
    job_id = await create_job(
        "https://github.com/test/repo/issues/3", 3, "Test", "user"
    )

    await update_job(job_id, status="in_progress", session_id="sess-123")

    job = await get_job_by_issue_url("https://github.com/test/repo/issues/3")
    assert job["status"] == "in_progress"
    assert job["session_id"] == "sess-123"


async def test_update_job_rejects_invalid_column():
    """update_job raises ValueError for non-whitelisted columns."""
    job_id = await create_job(
        "https://github.com/test/repo/issues/4", 4, "Test", "user"
    )

    with pytest.raises(ValueError, match="Invalid column name"):
        await update_job(job_id, invalid_column="bad")


async def test_get_active_jobs():
    """get_active_jobs returns pending, in_progress, and blocked jobs."""
    await create_job("https://github.com/test/repo/issues/10", 10, "A", "u")
    job_id_2 = await create_job("https://github.com/test/repo/issues/11", 11, "B", "u")
    job_id_3 = await create_job("https://github.com/test/repo/issues/12", 12, "C", "u")

    await update_job(job_id_2, status="in_progress")
    await update_job(job_id_3, status="completed")

    active = await get_active_jobs()
    active_issues = [j["issue_number"] for j in active]
    assert 10 in active_issues
    assert 11 in active_issues
    assert 12 not in active_issues


async def test_get_all_jobs_ordered():
    """get_all_jobs returns all jobs ordered by created_at DESC."""
    await create_job("https://github.com/test/repo/issues/20", 20, "First", "u")
    await create_job("https://github.com/test/repo/issues/21", 21, "Second", "u")

    jobs = await get_all_jobs()
    assert len(jobs) >= 2
    assert jobs[0]["issue_number"] == 21


async def test_get_job_stats():
    """get_job_stats returns correct counts."""
    await create_job("https://github.com/test/repo/issues/30", 30, "A", "u")
    job_id = await create_job("https://github.com/test/repo/issues/31", 31, "B", "u")
    await update_job(job_id, status="completed", pr_url="https://github.com/test/repo/pull/1")

    stats = await get_job_stats()
    assert stats["total"] >= 2
    assert stats["prs_created"] >= 1
    assert "pending" in stats or "completed" in stats
