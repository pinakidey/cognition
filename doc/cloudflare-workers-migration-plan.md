# Migration Plan: Fly.io → Cloudflare Workers

## Overview

This document outlines the plan to port the Devin Remediation Service from Fly.io (Python/FastAPI) to Cloudflare Workers (TypeScript/Hono) for cost-effective, scalable hosting on Cloudflare's generous free tier.

## Current Architecture (Fly.io)

```
┌─────────────────────────────────────────────────┐
│  Fly.io VM (single instance, nrt region)        │
│                                                 │
│  FastAPI (Python 3.12, uvicorn)                 │
│  ├── POST /webhook/slack (Slack Events API)     │
│  ├── GET  / (HTML dashboard)                    │
│  ├── GET  /status (JSON metrics)                │
│  ├── POST /retry/{job_id} (manual retry)        │
│  ├── GET  /health (health check)                │
│  │                                              │
│  ├── Background Poller (asyncio, 30s interval)  │
│  └── SQLite (aiosqlite, WAL mode)              │
│       └── /data/jobs.db (persistent volume)     │
└─────────────────────────────────────────────────┘
```

**Limitations:**
- 7-day free trial, then paid ($5/mo minimum)
- Single region unless you pay for multi-region
- Must manage VM lifecycle (restarts, health checks)
- Cold starts if machine scales to zero

## Target Architecture (Cloudflare Workers)

```
┌──────────────────────────────────────────────────────────┐
│  Cloudflare Workers (global edge)                        │
│                                                          │
│  Worker: webhook-handler                                 │
│  ├── POST /webhook/slack (Slack Events API)              │
│  ├── GET  / (HTML dashboard)                             │
│  ├── GET  /status (JSON metrics)                         │
│  ├── POST /retry/{job_id} (manual retry)                 │
│  └── GET  /health (health check)                         │
│                                                          │
│  Cron Trigger: session-poller (every 1 minute)           │
│  └── Polls active Devin sessions, updates DB + Slack     │
│                                                          │
│  D1 Database (SQLite-compatible, serverless)             │
│  └── jobs table (same schema as current SQLite)          │
│                                                          │
│  Secrets (Workers Secrets)                               │
│  └── DEVIN_API_KEY, GH_TOKEN, SLACK_BOT_TOKEN, etc.     │
└──────────────────────────────────────────────────────────┘
```

## Free Tier Capacity Analysis

| Resource | Cloudflare Free Limit | Our Projected Usage | Headroom |
|----------|----------------------|-----------------------|----------|
| Worker requests | 100,000/day | ~2,000/day | 50x |
| D1 reads | 5,000,000/day | ~10,000/day | 500x |
| D1 writes | 100,000/day | ~500/day | 200x |
| D1 storage | 5 GB | < 10 MB | 500x |
| Cron triggers | Unlimited | 1,440/day (1/min) | Unlimited |
| CPU time (free) | 10ms/request | ~2-5ms typical | 2-5x |
| Worker size | 1 MB (compressed) | ~100 KB estimated | 10x |

**Verdict:** Easily within free tier at 10x the current load (1,000 issues/day).

## Technology Stack Mapping

| Python (Current) | TypeScript (Target) | Notes |
|-----------------|---------------------|-------|
| FastAPI | **Hono** | Lightweight, CF Workers native, similar DX |
| uvicorn | Workers runtime | No server management needed |
| aiosqlite | **D1 bindings** | Same SQL syntax, serverless |
| httpx | **native fetch()** | Built into Workers runtime |
| asyncio background task | **Cron Triggers** | Scheduled execution, no persistent process |
| pydantic-settings | **wrangler.toml** + env bindings | Config via Workers secrets |
| pytest | **Vitest** | Fast, TypeScript-native testing |
| Docker | Not needed | Workers deploy as JS bundles |

## Migration Phases

### Phase 1: Project Setup (Day 1)

**Goal:** Scaffold the TypeScript project with Hono + D1.

