# Devin Remediation Service — Demo Manuscript

**Format:** 5-minute Loom video for VP of Engineering audience
**Tone:** Technical but accessible, confident, data-driven

---

## SLIDE 1: Opening (0:00 - 0:30)

### Visual
Dashboard at `https://devin-remediation-service.pinakidey2006.workers.dev/`

### Speaker Notes

> "What if your team's bug-fix workflow required just two emoji reactions instead of four hours of engineering time?"
>
> "I'm going to show you a system I built using Devin — Cognition's autonomous software engineering agent — that turns GitHub issue remediation into a fully automated pipeline. Engineers stay in Slack, react with a rocket emoji to kick off a fix, review the PR that Devin delivers in minutes, and react with a checkmark to approve and merge — two reactions, zero context switches."
>
> "Let me start with a quick introduction to what Devin is, then walk you through the problem, the live system, the architecture, and why this approach is uniquely powerful."

---

## SLIDE 2: What is Devin? (0:30 - 1:00)

### Visual
Devin API documentation or Devin session UI

### Speaker Notes

> "Devin is an autonomous AI software engineer built by Cognition. Unlike code-completion tools that suggest one line at a time, Devin operates as a full engineering agent — it can clone repos, read code, investigate issues, write fixes, run tests, and open pull requests. All autonomously."
>
> "It exposes a REST API that lets you programmatically create sessions, pass in prompts, and monitor progress. That API is the foundation of what I built — the remediation service is pure orchestration on top of Devin's engineering capabilities."
>
> "Think of it this way: Devin is the engineer, and our service is the project manager that assigns work, tracks progress, and reports results."

---

## SLIDE 3: The Problem — Why This Matters (1:00 - 1:45)

### Visual
README "Business Impact" section — the Before/After table

### Speaker Notes

> "Here's the workflow problem we're solving. In a typical engineering org, a bug-fix cycle looks like this: an issue gets filed, an engineer context-switches away from feature work, reads the report, sets up a local environment, debugs, writes the fix, opens a PR, waits for review, addresses feedback, and merges. That's 2 to 4 hours of focused engineering time per fix."
>
> "But the real cost isn't the fix itself — it's the interruption. Studies show each context switch costs 15 to 25 minutes of recovery time. An engineer handling three bugs in a day might lose two hours just re-entering flow state."
>
> "Now multiply that across a team. A hundred bug fixes per month at an average of three hours each — that's $22,500 in engineering time. And those are hours not spent on feature work, architecture improvements, or technical debt reduction."
>
> "The question we asked: can we reduce the engineer's involvement to just reviewing the AI's work? Not zero humans — humans still make the decisions — but zero humans doing the tedious implementation work."
>
> "Now, you might ask — why not just let Devin fix everything automatically? Because not all issues are valid, and not all valid issues are equal priority. A fully autonomous system would burn tokens on low-priority or duplicate issues that an engineer would dismiss in seconds. The human-in-the-loop design ensures every AI session is intentional — the engineer triages first, then triggers remediation only on issues worth fixing."

---

## SLIDE 4: Live Demo — The System in Action (1:45 - 3:15)

### Visual
Screen recording showing the full flow in Slack and the dashboard

### Speaker Notes

