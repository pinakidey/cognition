# Devin Remediation Service

Event-driven issue remediation service that uses the [Devin API](https://docs.devin.ai/api-reference/overview) to automatically fix GitHub issues triggered by human approval in Slack.

## Live Deployment

| Endpoint | URL |
|----------|-----|
| Dashboard | https://devin-remediation-service.fly.dev/ |
| Health Check | https://devin-remediation-service.fly.dev/health |
| Status API | https://devin-remediation-service.fly.dev/status |
| Slack Webhook | https://devin-remediation-service.fly.dev/webhook/slack |

## Architecture

```
[GitHub Issue Notification in #devin-report]
        │
        ▼ (Engineer reacts with 🚀)
[Slack Events API → POST /webhook/slack]
        │
        ├─ Extracts GitHub issue URL from message
        ├─ Validates: issue is open, no existing PR or active session
        ├─ Creates Devin session via API with tailored fix prompt
        ├─ Posts Slack thread reply: "🚀 Remediation started"
        │
        ▼ (Background poller)
[Polls Devin session status every 30s]
        │
        ├─ On completion: updates GitHub issue + Slack thread with PR link
        ├─ On failure: notifies in Slack thread
        │
        ▼
[GET / — Observability Dashboard]
        ├─ Total jobs, success rate, PRs created
        ├─ Active sessions, recent completions
        └─ Auto-refreshing HTML view
```

## Project Structure

```
cognition/
├── app/                          # Application source code
│   ├── __init__.py
│   ├── main.py                   # FastAPI app, lifespan, routes
│   ├── config.py                 # Pydantic settings (env vars)
│   ├── webhook.py                # Slack webhook handler + signature verification
│   ├── remediation.py            # Trigger logic, deduplication, race conditions
│   ├── poller.py                 # Background session status polling
│   ├── database.py               # SQLite async CRUD (aiosqlite)
│   ├── devin_client.py           # Devin API client
│   ├── github_client.py          # GitHub API client
│   ├── slack_client.py           # Slack API client
│   └── dashboard.py              # HTML dashboard + JSON status API
├── tests/                        # Test suite (82 tests, 96% coverage)
│   ├── conftest.py               # Fixtures, DB setup, env overrides
│   ├── test_config.py
│   ├── test_database.py
│   ├── test_webhook.py
│   ├── test_remediation.py
│   ├── test_poller.py
│   ├── test_slack_client.py
│   ├── test_github_client.py
│   ├── test_devin_client.py
│   ├── test_dashboard.py
│   └── test_main.py
├── .github/workflows/
│   └── deploy.yml                # CI: secret sync + Fly.io deploy
├── Dockerfile
├── fly.toml                      # Fly.io deployment config
├── requirements.txt              # Production dependencies
├── requirements-dev.txt          # Dev/test dependencies
├── pytest.ini                    # Test configuration
└── pyproject.toml                # Package metadata
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhook/slack` | Slack Events API handler (reaction_added) |
| `GET` | `/` | HTML observability dashboard |
| `GET` | `/status` | JSON API for metrics and job tracking |
| `GET` | `/health` | Health check |

## How It Works

1. **Daily Scanner** (Devin Automation) finds issues in `pinakidey/superset` at 8AM JST
2. **GitHub → Slack** integration posts issue notifications to `#devin-report`
3. **Slack Triage** (Devin Automation) analyzes and replies with root cause + confidence score
4. **Engineer** reviews triage and reacts with 🚀 to approve remediation
5. **This Service** receives the Slack event, validates the issue, and starts a Devin session
6. **Devin** fixes the issue and creates a PR
7. **Background Poller** detects PR creation and notifies GitHub + Slack

## Configuration

All configuration is via environment variables (managed as deployment/repo secrets):

| Variable | Description |
|----------|-------------|
| `DEVIN_API_KEY` | Devin API key (service or personal) |
| `DEVIN_API_BASE` | Devin API base URL (default: `https://api.devin.ai/v1`) |
| `DEVIN_MAX_ACU` | Max ACUs per remediation session (default: 10) |
| `GH_TOKEN` | GitHub PAT with repo access (`GITHUB_` prefix is reserved by GitHub Actions) |
| `GITHUB_REPO` | Target repository (default: `pinakidey/superset`) |
| `SLACK_BOT_TOKEN` | Slack Bot OAuth token |
| `SLACK_SIGNING_SECRET` | Slack app signing secret for request verification |
| `SLACK_CHANNEL_ID` | Channel ID for `#devin-report` (restricts which channel can trigger remediation) |
| `DB_PATH` | SQLite database path (default: `./data/jobs.db`) |
| `POLL_INTERVAL_SECONDS` | How often to poll active sessions (default: 30) |

## Local Development

```bash
# Install dependencies
pip install -r requirements-dev.txt

# Set environment variables
export DEVIN_API_KEY=your_key
export GH_TOKEN=your_token
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_SIGNING_SECRET=...
export SLACK_CHANNEL_ID=C0BE0NKLY3E

# Run the service
uvicorn app.main:app --reload --port 8000

# Run tests
pytest

# Run tests with coverage
pytest --cov=app --cov-report=term-missing
```

## Deployment

Deployed to Fly.io (Tokyo/nrt region) with persistent volume for SQLite.

GitHub Actions automatically syncs secrets and deploys on push to `main`:

```yaml
# .github/workflows/deploy.yml
# Triggers on push to main or workflow_dispatch
# Reads secrets from GitHub repo secrets → sets on Fly.io → deploys
```

### Required GitHub Repo Secrets

| Secret | Description |
|--------|-------------|
| `DEVIN_API_KEY` | Devin API key |
| `GH_TOKEN` | GitHub PAT |
| `SLACK_BOT_TOKEN` | Slack Bot OAuth token |
| `SLACK_SIGNING_SECRET` | Slack app signing secret |
| `SLACK_CHANNEL_ID` | Slack channel ID |
| `FLY_TOKEN` | Fly.io personal access token |

## Security

- **Slack signature verification** — All incoming webhooks are verified using HMAC-SHA256 before processing (including URL verification challenges)
- **Channel restriction** — Only reactions from the configured `SLACK_CHANNEL_ID` trigger remediation
- **HTML escaping** — All user-controlled content is escaped before rendering in the dashboard (XSS protection)
- **SQL injection prevention** — Column names in dynamic queries are validated against a whitelist
- **No hardcoded secrets** — All credentials are read from environment variables

## Observability

The dashboard at `/` provides:
- **Total Jobs**: Number of remediation requests processed
- **In Progress**: Currently active Devin sessions
- **Completed**: Successfully resolved with PR
- **PRs Created**: Pull requests opened
- **Success Rate**: Completed / Total ratio
- **Failed**: Sessions that errored out

The `/status` JSON endpoint is suitable for monitoring/alerting integrations.

## Testing

82 tests with 96% line coverage:

```bash
pytest                                     # Run all tests
pytest --cov=app --cov-report=term-missing # With coverage report
pytest tests/test_webhook.py -v            # Single module
```

Test stack: pytest + pytest-asyncio + respx (HTTP mocking) + in-memory SQLite per test.
