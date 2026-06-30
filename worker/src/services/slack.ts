import type { Env } from "../types";

const SLACK_API = "https://slack.com/api";

// Some Slack API methods (e.g. conversations.replies) only accept GET with query params,
// not POST with JSON body. Use GET for read-only methods that require it.
const GET_METHODS = new Set(["conversations.replies", "users.info"]);

async function slackApi(
  env: Env,
  method: string,
  params: Record<string, string | number | boolean>
): Promise<Record<string, unknown>> {
  let response: Response;
  if (GET_METHODS.has(method)) {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])
    ).toString();
    response = await fetch(`${SLACK_API}/${method}?${qs}`, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
  } else {
    response = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
    });
  }
  return (await response.json()) as Record<string, unknown>;
}

export interface SlackMessage {
  text: string;
  attachments: Array<Record<string, string>>;
}

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
    limit: 5,
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

export async function getMessageText(
  env: Env,
  channel: string,
  messageTs: string
): Promise<string> {
  const msg = await getMessage(env, channel, messageTs);
  return msg.text;
}

export async function getMessageAttachments(
  env: Env,
  channel: string,
  messageTs: string
): Promise<Array<Record<string, string>>> {
  const msg = await getMessage(env, channel, messageTs);
  return msg.attachments;
}

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

export async function getUserMention(userId: string): Promise<string> {
  return `<@${userId}>`;
}

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
