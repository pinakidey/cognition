# Devin Remediation Service

Event-driven issue remediation service that uses the [Devin API](https://docs.devin.ai/api-reference/overview) to automatically fix GitHub issues triggered by human approval in Slack.

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
3. **Slack Triage** (Devin Automation) analyzes and replies with root cause
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
| `GITHUB_TOKEN` | GitHub PAT with repo access |
| `GITHUB_REPO` | Target repository (default: `pinakidey/superset`) |
| `SLACK_BOT_TOKEN` | Slack Bot OAuth token |
| `SLACK_SIGNING_SECRET` | Slack app signing secret for request verification |
| `SLACK_CHANNEL_ID` | Channel ID for `#devin-report` |
| `DB_PATH` | SQLite database path (default: `./data/jobs.db`) |
| `POLL_INTERVAL_SECONDS` | How often to poll active sessions (default: 30) |

## Local Development

```bash
# Install dependencies
pip install -e .

# Set environment variables
export DEVIN_API_KEY=your_key
export GITHUB_TOKEN=your_token
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_SIGNING_SECRET=...

# Run the service
uvicorn app.main:app --reload --port 8000
```

## Deployment

The service is deployed via Fly.io with a persistent volume for SQLite storage.

```bash
fly deploy
```

## Observability

The dashboard at `/` provides:
- **Total Jobs**: Number of remediation requests processed
- **In Progress**: Currently active Devin sessions
- **Completed**: Successfully resolved with PR
- **PRs Created**: Pull requests opened
- **Success Rate**: Completed / Total ratio
- **Failed**: Sessions that errored out

The `/status` JSON endpoint is suitable for monitoring/alerting integrations.
