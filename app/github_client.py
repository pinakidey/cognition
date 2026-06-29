import httpx
import logging
import re

from app.config import settings

logger = logging.getLogger(__name__)

HEADERS = {
    "Authorization": f"token {settings.github_token}",
    "Accept": "application/vnd.github.v3+json",
}

GITHUB_API = "https://api.github.com"


def parse_issue_url(url: str) -> tuple[str, int] | None:
    """Extract (owner/repo, issue_number) from a GitHub issue URL."""
    match = re.search(r"github\.com/([^/]+/[^/]+)/issues/(\d+)", url)
    if match:
        return match.group(1), int(match.group(2))
    return None


async def get_issue(repo: str, issue_number: int) -> dict | None:
    """Fetch a GitHub issue. Returns None if not found."""
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(
            f"{GITHUB_API}/repos/{repo}/issues/{issue_number}",
            headers=HEADERS,
        )
        if response.status_code == 200:
            return response.json()
        logger.warning("Failed to fetch issue %s#%d: %d", repo, issue_number, response.status_code)
        return None


async def is_issue_open(repo: str, issue_number: int) -> bool:
    """Check if a GitHub issue is open."""
    issue = await get_issue(repo, issue_number)
    if issue is None:
        return False
    return issue.get("state") == "open"


async def get_issue_linked_prs(repo: str, issue_number: int) -> list[dict]:
    """Check if there are open PRs that reference this issue."""
    async with httpx.AsyncClient(timeout=15) as client:
        # Search for PRs mentioning this issue
        query = f"repo:{repo} is:pr is:open {issue_number} in:body"
        response = await client.get(
            f"{GITHUB_API}/search/issues",
            headers=HEADERS,
            params={"q": query},
        )
        if response.status_code == 200:
            data = response.json()
            return data.get("items", [])
        return []


async def comment_on_issue(repo: str, issue_number: int, body: str) -> bool:
    """Post a comment on a GitHub issue."""
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            f"{GITHUB_API}/repos/{repo}/issues/{issue_number}/comments",
            headers=HEADERS,
            json={"body": body},
        )
        if response.status_code == 201:
            logger.info("Commented on %s#%d", repo, issue_number)
            return True
        logger.warning("Failed to comment on %s#%d: %d", repo, issue_number, response.status_code)
        return False
