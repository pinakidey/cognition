import type { Env } from "../types";

const SLACK_API = "https://slack.com/api";

// Some Slack API methods (e.g. conversations.replies) only accept GET with query params,
// not POST with JSON body. Use GET for read-only methods that require it.
const GET_METHODS = new Set(["conversations.replies", "users.info"]);
const FETCH_TIMEOUT_MS = 10_000;

// Calls a Slack Web API method, routing GET-only methods via query params.
async function slackApi(
  env: Env,
  method: string,
  params: Record<string, string | number | boolean>
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let response: Response;
    if (GET_METHODS.has(method)) {
      const qs = new URLSearchParams(
        Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])
      ).toString();
      response = await fetch(`${SLACK_API}/${method}?${qs}`, {
        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
        signal: controller.signal,
      });
    } else {
      response = await fetch(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    }

    if (!response.ok) {
      console.error(`Slack API ${method} returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (!data.ok) {
      console.error(`Slack API ${method} error: ${data.error ?? "unknown"}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export interface SlackMessage {
  text: string;
  attachments: Array<Record<string, string>>;
}

// Fetches a Slack message by timestamp, falling back to thread search for replies.
export async function getMessage(
  env: Env,
  channel: string,
  messageTs: string
): Promise<SlackMessage> {
  // Try channel history first (works for top-level messages)
  const histResult = await slackApi(env, "conversations.history", {
    channel,
    latest: messageTs,
    inclusive: true,
    limit: 1,
  });

  if (histResult.ok) {
    const messages = histResult.messages as Array<{
      text?: string;
      attachments?: Array<Record<string, string>>;
      ts?: string;
    }>;
    const msg = messages?.[0];
    if (msg?.ts === messageTs) {
      return { text: msg.text ?? "", attachments: msg.attachments ?? [] };
    }
  }

  // Not found in channel history — likely a thread reply.
  // Search recent top-level messages' threads to find the target.
  const nearbyResult = await slackApi(env, "conversations.history", {
    channel,
    latest: messageTs,
    inclusive: false,
    limit: 20,
  });

  if (nearbyResult.ok) {
    const nearby = nearbyResult.messages as Array<{
      ts?: string;
      reply_count?: number;
    }>;
    for (const parent of nearby) {
      if (!parent.ts || !parent.reply_count) continue;
      const threadResult = await slackApi(env, "conversations.replies", {
        channel,
        ts: parent.ts,
      });
      if (threadResult.ok) {
        const threadMsgs = threadResult.messages as Array<{
          text?: string;
          attachments?: Array<Record<string, string>>;
          ts?: string;
        }>;
        const target = threadMsgs?.find((m) => m.ts === messageTs);
        if (target) {
          return { text: target.text ?? "", attachments: target.attachments ?? [] };
        }
      }
    }
  }

  return { text: "", attachments: [] };
}

// Returns only the text content of a Slack message.
export async function getMessageText(
  env: Env,
  channel: string,
  messageTs: string
): Promise<string> {
  const msg = await getMessage(env, channel, messageTs);
  return msg.text;
}

// Returns only the attachments array of a Slack message.
export async function getMessageAttachments(
  env: Env,
  channel: string,
  messageTs: string
): Promise<Array<Record<string, string>>> {
  const msg = await getMessage(env, channel, messageTs);
  return msg.attachments;
}

// Posts a reply message in an existing Slack thread.
export async function postThreadReply(
  env: Env,
  channel: string,
  threadTs: string,
  text: string
): Promise<void> {
  await slackApi(env, "chat.postMessage", {
    channel,
    thread_ts: threadTs,
    text,
  });
}

// Formats a Slack user ID as a mentionable link.
export function getUserMention(userId: string): string {
  return `<@${userId}>`;
}

// Retrieves a Slack user's email address from their profile.
export async function getUserEmail(
  env: Env,
  userId: string
): Promise<string | null> {
  const result = await slackApi(env, "users.info", {
    user: userId,
  });

  if (!result.ok) return null;

  const user = result.user as {
    profile?: { email?: string };
  } | undefined;

  return user?.profile?.email ?? null;
}

// Retrieves a Slack user's display name, falling back to real name or user ID.
export async function getUserDisplayName(
  env: Env,
  userId: string
): Promise<string> {
  const result = await slackApi(env, "users.info", {
    user: userId,
  });

  if (!result.ok) return userId;

  const user = result.user as {
    real_name?: string;
    profile?: { display_name?: string };
  } | undefined;

  return user?.profile?.display_name || user?.real_name || userId;
}

// Checks whether a Slack user ID belongs to a bot.
export async function isSlackBot(
  env: Env,
  userId: string
): Promise<boolean> {
  const result = await slackApi(env, "users.info", { user: userId });
  if (!result.ok) return false;

  const user = result.user as {
    is_bot?: boolean;
    id?: string;
  } | undefined;

  return user?.is_bot === true;
}
