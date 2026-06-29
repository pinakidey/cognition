import aiosqlite
import os
from datetime import datetime, timezone

from config import settings


async def get_db() -> aiosqlite.Connection:
    db_dir = os.path.dirname(settings.db_path)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    db = await aiosqlite.connect(settings.db_path)
    db.row_factory = aiosqlite.Row
    return db


async def init_db() -> None:
    db = await get_db()
    try:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS remediation_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                issue_url TEXT NOT NULL,
                issue_number INTEGER NOT NULL,
                issue_title TEXT NOT NULL,
                session_id TEXT,
                session_url TEXT,
                pr_url TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                triggered_by TEXT,
                slack_message_ts TEXT,
                slack_channel TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        await db.commit()
    finally:
        await db.close()


async def create_job(
    issue_url: str,
    issue_number: int,
    issue_title: str,
    triggered_by: str,
    slack_message_ts: str | None = None,
    slack_channel: str | None = None,
) -> int:
    db = await get_db()
    try:
        now = datetime.now(timezone.utc).isoformat()
        cursor = await db.execute(
            """INSERT INTO remediation_jobs
               (issue_url, issue_number, issue_title, triggered_by,
                slack_message_ts, slack_channel, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)""",
            (issue_url, issue_number, issue_title, triggered_by,
             slack_message_ts, slack_channel, now, now),
        )
        await db.commit()
        return cursor.lastrowid  # type: ignore[return-value]
    finally:
        await db.close()


ALLOWED_COLUMNS = frozenset({
    "session_id", "session_url", "pr_url", "status",
    "triggered_by", "slack_message_ts", "slack_channel", "updated_at",
})


async def update_job(job_id: int, **kwargs: str | None) -> None:
    db = await get_db()
    try:
        kwargs["updated_at"] = datetime.now(timezone.utc).isoformat()
        # Whitelist column names to prevent SQL injection
        for key in kwargs:
            if key not in ALLOWED_COLUMNS:
                raise ValueError(f"Invalid column name: {key}")
        set_clause = ", ".join(f"{k} = ?" for k in kwargs)
        values = list(kwargs.values()) + [job_id]
        await db.execute(
            f"UPDATE remediation_jobs SET {set_clause} WHERE id = ?",
            values,
        )
        await db.commit()
    finally:
        await db.close()


async def get_job_by_issue_url(issue_url: str) -> dict | None:
    """Get the most recent job for an issue URL."""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM remediation_jobs WHERE issue_url = ? ORDER BY created_at DESC LIMIT 1",
            (issue_url,),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def get_active_jobs() -> list[dict]:
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM remediation_jobs WHERE status IN ('pending', 'in_progress', 'blocked')"
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def get_all_jobs() -> list[dict]:
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM remediation_jobs ORDER BY created_at DESC"
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def get_job_stats() -> dict:
    db = await get_db()
    try:
        cursor = await db.execute("SELECT status, COUNT(*) as count FROM remediation_jobs GROUP BY status")
        rows = await cursor.fetchall()
        stats = {row["status"]: row["count"] for row in rows}

        cursor = await db.execute("SELECT COUNT(*) as total FROM remediation_jobs")
        row = await cursor.fetchone()
        stats["total"] = row["total"] if row else 0

        cursor = await db.execute(
            "SELECT COUNT(*) as count FROM remediation_jobs WHERE pr_url IS NOT NULL"
        )
        row = await cursor.fetchone()
        stats["prs_created"] = row["count"] if row else 0

        return stats
    finally:
        await db.close()
