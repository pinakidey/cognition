import asyncio
import hashlib
import hmac
import json
import logging
import re
import time

from fastapi import APIRouter, Request, Response

from config import settings
from remediation import trigger_remediation
from slack_client import get_message_attachments, get_message_text

logger = logging.getLogger(__name__)
router = APIRouter()

ROCKET_EMOJI = "rocket"


def verify_slack_signature(
    body: bytes,
    timestamp: str,
    signature: str,
) -> bool:
    """Verify Slack request signature."""
    if not settings.slack_signing_secret:
        logger.warning("No Slack signing secret configured — rejecting request")
        return False

    # Check timestamp is recent (within 5 minutes)
    try:
        if abs(time.time() - int(timestamp)) > 300:
            return False
    except (ValueError, TypeError):
        return False

    sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
    computed = "v0=" + hmac.HMAC(
        settings.slack_signing_secret.encode(),
        sig_basestring.encode(),
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(computed, signature)


def extract_github_issue_url(text: str, attachments: list[dict] | None = None) -> str | None:
    """Extract a GitHub issue URL from message text or attachments."""
    # Try message text first
    match = re.search(r"https://github\.com/[^/]+/[^/]+/issues/\d+", text or "")
    if match:
        return match.group(0)

    # Try attachments (GitHub integration uses these)
    if attachments:
        for att in attachments:
            # Check title_link
            title_link = att.get("title_link", "")
            if "issues/" in title_link:
                match = re.search(r"https://github\.com/[^/]+/[^/]+/issues/\d+", title_link)
                if match:
                    return match.group(0)
            # Check fallback text
            fallback = att.get("fallback", "")
            match = re.search(r"https://github\.com/[^/]+/[^/]+/issues/\d+", fallback)
            if match:
                return match.group(0)
            # Check text field
            att_text = att.get("text", "")
            match = re.search(r"https://github\.com/[^/]+/[^/]+/issues/\d+", att_text)
            if match:
                return match.group(0)

    return None


@router.post("/webhook/slack")
async def slack_webhook(request: Request) -> Response:
    """Handle Slack Events API callbacks."""
    body = await request.body()

    # Verify signature first (before parsing JSON)
    timestamp = request.headers.get("x-slack-request-timestamp", "")
    signature = request.headers.get("x-slack-signature", "")
    if not verify_slack_signature(body, timestamp, signature):
        logger.warning("Invalid Slack signature")
        return Response(status_code=401)

    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, ValueError):
        return Response(status_code=400)

    # Handle Slack URL verification challenge (after signature is verified)
    if payload.get("type") == "url_verification":
        return Response(
            content=payload["challenge"],
            media_type="text/plain",
        )

    # Process events
    event = payload.get("event", {})
    event_type = event.get("type")

    if event_type == "reaction_added":
        asyncio.create_task(handle_reaction_added(event))

    # Always respond 200 quickly to Slack
    return Response(status_code=200)


async def handle_reaction_added(event: dict) -> None:
    """Handle a reaction_added event — trigger remediation on :rocket:."""
    channel = ""
    message_ts = ""
    try:
        reaction = event.get("reaction", "")
        if reaction != ROCKET_EMOJI:
            return

        channel = event.get("item", {}).get("channel", "")
        message_ts = event.get("item", {}).get("ts", "")
        user = event.get("user", "unknown")

        if not channel or not message_ts:
            logger.warning("reaction_added event missing channel or ts")
            return

        # Reject if no channel is configured (fail closed)
        if not settings.slack_channel_id:
            logger.warning("SLACK_CHANNEL_ID not configured — ignoring all reactions")
            return

        # Only process reactions from the configured channel
        if channel != settings.slack_channel_id:
            logger.info("Ignoring reaction from non-configured channel %s", channel)
            return

        logger.info(
            "Rocket reaction by %s on message %s in channel %s",
            user, message_ts, channel,
        )

        # Fetch the message to extract GitHub issue URL
        text = await get_message_text(channel, message_ts)
        attachments = await get_message_attachments(channel, message_ts)
        issue_url = extract_github_issue_url(text, attachments)

        if not issue_url:
            logger.info("No GitHub issue URL found in message %s", message_ts)
            return

        logger.info("Found issue URL: %s — triggering remediation", issue_url)

        result = await trigger_remediation(
            issue_url=issue_url,
            triggered_by=f"slack_user:{user}",
            slack_channel=channel,
            slack_message_ts=message_ts,
        )

        if not result["ok"]:
            from slack_client import post_thread_reply
            await post_thread_reply(
                channel,
                message_ts,
                f"⚠️ Could not start remediation: {result['error']}",
            )

    except Exception:
        logger.exception("Unhandled error in handle_reaction_added")
        if channel and message_ts:
            try:
                from slack_client import post_thread_reply
                await post_thread_reply(
                    channel,
                    message_ts,
                    "❌ An internal error occurred while processing this reaction. Please try again.",
                )
            except Exception:
                logger.exception("Failed to send error notification to Slack")
