export interface Env {
  DB: D1Database;
  DEVIN_API_KEY: string;
  GH_TOKEN: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_CHANNEL_ID: string;
  ADMIN_API_KEY?: string;
  GITHUB_REPO: string;
}

export type JobStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "timed_out"
  | "finished_no_pr";

export interface Job {
  id: number;
  issue_url: string;
  issue_number: number;
  issue_title: string;
  session_id: string | null;
  session_url: string | null;
  pr_url: string | null;
  status: JobStatus;
  error_message: string | null;
  triggered_by: string | null;
  slack_channel: string | null;
  slack_message_ts: string | null;
  retry_count: number;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface DevinSession {
  session_id: string;
  status: string;
  url: string;
  pull_request_url?: string;
  title?: string;
}

export interface SlackReactionEvent {
  type: "reaction_added";
  user: string;
  reaction: string;
  item: {
    type: string;
    channel: string;
    ts: string;
  };
  event_ts: string;
}

export interface SlackEventPayload {
  type: string;
  challenge?: string;
  event?: SlackReactionEvent;
  token?: string;
  team_id?: string;
}

export interface JobStats {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
  failed: number;
  blocked: number;
  timed_out: number;
  prs_created: number;
}
