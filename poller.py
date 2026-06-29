import asyncio
import logging
import re

from config import settings
from database import get_active_jobs, update_job
from devin_client import get_session
from github_client import comment_on_issue, parse_issue_url
from slack_client import post_thread_reply

logger = logging.getLogger(__name__)


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
                    await update_job(job["id"], status="blocked")
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
                    await update_job(job["id"], status="in_progress")

            elif status in ("stopped", "error"):
                await update_job(job["id"], status="failed")
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
