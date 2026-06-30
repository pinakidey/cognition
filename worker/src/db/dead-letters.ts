export interface DeadLetter {
  id: number;
  event_type: string;
  payload: string;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  next_retry_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

// Stores a failed webhook event for automatic retry with exponential backoff.
export async function enqueueDeadLetter(
  db: D1Database,
  eventType: string,
  payload: string,
  errorMessage: string
): Promise<void> {
  const nextRetry = new Date(Date.now() + 60_000).toISOString(); // retry after 1 min
  await db
    .prepare(
      `INSERT INTO dead_letters (event_type, payload, error_message, next_retry_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(eventType, payload, errorMessage, nextRetry)
    .run();
}

// Returns pending dead letters whose next_retry_at has elapsed.
export async function getRetryableDeadLetters(
  db: D1Database
): Promise<DeadLetter[]> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `SELECT * FROM dead_letters
       WHERE status = 'pending' AND retry_count < max_retries AND next_retry_at <= ?
       ORDER BY created_at ASC LIMIT 10`
    )
    .bind(now)
    .all<DeadLetter>();
  return result.results;
}

// Updates a dead letter after retry: marks resolved on success, increments backoff on failure.
export async function markDeadLetterRetried(
  db: D1Database,
  id: number,
  success: boolean,
  errorMessage?: string
): Promise<void> {
  if (success) {
    await db
      .prepare(
        "UPDATE dead_letters SET status = 'resolved', updated_at = datetime('now') WHERE id = ?"
      )
      .bind(id)
      .run();
  } else {
    // Exponential backoff: 1min, 4min, 16min
    const letter = await db
      .prepare("SELECT retry_count FROM dead_letters WHERE id = ?")
      .bind(id)
      .first<{ retry_count: number }>();

    const retryCount = (letter?.retry_count ?? 0) + 1;
    const backoffMs = Math.pow(4, retryCount) * 60_000;
    const nextRetry = new Date(Date.now() + backoffMs).toISOString();

    await db
      .prepare(
        `UPDATE dead_letters
         SET retry_count = ?, error_message = ?, next_retry_at = ?, updated_at = datetime('now'),
             status = CASE WHEN ? >= max_retries THEN 'exhausted' ELSE 'pending' END
         WHERE id = ?`
      )
      .bind(retryCount, errorMessage ?? null, nextRetry, retryCount, id)
      .run();
  }
}

// Deletes resolved/exhausted dead letters older than 7 days.
export async function cleanupOldDeadLetters(db: D1Database): Promise<void> {
  // Remove resolved/exhausted entries older than 7 days
  await db
    .prepare(
      "DELETE FROM dead_letters WHERE status IN ('resolved', 'exhausted') AND created_at < datetime('now', '-7 days')"
    )
    .run();
}
