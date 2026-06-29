import httpx
import logging
import re

from app.config import settings

logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"

# Shared HTTP client for GitHub API (connection reuse)
_github_client: httpx.AsyncClient | None = None


def _get_github_client() -> httpx.AsyncClient:
    global _github_client
    if _github_client is None or _github_client.is_closed:
        _github_client = httpx.AsyncClient(
            timeout=15,
            headers={
                "Authorization": f"token {settings.gh_token}",
                "Accept": "application/vnd.github.v3+json",
            },
        )
    return _github_client


async def close_github_client() -> None:
    global _github_client
    if _github_client and not _github_client.is_closed:
        await _github_client.aclose()
        _github_client = None


def parse_issue_url(url: str) -> tuple[str, int] | None:
    """Extract (owner/repo, issue_number) from a GitHub issue URL."""
    match = re.search(r"github\.com/([^/]+/[^/]+)/issues/(\d+)", url)
    if match:
        return match.group(1), int(match.group(2))
    return None


async def get_issue(repo: str, issue_number: int) -> dict | None:
    """Fetch a GitHub issue. Returns None if not found."""
    client = _get_github_client()
    response = await client.get(
        f"{GITHUB_API}/repos/{repo}/issues/{issue_number}",
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
    client = _get_github_client()
    query = f"repo:{repo} is:pr is:open {issue_number} in:body"
    response = await client.get(
        f"{GITHUB_API}/search/issues",
        params={"q": query},
    )
    if response.status_code == 200:
        data = response.json()
        return data.get("items", [])
    return []


async def comment_on_issue(repo: str, issue_number: int, body: str) -> bool:
    """Post a comment on a GitHub issue."""
    client = _get_github_client()
    response = await client.post(
        f"{GITHUB_API}/repos/{repo}/issues/{issue_number}/comments",
        json={"body": body},
    )
    if response.status_code == 201:
        logger.info("Commented on %s#%d", repo, issue_number)
        return True
    logger.warning("Failed to comment on %s#%d: %d", repo, issue_number, response.status_code)
    return False
