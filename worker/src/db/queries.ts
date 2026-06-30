import type { Job, JobStats } from "../types";

// Inserts a new remediation job record into D1.
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

// Retrieves a single job by its primary key.
export async function getJobById(
  db: D1Database,
  jobId: number
): Promise<Job | null> {
  return db
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<Job>();
}

// Returns all jobs in pending, in_progress, or blocked state.
export async function getActiveJobs(db: D1Database): Promise<Job[]> {
  const result = await db
    .prepare(
      "SELECT * FROM jobs WHERE status IN ('pending', 'in_progress', 'blocked')"
    )
    .all<Job>();
  return result.results;
}

// Returns the 50 most recent jobs for dashboard display.
export async function getAllJobs(db: D1Database): Promise<Job[]> {
  const result = await db
    .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50")
    .all<Job>();
  return result.results;
}

// Partially updates a job's fields (status, PR URL, etc.) by ID.
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

// Aggregates job counts by status for the dashboard summary.
export async function getJobStats(db: D1Database): Promise<JobStats> {
  const result = await db
    .prepare(
      `SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as in_progress,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) as blocked,
        COALESCE(SUM(CASE WHEN status = 'timed_out' THEN 1 ELSE 0 END), 0) as timed_out,
        COALESCE(SUM(CASE WHEN pr_url IS NOT NULL THEN 1 ELSE 0 END), 0) as prs_created
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

// Finds an active (non-terminal) job for a given issue URL to prevent duplicates.
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

// Finds a completed job with a PR URL for a given issue (prevents redundant sessions).
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

// Atomically checks and inserts an idempotency key; returns true if duplicate.
export async function checkIdempotency(
  db: D1Database,
  key: string,
  ttlSeconds: number = 300
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - ttlSeconds;

  // Clean expired entries for this key first
  await db
    .prepare("DELETE FROM idempotency WHERE key = ? AND created_at <= ?")
    .bind(key, cutoff)
    .run();

  // Atomic insert — if key already exists, INSERT OR IGNORE does nothing
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO idempotency (key, created_at) VALUES (?, ?)"
    )
    .bind(key, now)
    .run();

  // If no rows were inserted, the key already existed (duplicate)
  return result.meta.changes === 0;
}

// Removes expired idempotency entries older than 1 hour.
export async function cleanupIdempotency(db: D1Database): Promise<void> {
  // Use 3600s cutoff to respect message locks (1-hour TTL)
  const cutoff = Math.floor(Date.now() / 1000) - 3600;
  await db
    .prepare("DELETE FROM idempotency WHERE created_at < ?")
    .bind(cutoff)
    .run();
}
