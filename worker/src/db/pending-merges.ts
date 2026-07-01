export interface PendingMerge {
  id: number;
  pr_url: string;
  owner: string;
  repo: string;
  pr_number: number;
  slack_channel: string | null;
  slack_message_ts: string | null;
  attempts: number;
  status: string;
  created_at: string;
  updated_at: string;
}

// Queues a PR for auto-merge once CI checks pass.
export async function enqueuePendingMerge(
  db: D1Database,
  params: {
    pr_url: string;
    owner: string;
    repo: string;
    pr_number: number;
    slack_channel: string | null;
    slack_message_ts: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO pending_merges (pr_url, owner, repo, pr_number, slack_channel, slack_message_ts)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      params.pr_url,
      params.owner,
      params.repo,
      params.pr_number,
      params.slack_channel,
      params.slack_message_ts
    )
    .run();
}

// Returns all pending merge entries that haven't been resolved or exhausted.
export async function getPendingMerges(db: D1Database): Promise<PendingMerge[]> {
  const result = await db
    .prepare(
      "SELECT * FROM pending_merges WHERE status = 'pending' AND attempts < 30 ORDER BY created_at ASC"
    )
    .all<PendingMerge>();
  return result.results;
}

// Deletes resolved (merged/failed) pending merge entries older than 7 days.
export async function cleanupOldPendingMerges(db: D1Database): Promise<void> {
  await db
    .prepare(
      "DELETE FROM pending_merges WHERE status IN ('merged', 'failed') AND created_at < datetime('now', '-7 days')"
    )
    .run();
}

// Marks a pending merge as merged or increments its attempt count.
export async function updatePendingMerge(
  db: D1Database,
  id: number,
  status: "merged" | "failed" | "pending",
  incrementAttempt: boolean = false
): Promise<void> {
  if (status === "merged" || status === "failed") {
    await db
      .prepare(
        "UPDATE pending_merges SET status = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(status, id)
      .run();
  } else if (incrementAttempt) {
    await db
      .prepare(
        "UPDATE pending_merges SET attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(id)
      .run();
  }
}