> "Let me show you the system running in production right now."
>
> **[Show Slack #devin-report channel]**
>
> "This is our #devin-report channel. Every day at midnight UTC, a Devin automation scans the target repository — in this case, Apache Superset — for code quality and security issues. It creates GitHub issues for anything new it finds. Those issues flow into this channel via the GitHub-Slack integration."
>
> **[Point to a triage reply in a thread]**
>
> "A second automation — our triage bot — immediately analyzes each issue and posts a threaded reply with a confidence score, root cause analysis, suggested fix, and scope estimate. The engineer doesn't even need to open GitHub to decide if this is worth fixing."
>
> **[Point to a message with a rocket reaction]**
>
> "When the engineer decides to fix an issue, they react with the rocket emoji. That's it. That single reaction triggers our remediation service."
>
> **[Show the thread replies appearing]**
>
> "Within seconds, the service posts a confirmation: 'Remediation started for issue #25.' It includes a link to the live Devin session so anyone can watch the AI work in real time."
>
> "Every five minutes, the service posts a progress update in the thread. The engineer doesn't need to check anything — updates come to them."
>
> **[Show the PR notification in the thread]**
>
> "And here's the result — a PR notification with the fix, posted right in the same thread. The engineer reviews the diff, and if it looks good, they react with a checkmark."
>
> **[Show the checkmark reaction and approval]**
>
> "That checkmark triggers our approval flow: the service maps their Slack identity to their GitHub account, submits an approved review on their behalf, and if CI passes, auto-merges the PR. If CI is still running, it queues the merge and retries every 60 seconds."
>
> **[Show the dashboard]**
>
> "Here's our observability dashboard — total jobs, success rate, active sessions, completed remediations with PR links. Everything is visible at a glance."

---

## SLIDE 5: Architecture — Key Decisions (3:15 - 4:00)

### Visual
Architecture diagram from README or code structure

### Speaker Notes

> "Let me walk through the architecture decisions that make this work."
>
> "The entire service runs on Cloudflare Workers — serverless, edge-deployed, with a permanent free tier. Infrastructure cost is literally zero dollars per month. The only real cost is the Devin API at about $2 to $5 per session."
>
> "The architecture is event-driven with three main components:"
>
> "First, the **webhook handler**. Slack sends a `reaction_added` event to our endpoint. We verify the HMAC-SHA256 signature, check rate limits, enforce channel and repo allowlists, validate idempotency to prevent duplicate sessions, extract the GitHub issue URL from the Slack message, and create a Devin session — all in under 200 milliseconds to meet Slack's 3-second deadline."
>
> "Second, the **cron poller**. Every 60 seconds, a Cloudflare Cron Trigger polls all active Devin sessions via the API, posts progress updates to Slack threads, searches GitHub for PRs, and handles the approval queue. It uses `Promise.all` for concurrent polling and D1 API caching to minimize external API calls."
>
> "Third, the **D1 database** — Cloudflare's serverless SQLite. It tracks job state, rate limits, idempotency keys, pending merges, audit logs, and a dead-letter queue for failed events. All state transitions are atomic."
>
> "Security has ten layers: signature verification, constant-time comparison, rate limiting, idempotency, channel restriction, bot filtering, approval allowlists, repo restriction, admin auth, and error sanitization. The bot even filters itself out to prevent expensive recursive sessions."
>
> "We have 79 unit tests, TypeScript strict mode with zero `any` types, and CI/CD via GitHub Actions that deploys on every push to main."

---

## SLIDE 6: Why Devin — What Makes This Possible (4:00 - 4:30)

### Visual
Side-by-side comparison or Devin session screenshot

### Speaker Notes

> "So why Devin specifically? Why not just a GPT wrapper or a code-generation script?"
>
> "Three reasons."
>
> "First, **autonomy**. Devin doesn't just generate code — it investigates. It clones the repo, reads the codebase, understands the dependency graph, writes the fix, runs the linter, handles errors, and creates a well-structured PR with a description, testing instructions, and linked issues. No human handholding in between."
>
> "Second, **the API**. Devin's REST API lets us programmatically create sessions, pass structured prompts, and poll for status and results. That's what makes the orchestration layer possible — we can build workflows around Devin the same way you'd build workflows around any other API."
>
> "Third, **scope**. This isn't a toy demo. Devin handles real migrations — upgrading react-redux from v7 to v9 across 40+ files, replacing abandoned npm packages with typed alternatives, completing partial framework migrations. These are multi-file, multi-concern refactors that would take a senior engineer hours."

---

## SLIDE 7: Next Steps — Real Customer Engagement (4:30 - 4:50)

### Visual
Bullet list of extension points

### Speaker Notes

> "In a real customer engagement, here's how we'd extend this:"
>
> "**Multi-repo at scale** — the system already supports multiple repos and channels. Plug in an organization's top 10 repositories and route issue notifications to team-specific Slack channels."
>
> "**Custom scan profiles** — tailor the daily scanner to each team's priorities: security-focused for infrastructure teams, dependency hygiene for frontend teams, performance patterns for backend teams."
>
> "**Metrics and reporting** — feed the job completion data into the team's existing observability stack. Track mean time to remediation, AI fix success rate, and engineering hours saved per sprint."
>
> "**Review quality gates** — integrate with the team's existing CI/CD, code coverage requirements, and review policies before auto-merge."
>
> "**GitHub App migration** — replace the single PAT with a GitHub App for fine-grained, per-repo permissions and higher API rate limits."

---

## SLIDE 8: Closing — The Business Case (4:50 - 5:00)

### Visual
ROI table from README

### Speaker Notes

> "Let me leave you with the numbers."
>
> "At 100 bug fixes per month — a modest number for any mid-size engineering org — this system saves over $15,000 per month in engineering time. At 500 fixes per month, that's over $75,000. Infrastructure cost is zero. The only variable cost is the Devin API at roughly $350 per month for 100 sessions."
>
> "But the real value isn't the dollar savings — it's the engineering capacity you reclaim. Every hour an engineer doesn't spend on a routine bug fix is an hour they can spend on the product features that drive revenue."
>
> "Two emoji reactions. From issue to merged PR. That's the system."

---

## Production Notes

### Recording Checklist

1. Open the dashboard in Chrome, full screen
2. Open Slack #devin-report channel in a second tab
3. Have a recent remediation thread ready to show (one with all stages: rocket reaction, progress updates, PR notification, checkmark)
4. Have the README architecture diagram visible
5. Speak at a measured pace — 5 minutes is tight but sufficient if you stay on script
6. Keep transitions smooth — use tab switching, not window rearranging

### Key Stats to Memorize

| Stat | Value |
|------|-------|
| Engineer time per fix (before) | 2-4 hours |
| Engineer time per fix (after) | ~5 min (PR review) |
| Time savings | 90-95% |
| Infrastructure cost | $0/month |
| Devin API cost (100 sessions) | ~$350/month |
| ROI at 100 fixes/month | 67% cost reduction ($15,085 saved) |
| ROI at 500 fixes/month | $75,000+ saved |
| Unit tests | 79 |
| Security layers | 10 |
| TypeScript `any` types | 0 |
| Deploy time | <3 seconds |

### Audience Q&A Preparation

**Q: What's the AI fix success rate?**
A: We estimate 70% for routine fixes (dependency upgrades, deprecated API replacements, code quality issues). Complex architectural issues still require human intervention. The system handles this gracefully — failed sessions are logged, and the engineer is notified in the Slack thread.

**Q: What about security? Is the AI committing directly to main?**
A: No. Devin creates PRs on feature branches. The engineer reviews the diff and explicitly approves via the checkmark reaction. Auto-merge only happens after CI passes and the engineer approves. There are 10 security layers including HMAC signature verification, rate limiting, and approval allowlists.

**Q: How does this handle sensitive code or proprietary business logic?**
A: Devin operates within the same security boundary as any CI/CD system — it has repo access via a scoped token. The remediation service itself never sees the code; it only passes the issue URL to Devin and monitors the session status.

**Q: What happens when Devin gets stuck?**
A: The poller detects stale sessions (60-minute timeout) and notifies the engineer in the Slack thread. Failed events go to a dead-letter queue with exponential backoff retry. The system is designed to fail gracefully and keep the human in the loop.

**Q: Can this work with our existing CI/CD pipeline?**
A: Yes. The service is agnostic to the target repo's CI setup. Devin creates a PR, your existing CI runs on it, and the auto-merge only proceeds when all checks pass. No changes to your pipeline required.
