"""Tests for config.py — settings loading and defaults."""
import os

from app.config import Settings


def test_defaults(monkeypatch):
    """Settings have sensible defaults when no env vars are set."""
    monkeypatch.delenv("DB_PATH", raising=False)
    s = Settings(
        _env_file=None,
        devin_api_key="",
        gh_token="",
        slack_bot_token="",
        slack_signing_secret="",
        slack_channel_id="",
    )
    assert s.devin_api_base == "https://api.devin.ai/v1"
    assert s.devin_max_acu == 10
    assert s.github_repo == "pinakidey/superset"
    assert s.db_path == "./data/jobs.db"
    assert s.poll_interval_seconds == 30


def test_env_override(monkeypatch):
    """Settings can be overridden via env vars."""
    monkeypatch.setenv("DEVIN_API_KEY", "apk_test123")
    monkeypatch.setenv("GH_TOKEN", "ghp_test")
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "secret123")
    monkeypatch.setenv("SLACK_CHANNEL_ID", "C012345")
    monkeypatch.setenv("DB_PATH", "/tmp/test.db")
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "60")

    s = Settings(_env_file=None)
    assert s.devin_api_key == "apk_test123"
    assert s.gh_token == "ghp_test"
    assert s.slack_bot_token == "xoxb-test"
    assert s.slack_signing_secret == "secret123"
    assert s.slack_channel_id == "C012345"
    assert s.db_path == "/tmp/test.db"
    assert s.poll_interval_seconds == 60


def test_extra_env_vars_ignored(monkeypatch):
    """Extra env vars don't cause validation errors."""
    monkeypatch.setenv("UNRELATED_VAR", "some_value")
    s = Settings(_env_file=None)
    assert s.devin_api_base == "https://api.devin.ai/v1"
