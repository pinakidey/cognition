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

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
