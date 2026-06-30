import { Hono } from "hono";
import type { Env, SlackEventPayload } from "../types";
import { verifySlackSignature } from "../middleware/slack-verify";
import { checkRateLimit } from "../middleware/rate-limit";
import { checkIdempotency, findExistingActiveJob, findCompletedJobWithPr, createJob } from "../db/queries";
import { getMessageText, getMessageAttachments, postThreadReply } from "../services/slack";
import { parseIssueUrl, getIssue } from "../services/github";
import { createSession } from "../services/devin";

const ROCKET_EMOJI = "rocket";

const app = new Hono<{ Bindings: Env; Variables: { rawBody: string } }>();

function extractGithubIssueUrl(
  text: string,
  attachments: Array<Record<string, string>> | null
): string | null {
  const pattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/;

  // Try message text first
  const match = text.match(pattern);
  if (match) return match[0];

  // Try attachments
  if (attachments) {
    for (const att of attachments) {
      for (const field of ["title_link", "fallback", "text"]) {
        const val = att[field] ?? "";
        const attMatch = val.match(pattern);
        if (attMatch) return attMatch[0];
      }
    }
  }

  return null;
}

app.post("/webhook/slack", verifySlackSignature, checkRateLimit, async (c) => {
  const body = c.get("rawBody");
  const payload: SlackEventPayload = JSON.parse(body);

  // Handle URL verification challenge
  if (payload.type === "url_verification") {
    return c.text(payload.challenge ?? "");
  }

  // Process events
  const event = payload.event;
  if (!event || event.type !== "reaction_added") {
    return c.json({ ok: true });
  }

  // Only process rocket reactions
  if (event.reaction !== ROCKET_EMOJI) {
    return c.json({ ok: true });
  }

  const channel = event.item.channel;
  const messageTs = event.item.ts;
  const user = event.user;

  // Channel restriction
  if (c.env.SLACK_CHANNEL_ID && channel !== c.env.SLACK_CHANNEL_ID) {
    return c.json({ ok: true });
  }

  // Idempotency check (per-user: prevents Slack retries)
  const idempotencyKey = `${channel}:${messageTs}:${user}`;
  const isDuplicate = await checkIdempotency(c.env.DB, idempotencyKey);
  if (isDuplicate) {
    return c.json({ ok: true });
  }

  // Per-message lock: prevents concurrent reactions from different users
  // creating duplicate sessions for the same issue
  const messageLockKey = `msg_lock:${channel}:${messageTs}`;
  const isLocked = await checkIdempotency(c.env.DB, messageLockKey, 3600);
  if (isLocked) {
    return c.json({ ok: true });
  }

  // Process remediation in background
  c.executionCtx.waitUntil(
    handleRemediation(c.env, channel, messageTs, user)
  );

  return c.json({ ok: true });
});

async function handleRemediation(
  env: Env,
  channel: string,
  messageTs: string,
  user: string
): Promise<void> {
  try {
    // Fetch message to extract issue URL
    const text = await getMessageText(env, channel, messageTs);
    const attachments = await getMessageAttachments(env, channel, messageTs);
    const issueUrl = extractGithubIssueUrl(text, attachments);

    if (!issueUrl) {
      console.log(`No GitHub issue URL found in message ${messageTs}`);
      return;
    }

    // Parse issue URL
    const parsed = parseIssueUrl(issueUrl);
    if (!parsed) {
      console.log(`Could not parse issue URL: ${issueUrl}`);
      return;
    }

    // Check for existing active job
    const existingJob = await findExistingActiveJob(env.DB, issueUrl);
    if (existingJob) {
      await postThreadReply(
        env,
        channel,
        messageTs,
        `⚠️ Remediation already in progress for issue #${parsed.number}.`
      );
      return;
    }

    // Check if there's already a PR
    const completedJob = await findCompletedJobWithPr(env.DB, issueUrl);
    if (completedJob) {
      await postThreadReply(
        env,
        channel,
        messageTs,
        `✅ A PR already exists for issue #${parsed.number}: ${completedJob.pr_url}`
      );
      return;
    }

    // Fetch issue details from GitHub
    const issue = await getIssue(env, parsed.owner, parsed.repo, parsed.number);
    if (!issue) {
      await postThreadReply(
        env,
        channel,
        messageTs,
        `❌ Could not find GitHub issue #${parsed.number}.`
      );
      return;
    }

    // Only remediate open issues
    if (issue.state !== "open") {
      await postThreadReply(
        env,
        channel,
        messageTs,
        `⚠️ Issue #${parsed.number} is already ${issue.state}. Skipping remediation.`
      );
      return;
    }

    // Create Devin session
    const prompt = `Fix the following GitHub issue: ${issueUrl}\n\nTitle: ${issue.title}\n\nPlease investigate the issue, implement a fix, and create a pull request.`;
    const session = await createSession(env, prompt);

    // Create job record
    await createJob(env.DB, {
      issue_url: issueUrl,
      issue_number: parsed.number,
      issue_title: issue.title,
      session_id: session.sessionId,
      session_url: session.url,
      triggered_by: `slack_user:${user}`,
      slack_channel: channel,
      slack_message_ts: messageTs,
    });

    // Notify in thread
    await postThreadReply(
      env,
      channel,
      messageTs,
      `🚀 Remediation started for issue #${parsed.number}: "${issue.title}"\n🔗 Session: ${session.url}`
    );
  } catch (err) {
    console.error("Error in handleRemediation:", err);
    await postThreadReply(
      env,
      channel,
      messageTs,
      `❌ An internal error occurred while processing this reaction. Please try again.`
    );
  }
}

export const webhookRoutes = app;
