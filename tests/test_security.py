"""Tests for security hardening — admin auth, rate limiting, log sanitization."""
import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient

from app.main import app
from app.database import init_db


@pytest.fixture
def client(init_test_db):
    return TestClient(app)


def test_health_endpoint_no_auth_required(client):
    """Health endpoint should always be accessible without auth."""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_status_endpoint_no_auth_when_key_not_configured(client):
    """When ADMIN_API_KEY is empty, admin endpoints are unrestricted."""
    with patch("app.security.settings") as mock_settings:
        mock_settings.admin_api_key = ""
        response = client.get("/status")
        assert response.status_code == 200


def test_status_endpoint_requires_auth_when_key_configured(client):
    """When ADMIN_API_KEY is set, admin endpoints reject unauthenticated requests."""
    with patch("app.security.settings") as mock_settings:
        mock_settings.admin_api_key = "my-secret-key"
        response = client.get("/status")
        assert response.status_code == 401


def test_status_endpoint_accepts_valid_admin_key(client):
    """Admin endpoints accept valid X-Admin-Key header."""
    with patch("app.security.settings") as mock_settings:
        mock_settings.admin_api_key = "my-secret-key"
        response = client.get("/status", headers={"X-Admin-Key": "my-secret-key"})
        assert response.status_code == 200


def test_status_endpoint_accepts_bearer_token(client):
    """Admin endpoints accept Authorization: Bearer <key>."""
    with patch("app.security.settings") as mock_settings:
        mock_settings.admin_api_key = "my-secret-key"
        response = client.get("/status", headers={"Authorization": "Bearer my-secret-key"})
        assert response.status_code == 200


def test_dashboard_requires_auth_when_key_configured(client):
    """Dashboard HTML endpoint also requires auth."""
    with patch("app.security.settings") as mock_settings:
        mock_settings.admin_api_key = "my-secret-key"
        response = client.get("/")
        assert response.status_code == 401


def test_retry_endpoint_requires_auth_when_key_configured(client):
    """Retry endpoint requires auth."""
    with patch("app.security.settings") as mock_settings:
        mock_settings.admin_api_key = "my-secret-key"
        response = client.post("/retry/1")
        assert response.status_code == 401


def test_retry_endpoint_with_valid_key(client):
    """Retry endpoint works with valid key (returns 404 for non-existent job)."""
    with patch("app.security.settings") as mock_settings:
        mock_settings.admin_api_key = "my-secret-key"
        response = client.post("/retry/999", headers={"X-Admin-Key": "my-secret-key"})
        assert response.status_code == 404


def test_rate_limit_parse():
    """Rate limit string parsing works correctly."""
    from app.rate_limit import _parse_rate_limit

    assert _parse_rate_limit("30/minute") == (30, 60)
    assert _parse_rate_limit("100/hour") == (100, 3600)
    assert _parse_rate_limit("5/second") == (5, 1)


def test_log_filter_redacts_tokens():
    """SensitiveDataFilter redacts known token patterns."""
    import logging
    from app.main import SensitiveDataFilter

    f = SensitiveDataFilter()
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname="", lineno=0,
        msg="Token is Bearer apk_abc123xyz", args=None, exc_info=None,
    )
    f.filter(record)
    assert "apk_abc123xyz" not in record.msg
    assert "[REDACTED]" in record.msg


def test_log_filter_redacts_slack_token():
    """SensitiveDataFilter redacts Slack bot tokens."""
    import logging
    from app.main import SensitiveDataFilter

    f = SensitiveDataFilter()
    record = logging.LogRecord(
        name="test", level=logging.INFO, pathname="", lineno=0,
        msg="Using xoxb-123-456-abc", args=None, exc_info=None,
    )
    f.filter(record)
    assert "xoxb-123-456-abc" not in record.msg
    assert "[REDACTED]" in record.msg
