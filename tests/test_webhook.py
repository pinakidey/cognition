"""Tests for webhook.py — signature verification, event routing, URL extraction."""
import hashlib
import hmac
import json
import time
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from webhook import extract_github_issue_url, verify_slack_signature


def _make_signature(body: bytes, secret: str = "test-signing-secret", ts: str | None = None) -> tuple[str, str]:
    """Create a valid Slack signature for testing."""
    timestamp = ts or str(int(time.time()))
    sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
    computed = "v0=" + hmac.new(
        secret.encode(), sig_basestring.encode(), hashlib.sha256
    ).hexdigest()
    return timestamp, computed


# --- verify_slack_signature tests ---

def test_verify_valid_signature(monkeypatch):
    """Valid signature passes verification."""
    monkeypatch.setattr("config.settings.slack_signing_secret", "test-secret")
    body = b'{"type":"url_verification","challenge":"abc"}'
    timestamp = str(int(time.time()))
    sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
    signature = "v0=" + hmac.new(
        b"test-secret", sig_basestring.encode(), hashlib.sha256
    ).hexdigest()

    assert verify_slack_signature(body, timestamp, signature) is True


def test_verify_invalid_signature(monkeypatch):
    """Invalid signature fails verification."""
    monkeypatch.setattr("config.settings.slack_signing_secret", "test-secret")
    body = b'{"type":"event"}'
    timestamp = str(int(time.time()))

    assert verify_slack_signature(body, timestamp, "v0=invalid") is False


def test_verify_no_secret_configured(monkeypatch):
    """Missing signing secret rejects all requests."""
    monkeypatch.setattr("config.settings.slack_signing_secret", "")
    assert verify_slack_signature(b"body", "12345", "v0=sig") is False


def test_verify_expired_timestamp(monkeypatch):
    """Timestamp older than 5 minutes fails."""
    monkeypatch.setattr("config.settings.slack_signing_secret", "test-secret")
    old_ts = str(int(time.time()) - 600)
    assert verify_slack_signature(b"body", old_ts, "v0=sig") is False


def test_verify_invalid_timestamp(monkeypatch):
    """Non-numeric timestamp fails gracefully."""
    monkeypatch.setattr("config.settings.slack_signing_secret", "test-secret")
    assert verify_slack_signature(b"body", "not-a-number", "v0=sig") is False


# --- extract_github_issue_url tests ---

def test_extract_url_from_text():
    """Extracts issue URL from plain message text."""
    text = "New issue: https://github.com/owner/repo/issues/42 needs attention"
    assert extract_github_issue_url(text) == "https://github.com/owner/repo/issues/42"


def test_extract_url_from_text_no_match():
    """Returns None when no issue URL in text."""
    assert extract_github_issue_url("just some text") is None
    assert extract_github_issue_url("") is None
    assert extract_github_issue_url(None) is None  # type: ignore[arg-type]


def test_extract_url_from_attachments_title_link():
    """Extracts URL from attachment title_link field."""
    attachments = [
        {"title_link": "https://github.com/pinakidey/superset/issues/5", "fallback": ""}
    ]
    assert extract_github_issue_url("", attachments) == "https://github.com/pinakidey/superset/issues/5"


def test_extract_url_from_attachments_fallback():
    """Extracts URL from attachment fallback field."""
    attachments = [
        {"title_link": "", "fallback": "[pinakidey/superset] Issue: https://github.com/pinakidey/superset/issues/3"}
    ]
    assert extract_github_issue_url("", attachments) == "https://github.com/pinakidey/superset/issues/3"


def test_extract_url_from_attachments_text():
    """Extracts URL from attachment text field."""
    attachments = [
        {"text": "Check this out https://github.com/owner/repo/issues/99"}
    ]
    assert extract_github_issue_url("", attachments) == "https://github.com/owner/repo/issues/99"


def test_extract_url_text_takes_priority_over_attachments():
    """Text match takes priority over attachment match."""
    text = "Issue https://github.com/a/b/issues/1"
    attachments = [{"title_link": "https://github.com/c/d/issues/2"}]
    assert extract_github_issue_url(text, attachments) == "https://github.com/a/b/issues/1"


# --- Webhook endpoint tests ---

@pytest.fixture
def client():
    """Create a test client with mocked signature verification."""
    from main import app
    return TestClient(app)


def test_webhook_rejects_invalid_signature(client, monkeypatch):
    """Returns 401 for invalid Slack signature."""
    monkeypatch.setattr("config.settings.slack_signing_secret", "real-secret")
    response = client.post(
        "/webhook/slack",
        content=b'{"type":"event"}',
        headers={
            "x-slack-request-timestamp": str(int(time.time())),
            "x-slack-signature": "v0=invalid",
        },
    )
    assert response.status_code == 401


def test_webhook_url_verification(client, monkeypatch):
    """Responds to Slack URL verification challenge."""
    monkeypatch.setattr("config.settings.slack_signing_secret", "test-secret")
    body = json.dumps({"type": "url_verification", "challenge": "test-challenge-abc"}).encode()
    timestamp = str(int(time.time()))
    sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
    signature = "v0=" + hmac.new(
        b"test-secret", sig_basestring.encode(), hashlib.sha256
    ).hexdigest()

    response = client.post(
        "/webhook/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": signature,
        },
    )
    assert response.status_code == 200
    assert response.text == "test-challenge-abc"


def test_webhook_returns_400_for_invalid_json(client, monkeypatch):
    """Returns 400 if body isn't valid JSON after sig verification passes."""
    monkeypatch.setattr("config.settings.slack_signing_secret", "test-secret")
    body = b"not valid json"
    timestamp = str(int(time.time()))
    sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
    signature = "v0=" + hmac.new(
        b"test-secret", sig_basestring.encode(), hashlib.sha256
    ).hexdigest()

    response = client.post(
        "/webhook/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": signature,
        },
    )
    assert response.status_code == 400


def test_webhook_reaction_event_returns_200(client, monkeypatch):
    """Returns 200 immediately for reaction events (processed in background)."""
    monkeypatch.setattr("config.settings.slack_signing_secret", "test-secret")
    payload = {
        "type": "event_callback",
        "event": {
            "type": "reaction_added",
            "reaction": "rocket",
            "user": "U123",
            "item": {"channel": "C0TEST", "ts": "1234.5678"},
        },
    }
    body = json.dumps(payload).encode()
    timestamp = str(int(time.time()))
    sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
    signature = "v0=" + hmac.new(
        b"test-secret", sig_basestring.encode(), hashlib.sha256
    ).hexdigest()

    response = client.post(
        "/webhook/slack",
        content=body,
        headers={
            "x-slack-request-timestamp": timestamp,
            "x-slack-signature": signature,
        },
    )
    assert response.status_code == 200