```bash
# Initialize project
npm create cloudflare@latest cognition-worker -- --template hono
cd cognition-worker

# Install dependencies
npm install hono @hono/zod-validator zod

# Configure wrangler.toml
```

**wrangler.toml:**
```toml
name = "devin-remediation-service"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "remediation-db"
database_id = "<generated-on-create>"

[triggers]
crons = ["*/1 * * * *"]  # Every 1 minute

[vars]
GITHUB_REPO = "pinakidey/superset"
RATE_LIMIT = "30/minute"
```

**Directory structure:**
```
cognition-worker/
├── src/
│   ├── index.ts              # Main Hono app + route registration
│   ├── routes/
│   │   ├── webhook.ts        # POST /webhook/slack
│   │   ├── dashboard.ts      # GET / (HTML) + GET /status (JSON)
│   │   ├── retry.ts          # POST /retry/{job_id}
│   │   └── health.ts         # GET /health
│   ├── services/
│   │   ├── devin.ts          # Devin API client
│   │   ├── github.ts         # GitHub API client
│   │   ├── slack.ts          # Slack API client
│   │   └── poller.ts         # Session polling logic
│   ├── middleware/
│   │   ├── auth.ts           # Admin API key verification
│   │   ├── rate-limit.ts     # Rate limiting (using D1 or KV)
│   │   └── slack-verify.ts   # Slack signature verification
│   ├── db/
│   │   ├── schema.sql        # D1 table definitions
│   │   ├── queries.ts        # Type-safe query functions
│   │   └── migrations/       # D1 migration files
│   ├── types.ts              # Shared TypeScript interfaces
│   └── config.ts             # Environment bindings type
├── test/
│   ├── webhook.test.ts
│   ├── poller.test.ts
│   ├── dashboard.test.ts
│   └── helpers/
│       └── fixtures.ts
├── wrangler.toml
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Phase 2: Database Migration (Day 1-2)

**Goal:** Recreate the SQLite schema in D1 with identical structure.

**schema.sql:**
```sql
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_url TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_title TEXT NOT NULL DEFAULT '',
    session_id TEXT,
    session_url TEXT,
    pr_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    triggered_by TEXT,
    slack_channel TEXT,
    slack_message_ts TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_issue_url ON jobs(issue_url);
```

**Migration commands:**
```bash
# Create D1 database
wrangler d1 create remediation-db

# Apply schema
wrangler d1 execute remediation-db --file=src/db/schema.sql

# For data migration from existing Fly.io SQLite:
# 1. Export: fly ssh console -C "sqlite3 /data/jobs.db .dump" > dump.sql
# 2. Import: wrangler d1 execute remediation-db --file=dump.sql
```

### Phase 3: Core Business Logic (Day 2-3)

**Goal:** Port all endpoint handlers and API clients to TypeScript.

**Port order (by dependency):**
1. `types.ts` — Define all interfaces (Job, SlackEvent, DevinSession, etc.)
2. `config.ts` — Environment bindings type definition
3. `db/queries.ts` — Database CRUD operations
4. `services/slack.ts` — Slack API client (post message, get permalink)
5. `services/github.ts` — GitHub API client (validate issue, check PRs)
6. `services/devin.ts` — Devin API client (create session, get status)
7. `middleware/slack-verify.ts` — HMAC-SHA256 signature verification
8. `middleware/auth.ts` — Admin API key check (using `crypto.timingSafeEqual`)
9. `middleware/rate-limit.ts` — Rate limiting using D1 (no in-memory state)
10. `routes/webhook.ts` — Slack webhook handler with remediation trigger
11. `routes/dashboard.ts` — HTML dashboard + JSON status endpoint
12. `routes/retry.ts` — Manual retry endpoint
13. `services/poller.ts` — Session polling logic (called by Cron Trigger)
14. `index.ts` — Wire everything together

**Key implementation notes:**

```typescript
// src/types.ts
export interface Env {
  DB: D1Database;
  DEVIN_API_KEY: string;
  GH_TOKEN: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_CHANNEL_ID: string;
  ADMIN_API_KEY?: string;
  GITHUB_REPO: string;
  RATE_LIMIT: string;
}

