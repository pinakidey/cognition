import type { Env } from "../types";

const SLACK_API = "https://slack.com/api";

async function slackApi(
  env: Env,
  method: string,
  params: Record<string, string | number | boolean>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
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
  const result = await slackApi(env, "conversations.history", {
    channel,
    latest: messageTs,
    inclusive: true,
    limit: 1,
  });

  if (!result.ok) return { text: "", attachments: [] };

  const messages = result.messages as Array<{
    text?: string;
    attachments?: Array<Record<string, string>>;
  }>;
  const msg = messages?.[0];
  return {
    text: msg?.text ?? "",
    attachments: msg?.attachments ?? [],
  };
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
