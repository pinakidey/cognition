import { Hono } from "hono";
import type { Env } from "../types";
import { verifyAdminKey } from "../middleware/auth";
import { getJobById, updateJob, createJob, findExistingActiveJob, findCompletedJobWithPr } from "../db/queries";
import { createSession } from "../services/devin";
import { postThreadReply, getMessage } from "../services/slack";
import { parseIssueUrl, getIssue } from "../services/github";
import { extractGithubIssueUrl } from "../services/url-extract";
import { isRepoAllowed, isChannelAllowed } from "../services/config";
import { logAuditEvent } from "../db/audit";
import { logError } from "../services/logger";

const app = new Hono<{ Bindings: Env }>();

app.post("/retry/:jobId", verifyAdminKey, async (c) => {
  const jobId = parseInt(c.req.param("jobId") ?? "", 10);

  if (isNaN(jobId)) {
    return c.json({ error: "Invalid job ID" }, 400);
  }

  const job = await getJobById(c.env.DB, jobId);
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  if (!["failed", "timed_out", "finished_no_pr"].includes(job.status)) {
    return c.json(
      { error: `Cannot retry job with status: ${job.status}` },
      400
    );
  }

  try {
    // Create a new Devin session
    const prompt = `Fix the following GitHub issue: ${job.issue_url}\n\nTitle: ${job.issue_title}\n\nThis is a retry — the previous session did not produce a successful fix. Please investigate and create a pull request.`;
    const session = await createSession(c.env, prompt);

    // Create a new job (keep old one for history)
    const newJob = await createJob(c.env.DB, {
      issue_url: job.issue_url,
      issue_number: job.issue_number,
      issue_title: job.issue_title,
      session_id: session.sessionId,
      session_url: session.url,
      triggered_by: "manual_retry",
      slack_channel: job.slack_channel ?? "",
      slack_message_ts: job.slack_message_ts ?? "",
    });

    // Mark old job retry_count
    await updateJob(c.env.DB, job.id, { retry_count: job.retry_count + 1 });

    // Notify in Slack if applicable
    if (job.slack_channel && job.slack_message_ts) {
      await postThreadReply(
        c.env,
        job.slack_channel,
        job.slack_message_ts,
        `🔄 Retrying remediation for issue #${job.issue_number}...\n🔗 New session: ${session.url}`
      );
    }

    return c.json({
      ok: true,
      new_job_id: newJob.id,
      session_url: session.url,
    });
  } catch (err) {
    console.error("Retry failed:", err);
    return c.json(
      { error: "Failed to create retry session" },
      500
    );
  }
});

// Triggers a full E2E remediation test for a given Slack message (skips bot check).
app.post("/admin/e2e-test", verifyAdminKey, async (c) => {
  const body = await c.req.json<{ channel: string; message_ts: string }>().catch(() => null);
  if (!body?.channel || !body?.message_ts) {
    return c.json({ error: "Required: channel, message_ts" }, 400);
  }

  const { channel, message_ts: messageTs } = body;
  const botUser = "e2e_test";

  if (!isChannelAllowed(c.env, channel)) {
    return c.json({ error: `Channel ${channel} not in SLACK_CHANNEL_IDS` }, 403);
  }

  try {
    const msg = await getMessage(c.env, channel, messageTs);
    const issueUrl = extractGithubIssueUrl(msg.text, msg.attachments);
    if (!issueUrl) {
      return c.json({ error: "No issue URL found in message" }, 400);
    }

    const parsed = parseIssueUrl(issueUrl);
    if (!parsed) {
      return c.json({ error: `Cannot parse issue URL: ${issueUrl}` }, 400);
    }

    const fullRepo = `${parsed.owner}/${parsed.repo}`;
    if (!isRepoAllowed(c.env, fullRepo)) {
      return c.json({ error: `Repo ${fullRepo} not in ALLOWED_REPOS` }, 403);
    }

    const existing = await findExistingActiveJob(c.env.DB, issueUrl);
    if (existing) {
      return c.json({ error: `Active job already exists for issue #${parsed.number}`, job_id: existing.id }, 409);
    }

    const completed = await findCompletedJobWithPr(c.env.DB, issueUrl);
    if (completed) {
      return c.json({ error: `PR already exists for issue #${parsed.number}`, pr_url: completed.pr_url }, 409);
    }

    const issue = await getIssue(c.env, parsed.owner, parsed.repo, parsed.number);
    if (!issue) {
      return c.json({ error: `GitHub issue #${parsed.number} not found` }, 404);
    }
    if (issue.state !== "open") {
      return c.json({ error: `Issue #${parsed.number} is ${issue.state}` }, 400);
    }

    const prompt = `Fix the following GitHub issue: ${issueUrl}\n\nTitle: ${issue.title}\n\nPlease investigate the issue, implement a fix, and create a pull request.`;
    const session = await createSession(c.env, prompt);

    const triggeredByLabel = `e2e_test:${botUser}`;

    const newJob = await createJob(c.env.DB, {
      issue_url: issueUrl,
      issue_number: parsed.number,
      issue_title: issue.title,
      session_id: session.sessionId,
      session_url: session.url,
      triggered_by: triggeredByLabel,
      slack_channel: channel,
      slack_message_ts: messageTs,
    });

    try {
      await logAuditEvent(c.env.DB, {
        action: "e2e_test_started",
        actor_slack_id: botUser,
        target: issueUrl,
        details: `E2E test: Issue #${parsed.number}: ${issue.title} -> Session ${session.sessionId}`,
      });
    } catch { /* non-critical */ }

    await postThreadReply(
      c.env,
      channel,
      messageTs,
      `🧪 E2E Test: Remediation started for issue #${parsed.number}: "${issue.title}"\n🔗 Session: ${session.url}`
    );

    return c.json({
      ok: true,
      job_id: newJob.id,
      issue_number: parsed.number,
      issue_title: issue.title,
      session_id: session.sessionId,
      session_url: session.url,
    });
  } catch (err) {
    logError("e2e_test_failed", err);
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

export const retryRoutes = app;
