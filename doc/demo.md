# Devin Remediation Service — Demo Manuscript

**Format:** 5-minute Loom video
**Audience:** VP of Engineering (Cognition team or prospective customer)

---

## SLIDE 1: Opening (0:00 - 0:20)

### Visual
Slack #devin-report channel with a remediation thread visible

### Speaker Notes

> "What if fixing a bug took two emoji reactions instead of four hours? I built an event-driven service on top of Devin's API that does exactly that — engineers react with a rocket to trigger a fix, review the PR, and react with a checkmark to merge. Let me show you how it works."

---

## SLIDE 2: The Problem (0:20 - 0:50)

### Visual
README "Business Impact" table

### Speaker Notes

> "A typical bug-fix cycle — triage, reproduce, fix, PR, review, merge — takes 2 to 4 hours per issue. The real cost is the context switch: each interruption costs 15 to 25 minutes of recovery time."
>
> "Why not let Devin fix everything automatically? Because not all issues are valid or equal priority. A fully autonomous system burns tokens on issues an engineer would dismiss in seconds. Our human-in-the-loop design ensures every AI session is intentional — the engineer decides what's worth fixing."

---

## SLIDE 3: Live Demo (0:50 - 2:30)

### Visual
Screen recording — full Slack flow

### Speaker Notes

> **[Show Slack channel]**
>
> "This is #devin-report. A daily Devin automation scans the repo for issues and posts them here. A triage bot analyzes each one and replies with root cause, confidence score, and scope estimate — so the engineer knows what they're looking at without leaving Slack."
>
> **[Point to rocket reaction]**
>
> "The engineer reacts with a rocket. That triggers our service — it extracts the issue URL, validates it, and creates a Devin session."
>
> **[Show thread: progress updates → PR notification]**
>
> "Progress updates post every 5 minutes. When Devin finishes, the PR link appears in the thread. The engineer reviews the diff, reacts with a checkmark — the service maps their Slack identity to GitHub, submits an approved review, and auto-merges when CI passes."
>
> **[Show dashboard]**
>
> "The dashboard shows all jobs — status, session links, PRs, who triggered them."

---

## SLIDE 4: Architecture (2:30 - 3:30)

### Visual
Architecture diagram from README

### Speaker Notes

> "Three components, all on Cloudflare Workers — zero infrastructure cost."
>
> "The **webhook handler** receives Slack's `reaction_added` event, verifies the HMAC signature, enforces rate limits and repo/channel allowlists, checks idempotency, and creates a Devin session — under 200ms."
>
> "A **cron poller** runs every 60 seconds — polls active sessions, posts progress updates, detects PRs via GitHub search, and manages the approval-merge queue."
>
> "**D1** — Cloudflare's serverless SQLite — tracks job state, idempotency keys, pending merges, audit logs, and a dead-letter queue with exponential backoff."
>
> "Security: 10 layers including signature verification, rate limiting, bot self-filtering, per-repo approval allowlists, and error sanitization. 79 unit tests, TypeScript strict mode, zero `any` types."

---

## SLIDE 5: Why Devin (3:30 - 4:10)

### Visual
Devin session screenshot showing a multi-file migration PR

### Speaker Notes

> "Why Devin and not a code-generation wrapper?"
>
> "**Autonomy.** Devin clones the repo, investigates the issue, writes the fix across multiple files, runs the linter, and creates a structured PR — no handholding."
>
> "**The API.** Session creation, structured prompts, status polling — it's a programmable engineering agent. Our service is pure orchestration; Devin does the engineering."
>
> "**Real scope.** This isn't toy demos — Devin handled a react-redux v7 to v9 upgrade across 40+ files and a full react-dnd to @dnd-kit migration. Multi-file, multi-concern refactors that take a senior engineer hours."

---

## SLIDE 6: Next Steps & Close (4:10 - 5:00)

### Visual
Bullet list → then dashboard or Slack thread

### Speaker Notes

> "The system already supports multi-repo and multi-channel — plug in 10 repos and route to team-specific channels. Custom scan profiles per team. And it integrates with any existing CI/CD pipeline — no changes required."
>
> "The key insight: engineers make decisions, Devin does the work. Two emoji reactions — rocket to start, checkmark to ship. From issue to merged PR, fully observable, fully automated."

---

## Production Notes

### Recording Checklist

1. Open Slack #devin-report with a complete remediation thread (rocket → updates → PR → checkmark)
2. Open the dashboard in a second tab
3. Have the README architecture diagram ready
4. Aim for ~120 words/minute — conversational pace

### Key Stats

| Stat | Value |
|------|-------|
| Engineer time per fix (before/after) | 2-4 hrs → ~5 min |
| Infrastructure cost | $0/month |
| Unit tests | 79 |
| Security layers | 10 |

### Q&A Prep

**Q: What's the fix success rate?**
A: ~70% for routine fixes. Failed sessions notify the engineer in the Slack thread — the system fails gracefully.

**Q: Is the AI committing directly to main?**
A: No — PRs on feature branches, engineer reviews and approves, auto-merge only after CI passes.

**Q: What happens when Devin gets stuck?**
A: 60-minute timeout, engineer is notified, failed events retry via dead-letter queue with backoff.
