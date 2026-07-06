import type { Env, Job } from "../types";
import { getActiveJobs, updateJob, cleanupIdempotency, createJob, findExistingActiveJob, getCompletedJobsWithPr } from "../db/queries";
import { getSession } from "./devin";
import { createSession } from "./devin";
import { findPullRequestForIssue, parseIssueUrl, getIssue, arePrChecksPassing, mergePullRequest, isPullRequestMerged, parsePrUrl } from "./github";
import { postThreadReply, getUserMention, getUserDisplayName, getMessage } from "./slack";
import { cleanupCache } from "../db/cache";
import { getRetryableDeadLetters, markDeadLetterRetried, cleanupOldDeadLetters } from "../db/dead-letters";
import { getPendingMerges, updatePendingMerge, cleanupOldPendingMerges } from "../db/pending-merges";
import { extractGithubIssueUrl } from "./url-extract";
import { logInfo, logError } from "./logger";

const STALE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const PROGRESS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Cron entry point: polls all active jobs, processes dead letters, and cleans up stale data.
export async function pollActiveSessions(env: Env): Promise<void> {
  const activeJobs = await getActiveJobs(env.DB);

  // Poll all jobs concurrently
  await Promise.all(activeJobs.map((job) => pollSingleJob(job, env)));

  // Cleanup old idempotency entries + expired cache
  await cleanupIdempotency(env.DB);
  await cleanupCache(env.DB);

  // Process dead letter queue
  await processDeadLetters(env);

  // Process pending merges (auto-merge approved PRs once CI passes)
  await processPendingMerges(env);

  // Detect completed jobs whose PR has since been merged
  await processMergedJobs(env);

  // Periodic cleanup of old dead letters and resolved pending merges
  await cleanupOldDeadLetters(env.DB);
  await cleanupOldPendingMerges(env.DB);
}

// Retries failed webhook events from the dead-letter queue with backoff.
async function processDeadLetters(env: Env): Promise<void> {
  const retryable = await getRetryableDeadLetters(env.DB);

  for (const letter of retryable) {
    try {
      const payload = JSON.parse(letter.payload) as {
        channel: string;
        messageTs: string;
        user: string;
      };

      const msg = await getMessage(env, payload.channel, payload.messageTs);

      if (!msg.text && msg.attachments.length === 0) {
        await markDeadLetterRetried(env.DB, letter.id, false, "Message no longer accessible");
        continue;
      }

      const issueUrl = extractGithubIssueUrl(msg.text, msg.attachments);

      if (!issueUrl) {
        await markDeadLetterRetried(env.DB, letter.id, true);
        continue;
      }

      const parsed = parseIssueUrl(issueUrl);
      if (!parsed) {
        await markDeadLetterRetried(env.DB, letter.id, true);
        continue;
      }

      const existing = await findExistingActiveJob(env.DB, issueUrl);
      if (existing) {
        await markDeadLetterRetried(env.DB, letter.id, true);
        continue;
      }

      const issue = await getIssue(env, parsed.owner, parsed.repo, parsed.number);
      if (!issue || issue.state !== "open") {
        await markDeadLetterRetried(env.DB, letter.id, true);
        continue;
      }

      const prompt = `Fix the following GitHub issue: ${issueUrl}\n\nTitle: ${issue.title}\n\nPlease investigate the issue, implement a fix, and create a pull request.`;
      const session = await createSession(env, prompt);

      let triggeredByLabel = `slack_user:${payload.user}`;
      try {
        const name = await getUserDisplayName(env, payload.user);
        if (name) triggeredByLabel = `slack_user:${payload.user}:${name}`;
      } catch { /* fall back to user ID only */ }

      await createJob(env.DB, {
        issue_url: issueUrl,
        issue_number: parsed.number,
        issue_title: issue.title,
        session_id: session.sessionId,
        session_url: session.url,
        triggered_by: triggeredByLabel,
        slack_channel: payload.channel,
        slack_message_ts: payload.messageTs,
      });

      await postThreadReply(
        env,
        payload.channel,
        payload.messageTs,
        `🔄 Retry successful! Remediation started for issue #${parsed.number}: "${issue.title}"\n🔗 Session: ${session.url}`
      );

      await markDeadLetterRetried(env.DB, letter.id, true);
    } catch (err) {
      try {
        await markDeadLetterRetried(
          env.DB,
          letter.id,
          false,
          err instanceof Error ? err.message : "Retry failed"
        );
      } catch (innerErr) {
        logError("dead_letter_mark_failed", innerErr, { letterId: letter.id });
      }
    }
  }
}

// Attempts to merge approved PRs that are waiting for CI to pass (concurrently).
async function processPendingMerges(env: Env): Promise<void> {
  const pending = await getPendingMerges(env.DB);
  await Promise.all(pending.map((entry) => processSinglePendingMerge(env, entry)));
}

