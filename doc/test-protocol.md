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

The real E2E test exercises the entire flow from Slack reaction to PR merge.

### Prerequisites
- A GitHub issue notification exists in the configured Slack channel
- The issue is **open** in the target repo
- `ALLOWED_REPOS`, `SLACK_CHANNEL_IDS`, `APPROVAL_ALLOWLIST` are configured

### Test Steps

| Step | Action | Verification | Timeout |
|------|--------|-------------|---------|
| 4.1 | Add `rocket` reaction to an issue notification in the Slack channel | Worker receives webhook, creates idempotency key | 10s |
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

### Latest Run: [DATE]

| Phase | Result | Notes |
|-------|--------|-------|
| Phase 1: Unit Tests | | /79 tests |
| Phase 2: Static Analysis | | tsc --noEmit |
| Phase 3: Live Endpoints | | All endpoints |
| Phase 4: Full E2E | | Issue # → PR # |
| Phase 5: Security | | All checks |
