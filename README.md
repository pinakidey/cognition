# Devin Remediation Service

Event-driven issue remediation service that uses the [Devin API](https://docs.devin.ai/api-reference/overview) to automatically fix GitHub issues triggered by human approval in Slack.

## How It All Comes Together

![Workflow](doc/workflow-illustration.png)

A daily scanner finds issues in the target repo and creates GitHub issues. These flow into the `#devin-report` Slack channel where engineers review them. When an engineer reacts with 🚀, the remediation service picks it up, spins up a Devin AI session to implement the fix, posts progress updates every 5 minutes, and delivers a ready-to-review PR — all within minutes, with full observability via the dashboard and Slack thread updates.

Once the PR is ready, the engineer can approve it directly from Slack by reacting with ✅ on the PR notification message — the service maps their Slack identity to GitHub and submits an approved review on their behalf.

## Tech Stack

### Production (Cloudflare Workers)

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Framework | **Hono** (TypeScript) | Lightweight edge-native web framework |
| Runtime | **Cloudflare Workers** (V8 isolates) | Serverless, global edge, permanent free tier |
| Database | **D1** (Cloudflare serverless SQLite) | Job tracking, rate limiting, idempotency |
| Scheduler | **Cron Triggers** (every 60s) | Session polling (replaces background loop) |
| Messaging | **Slack** (Events API + Bot) | HITL trigger (🚀 reaction), progress notifications, thread replies |
| AI Engine | **Devin API** | Creates and monitors automated fix sessions |
| VCS | **GitHub API** | Issue validation, PR detection, issue comments |
| CI/CD | **GitHub Actions** | Auto-deploy + secret sync on push to `main` |
| Testing | **Vitest** | Unit and integration tests |

### Legacy (Fly.io — trial expired)

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Framework | **FastAPI** (Python 3.12) | Async web framework with OpenAPI support |
| Server | **Uvicorn** | ASGI server with hot reload |
| Database | **SQLite** (aiosqlite, WAL mode) | Persistent job tracking with connection pooling |
| HTTP Client | **httpx** | Async HTTP for Devin, GitHub, and Slack APIs |
| Config | **Pydantic Settings** | Type-safe env var management |
| Deployment | **Fly.io** (Docker) | Single-region container with persistent volume |
| Containerization | **Docker** (multi-stage) | Non-root, minimal production image |

## Live Deployment

### Cloudflare Workers (active)

| Endpoint | URL | Auth |
|----------|-----|------|
| Dashboard | https://devin-remediation-service.pinakidey2006.workers.dev/ | Public |
| Health Check | https://devin-remediation-service.pinakidey2006.workers.dev/health | Public |
| Status API | https://devin-remediation-service.pinakidey2006.workers.dev/status | Public |
| Slack Webhook | https://devin-remediation-service.pinakidey2006.workers.dev/webhook/slack | Slack signature |
| Retry Job | https://devin-remediation-service.pinakidey2006.workers.dev/retry/{job_id} | `X-Admin-Key` |

### Fly.io (legacy — trial expired)

| Endpoint | URL | Auth |
|----------|-----|------|
| Dashboard | https://devin-remediation-service.fly.dev/ | Public |
| Health Check | https://devin-remediation-service.fly.dev/health | Public |
| Status API | https://devin-remediation-service.fly.dev/status | Public |
| Slack Webhook | https://devin-remediation-service.fly.dev/webhook/slack | Slack signature |
| Retry Job | https://devin-remediation-service.fly.dev/retry/{job_id} | `X-Admin-Key` |

**Retry endpoint** (protected):
```bash
curl -X POST -H "X-Admin-Key: <your-admin-key>" https://devin-remediation-service.pinakidey2006.workers.dev/retry/{job_id}
```

## Architecture

```
[GitHub Issue Notification in #devin-report]
        │
        ▼ (Engineer reacts with 🚀)
[Slack Events API → POST /webhook/slack]
        │
        ├─ Slack signature verification (HMAC-SHA256)
        ├─ Channel restriction (only configured channel)
        ├─ Rate limiting (30 req/min per IP via D1)
        ├─ Idempotency check (prevents duplicate processing)
        ├─ Extracts GitHub issue URL from message
        ├─ Validates: issue is open, no existing PR or active session
        ├─ Creates Devin session via API with tailored fix prompt
        ├─ Posts Slack thread reply: "🚀 Remediation started"
        │
        ▼ (Cron Trigger — every 60s)
[Polls Devin session status via D1 + Devin API + GitHub API]
        │
        ├─ Every 5 min: posts progress update in Slack thread
        ├─ PR detected (via GitHub search): posts PR link, @-mentions engineer
        ├─ On failure: notifies in Slack thread with retry hint
        ├─ On timeout (60 min): marks stale, notifies
        │
        ▼ (Engineer reacts with ✅ on PR message)
[PR Approval via Slack]
        │
        ├─ Extracts PR URL from message
        ├─ Looks up Slack user's email → GitHub username
        ├─ Submits APPROVE review on GitHub with attribution
        ├─ Posts confirmation in Slack thread
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
├── worker/                        # Cloudflare Workers (TypeScript) — ACTIVE
│   ├── src/
│   │   ├── index.ts               # Hono app entry + Cron Trigger export
│   │   ├── types.ts               # TypeScript interfaces (Env, Job, etc.)
│   │   ├── db/
│   │   │   ├── schema.sql         # D1 table definitions
│   │   │   └── queries.ts         # Typed D1 query functions
│   │   ├── routes/
│   │   │   ├── webhook.ts         # POST /webhook/slack (reaction handler)
│   │   │   ├── dashboard.ts       # GET / (HTML) + GET /status (JSON)
│   │   │   ├── retry.ts           # POST /retry/{jobId} (manual retry)
│   │   │   └── health.ts          # GET /health
│   │   ├── services/
│   │   │   ├── devin.ts           # Devin API client (with retry/backoff)
│   │   │   ├── github.ts          # GitHub API client
│   │   │   ├── slack.ts           # Slack API client
│   │   │   └── poller.ts          # Session polling logic (Cron handler)
│   │   └── middleware/
│   │       ├── auth.ts            # Admin API key verification
│   │       ├── slack-verify.ts    # Slack signature verification
│   │       └── rate-limit.ts      # D1-backed rate limiting
│   ├── test/                      # Vitest test suite (12 tests)
│   ├── wrangler.toml              # Cloudflare config (D1 binding, cron)
│   ├── package.json               # Dependencies (Hono, Vitest, Wrangler)
│   └── tsconfig.json              # TypeScript strict mode
├── app/                           # Python/FastAPI (legacy Fly.io)
│   ├── main.py                    # FastAPI app, lifespan, routes
│   ├── webhook.py                 # Slack webhook handler
│   ├── poller.py                  # Background polling loop
│   ├── database.py                # SQLite async CRUD
│   └── ...                        # Other modules
├── tests/                         # Python test suite (114 tests)
├── .github/workflows/
│   ├── deploy-cloudflare.yml      # CI: test + deploy to CF Workers (main)
│   └── deploy.yml                 # CI: deploy to Fly.io (main)
├── doc/
│   └── cloudflare-workers-migration-plan.md
├── Dockerfile                     # Fly.io container
├── fly.toml                       # Fly.io deployment config
└── docker-compose.yml             # Local development
```

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/webhook/slack` | Slack signature | Slack Events API handler (reaction_added) |
| `GET` | `/` | Public | HTML observability dashboard |
| `GET` | `/status` | Public | JSON API for metrics and job tracking |
| `POST` | `/retry/{job_id}` | `X-Admin-Key` | Retry a failed/timed-out job |
| `GET` | `/health` | Public | Health check |

## How It Works

1. **Daily Scanner** (Devin Automation) finds issues in `pinakidey/superset` at 8AM JST
2. **GitHub → Slack** integration posts issue notifications to `#devin-report`
3. **Slack Triage** (Devin Automation) analyzes and replies with root cause + confidence score
4. **Engineer** reviews triage and reacts with 🚀 to approve remediation
5. **This Service** receives the Slack event, validates the issue, and starts a Devin session
6. **Progress Updates** — every 5 minutes, posts session status in the Slack thread
7. **Devin** fixes the issue and creates a PR
8. **PR Detection** — cron trigger (every 60s) searches GitHub for the PR and notifies Slack with @-mention
9. **Engineer** reacts with ✅ on the PR notification message
10. **PR Approval** — service maps Slack user → GitHub user (via email) and submits an APPROVE review with attribution

## Monthly Cost Estimate

The service itself runs entirely on Cloudflare's free tier. The primary cost driver is Devin API usage (per-session compute). GitHub and Slack APIs are free.

### Per-Ticket Breakdown

| Component | Per Ticket | Notes |
|-----------|-----------|-------|
| **Devin API** | ~$2–5 | Varies by task complexity (simple bug fix vs. large refactor) |
| **CF Workers** | $0 | ~70 requests per ticket (webhook + polling + notifications) |
| **D1 Database** | $0 | ~60 reads + 10 writes per ticket |
| **GitHub API** | $0 | ~3–5 calls per ticket (issue fetch, PR search, approval) |
| **Slack API** | $0 | ~5–8 calls per ticket (message fetch, thread replies) |

### Scale Projections

| Scale | Tickets/mo | Devin API | CF Workers | D1 | **Total** |
|-------|-----------|-----------|------------|-----|-----------|
| **Low** | 100 | $200–500 | $0 (free tier) | $0 (free tier) | **~$200–500/mo** |
| **Medium** | 500 | $1,000–2,500 | $0 (free tier) | $0 (free tier) | **~$1,000–2,500/mo** |
| **High** | 1,000 | $2,000–5,000 | $0 (free tier) | $0 (free tier) | **~$2,000–5,000/mo** |
| **Very High** | 5,000 | $10,000–25,000 | ~$5 (paid tier) | ~$5 (paid tier) | **~$10,000–25,000/mo** |

### Free Tier Headroom (Cloudflare)

| Resource | Free Limit | Usage at 1,000 tickets/mo | Headroom |
|----------|-----------|---------------------------|----------|
| Worker requests | 100K/day (3M/mo) | ~70K/mo | **43x** |
| D1 reads | 5M/day (150M/mo) | ~60K/mo | **2,500x** |
| D1 writes | 100K/day (3M/mo) | ~10K/mo | **300x** |
| Cron triggers | Unlimited | 1/min (44K/mo) | **∞** |

### Notes

- **Devin API cost** depends on your plan: Teams ($80/mo minimum + usage), Enterprise (custom ACU pricing). The $2–5/session estimate assumes moderate bug-fix tasks; complex multi-file refactors may cost more.
- **Infrastructure cost is effectively $0** up to ~5,000 tickets/month on Cloudflare's free tier.
- **GitHub API** has a 5,000 requests/hour limit for authenticated requests — sufficient for all projected scales.
- The Devin session itself handles the expensive work (LLM inference, code execution, testing). All service infrastructure is just lightweight orchestration.

## Configuration

All configuration is via environment variables (set as Worker secrets or GitHub repo secrets):

| Variable | Description |
|----------|-------------|
| `DEVIN_API_KEY` | Devin API key (service or personal) |
| `GH_TOKEN` | GitHub PAT with `repo` scope (for PR approval + issue validation) |
| `GITHUB_REPO` | Target repository (default: `pinakidey/superset`) |
| `SLACK_BOT_TOKEN` | Slack Bot OAuth token |
| `SLACK_SIGNING_SECRET` | Slack app signing secret for request verification |
| `SLACK_CHANNEL_ID` | Channel ID for `#devin-report` (restricts which channel can trigger actions) |
| `ADMIN_API_KEY` | API key for `/retry` endpoint (optional) |

### Required Slack Bot Scopes

| Scope | Purpose |
|-------|---------|
| `channels:history` | Read messages to extract issue/PR URLs |
| `channels:join` | Join the configured channel |
| `chat:write` | Post thread replies (notifications, progress) |
| `reactions:read` | Receive reaction events |
| `reactions:write` | Add reactions (for E2E testing) |
| `users:read.email` | Look up user email for GitHub mapping (✅ approval) |

## Deployment

### Cloudflare Workers (active)

Deployed to Cloudflare's global edge network. GitHub Actions deploys on push to `main`:

```
git push origin main  →  GitHub Action  →  wrangler deploy  →  Live on CF edge
```

**Branches:**
- `main` — production (CF Workers deployment target)
- `python` — backup of the Python/FastAPI implementation

**Initial setup (one-time, already done):**
```bash
npx wrangler d1 create remediation-db      # Create D1 database
npx wrangler d1 execute remediation-db \    # Run schema migration
  --remote --file=worker/src/db/schema.sql
```

### Fly.io (legacy — trial expired)

Deployed to Fly.io (Tokyo/nrt region) with persistent volume for SQLite.
GitHub Actions deploys on push to `main`.

### Required GitHub Repo Secrets

| Secret | Description | Used by |
|--------|-------------|---------|
| `CF_API_TOKEN` | Cloudflare API token (Workers + D1 Edit) | CF deploy |
| `DEVIN_API_KEY` | Devin API key | Both |
| `GH_TOKEN` | GitHub PAT | Both |
| `SLACK_BOT_TOKEN` | Slack Bot OAuth token | Both |
| `SLACK_SIGNING_SECRET` | Slack app signing secret | Both |
| `SLACK_CHANNEL_ID` | Slack channel ID | Both |
| `ADMIN_API_KEY` | Admin auth for retry endpoint | Both |
| `FLY_TOKEN` | Fly.io personal access token | Fly.io only |

## Local Development

### Cloudflare Workers (recommended)

```bash
cd worker
npm install

# Run locally with Miniflare (D1 simulated)
npx wrangler dev

# Run tests
npm test

# Type check
npm run lint

# Deploy manually
npx wrangler deploy
```

### With Docker Compose (Python/legacy)

```bash
# Create a .env file with your secrets
cat > .env <<EOF
DEVIN_API_KEY=your_key
GH_TOKEN=your_token
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_CHANNEL_ID=C0BE0NKLY3E
EOF

# Start the service
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

### Running Tests

```bash
# CF Workers (TypeScript)
cd worker && npm test

# Python (legacy)
pip install -r requirements-dev.txt
pytest --cov=app --cov-report=term-missing
```

## Security

- **Slack signature verification** — All incoming webhooks are verified using HMAC-SHA256 before processing
- **Rate limiting** — Webhook endpoint is rate-limited (30/min per IP) using D1-backed sliding window
- **Idempotency** — Atomic INSERT OR IGNORE prevents duplicate processing from Slack retries
- **Channel restriction** — Only reactions from the configured `SLACK_CHANNEL_ID` trigger remediation
- **Admin API key** — `/retry` endpoint protected by `X-Admin-Key` header with constant-time comparison
- **SQL injection prevention** — All queries use parameterized bindings; column names validated against whitelist
- **No hardcoded secrets** — All credentials are Worker secrets (encrypted at rest)

## Observability

### Dashboard (`/`)

The HTML dashboard provides at-a-glance metrics:
- **Total Jobs**: Number of remediation requests processed
- **In Progress**: Currently active Devin sessions
- **Completed**: Successfully resolved with PR
- **PRs Created**: Pull requests opened
- **Success Rate**: Completed / Total ratio
- **Failed**: Sessions that errored out

The `/status` JSON endpoint returns the same data in machine-readable format, suitable for monitoring/alerting integrations.

### Slack Thread Notifications

Each remediation session maintains a full conversation in the original Slack thread:

```
🚀 Remediation started for issue #7: "Fix login bug"     ← 🚀 reaction triggers session
   🔗 Session: <devin session url>
🔧 Progress update (5min elapsed): status is *running*   ← periodic every 5 min
🔧 Progress update (10min elapsed): status is *running*  ← keeps team informed
⏸️ Session is blocked and needs attention                 ← session hits a blocker
▶️ Session has resumed                                    ← blocker resolved
✅ PR ready for issue #7: <PR url> @engineer              ← PR detected, @-mentions triggerer
✅ PR #22 approved on GitHub (by @engineer)               ← ✅ reaction triggers approval
```

**Progress updates** post every 5 minutes while the session is active, keeping the team aware without requiring them to check the Devin dashboard.

**PR detection** uses GitHub search API as a fallback since the Devin v1 API doesn't expose PRs until the session finishes. The poller checks every 60s for open PRs referencing the issue.

**PR approval** is triggered by reacting with ✅ on any message containing a GitHub PR URL. The service maps the Slack user's email to their GitHub account and submits an APPROVE review with attribution.

### Failsafes & Retries

| Mechanism | Behavior | Configuration |
|-----------|----------|---------------|
| **Devin API retry** | Exponential backoff on session creation (5s → 10s → 20s) | 3 max attempts |
| **Stale job timeout** | Jobs exceeding 60 min are marked `timed_out` with Slack notification | Hardcoded |
| **Manual retry endpoint** | `POST /retry/{job_id}` re-triggers failed/timed-out jobs | Only accepts `failed`, `timed_out`, `finished_no_pr` statuses |
| **Slack retry hints** | Failure/timeout messages include "React with 🚀 again to retry" | Automatic on failure |

## Migration: Fly.io → Cloudflare Workers

The service was migrated from Python/FastAPI on Fly.io to TypeScript/Hono on Cloudflare Workers due to Fly.io's 7-day free trial limitation and 5-minute auto-restart on trial machines.

**Key differences:**

| Aspect | Fly.io (Python) | CF Workers (TypeScript) |
|--------|-----------------|------------------------|
| Runtime | Long-running process | Request-driven V8 isolates |
| Background tasks | asyncio loop (30s) | Cron Trigger (60s) |
| Database | SQLite file on volume | D1 (serverless SQLite) |
| State | In-memory locks + file | D1 (stateless workers) |
| Free tier | 7-day trial | 100K requests/day (permanent) |
| Cold start | None | ~1-5ms |

See `doc/cloudflare-workers-migration-plan.md` for the full migration plan.

## Docker Image Details (Fly.io legacy)

- **Base**: `python:3.12-slim` (multi-stage build)
- **User**: Runs as non-root `appuser` (uid 1000)
- **Health check**: Built-in `HEALTHCHECK` hitting `/health`
- **Port**: Configurable via `PORT` env var (default: 8080)
- **Data**: Mount a volume at `/data` for persistent SQLite storage
- **Env-agnostic**: No platform-specific config baked into the image — works on Fly.io, AWS ECS, GCP Cloud Run, Railway, or any Docker host
