-- Migration 002: Add index on jobs.session_id for faster session lookups
CREATE INDEX IF NOT EXISTS idx_jobs_session_id ON jobs(session_id);
