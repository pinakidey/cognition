import httpx
import logging

from app.config import settings

logger = logging.getLogger(__name__)

SLACK_API = "https://slack.com/api"


async def post_thread_reply(channel: str, thread_ts: str, text: str) -> bool:
    """Post a reply in a Slack thread."""
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            f"{SLACK_API}/chat.postMessage",
            headers={"Authorization": f"Bearer {settings.slack_bot_token}"},
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
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(
            f"{SLACK_API}/conversations.history",
            headers={"Authorization": f"Bearer {settings.slack_bot_token}"},
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
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(
            f"{SLACK_API}/conversations.history",
            headers={"Authorization": f"Bearer {settings.slack_bot_token}"},
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
