import asyncio
import logging

from app.database import create_job, get_job_by_issue_url, update_job
from app.devin_client import create_session
from app.github_client import (
    comment_on_issue,
    get_issue,
    get_issue_linked_prs,
    is_issue_open,
    parse_issue_url,
)
from app.slack_client import post_thread_reply

logger = logging.getLogger(__name__)

# Per-issue lock to prevent race conditions between concurrent reactions
_issue_locks: dict[str, asyncio.Lock] = {}


def build_fix_prompt(issue: dict, repo: str, issue_number: int) -> str:
    """Build a detailed prompt for Devin to fix the issue."""
    title = issue.get("title", "")
    body = issue.get("body", "") or ""

    return f"""You are tasked with fixing a GitHub issue in the repository {repo}.

## Issue #{issue_number}: {title}

{body}

## Instructions

1. Clone the repository: https://github.com/{repo}
2. Create a new branch named `devin/fix-issue-{issue_number}` from the default branch
3. Analyze the issue description carefully — it contains file paths, line numbers, and proposed fixes
4. Implement the fix as described
5. Run any relevant linting/type checking (e.g., `pre-commit run --all-files` for affected files)
6. Commit your changes with a descriptive message referencing the issue: "fix: <description> (#{issue_number})"
7. Push and create a Pull Request that:
   - References the issue with "Fixes #{issue_number}" in the body
   - Has a clear title describing the fix
   - Includes a summary of what was changed and why

## Constraints
- Make minimal, focused changes — only what's needed to fix this issue
- Follow existing code conventions in the repository
- Do NOT modify unrelated files
- If the fix requires a dependency change, update both the constraint file and lock file
"""


async def trigger_remediation(
    issue_url: str,
    triggered_by: str,
    slack_channel: str | None = None,
    slack_message_ts: str | None = None,
) -> dict:
    """
    Trigger a Devin session to remediate a GitHub issue.
    Returns a result dict with status info.
    """
    # Parse issue URL
    parsed = parse_issue_url(issue_url)
    if not parsed:
        return {"ok": False, "error": f"Invalid issue URL: {issue_url}"}

    repo, issue_number = parsed

    # Acquire per-issue lock to prevent race conditions from concurrent reactions
    if issue_url not in _issue_locks:
        _issue_locks[issue_url] = asyncio.Lock()
    async with _issue_locks[issue_url]:
        return await _do_trigger_remediation(
            issue_url, repo, issue_number, triggered_by, slack_channel, slack_message_ts
        )


async def _do_trigger_remediation(
    issue_url: str,
    repo: str,
    issue_number: int,
    triggered_by: str,
    slack_channel: str | None,
    slack_message_ts: str | None,
) -> dict:
    """Inner implementation, called under per-issue lock."""
    # Check for duplicate active jobs (includes blocked)
    existing = await get_job_by_issue_url(issue_url)
    if existing and existing["status"] in ("pending", "in_progress", "blocked"):
        return {
            "ok": False,
            "error": f"Active remediation already exists for this issue (status: {existing['status']})",
            "session_url": existing.get("session_url"),
        }

    # Verify issue is open
    if not await is_issue_open(repo, issue_number):
        return {"ok": False, "error": f"Issue #{issue_number} is not open"}

    # Check for existing PRs
    existing_prs = await get_issue_linked_prs(repo, issue_number)
    if existing_prs:
        pr_urls = [pr["html_url"] for pr in existing_prs]
        return {
            "ok": False,
            "error": f"Open PR(s) already exist for this issue: {', '.join(pr_urls)}",
        }

    # Get full issue details for prompt
    issue = await get_issue(repo, issue_number)
    if not issue:
        return {"ok": False, "error": f"Could not fetch issue #{issue_number}"}

    # Create tracking record
    job_id = await create_job(
        issue_url=issue_url,
        issue_number=issue_number,
        issue_title=issue.get("title", ""),
        triggered_by=triggered_by,
        slack_message_ts=slack_message_ts,
        slack_channel=slack_channel,
    )

    # Build prompt and create Devin session
    prompt = build_fix_prompt(issue, repo, issue_number)
    try:
        session_data = await create_session(
            prompt=prompt,
            tags=[f"issue-{issue_number}", "remediation", repo],
        )
        session_id = session_data["session_id"]
        session_url = session_data["url"]

        await update_job(
            job_id,
            session_id=session_id,
            session_url=session_url,
            status="in_progress",
            last_notified_status="started",
        )

        # Comment on the GitHub issue
        await comment_on_issue(
            repo,
            issue_number,
            f"🚀 **Automated remediation started**\n\n"
            f"A Devin session has been triggered to fix this issue.\n"
            f"Session: {session_url}\n\n"
            f"Triggered by: {triggered_by}",
        )

        # Notify in Slack thread
        if slack_channel and slack_message_ts:
            await post_thread_reply(
                slack_channel,
                slack_message_ts,
                f"🚀 Remediation started for issue #{issue_number}\n"
                f"Session: {session_url}",
            )

        return {
            "ok": True,
            "job_id": job_id,
            "session_id": session_id,
            "session_url": session_url,
        }

    except Exception as e:
        logger.exception("Failed to create Devin session for issue %s", issue_url)
        await update_job(job_id, status="failed")
        return {"ok": False, "error": str(e)}
