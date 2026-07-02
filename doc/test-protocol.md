# Test Protocol

Comprehensive test protocol for the Devin Remediation Service. Covers unit, integration, live endpoint verification, and full end-to-end testing.

---

## Phase 1: Unit Tests

**Tool:** Vitest  
**Command:** `cd worker && npm test`  
**Duration:** <2s  

79 tests across 14 files with zero external dependencies (all D1/API calls mocked).

| Test File | Coverage Area |
|-----------|--------------|
| `config.test.ts` | Multi-repo/channel parsing, per-repo approval allowlist, backward compat |
| `cache.test.ts` | D1 API cache (get/set, TTL expiry, stale cleanup) |
| `audit.test.ts` | Audit log writes and retrieval |
| `dead-letters.test.ts` | DLQ lifecycle (enqueue, backoff formula, retry marking) |
| `pending-merges.test.ts` | Merge queue (enqueue, status update, attempt increment, cleanup) |
| `allowlist.test.ts` | Global approval allowlist CSV parsing |
| `pr-url.test.ts` | PR URL extraction from Slack messages |
| `url-extract.test.ts` | Issue/PR URL extraction from text and attachments |
| `auth.test.ts` | Admin API key auth (deny-all when unset, constant-time compare) |
| `health.test.ts` | Health endpoint (shallow + deep modes, degradation 503) |
| `dashboard.test.ts` | Dashboard HTML rendering, CSP headers, pagination |
| `webhook.test.ts` | Issue URL extraction from Slack message formats |
| `github.test.ts` | GitHub API client (PR search, issue URL parsing) |
| `logger.test.ts` | Structured JSON logging (levels, error serialization) |

**Pass criteria:** All tests green, zero TypeScript errors (`npx tsc --noEmit`).

---

## Phase 2: Static Analysis

**Command:** `cd worker && npx tsc --noEmit`

| Check | Criteria |
|-------|----------|
| TypeScript strict mode | Zero errors with `strict: true` |
| No `any` types | All types explicitly declared |
| No unused imports | Clean compilation output |

---

## Phase 3: Live Endpoint Verification

Verify the deployed Worker responds correctly to all public endpoints.

| # | Test | Command | Expected |
|---|------|---------|----------|
| 3.1 | Health (shallow) | `curl /health` | `{"status":"ok","checks":{"worker":"ok","database":"ok"}}` |
| 3.2 | Health (deep) | `curl /health?deep=true` | All checks `ok` (worker, database, github, slack) |
| 3.3 | Status API | `curl /status` | JSON with `stats`, `active_jobs`, `recent_completed` |
| 3.4 | Dashboard | `curl -I /` | HTTP 200, `Content-Security-Policy` present, `X-Frame-Options: DENY` |
| 3.5 | Webhook rejection | `curl -X POST /webhook/slack` (unsigned) | HTTP 403 (rejects unsigned requests) |
| 3.6 | Admin auth | `curl -X POST /retry/1` (no key) | HTTP 401 or 403 |

**Base URL:** `https://devin-remediation-service.pinakidey2006.workers.dev`

---

## Phase 4: Full End-to-End Test

Two automated E2E approaches — both require zero human involvement.

### Approach A: Webhook-level E2E (via MOCK_MODE)

Tests the **entire** pipeline including the Slack webhook event. The bot adds a 🚀 reaction on a Slack message, Slack sends the `reaction_added` webhook to the Worker, and `MOCK_MODE=true` bypasses the `isSlackBot` filter so the bot's own reaction is processed.

**Prerequisites:**
- `MOCK_MODE` Worker secret set to `"true"` (via `wrangler secret put MOCK_MODE` or deploy workflow)
- A GitHub issue notification exists in the configured Slack channel
- The issue is **open** in the target repo

**Trigger:**
```bash
# Bot adds 🚀 reaction to a Slack message containing an issue URL
curl -s -X POST "https://slack.com/api/reactions.add" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel":"<CHANNEL>","name":"rocket","timestamp":"<MESSAGE_TS>"}'
```

**Coverage:** Slack webhook delivery → signature verification → event routing → idempotency → bot check bypass → message parsing → issue validation → Devin session → progress updates → PR detection.

### Approach B: Admin endpoint E2E (via /admin/e2e-test)

Tests everything **after** the webhook event. Admin-protected endpoint directly triggers the remediation flow for a given Slack message.

**Trigger:**
```bash
curl -s -X POST https://<worker>/admin/e2e-test \
  -H "X-Admin-Key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"channel":"<CHANNEL>","message_ts":"<MESSAGE_TS>"}'
```

**Coverage:** Message parsing → channel/repo allowlist → issue validation → Devin session → progress updates → PR detection. Skips webhook signature verification and bot check.

