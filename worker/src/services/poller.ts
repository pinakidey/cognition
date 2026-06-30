import type { Env, Job } from "../types";
import { getActiveJobs, updateJob, cleanupIdempotency } from "../db/queries";
import { getSession } from "./devin";
import { findPullRequestForIssue, parseIssueUrl } from "./github";
import { postThreadReply, getUserMention } from "./slack";

const STALE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const PROGRESS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function pollActiveSessions(env: Env): Promise<void> {
  const activeJobs = await getActiveJobs(env.DB);

  // Poll all jobs concurrently
  await Promise.all(activeJobs.map((job) => pollSingleJob(job, env)));

  // Cleanup old idempotency entries
  await cleanupIdempotency(env.DB);
}

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
    console.error(`Error polling job ${job.id}:`, err);
  }
}

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
      const userId = triggeredBy.replace("slack_user:", "");
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

function getElapsedMinutes(updatedAt: string): number {
  return Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60000);
}

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