// Processes a single pending merge entry with full error isolation.
async function processSinglePendingMerge(env: Env, entry: import("../db/pending-merges").PendingMerge): Promise<void> {
  try {
    const { passing, sha, merged: alreadyMerged, error } = await arePrChecksPassing(
      env,
      entry.owner,
      entry.repo,
      entry.pr_number
    );

    if (error) {
      if (entry.attempts >= 29) {
        await updatePendingMerge(env.DB, entry.id, "failed");
        await safeThreadReply(env, entry, `⚠️ Auto-merge for PR #${entry.pr_number} failed — unable to verify CI status after repeated attempts. Please merge manually.`);
      } else {
        await updatePendingMerge(env.DB, entry.id, "pending", true);
      }
      return;
    }

    if (alreadyMerged) {
      await updatePendingMerge(env.DB, entry.id, "merged");
      return;
    }

    if (!sha) {
      await updatePendingMerge(env.DB, entry.id, "failed");
      await safeThreadReply(env, entry, `ℹ️ PR #${entry.pr_number} was closed — auto-merge cancelled.`);
      return;
    }

    if (passing) {
      const merged = await mergePullRequest(env, entry.owner, entry.repo, entry.pr_number, sha);
      if (merged) {
        await updatePendingMerge(env.DB, entry.id, "merged");
        await safeThreadReply(env, entry, `🎉 PR #${entry.pr_number} auto-merged (all checks passed)`);
      } else if (entry.attempts >= 29) {
        await updatePendingMerge(env.DB, entry.id, "failed");
        await safeThreadReply(env, entry, `⚠️ Auto-merge for PR #${entry.pr_number} failed after 30 attempts — the PR may have merge conflicts or branch protection issues. Please merge manually.`);
      } else {
        await updatePendingMerge(env.DB, entry.id, "pending", true);
      }
    } else {
      if (entry.attempts >= 29) {
        await updatePendingMerge(env.DB, entry.id, "failed");
        await safeThreadReply(env, entry, `⚠️ Auto-merge for PR #${entry.pr_number} timed out — CI checks did not pass within 30 minutes. Please merge manually.`);
      } else {
        await updatePendingMerge(env.DB, entry.id, "pending", true);
      }
    }
  } catch (err) {
    logError("pending_merge_failed", err, { prNumber: entry.pr_number });
    try {
      if (entry.attempts >= 29) {
        await updatePendingMerge(env.DB, entry.id, "failed");
        await safeThreadReply(env, entry, `⚠️ Auto-merge for PR #${entry.pr_number} failed after repeated errors. Please merge manually.`);
      } else {
        await updatePendingMerge(env.DB, entry.id, "pending", true);
      }
    } catch (innerErr) {
      logError("pending_merge_update_failed", innerErr, { entryId: entry.id });
    }
  }
}

// Posts a thread reply for a pending merge entry, swallowing errors.
async function safeThreadReply(
  env: Env,
  entry: { slack_channel: string | null; slack_message_ts: string | null },
  text: string
): Promise<void> {
  if (!entry.slack_channel || !entry.slack_message_ts) return;
  try {
    await postThreadReply(env, entry.slack_channel, entry.slack_message_ts, text);
  } catch (err) {
    logError("pending_merge_reply_failed", err);
  }
}

// Promotes completed jobs to "merged" once their PR has been merged on GitHub.
async function processMergedJobs(env: Env): Promise<void> {
  const jobs = await getCompletedJobsWithPr(env.DB);
  await Promise.all(
    jobs.map(async (job) => {
      try {
        if (!job.pr_url) return;
        const parsed = parsePrUrl(job.pr_url);
        if (!parsed) return;
        const merged = await isPullRequestMerged(
          env,
          parsed.owner,
          parsed.repo,
          parsed.number
        );
        if (merged) {
          await updateJob(env.DB, job.id, { status: "merged" });
        }
      } catch (err) {
        logError("merged_job_check_failed", err, { jobId: job.id });
      }
    })
  );
}

// Checks a single job's Devin session status and posts updates on transitions.
async function pollSingleJob(job: Job, env: Env): Promise<void> {
  try {
    // Check for stale jobs (timeout after 60 minutes)
    const createdAt = new Date(job.created_at).getTime();
    if (Date.now() - createdAt > STALE_TIMEOUT_MS) {
      await markJobTimedOut(job, env);
      return;
    }

    if (!job.session_id) return;

    const session = await getSession(env, job.session_id);

    // PR detected — treat as completed
    if (session.pull_request_url && !job.pr_url) {
      await markJobCompleted(job, session.pull_request_url, env);
      return;
    }

    // Fallback: check GitHub directly for PRs (Devin v1 API doesn't
    // populate pull_request until session finishes)
    if (!job.pr_url) {
      const parsed = parseIssueUrl(job.issue_url);
      if (parsed) {
        const ghPrUrl = await findPullRequestForIssue(
          env,
          parsed.owner,
          parsed.repo,
          parsed.number
        );
        if (ghPrUrl) {
          await markJobCompleted(job, ghPrUrl, env);
          return;
        }
      }
    }

    if (session.status !== job.last_status) {
      await handleStatusTransition(job, session, env);
    } else {
      // No transition — post periodic progress update every 5 minutes
      await maybePostProgressUpdate(job, session, env);
    }
  } catch (err) {
    logError("poll_job_failed", err, { jobId: job.id });
  }
}