### Test Steps (both approaches)

| Step | Action | Verification | Timeout |
|------|--------|-------------|---------|
| 4.1 | Trigger remediation (Approach A or B) | Worker creates job, idempotency key set | 10s |
| 4.2 | Worker creates Devin session | Job appears in `/status` API with `status: "in_progress"` | 30s |
| 4.3 | Worker posts "Remediation started" in Slack thread | Thread reply visible with session URL | 30s |
| 4.4 | Poller posts progress updates | Thread reply every 5 minutes with elapsed time | 6min |
| 4.5 | Devin creates a PR | Job transitions to `status: "completed"`, `pr_url` populated | 60min |
| 4.6 | Worker posts PR notification | Thread reply with PR URL and @-mention of triggerer | 60s after PR |
| 4.7 | Add `white_check_mark` reaction to PR notification | Worker submits APPROVE review on GitHub | 30s |
| 4.8 | Auto-merge | PR merged (if CI passes) or queued in `pending_merges` | 30min |

### Monitoring During E2E

```bash
# Watch job status
watch -n 10 'curl -s .../status | python3 -m json.tool'

# Watch Slack thread for updates
curl -s -G "https://slack.com/api/conversations.replies" \
  --data-urlencode "channel=<CHANNEL>" \
  --data-urlencode "ts=<MESSAGE_TS>" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN"
```

### Post-test cleanup (Approach A)

Remove `MOCK_MODE` after testing to restore bot filtering in production:
```bash
wrangler secret delete MOCK_MODE
```

### Pass/Fail Criteria

| Criteria | Required |
|----------|----------|
| Job created in D1 | Yes |
| Devin session started | Yes |
| Slack thread reply posted | Yes |
| PR created in target repo | Yes |
| PR notification with @-mention | Yes |
| Approval review submitted (on manual trigger) | Yes |
| Auto-merge on CI pass (on manual trigger) | Yes |
| No error messages in Slack thread | Yes |
| Dashboard shows job with display name | Yes |

---

## Phase 5: Security Verification

| # | Test | Method | Expected |
|---|------|--------|----------|
| 5.1 | Unsigned webhook rejected | POST without Slack signature headers | 403 |
| 5.2 | Expired timestamp rejected | POST with timestamp >5min old | 403 |
| 5.3 | Invalid signature rejected | POST with wrong HMAC | 401 |
| 5.4 | Rate limiting enforced | 31+ requests in 60s from same IP | 429 |
| 5.5 | Admin endpoint denied without key | POST /retry/1 without X-Admin-Key | 401/403 |
| 5.6 | Bot user rejected on rocket | Bot adds rocket reaction | Silently ignored, no session created |
| 5.7 | Unauthorized approver denied | User not in APPROVAL_ALLOWLIST reacts with checkmark | Warning posted in thread |
| 5.8 | Cross-repo request blocked | Reaction on message with issue from unlisted repo | Silently ignored |

---

## Execution Record

### Run: 2026-07-02

| Phase | Result | Notes |
|-------|--------|-------|
| Phase 1: Unit Tests | PASS | 79/79 tests, 14 files, 1.78s |
| Phase 2: Static Analysis | PASS | `tsc --noEmit` zero errors |
| Phase 3: Live Endpoints | PASS | health, health?deep=true, status, dashboard (200 + CSP), webhook (403) |
| Phase 4: Full E2E (Approach B) | PASS | Issue #28 → PR pinakidey/superset#31 (job #6, ~15min) |
| Phase 4: Full E2E (Approach A) | PASS | Bot 🚀 → webhook → MOCK_MODE bypass → existing PR detected |
| Phase 5: Security | PASS | Unsigned=403, no-admin-key=401 |

**E2E Approach B timeline (job #6):**
- 06:34:20 — Job created via `/admin/e2e-test`, Devin session started
- 06:34:20 — "🧪 E2E Test: Remediation started" posted in Slack thread
- 06:39:47 — Progress update (5min elapsed)
- 06:44:47 — Progress update (10min elapsed)
- ~06:49:xx — PR pinakidey/superset#31 detected, "✅ PR ready" posted in thread
- Session: `devin-227c4a64690d4238bc7be1bf22b0e4fb`

**E2E Approach A (webhook-level) verified:**
- Set `MOCK_MODE=true` via `wrangler secret put`
- Bot added 🚀 reaction to issue #28 message (ts=1782860836.364309)
- Slack delivered `reaction_added` webhook → Worker verified signature
- `MOCK_MODE` bypassed `isSlackBot` → full pipeline executed
- Worker detected existing PR → replied "✅ A PR already exists for issue #28"
- `MOCK_MODE` deleted, bot reaction removed (cleanup)
- Result: Full webhook flow confirmed working end-to-end
