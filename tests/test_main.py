"""Tests for main.py — app startup, health check, route registration."""
import pytest
from fastapi.testclient import TestClient

from main import app


@pytest.fixture
def client(init_test_db):
    return TestClient(app)


def test_health_endpoint(client):
    """Health endpoint returns expected JSON."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["service"] == "devin-remediation-service"


def test_webhook_route_exists(client):
    """Webhook route is registered (returns 401 without valid signature, not 404)."""
    response = client.post(
        "/webhook/slack",
        content=b"{}",
        headers={
            "x-slack-request-timestamp": "0",
            "x-slack-signature": "v0=invalid",
        },
    )
    # 401 (auth failure) proves the route exists and handler runs
    assert response.status_code == 401


def test_status_route_exists(client):
    """Status route is registered."""
    response = client.get("/status")
    assert response.status_code == 200


def test_dashboard_route_exists(client):
    """Dashboard route is registered."""
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


def test_404_for_unknown_route(client):
    """Unknown routes return 404."""
    response = client.get("/nonexistent")
    assert response.status_code == 404
