"""Tests for devin_client.py — Devin API interactions."""
import httpx
import pytest
import respx

from app.devin_client import create_session, get_session


@respx.mock
async def test_create_session_success(monkeypatch):
    """Creates a Devin session with prompt and tags."""
    monkeypatch.setattr("app.config.settings.devin_api_key", "apk_test")
    monkeypatch.setattr("app.config.settings.devin_api_base", "https://api.devin.ai/v1")
    monkeypatch.setattr("app.config.settings.devin_max_acu", 10)

    respx.post("https://api.devin.ai/v1/sessions").mock(
        return_value=httpx.Response(200, json={
            "session_id": "sess-abc123",
            "url": "https://app.devin.ai/sessions/sess-abc123",
        })
    )

    result = await create_session(
        prompt="Fix issue #1",
        tags=["issue-1", "remediation"],
    )

    assert result["session_id"] == "sess-abc123"
    assert result["url"] == "https://app.devin.ai/sessions/sess-abc123"

    # Verify request payload
    request = respx.calls[0].request
    import json
    body = json.loads(request.content)
    assert body["prompt"] == "Fix issue #1"
    assert body["tags"] == ["issue-1", "remediation"]
    assert body["max_acu_limit"] == 10


@respx.mock
async def test_create_session_no_tags(monkeypatch):
    """Creates session without tags when None provided."""
    monkeypatch.setattr("app.config.settings.devin_api_key", "apk_test")
    monkeypatch.setattr("app.config.settings.devin_api_base", "https://api.devin.ai/v1")
    monkeypatch.setattr("app.config.settings.devin_max_acu", 5)

    respx.post("https://api.devin.ai/v1/sessions").mock(
        return_value=httpx.Response(200, json={
            "session_id": "sess-xyz",
            "url": "https://app.devin.ai/sessions/sess-xyz",
        })
    )

    result = await create_session(prompt="Do something")

    import json
    body = json.loads(respx.calls[0].request.content)
    assert "tags" not in body
    assert body["max_acu_limit"] == 5


@respx.mock
async def test_create_session_api_error_after_retries(monkeypatch):
    """Raises after exhausting all retry attempts."""
    monkeypatch.setattr("app.config.settings.devin_api_key", "apk_test")
    monkeypatch.setattr("app.config.settings.devin_api_base", "https://api.devin.ai/v1")
    monkeypatch.setattr("app.config.settings.max_retry_attempts", 3)
    monkeypatch.setattr("app.config.settings.retry_base_delay_seconds", 0)

    respx.post("https://api.devin.ai/v1/sessions").mock(
        return_value=httpx.Response(500, json={"error": "Server Error"})
    )

    with pytest.raises(httpx.HTTPStatusError):
        await create_session(prompt="Test")

    # Should have tried 3 times
    assert len(respx.calls) == 3


@respx.mock
async def test_create_session_retries_then_succeeds(monkeypatch):
    """Succeeds on retry after transient failure."""
    monkeypatch.setattr("app.config.settings.devin_api_key", "apk_test")
    monkeypatch.setattr("app.config.settings.devin_api_base", "https://api.devin.ai/v1")
    monkeypatch.setattr("app.config.settings.max_retry_attempts", 3)
    monkeypatch.setattr("app.config.settings.retry_base_delay_seconds", 0)

    route = respx.post("https://api.devin.ai/v1/sessions")
    route.side_effect = [
        httpx.Response(503, json={"error": "Unavailable"}),
        httpx.Response(200, json={"session_id": "sess-retry", "url": "https://app.devin.ai/sessions/sess-retry"}),
    ]

    result = await create_session(prompt="Retry test")

    assert result["session_id"] == "sess-retry"
    assert len(respx.calls) == 2


@respx.mock
async def test_get_session_success(monkeypatch):
    """Gets session status."""
    monkeypatch.setattr("app.config.settings.devin_api_key", "apk_test")
    monkeypatch.setattr("app.config.settings.devin_api_base", "https://api.devin.ai/v1")

    respx.get("https://api.devin.ai/v1/sessions/sess-abc").mock(
        return_value=httpx.Response(200, json={
            "session_id": "sess-abc",
            "status_enum": "finished",
            "session_links": ["https://github.com/o/r/pull/1"],
        })
    )

    result = await get_session("sess-abc")
    assert result["status_enum"] == "finished"
    assert "pull/1" in result["session_links"][0]


@respx.mock
async def test_get_session_not_found(monkeypatch):
    """Raises on 404."""
    monkeypatch.setattr("app.config.settings.devin_api_key", "apk_test")
    monkeypatch.setattr("app.config.settings.devin_api_base", "https://api.devin.ai/v1")

    respx.get("https://api.devin.ai/v1/sessions/nonexistent").mock(
        return_value=httpx.Response(404, json={"error": "Not Found"})
    )

    with pytest.raises(httpx.HTTPStatusError):
        await get_session("nonexistent")
