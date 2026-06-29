import httpx
import logging

from app.config import settings

logger = logging.getLogger(__name__)

SLACK_API = "https://slack.com/api"

# Shared HTTP client for Slack API (connection reuse)
_slack_client: httpx.AsyncClient | None = None


def _get_slack_client() -> httpx.AsyncClient:
    global _slack_client
    if _slack_client is None or _slack_client.is_closed:
        _slack_client = httpx.AsyncClient(
            timeout=15,
            headers={"Authorization": f"Bearer {settings.slack_bot_token}"},
        )
    return _slack_client


async def close_slack_client() -> None:
    global _slack_client
    if _slack_client and not _slack_client.is_closed:
        await _slack_client.aclose()
        _slack_client = None


async def post_thread_reply(channel: str, thread_ts: str, text: str) -> bool:
    """Post a reply in a Slack thread."""
    client = _get_slack_client()
    response = await client.post(
        f"{SLACK_API}/chat.postMessage",
        json={
            "channel": channel,
            "thread_ts": thread_ts,
            "text": text,
        },
    )
    data = response.json()
    if data.get("ok"):
        logger.info("Posted Slack reply in %s (thread %s)", channel, thread_ts)
        return True
    logger.warning("Slack post failed: %s", data.get("error"))
    return False


async def get_message_text(channel: str, ts: str) -> str | None:
    """Fetch the text of a specific Slack message."""
    client = _get_slack_client()
    response = await client.get(
        f"{SLACK_API}/conversations.history",
        params={
            "channel": channel,
            "latest": ts,
            "inclusive": "true",
            "limit": "1",
        },
    )
    data = response.json()
    if data.get("ok") and data.get("messages"):
        return data["messages"][0].get("text", "")
    return None


async def get_message_attachments(channel: str, ts: str) -> list[dict]:
    """Fetch attachments of a specific Slack message (for GitHub integration messages)."""
    client = _get_slack_client()
    response = await client.get(
        f"{SLACK_API}/conversations.history",
        params={
            "channel": channel,
            "latest": ts,
            "inclusive": "true",
            "limit": "1",
        },
    )
    data = response.json()
    if data.get("ok") and data.get("messages"):
        msg = data["messages"][0]
        return msg.get("attachments", [])
    return []
