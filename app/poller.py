import asyncio
import logging

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


async def poll_active_jobs() -> None:
    """Poll all active Devin sessions and update job status."""
    jobs = await get_active_jobs()

    for job in jobs:
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
                    if pr_url:
                        await post_thread_reply(
                            job["slack_channel"],
                            job["slack_message_ts"],
                            f"✅ PR ready for issue #{job['issue_number']}: {pr_url}",
                        )
                    else:
                        await post_thread_reply(
                            job["slack_channel"],
                            job["slack_message_ts"],
                            f"⚠️ Session finished for issue #{job['issue_number']} but no PR was created. "
                            f"Check session: {job.get('session_url', 'N/A')}",
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
                # Send progress update on first transition to running
                await _notify_progress(job, status, job.get("session_url"))

                # Handle transition from blocked back to active
                if job["status"] == "blocked":
                    await update_job(job["id"], status="in_progress", last_notified_status=status)
                    if job.get("slack_channel") and job.get("slack_message_ts"):
                        await post_thread_reply(
                            job["slack_channel"],
                            job["slack_message_ts"],
                            f"▶️ Session for issue #{job['issue_number']} is no longer blocked and has resumed.",
                        )

            elif status in ("stopped", "error"):
                await update_job(job["id"], status="failed", last_notified_status=status)
                if job.get("slack_channel") and job.get("slack_message_ts"):
                    await post_thread_reply(
                        job["slack_channel"],
                        job["slack_message_ts"],
                        f"❌ Remediation failed for issue #{job['issue_number']}. "
                        f"Session: {job.get('session_url', 'N/A')}",
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
