import asyncio
import logging
from datetime import datetime, timezone

from app.config import settings
from app.database import get_active_jobs, update_job
from app.devin_client import get_session
from app.github_client import comment_on_issue, parse_issue_url
from app.slack_client import post_thread_reply

logger = logging.getLogger(__name__)

# Maps Devin session status to user-friendly progress messages
PROGRESS_MESSAGES: dict[str, str] = {
    "running": "🔧 Devin is actively working on the fix...",
    "in_progress": "🔧 Devin is actively working on the fix...",
}


def _format_user_mention(triggered_by: str | None) -> str:
    """Format a Slack @-mention from the triggered_by field."""
    if not triggered_by:
        return ""
    # triggered_by is stored as "slack_user:U12345" or "retry(job_id=N)"
    if triggered_by.startswith("slack_user:"):
        user_id = triggered_by.removeprefix("slack_user:")
        return f"<@{user_id}>"
    return ""


def extract_pr_url(session_data: dict) -> str | None:
    """Extract PR URL from session data if available."""
    # Check structured_output
    structured = session_data.get("structured_output")
    if structured and isinstance(structured, dict):
        pr_url = structured.get("pr_url") or structured.get("pull_request_url")
        if pr_url:
            return pr_url

    # Check session links
    links = session_data.get("session_links")
    if links and isinstance(links, list):
        for link in links:
            if "pull" in link:
                return link

    return None


def _is_job_stale(job: dict) -> bool:
    """Check if a job has exceeded the timeout threshold."""
    created_at = job.get("created_at")
    if not created_at:
        return False
    try:
        created = datetime.fromisoformat(created_at)
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        elapsed_minutes = (datetime.now(timezone.utc) - created).total_seconds() / 60
        return elapsed_minutes > settings.job_timeout_minutes
    except (ValueError, TypeError):
        return False


async def _notify_progress(job: dict, status: str, session_url: str | None) -> None:
    """Send a progress update to Slack if status changed since last notification."""
    last_notified = job.get("last_notified_status")

    # Only notify on status transitions we haven't already reported
    if status == last_notified:
        return

    message = PROGRESS_MESSAGES.get(status)
    if not message:
        return

    channel = job.get("slack_channel")
    message_ts = job.get("slack_message_ts")
    if not channel or not message_ts:
        return

    issue_number = job["issue_number"]
    full_message = f"{message}\nIssue #{issue_number}"
    if session_url:
        full_message += f" | Session: {session_url}"

    try:
        await post_thread_reply(channel, message_ts, full_message)
        await update_job(job["id"], last_notified_status=status)
    except Exception:
        logger.exception("Failed to send progress notification for job %d", job["id"])


async def _handle_stale_job(job: dict) -> None:
    """Mark a stale job as timed_out and notify."""
    await update_job(job["id"], status="timed_out", last_notified_status="timed_out")

    if job.get("slack_channel") and job.get("slack_message_ts"):
        await post_thread_reply(
            job["slack_channel"],
            job["slack_message_ts"],
            f"⏰ Remediation for issue #{job['issue_number']} timed out after "
            f"{settings.job_timeout_minutes} minutes.\n"
            f"Session: {job.get('session_url', 'N/A')}\n"
            f"React with 🚀 again to retry.",
        )

    parsed = parse_issue_url(job["issue_url"])
    if parsed:
        repo, issue_number = parsed
        await comment_on_issue(
            repo,
            issue_number,
            f"⏰ **Remediation timed out** after {settings.job_timeout_minutes} minutes.\n\n"
            f"Session: {job.get('session_url', 'N/A')}\n"
            f"You may re-trigger remediation by reacting with 🚀 in Slack.",
        )


