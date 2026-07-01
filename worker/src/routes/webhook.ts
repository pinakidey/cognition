import { Hono } from "hono";
import type { Env, SlackEventPayload } from "../types";
import { verifySlackSignature } from "../middleware/slack-verify";
import { checkRateLimit } from "../middleware/rate-limit";
import { checkIdempotency, findExistingActiveJob, findCompletedJobWithPr, createJob } from "../db/queries";
import { getMessage, getMessageText, getMessageAttachments, postThreadReply, getUserEmail, getUserDisplayName, isSlackBot } from "../services/slack";
import { parseIssueUrl, parsePrUrl, getIssue, findGitHubUserByEmail, approvePullRequest, assignIssue, arePrChecksPassing, mergePullRequest } from "../services/github";
import { createSession } from "../services/devin";
import { logAuditEvent } from "../db/audit";
import { enqueueDeadLetter } from "../db/dead-letters";
import { enqueuePendingMerge } from "../db/pending-merges";
import { extractGithubIssueUrl, extractGithubPrUrl } from "../services/url-extract";
import { logInfo, logError } from "../services/logger";

const ROCKET_EMOJI = "rocket";
const APPROVE_EMOJI = "white_check_mark";

const app = new Hono<{ Bindings: Env; Variables: { rawBody: string } }>();


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

  // Reject bot users from triggering expensive Devin sessions
  const isBotUser = await isSlackBot(c.env, user);
  if (isBotUser) {
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
      logInfo("no_issue_url", { messageTs });
      return;
    }

    // Parse issue URL
    const parsed = parseIssueUrl(issueUrl);
    if (!parsed) {
      logInfo("unparseable_issue_url", { issueUrl });
      return;
    }

    // Restrict to configured repository
    const configuredRepo = env.GITHUB_REPO;
    if (configuredRepo && `${parsed.owner}/${parsed.repo}` !== configuredRepo) {
      logInfo("repo_mismatch", { repo: `${parsed.owner}/${parsed.repo}`, configured: configuredRepo });
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

    // Store as slack_user:<id>:<display_name> for both mention and dashboard display
    let triggeredByLabel = `slack_user:${user}`;
    try {
      const name = await getUserDisplayName(env, user);
      if (name) triggeredByLabel = `slack_user:${user}:${name}`;
    } catch { /* fall back to user ID only */ }

    // Create job record
    await createJob(env.DB, {
      issue_url: issueUrl,
      issue_number: parsed.number,
      issue_title: issue.title,
      session_id: session.sessionId,
      session_url: session.url,
      triggered_by: triggeredByLabel,
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
      logError("issue_assignment_failed", assignErr, { issueNumber: parsed.number });
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
      logError("audit_log_write_failed", auditErr);
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
    logError("handle_remediation_failed", err, { channel, messageTs });

    // Dead-letter queue: store failed event for retry
    try {
      await enqueueDeadLetter(
        env.DB,
        "remediation",
        JSON.stringify({ channel, messageTs, user }),
        err instanceof Error ? err.message : "Unknown error"
      );
    } catch (dlErr) {
      logError("dead_letter_enqueue_failed", dlErr);
    }

    await postThreadReply(
      env,
      channel,
      messageTs,
      `❌ An internal error occurred while processing this reaction. Please try again.`
    );
  }
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
          logError("audit_log_write_failed", auditErr);
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

    // Restrict approvals to configured repository
    const configuredRepo = env.GITHUB_REPO;
    if (configuredRepo && `${parsed.owner}/${parsed.repo}` !== configuredRepo) {
      logInfo("approval_repo_mismatch", { repo: `${parsed.owner}/${parsed.repo}`, configured: configuredRepo });
      return;
    }

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
        logError("audit_log_write_failed", auditErr);
      }

      // Auto-merge if all CI checks are passing
      try {
        const { passing, sha, merged: alreadyMerged } = await arePrChecksPassing(
          env,
          parsed.owner,
          parsed.repo,
          parsed.number
        );

        if (alreadyMerged) {
          await postThreadReply(
            env,
            channel,
            messageTs,
            `ℹ️ PR #${parsed.number} is already merged.`
          );
        } else if (passing && sha) {
          const merged = await mergePullRequest(
            env,
            parsed.owner,
            parsed.repo,
            parsed.number,
            sha
          );
          if (merged) {
            await postThreadReply(
              env,
              channel,
              messageTs,
              `🎉 PR #${parsed.number} auto-merged (all checks passed)`
            );
          } else {
            // Merge failed despite checks passing (e.g., merge conflicts)
            await enqueuePendingMerge(env.DB, {
              pr_url: prUrl,
              owner: parsed.owner,
              repo: parsed.repo,
              pr_number: parsed.number,
              slack_channel: channel,
              slack_message_ts: messageTs,
            });
            await postThreadReply(
              env,
              channel,
              messageTs,
              `⏳ PR #${parsed.number} approved — will auto-merge once all checks pass.`
            );
          }
        } else {
          // CI not yet passing — queue for poller
          await enqueuePendingMerge(env.DB, {
            pr_url: prUrl,
            owner: parsed.owner,
            repo: parsed.repo,
            pr_number: parsed.number,
            slack_channel: channel,
            slack_message_ts: messageTs,
          });
          await postThreadReply(
            env,
            channel,
            messageTs,
            `⏳ PR #${parsed.number} approved — will auto-merge once all checks pass.`
          );
        }
      } catch (mergeErr) {
        logError("auto_merge_failed", mergeErr, { prNumber: parsed.number });
        // Still queue it so the poller can retry
        try {
          await enqueuePendingMerge(env.DB, {
            pr_url: prUrl,
            owner: parsed.owner,
            repo: parsed.repo,
            pr_number: parsed.number,
            slack_channel: channel,
            slack_message_ts: messageTs,
          });
        } catch { /* ignore */ }
        await postThreadReply(
          env,
          channel,
          messageTs,
          `⏳ PR #${parsed.number} approved — will auto-merge once all checks pass.`
        );
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
        logError("audit_log_write_failed", auditErr);
      }
    }
  } catch (err) {
    logError("handle_approval_failed", err, { channel, messageTs });
    try {
      await postThreadReply(
        env,
        channel,
        messageTs,
        `❌ An internal error occurred while processing the approval. Please try again.`
      );
    } catch {
      // ignore post failure
    }
  }
}

export const webhookRoutes = app;
