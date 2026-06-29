import type { Job, JobStats } from "../types";

export async function createJob(
  db: D1Database,
  params: {
    issue_url: string;
    issue_number: number;
    issue_title: string;
    session_id: string;
    session_url: string;
    triggered_by: string;
    slack_channel: string;
    slack_message_ts: string;
  }
): Promise<Job> {
  const result = await db
    .prepare(
      `INSERT INTO jobs (issue_url, issue_number, issue_title, session_id, session_url, status, triggered_by, slack_channel, slack_message_ts)
       VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, ?)
       RETURNING *`
    )
    .bind(
      params.issue_url,
      params.issue_number,
      params.issue_title,
      params.session_id,
      params.session_url,
      params.triggered_by,
      params.slack_channel,
      params.slack_message_ts
    )
    .first<Job>();

  return result!;
}

export async function getJobById(
  db: D1Database,
  jobId: number
): Promise<Job | null> {
  return db
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<Job>();
}

export async function getActiveJobs(db: D1Database): Promise<Job[]> {
  const result = await db
    .prepare(
      "SELECT * FROM jobs WHERE status IN ('pending', 'in_progress', 'blocked')"
    )
    .all<Job>();
  return result.results;
}

export async function getAllJobs(db: D1Database): Promise<Job[]> {
  const result = await db
    .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50")
    .all<Job>();
  return result.results;
}

export async function updateJob(
  db: D1Database,
  jobId: number,
  updates: Partial<
    Pick<
      Job,
      | "status"
      | "session_id"
      | "session_url"
      | "pr_url"
      | "error_message"
      | "last_status"
      | "retry_count"
    >
  >
): Promise<void> {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(updates)) {
    // Whitelist allowed columns
    const allowed = [
      "status",
      "session_id",
      "session_url",
      "pr_url",
      "error_message",
      "last_status",
      "retry_count",
    ];
    if (!allowed.includes(key)) continue;
    fields.push(`${key} = ?`);
    values.push(value as string | number | null);
  }

  if (fields.length === 0) return;

  fields.push("updated_at = datetime('now')");
  values.push(jobId);

  await db
    .prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function getJobStats(db: D1Database): Promise<JobStats> {
  const result = await db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN status = 'timed_out' THEN 1 ELSE 0 END) as timed_out,
        SUM(CASE WHEN pr_url IS NOT NULL THEN 1 ELSE 0 END) as prs_created
      FROM jobs`
    )
    .first<JobStats>();

  return (
    result ?? {
      total: 0,
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      timed_out: 0,
      prs_created: 0,
    }
  );
}

export async function findExistingActiveJob(
  db: D1Database,
  issueUrl: string
): Promise<Job | null> {
  return db
    .prepare(
      "SELECT * FROM jobs WHERE issue_url = ? AND status IN ('pending', 'in_progress', 'blocked') LIMIT 1"
    )
    .bind(issueUrl)
    .first<Job>();
}

export async function findCompletedJobWithPr(
  db: D1Database,
  issueUrl: string
): Promise<Job | null> {
  return db
    .prepare(
      "SELECT * FROM jobs WHERE issue_url = ? AND status = 'completed' AND pr_url IS NOT NULL ORDER BY created_at DESC LIMIT 1"
    )
    .bind(issueUrl)
    .first<Job>();
}

// Idempotency helpers
export async function checkIdempotency(
  db: D1Database,
  key: string,
  ttlSeconds: number = 300
): Promise<boolean> {
  const cutoff = Math.floor(Date.now() / 1000) - ttlSeconds;

  const existing = await db
    .prepare("SELECT key FROM idempotency WHERE key = ? AND created_at > ?")
    .bind(key, cutoff)
    .first();

  if (existing) return true;

  // Insert (upsert)
  await db
    .prepare(
      "INSERT OR REPLACE INTO idempotency (key, created_at) VALUES (?, ?)"
    )
    .bind(key, Math.floor(Date.now() / 1000))
    .run();

  return false;
}

export async function cleanupIdempotency(db: D1Database): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 300;
  await db
    .prepare("DELETE FROM idempotency WHERE created_at < ?")
    .bind(cutoff)
    .run();
}
