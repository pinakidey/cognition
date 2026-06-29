import os
import sys
import pytest

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Override settings before any import
os.environ["DEVIN_API_KEY"] = "test-api-key"
os.environ["GH_TOKEN"] = "test-gh-token"
os.environ["SLACK_BOT_TOKEN"] = "xoxb-test-token"
os.environ["SLACK_SIGNING_SECRET"] = "test-signing-secret"
os.environ["SLACK_CHANNEL_ID"] = "C0TEST"
os.environ["DB_PATH"] = ":memory:"


@pytest.fixture(autouse=True)
def reset_db_path(tmp_path, monkeypatch):
    """Use a temporary database for each test."""
    db_file = str(tmp_path / "test.db")
    monkeypatch.setattr("config.settings.db_path", db_file)


@pytest.fixture
async def init_test_db(reset_db_path):
    """Initialize the test database schema."""
    from database import init_db
    await init_db()
