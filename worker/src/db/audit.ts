export interface AuditEntry {
  action: string;
  actor_slack_id?: string;
  actor_email?: string;
  actor_github?: string;
  target: string;
  details?: string;
}

// Writes a timestamped audit record (approval, denial, remediation) to D1.
export async function logAuditEvent(
  db: D1Database,
  entry: AuditEntry
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (action, actor_slack_id, actor_email, actor_github, target, details)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      entry.action,
      entry.actor_slack_id ?? null,
      entry.actor_email ?? null,
      entry.actor_github ?? null,
      entry.target,
      entry.details ?? null
    )
    .run();
}

// Returns the most recent audit log entries for admin inspection.
export async function getRecentAuditLogs(
  db: D1Database,
  limit: number = 50
): Promise<AuditEntry[]> {
  const result = await db
    .prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<AuditEntry>();
  return result.results;
}
