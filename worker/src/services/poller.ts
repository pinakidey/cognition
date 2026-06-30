import type { Env, Job } from "../types";
import { getActiveJobs, updateJob, cleanupIdempotency } from "../db/queries";
import { getSession } from "./devin";
import { postThreadReply, getUserMention } from "./slack";

const STALE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

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

    // Only act on status transitions
    if (session.status === job.last_status) return;

    await handleStatusTransition(job, session, env);
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
    if (session.pull_request_url) {
      await updateJob(env.DB, job.id, {
        status: "completed",
        pr_url: session.pull_request_url,
        last_status: session.status,
      });
      if (hasSlack) {
        const mention = job.triggered_by?.startsWith("slack_user:")
          ? await getUserMention(job.triggered_by.replace("slack_user:", ""))
          : "";
        const mentionText = mention ? ` ${mention} — ready for your review.` : "";
        await postThreadReply(
          env,
          job.slack_channel!,
          job.slack_message_ts!,
          `✅ PR ready for issue #${job.issue_number}: ${session.pull_request_url}${mentionText}`
        );
      }
    } else {
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
