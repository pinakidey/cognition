"""Tests for slack_client.py — Slack API interactions."""
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx

from app.slack_client import get_message_attachments, get_message_text, post_thread_reply


@respx.mock
async def test_post_thread_reply_success(monkeypatch):
    """Successfully posts a thread reply."""
    monkeypatch.setattr("app.config.settings.slack_bot_token", "xoxb-test")
    respx.post("https://slack.com/api/chat.postMessage").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )

    result = await post_thread_reply("C0TEST", "1234.5678", "Hello!")
    assert result is True


@respx.mock
async def test_post_thread_reply_failure(monkeypatch):
    """Returns False when Slack API reports failure."""
    monkeypatch.setattr("app.config.settings.slack_bot_token", "xoxb-test")
    respx.post("https://slack.com/api/chat.postMessage").mock(
        return_value=httpx.Response(200, json={"ok": False, "error": "channel_not_found"})
    )

    result = await post_thread_reply("C0INVALID", "1234.5678", "Hello!")
    assert result is False


@respx.mock
async def test_get_message_text_success(monkeypatch):
    """Retrieves message text from conversations.history."""
    monkeypatch.setattr("app.config.settings.slack_bot_token", "xoxb-test")
    respx.get("https://slack.com/api/conversations.history").mock(
        return_value=httpx.Response(200, json={
            "ok": True,
            "messages": [{"text": "Check issue https://github.com/o/r/issues/1"}],
        })
    )

    text = await get_message_text("C0TEST", "1234.5678")
    assert text == "Check issue https://github.com/o/r/issues/1"


@respx.mock
async def test_get_message_text_no_messages(monkeypatch):
    """Returns None when no messages found."""
    monkeypatch.setattr("app.config.settings.slack_bot_token", "xoxb-test")
    respx.get("https://slack.com/api/conversations.history").mock(
        return_value=httpx.Response(200, json={"ok": True, "messages": []})
    )

    text = await get_message_text("C0TEST", "9999.0000")
    assert text is None


@respx.mock
async def test_get_message_text_api_error(monkeypatch):
    """Returns None on API error."""
    monkeypatch.setattr("app.config.settings.slack_bot_token", "xoxb-test")
    respx.get("https://slack.com/api/conversations.history").mock(
        return_value=httpx.Response(200, json={"ok": False, "error": "not_authed"})
    )

    text = await get_message_text("C0TEST", "1234.5678")
    assert text is None


@respx.mock
async def test_get_message_attachments_success(monkeypatch):
    """Retrieves message attachments."""
    monkeypatch.setattr("app.config.settings.slack_bot_token", "xoxb-test")
    respx.get("https://slack.com/api/conversations.history").mock(
        return_value=httpx.Response(200, json={
            "ok": True,
            "messages": [{
                "text": "",
                "attachments": [
                    {"title_link": "https://github.com/o/r/issues/5", "fallback": "Issue #5"}
                ],
            }],
        })
    )

    attachments = await get_message_attachments("C0TEST", "1234.5678")
    assert len(attachments) == 1
    assert attachments[0]["title_link"] == "https://github.com/o/r/issues/5"


@respx.mock
async def test_get_message_attachments_empty(monkeypatch):
    """Returns empty list when message has no attachments."""
    monkeypatch.setattr("app.config.settings.slack_bot_token", "xoxb-test")
    respx.get("https://slack.com/api/conversations.history").mock(
        return_value=httpx.Response(200, json={
            "ok": True,
            "messages": [{"text": "no attachments here"}],
        })
    )

    attachments = await get_message_attachments("C0TEST", "1234.5678")
    assert attachments == []
