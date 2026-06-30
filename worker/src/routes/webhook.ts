import { Hono } from "hono";
import type { Env, SlackEventPayload } from "../types";
import { verifySlackSignature } from "../middleware/slack-verify";
import { checkRateLimit } from "../middleware/rate-limit";
import { checkIdempotency, findExistingActiveJob, findCompletedJobWithPr, createJob } from "../db/queries";
import { getMessage, getMessageText, getMessageAttachments, postThreadReply, getUserEmail, getUserDisplayName } from "../services/slack";
import { parseIssueUrl, parsePrUrl, getIssue, findGitHubUserByEmail, approvePullRequest, assignIssue } from "../services/github";
import { createSession } from "../services/devin";
import { logAuditEvent } from "../db/audit";
import { enqueueDeadLetter } from "../db/dead-letters";

const ROCKET_EMOJI = "rocket";
const APPROVE_EMOJI = "white_check_mark";

const app = new Hono<{ Bindings: Env; Variables: { rawBody: string } }>();

// Extracts a GitHub issue URL from message text or attachments.
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

// Orchestrates the full remediation flow: fetch issue, create Devin session, notify Slack.
async function handleRemediation(
  env: Env,
  channel: string,
  messageTs: string,
  user: string
): Promise<void> {
  try {
    // Fetch message to extract issue URL (single API call)
    const msg = await getMessage(env, channel, messageTs);
    const issueUrl = extractGithubIssueUrl(msg.text, msg.attachments);

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
          const assigned = await assignIssue(env, parsed.owner, parsed.repo, parsed.number, ghUsername);
          if (!assigned) ghUsername = null;
        }
      }
    } catch (assignErr) {
      console.error("Non-critical: issue assignment failed:", assignErr);
    }

    // Audit log: non-critical — don't let failures mask successful remediation
    try {
      await logAuditEvent(env.DB, {
        action: "remediation_started",
        actor_slack_id: user,
        actor_github: ghUsername ?? undefined,
        target: issueUrl,
        details: `Issue #${parsed.number}: ${issue.title} → Session ${session.sessionId}`,
      });
    } catch (auditErr) {
      console.error("Non-critical: audit log write failed:", auditErr);
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

    // Dead-letter queue: store failed event for retry
    try {
      await enqueueDeadLetter(
        env.DB,
        "remediation",
        JSON.stringify({ channel, messageTs, user }),
        err instanceof Error ? err.message : "Unknown error"
      );
    } catch (dlErr) {
      console.error("Failed to enqueue dead letter:", dlErr);
    }

    await postThreadReply(
      env,
      channel,
      messageTs,
      `❌ An internal error occurred while processing this reaction. Please try again.`
    );
  }
}

// Extracts a GitHub pull request URL from message text or attachments.
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

// Handles ✅ reaction: maps Slack user to GitHub, submits PR approval with attribution.
async function handleApproval(
  env: Env,
  channel: string,
  messageTs: string,
  slackUserId: string
): Promise<void> {
  try {
    // Approval allowlist check
    if (env.APPROVAL_ALLOWLIST) {
      const allowlist = env.APPROVAL_ALLOWLIST.split(",").map((s) => s.trim());
      if (!allowlist.includes(slackUserId)) {
        await postThreadReply(
          env,
          channel,
          messageTs,
          "⚠️ You are not authorized to approve PRs via Slack. Contact an admin to be added to the allowlist."
        );
        try {
          await logAuditEvent(env.DB, {
            action: "approval_denied",
            actor_slack_id: slackUserId,
            target: `channel:${channel}:${messageTs}`,
            details: "User not in APPROVAL_ALLOWLIST",
          });
        } catch (auditErr) {
          console.error("Non-critical: audit log write failed:", auditErr);
        }
        return;
      }
    }

    // Fetch message to extract PR URL (single API call)
    const msg = await getMessage(env, channel, messageTs);
    const prUrl = extractGithubPrUrl(msg.text, msg.attachments);

    if (!prUrl) {
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

      // Audit log: non-critical
      try {
        await logAuditEvent(env.DB, {
          action: "pr_approved",
          actor_slack_id: slackUserId,
          actor_email: email,
          actor_github: ghUsername ?? undefined,
          target: prUrl,
          details: `PR #${parsed.number} in ${parsed.owner}/${parsed.repo}`,
        });
      } catch (auditErr) {
        console.error("Non-critical: audit log write failed:", auditErr);
      }
    } else {
      await postThreadReply(
        env,
        channel,
        messageTs,
        `❌ Failed to approve PR #${parsed.number}. The service token may lack write access to this repo.`
      );

      // Audit log: non-critical
      try {
        await logAuditEvent(env.DB, {
          action: "pr_approval_failed",
          actor_slack_id: slackUserId,
          actor_email: email,
          target: prUrl,
          details: "GitHub API rejected the approval request",
        });
      } catch (auditErr) {
        console.error("Non-critical: audit log write failed:", auditErr);
      }
    }
  } catch (err) {
    console.error("Error in handleApproval:", err);
    // Temporary: post error to thread for debugging
    try {
      const errMsg = err instanceof Error ? err.message : String(err);
      await postThreadReply(
        env,
        channel,
        messageTs,
        `❌ Approval error (debug): ${errMsg}`
      );
    } catch {
      // ignore post failure
    }
  }
}

