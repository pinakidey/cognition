import { Hono } from "hono";
import type { Env, SlackEventPayload } from "../types";
import { verifySlackSignature } from "../middleware/slack-verify";
import { checkRateLimit } from "../middleware/rate-limit";
import { checkIdempotency, findExistingActiveJob, findCompletedJobWithPr, createJob } from "../db/queries";
import { getMessageText, getMessageAttachments, postThreadReply, getUserEmail, getUserDisplayName } from "../services/slack";
import { parseIssueUrl, parsePrUrl, getIssue, findGitHubUserByEmail, approvePullRequest, assignIssue } from "../services/github";
import { createSession } from "../services/devin";

const ROCKET_EMOJI = "rocket";
const APPROVE_EMOJI = "white_check_mark";

const app = new Hono<{ Bindings: Env; Variables: { rawBody: string } }>();

function extractGithubIssueUrl(
  text: string,
  attachments: Array<Record<string, string>> | null
): string | null {
  const pattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/;

  // Try attachment title first — GitHub's Slack integration puts the
  // actual issue URL in the title field (e.g. "<url|#21 Title>").
  // This must be checked before text/fallback which may reference other issues.
  if (attachments) {
    for (const att of attachments) {
      const title = att["title"] ?? "";
      const titleMatch = title.match(pattern);
      if (titleMatch) return titleMatch[0];
    }
  }

  // Try message text
  const match = text.match(pattern);
  if (match) return match[0];

  // Try other attachment fields as fallback
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

  const channel = event.item.channel;
  const messageTs = event.item.ts;
  const user = event.user;

  // Channel restriction — applies to all reaction types
  if (c.env.SLACK_CHANNEL_ID && channel !== c.env.SLACK_CHANNEL_ID) {
    return c.json({ ok: true });
  }

  // Route by reaction type
  if (event.reaction === APPROVE_EMOJI) {
    // Idempotency: prevent duplicate approvals from Slack retries
    const approvalKey = `approve:${channel}:${messageTs}:${user}`;
    const isDuplicate = await checkIdempotency(c.env.DB, approvalKey);
    if (isDuplicate) {
      return c.json({ ok: true });
    }

    c.executionCtx.waitUntil(
      handleApproval(c.env, channel, messageTs, user)
    );
    return c.json({ ok: true });
  }

  if (event.reaction !== ROCKET_EMOJI) {
    return c.json({ ok: true });
  }

  // Idempotency check (per-user: prevents Slack retries)
  const idempotencyKey = `${channel}:${messageTs}:${user}`;
  const isDuplicate = await checkIdempotency(c.env.DB, idempotencyKey);
  if (isDuplicate) {
    return c.json({ ok: true });
  }

  // Per-message lock: prevents near-simultaneous reactions from creating
  // duplicate sessions. Short TTL (60s) so retry reactions work after failure.
  // findExistingActiveJob in handleRemediation provides long-term dedup.
  const messageLockKey = `msg_lock:${channel}:${messageTs}`;
  const isLocked = await checkIdempotency(c.env.DB, messageLockKey, 60);
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

    // Assign issue to the triggering user's GitHub account (non-critical)
    let ghUsername: string | null = null;
    try {
      const email = await getUserEmail(env, user);
      if (email) {
        ghUsername = await findGitHubUserByEmail(env, email);
        if (ghUsername) {
          await assignIssue(env, parsed.owner, parsed.repo, parsed.number, ghUsername);
        }
      }
    } catch (assignErr) {
      console.error("Non-critical: issue assignment failed:", assignErr);
    }

    // Notify in thread
    const mention = ghUsername ? ` (assigned to @${ghUsername})` : "";
    await postThreadReply(
      env,
      channel,
      messageTs,
      `🚀 Remediation started for issue #${parsed.number}: "${issue.title}"${mention}\n🔗 Session: ${session.url}`
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

function extractGithubPrUrl(
  text: string,
  attachments: Array<Record<string, string>> | null
): string | null {
  const pattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

  // Check attachment title first
  if (attachments) {
    for (const att of attachments) {
      const title = att["title"] ?? "";
      const titleMatch = title.match(pattern);
      if (titleMatch) return titleMatch[0];
    }
  }

  // Try message text
  const match = text.match(pattern);
  if (match) return match[0];

  // Fallback to other attachment fields
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

async function handleApproval(
  env: Env,
  channel: string,
  messageTs: string,
  slackUserId: string
): Promise<void> {
  try {
    // Fetch message to extract PR URL
    const text = await getMessageText(env, channel, messageTs);
    const attachments = await getMessageAttachments(env, channel, messageTs);
    const prUrl = extractGithubPrUrl(text, attachments);

    if (!prUrl) {
      // Not a PR message — silently ignore
      return;
    }

    const parsed = parsePrUrl(prUrl);
    if (!parsed) return;

    // Look up Slack user's email
    const email = await getUserEmail(env, slackUserId);
    if (!email) {
      await postThreadReply(
        env,
        channel,
        messageTs,
        "⚠️ Could not find your email in Slack profile. Please ensure your email is set to approve PRs."
      );
      return;
    }

    // Find corresponding GitHub user
    const ghUsername = await findGitHubUserByEmail(env, email);
    const displayName = await getUserDisplayName(env, slackUserId);

    // Build attribution message
    const attribution = ghUsername
      ? `Approved by @${ghUsername} (${displayName}) via Slack ✅ reaction`
      : `Approved by ${displayName} (${email}) via Slack ✅ reaction`;

    // Submit the approval
    const success = await approvePullRequest(
      env,
      parsed.owner,
      parsed.repo,
      parsed.number,
      attribution
    );

    if (success) {
      const ghRef = ghUsername ? `@${ghUsername}` : displayName;
      await postThreadReply(
        env,
        channel,
        messageTs,
        `✅ PR #${parsed.number} approved on GitHub (by ${ghRef})`
      );
    } else {
      await postThreadReply(
        env,
        channel,
        messageTs,
        `❌ Failed to approve PR #${parsed.number}. The service token may lack write access to this repo.`
      );
    }
  } catch (err) {
    console.error("Error in handleApproval:", err);
  }
}

export const webhookRoutes = app;
