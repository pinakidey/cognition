import { Hono } from "hono";
import type { Env } from "../types";
import { verifyAdminKey } from "../middleware/auth";
import { getJobById, updateJob, createJob } from "../db/queries";
import { createSession } from "../services/devin";
import { postThreadReply } from "../services/slack";

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

export const retryRoutes = app;