// Handles session status changes (blocked, resumed, finished, error) and notifies Slack.
async function handleStatusTransition(
  job: Job,
  session: { status: string; pull_request_url?: string },
  env: Env
): Promise<void> {
  const previousStatus = job.last_status;
  const hasSlack = Boolean(job.slack_channel && job.slack_message_ts);
  const terminalStates = ["finished", "stopped", "error"];

  // Determine and apply status changes (independent of Slack)
  // last_status is updated atomically with each status change to prevent
  // lost transitions if a subsequent operation fails
  if (session.status === "blocked" && previousStatus !== "blocked") {
    await updateJob(env.DB, job.id, {
      status: "blocked",
      last_status: session.status,
    });
    if (hasSlack) {
      await postThreadReply(
        env,
        job.slack_channel!,
        job.slack_message_ts!,
        "⏸️ Session is blocked and needs attention"
      );
    }
  } else if (
    previousStatus === "blocked" &&
    !terminalStates.includes(session.status)
  ) {
    await updateJob(env.DB, job.id, {
      status: "in_progress",
      last_status: session.status,
    });
    if (hasSlack) {
      await postThreadReply(
        env,
        job.slack_channel!,
        job.slack_message_ts!,
        "▶️ Session has resumed"
      );
    }
  } else if (session.status === "finished" || session.status === "stopped") {
    // PR case is already handled by markJobCompleted above (early return)
    // This path only runs if session ended without a PR
    await updateJob(env.DB, job.id, {
      status: "finished_no_pr",
      last_status: session.status,
    });
    if (hasSlack) {
      await postThreadReply(
        env,
        job.slack_channel!,
        job.slack_message_ts!,
        `⚠️ Session finished for issue #${job.issue_number} without creating a PR.`
      );
    }
  } else if (session.status === "error") {
    await updateJob(env.DB, job.id, {
      status: "failed",
      error_message: "Session ended with error",
      last_status: session.status,
    });
    if (hasSlack) {
      await postThreadReply(
        env,
        job.slack_channel!,
        job.slack_message_ts!,
        `❌ Remediation failed for issue #${job.issue_number}. React with 🚀 again to retry.`
      );
    }
  } else {
    // Non-terminal, non-blocked status change — just track it
    await updateJob(env.DB, job.id, { last_status: session.status });
  }
}

// Marks a job as completed with its PR URL and posts the notification to Slack.
async function markJobCompleted(
  job: Job,
  prUrl: string,
  env: Env
): Promise<void> {
  await updateJob(env.DB, job.id, {
    status: "completed",
    pr_url: prUrl,
    last_status: "finished",
  });

  if (job.slack_channel && job.slack_message_ts) {
    const triggeredBy = job.triggered_by ?? "";
    // Only @-mention if triggered by a human (not a bot)
    let mentionText = "";
    if (triggeredBy.startsWith("slack_user:")) {
      const parts = triggeredBy.split(":");
      const userId = parts[1];
      const mention = await getUserMention(userId);
      if (mention) {
        mentionText = ` ${mention} — ready for your review.`;
      }
    }

    await postThreadReply(
      env,
      job.slack_channel,
      job.slack_message_ts,
      `✅ PR ready for issue #${job.issue_number}: ${prUrl}${mentionText}`
    );
  }
}

// Returns an emoji representing the session status.
function formatStatusEmoji(status: string): string {
  switch (status) {
    case "running":
      return "🔧";
    case "blocked":
      return "⏸️";
    default:
      return "🔄";
  }
}

// Calculates minutes elapsed since the given ISO timestamp.
function getElapsedMinutes(updatedAt: string): number {
  return Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60000);
}

// Posts a progress update to Slack if 5+ minutes have elapsed since the last one.
async function maybePostProgressUpdate(
  job: Job,
  session: { status: string; pull_request_url?: string },
  env: Env
): Promise<void> {
  const elapsed = Date.now() - new Date(job.updated_at).getTime();
  if (elapsed < PROGRESS_INTERVAL_MS) return;

  const hasSlack = Boolean(job.slack_channel && job.slack_message_ts);
  if (!hasSlack) return;

  const minutes = getElapsedMinutes(job.created_at);
  const emoji = formatStatusEmoji(session.status);

  await postThreadReply(
    env,
    job.slack_channel!,
    job.slack_message_ts!,
    `${emoji} Progress update (${minutes}min elapsed): Session status is *${session.status}* for issue #${job.issue_number}`
  );

  // Touch updated_at to reset the 5-minute timer
  await updateJob(env.DB, job.id, { last_status: session.status });
}

// Marks a job as timed out and notifies the Slack thread.
async function markJobTimedOut(job: Job, env: Env): Promise<void> {
  await updateJob(env.DB, job.id, {
    status: "timed_out",
    error_message: "Job exceeded 60-minute timeout",
  });

  if (job.slack_channel && job.slack_message_ts) {
    await postThreadReply(
      env,
      job.slack_channel,
      job.slack_message_ts,
      `⏰ Remediation timed out for issue #${job.issue_number} (exceeded 60 min). React with 🚀 again to retry.`
    );
  }
}