export interface Job {
  id: number;
  issue_url: string;
  issue_number: number;
  issue_title: string;
  session_id: string | null;
  session_url: string | null;
  pr_url: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'timed_out' | 'finished_no_pr';
  error_message: string | null;
  triggered_by: string | null;
  slack_channel: string | null;
  slack_message_ts: string | null;
  retry_count: number;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}
```

```typescript
// src/index.ts
import { Hono } from 'hono';
import { webhookRoutes } from './routes/webhook';
import { dashboardRoutes } from './routes/dashboard';
import { retryRoutes } from './routes/retry';
import { healthRoutes } from './routes/health';
import { pollActiveSessions } from './services/poller';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

// Mount routes
app.route('/', healthRoutes);
app.route('/', webhookRoutes);
app.route('/', dashboardRoutes);
app.route('/', retryRoutes);

export default {
  fetch: app.fetch,
  // Cron Trigger handler — replaces the background poller
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(pollActiveSessions(env));
  },
};
```

### Phase 4: Middleware & Security (Day 3)

**Goal:** Port all security features.

```typescript
// src/middleware/slack-verify.ts
import { Context, Next } from 'hono';
import type { Env } from '../types';

export async function verifySlackSignature(c: Context<{ Bindings: Env }>, next: Next) {
  const timestamp = c.req.header('x-slack-request-timestamp');
  const signature = c.req.header('x-slack-signature');
  const body = await c.req.text();

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) {
    return c.json({ error: 'Request too old' }, 403);
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(c.env.SLACK_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sigBasestring));
  const expected = `v0=${Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')}`;

  // Constant-time comparison
  const encoder = new TextEncoder();
  const a = encoder.encode(expected);
  const b = encoder.encode(signature || '');
  if (a.length !== b.length || !crypto.subtle.timingSafeEqual?.(a, b)) {
    return c.json({ error: 'Invalid signature' }, 403);
  }

  // Store raw body for later use
  c.set('rawBody', body);
  await next();
}
```

```typescript
// src/middleware/auth.ts — fixes timing side-channel from Python version
export async function verifyAdminKey(c: Context<{ Bindings: Env }>, next: Next) {
  if (!c.env.ADMIN_API_KEY) return next(); // Unrestricted if not configured

  const token = c.req.header('x-admin-key') ||
    c.req.header('authorization')?.replace('Bearer ', '').trim() || '';

  const encoder = new TextEncoder();
  const a = encoder.encode(token);
  const b = encoder.encode(c.env.ADMIN_API_KEY);

  if (a.length !== b.length || !crypto.subtle.timingSafeEqual?.(a, b)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
}
```

### Phase 5: Poller as Cron Trigger (Day 3-4)

**Goal:** Replace the asyncio background loop with a Cron Trigger.

```typescript
// src/services/poller.ts
export async function pollActiveSessions(env: Env): Promise<void> {
  const activeJobs = await getActiveJobs(env.DB);

  // Poll all jobs concurrently (same as Python's asyncio.gather)
  await Promise.all(activeJobs.map(job => pollSingleJob(job, env)));
}

async function pollSingleJob(job: Job, env: Env): Promise<void> {
  // Check for stale jobs (timeout after 60 minutes)
  const createdAt = new Date(job.created_at).getTime();
  if (Date.now() - createdAt > 60 * 60 * 1000) {
    await markJobTimedOut(job, env);
    return;
  }

  // Poll Devin API for session status
  const session = await getDevinSession(job.session_id!, env);

  // Update status, post Slack notifications on transitions
  if (session.status !== job.last_status) {
    await handleStatusTransition(job, session, env);
  }
}
```

**Key difference:** The Cron Trigger runs every 60 seconds (vs. 30s in Python). This is acceptable — a 30-second delay in status updates is imperceptible for a service that creates PRs.

### Phase 6: Rate Limiting with D1 (Day 4)

**Goal:** Replace in-memory rate limiter with D1-backed persistent rate limiting.

```typescript
// src/middleware/rate-limit.ts
// Uses D1 instead of in-memory — works across multiple Workers instances

export async function checkRateLimit(c: Context<{ Bindings: Env }>, next: Next) {
  if (!c.env.RATE_LIMIT) return next();

  const [maxRequests, windowSeconds] = parseRateLimit(c.env.RATE_LIMIT);
  const clientIp = c.req.header('cf-connecting-ip') || 'unknown'; // Real client IP from CF
  const windowStart = Math.floor(Date.now() / 1000) - windowSeconds;

  // Count recent requests from this IP
  const result = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM rate_limits WHERE ip = ? AND timestamp > ?'
  ).bind(clientIp, windowStart).first<{ count: number }>();

  if (result && result.count >= maxRequests) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }

  // Record this request
  await c.env.DB.prepare(
    'INSERT INTO rate_limits (ip, timestamp) VALUES (?, ?)'
  ).bind(clientIp, Math.floor(Date.now() / 1000)).run();

  // Cleanup old entries (async, non-blocking)
  c.executionCtx.waitUntil(
    c.env.DB.prepare('DELETE FROM rate_limits WHERE timestamp < ?')
      .bind(windowStart)
      .run()
  );

  await next();
}
```

**Advantages over Python version:**
- Uses `cf-connecting-ip` header (real client IP, not proxy)
- Persistent across Worker restarts (D1-backed)
- No memory leak (old entries cleaned up)
- Works across multiple Workers instances

### Phase 7: Testing (Day 4-5)

**Goal:** Port all 114 tests to Vitest with Workers-compatible mocks.

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'miniflare', // Cloudflare Workers test environment
    globals: true,
  },
});
```

