CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_url TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_title TEXT NOT NULL DEFAULT '',
    session_id TEXT,
    session_url TEXT,
    pr_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    triggered_by TEXT,
    slack_channel TEXT,
    slack_message_ts TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_issue_url ON jobs(issue_url);

CREATE TABLE IF NOT EXISTS rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_ip_ts ON rate_limits(ip, timestamp);

CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);
