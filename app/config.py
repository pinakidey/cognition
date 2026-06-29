import os

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Devin API
    devin_api_key: str = ""
    devin_api_base: str = "https://api.devin.ai/v1"
    devin_max_acu: int = 10

    # GitHub (use GH_TOKEN since GITHUB_ prefix is reserved by GitHub Actions)
    gh_token: str = ""
    github_repo: str = "pinakidey/superset"

    # Slack
    slack_bot_token: str = ""
    slack_signing_secret: str = ""
    slack_channel_id: str = ""

    # App
    db_path: str = "./data/jobs.db"
    poll_interval_seconds: int = 30

    # Security
    admin_api_key: str = ""
    rate_limit: str = "30/minute"

    # Retry & Failsafe
    max_retry_attempts: int = 3
    retry_base_delay_seconds: int = 5
    job_timeout_minutes: int = 60

    # Disable .env loading in deployed environments (Fly.io sets FLY_APP_NAME)
    model_config = {"env_file": ".env" if not os.environ.get("FLY_APP_NAME") else None, "extra": "ignore"}


settings = Settings()