**Test categories:**
- Unit tests for each service (devin, github, slack clients)
- Integration tests for webhook handler (with mocked external APIs)
- D1 query tests (using Miniflare's local D1)
- Middleware tests (auth, rate limiting, signature verification)
- Cron trigger tests (poller logic)

### Phase 8: Deployment & Cutover (Day 5)

**Goal:** Deploy to Cloudflare and switch Slack webhook URL.

```bash
# Deploy
wrangler deploy

# Set secrets
wrangler secret put DEVIN_API_KEY
wrangler secret put GH_TOKEN
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put SLACK_CHANNEL_ID
wrangler secret put ADMIN_API_KEY

# Verify health
curl https://devin-remediation-service.<account>.workers.dev/health

# Create D1 database and apply schema
wrangler d1 create remediation-db
wrangler d1 execute remediation-db --file=src/db/schema.sql
```

**Cutover steps:**
1. Deploy Workers app and verify `/health` responds
2. Migrate existing job data from Fly.io SQLite → D1
3. Update Slack Event Subscription URL to Workers URL
4. Verify Slack challenge passes
5. Test with a 🚀 reaction on a test issue
6. Confirm Cron Trigger is polling (check Workers logs)
7. Decommission Fly.io app (`fly apps destroy devin-remediation-service`)

## GitHub Actions Update

```yaml
# .github/workflows/deploy.yml (updated for Cloudflare)
name: Deploy to Cloudflare Workers

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    name: Deploy
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm ci

      - run: npm test

      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          secrets: |
            DEVIN_API_KEY
            GH_TOKEN
            SLACK_BOT_TOKEN
            SLACK_SIGNING_SECRET
            SLACK_CHANNEL_ID
            ADMIN_API_KEY
        env:
          DEVIN_API_KEY: ${{ secrets.DEVIN_API_KEY }}
          GH_TOKEN: ${{ secrets.GH_TOKEN }}
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
          SLACK_SIGNING_SECRET: ${{ secrets.SLACK_SIGNING_SECRET }}
          SLACK_CHANNEL_ID: ${{ secrets.SLACK_CHANNEL_ID }}
          ADMIN_API_KEY: ${{ secrets.ADMIN_API_KEY }}
```

**New secret needed:** `CF_API_TOKEN` (Cloudflare API token with Workers + D1 permissions)

## Behavior Differences & Mitigations

| Behavior | Fly.io (Python) | Cloudflare Workers | Mitigation |
|----------|-----------------|-------------------|------------|
| Poll interval | 30 seconds | 60 seconds (Cron minimum) | Acceptable — PR creation takes minutes anyway |
| Cold starts | None (always-on) | <1ms (V8 isolates) | Non-issue — Workers are essentially always warm |
| Request timeout | Unlimited | 30s (free) / 6min (paid) | Our handlers complete in <5s — no issue |
| Webhook processing | async background task | `waitUntil()` | Same pattern — respond 200, process in background |
| In-memory state | Available (rate limiter, locks) | Not available | Use D1 for rate limits, idempotency keys |
| Long-running connections | Supported | Not supported | Not needed — all our APIs are request/response |
| File system | Persistent volume | Not available | D1 replaces SQLite file |
| Concurrent requests | Single process, asyncio | Multiple isolates, global | Better scalability, but need D1-based locks |

## Risks & Rollback Plan

### Risks

1. **D1 is in open beta** — Possible breaking changes or stability issues
   - Mitigation: D1 is GA as of 2024, but monitor Cloudflare status page
2. **Cron Trigger timing** — May not fire exactly every 60s under heavy load
   - Mitigation: Acceptable variance; sessions take minutes to complete anyway
3. **Workers CPU limit (10ms free tier)** — Complex handlers may exceed
   - Mitigation: Our logic is simple HTTP calls + DB queries; well within limits
4. **Data migration** — Existing job history must be preserved
   - Mitigation: Export SQLite dump → import to D1 before cutover

### Rollback Plan

If issues arise after cutover:
1. Update Slack Event Subscription URL back to Fly.io
2. Redeploy Fly.io app (code still in repo, `fly deploy`)
3. Investigate Workers issues at leisure
4. Total rollback time: < 5 minutes

## Timeline Summary

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 1. Project Setup | Day 1 | Scaffolded TypeScript project |
| 2. Database Migration | Day 1-2 | D1 schema + migration script |
| 3. Core Logic | Day 2-3 | All routes + API clients ported |
| 4. Security Middleware | Day 3 | Auth, rate limiting, signature verification |
| 5. Poller (Cron) | Day 3-4 | Background polling via Cron Triggers |
| 6. Rate Limiting | Day 4 | D1-backed persistent rate limiter |
| 7. Testing | Day 4-5 | Full test suite with Miniflare |
| 8. Deploy & Cutover | Day 5 | Live on Cloudflare, Fly.io decommissioned |

**Total estimated effort: 4-6 working days**

## Cost Comparison

| | Fly.io | Cloudflare Workers (Free) |
|---|--------|--------------------------|
| Monthly cost | $5-15/mo (after trial) | $0 |
| Annual cost | $60-180/yr | $0 |
| Scaling cost | +$5/mo per machine | Free up to 100K req/day |
| Database | Included (SQLite on volume) | Free (D1, 5M reads/day) |
| Custom domain | Free (Fly.io subdomain) | Free |
| SSL | Free | Free |
| DDoS protection | Basic | Enterprise-grade (free) |

## Prerequisites Before Starting

1. **Cloudflare account** — Sign up at https://dash.cloudflare.com
2. **CF API token** — Create at https://dash.cloudflare.com/profile/api-tokens (Workers + D1 permissions)
3. **Node.js 20+** — For local development and Wrangler CLI
4. **Wrangler CLI** — `npm install -g wrangler` (Cloudflare's deployment tool)
5. **Existing data export** — Run `fly ssh console -C "sqlite3 /data/jobs.db .dump"` before decommissioning

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Hono over itty-router | Better TypeScript DX, middleware support, active community |
| D1 over KV | Relational queries needed (JOIN, WHERE, ORDER BY); KV is key-value only |
| Cron Triggers over Durable Objects | Simpler; DO adds complexity we don't need at this scale |
| Vitest over Jest | Native TypeScript, faster, better Workers/Miniflare integration |
| Full rewrite over Python-on-Workers | Pyodide has major limitations (no httpx, limited stdlib, huge cold starts) |