async def poll_active_jobs() -> None:
    """Poll all active Devin sessions and update job status."""
    jobs = await get_active_jobs()

    for job in jobs:
        # Check for stale/timed-out jobs first
        if _is_job_stale(job):
            try:
                await _handle_stale_job(job)
            except Exception:
                logger.exception("Error handling stale job %d", job["id"])
            continue

        session_id = job.get("session_id")
        if not session_id:
            continue

        try:
            session_data = await get_session(session_id)
            status = session_data.get("status_enum", "unknown")

            if status == "finished":
                pr_url = extract_pr_url(session_data)
                await update_job(
                    job["id"],
                    status="completed" if pr_url else "finished_no_pr",
                    pr_url=pr_url,
                    last_notified_status="finished",
                )

                # Notify on completion
                parsed = parse_issue_url(job["issue_url"])
                if parsed:
                    repo, issue_number = parsed
                    if pr_url:
                        await comment_on_issue(
                            repo,
                            issue_number,
                            f"✅ **Remediation complete**\n\n"
                            f"Pull Request: {pr_url}",
                        )
                    else:
                        await comment_on_issue(
                            repo,
                            issue_number,
                            f"⚠️ **Remediation session finished** but no PR was created.\n\n"
                            f"Session: {job.get('session_url', 'N/A')}\n"
                            f"Please review the session for details.",
                        )

                # Slack notification
                if job.get("slack_channel") and job.get("slack_message_ts"):
                    mention = _format_user_mention(job.get("triggered_by"))
                    if pr_url:
                        await post_thread_reply(
                            job["slack_channel"],
                            job["slack_message_ts"],
                            f"✅ PR ready for issue #{job['issue_number']}: {pr_url}\n"
                            f"{mention} please review.",
                        )
                    else:
                        await post_thread_reply(
                            job["slack_channel"],
                            job["slack_message_ts"],
                            f"⚠️ Session finished for issue #{job['issue_number']} but no PR was created. "
                            f"Check session: {job.get('session_url', 'N/A')}\n"
                            f"cc {mention}",
                        )

            elif status == "blocked":
                # Only notify on transition to blocked (not on every poll cycle)
                if job["status"] != "blocked":
                    await update_job(job["id"], status="blocked", last_notified_status="blocked")
                    if job.get("slack_channel") and job.get("slack_message_ts"):
                        await post_thread_reply(
                            job["slack_channel"],
                            job["slack_message_ts"],
                            f"⏸️ Session for issue #{job['issue_number']} is blocked and needs attention. "
                            f"Session: {job.get('session_url', 'N/A')}",
                        )

            elif status in ("running", "in_progress"):
                # Handle transition from blocked back to active
                if job["status"] == "blocked":
                    await update_job(job["id"], status="in_progress", last_notified_status=status)
                    if job.get("slack_channel") and job.get("slack_message_ts"):
                        await post_thread_reply(
                            job["slack_channel"],
                            job["slack_message_ts"],
                            f"▶️ Session for issue #{job['issue_number']} is no longer blocked and has resumed.",
                        )
                else:
                    # Send progress update on first transition to running (not from blocked)
                    await _notify_progress(job, status, job.get("session_url"))

            elif status in ("stopped", "error"):
                await update_job(job["id"], status="failed", last_notified_status=status)
                if job.get("slack_channel") and job.get("slack_message_ts"):
                    await post_thread_reply(
                        job["slack_channel"],
                        job["slack_message_ts"],
                        f"❌ Remediation failed for issue #{job['issue_number']}. "
                        f"Session: {job.get('session_url', 'N/A')}\n"
                        f"React with 🚀 again to retry.",
                    )

        except Exception:
            logger.exception("Error polling session %s for job %d", session_id, job["id"])


async def start_poller() -> None:
    """Background task that polls active sessions periodically."""
    logger.info("Starting session poller (interval: %ds)", settings.poll_interval_seconds)
    while True:
        try:
            await poll_active_jobs()
        except Exception:
            logger.exception("Poller iteration failed")
        await asyncio.sleep(settings.poll_interval_seconds)