// Temporary debug endpoint to test approval flow without webhook signature
app.get("/webhook/test-approve", async (c) => {
  const channel = c.env.SLACK_CHANNEL_ID || "C0BE0NKLY3E";
  const messageTs = c.req.query("ts") || "1782805522.133329";
  const userId = c.req.query("user") || "U0H9KJEQP";

  const steps: string[] = [];
  try {
    steps.push("1. Starting handleApproval test");

    // Step 1: getMessage
    const msg = await getMessage(c.env, channel, messageTs);
    steps.push(`2. getMessage: text=${msg.text.substring(0, 80)}...`);

    // Step 2: extractGithubPrUrl
    const prUrl = extractGithubPrUrl(msg.text, msg.attachments);
    steps.push(`3. extractGithubPrUrl: ${prUrl}`);
    if (!prUrl) return c.json({ steps, error: "No PR URL found" });

    const parsed = parsePrUrl(prUrl);
    steps.push(`4. parsePrUrl: ${JSON.stringify(parsed)}`);
    if (!parsed) return c.json({ steps, error: "Failed to parse PR URL" });

    // Step 3: getUserEmail
    const email = await getUserEmail(c.env, userId);
    steps.push(`5. getUserEmail: ${email}`);
    if (!email) return c.json({ steps, error: "No email found" });

    // Step 4: findGitHubUserByEmail
    const ghUsername = await findGitHubUserByEmail(c.env, email);
    steps.push(`6. findGitHubUserByEmail: ${ghUsername}`);

    const displayName = await getUserDisplayName(c.env, userId);
    steps.push(`7. getUserDisplayName: ${displayName}`);

    // Step 5: Build attribution
    const attribution = ghUsername
      ? `Approved by @${ghUsername} (${displayName}) via Slack ✅ reaction`
      : `Approved by ${displayName} (${email}) via Slack ✅ reaction`;
    steps.push(`8. attribution: ${attribution}`);

    // Step 6: approvePullRequest (DRY RUN - don't actually approve)
    const dryRun = c.req.query("execute") !== "true";
    if (dryRun) {
      steps.push("9. DRY RUN - would call approvePullRequest. Add ?execute=true to actually approve.");
      return c.json({ steps, dryRun: true });
    }

    const success = await approvePullRequest(c.env, parsed.owner, parsed.repo, parsed.number, attribution);
    steps.push(`9. approvePullRequest: success=${success}`);

    if (success) {
      await postThreadReply(c.env, channel, messageTs, `✅ PR #${parsed.number} approved (test endpoint)`);
      steps.push("10. Posted success reply");
    } else {
      steps.push("10. Approval failed (GitHub API rejected)");
    }

    return c.json({ steps, success });
  } catch (err) {
    const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
    steps.push(`ERROR: ${errMsg}`);
    return c.json({ steps, error: errMsg }, 500);
  }
});

export const webhookRoutes = app;
