import type { Env } from "../types";

const SLACK_API = "https://slack.com/api";

async function slackApi(
  env: Env,
  method: string,
  params: Record<string, string>
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

export async function getMessageText(
  env: Env,
  channel: string,
  messageTs: string
): Promise<string> {
  const result = await slackApi(env, "conversations.history", {
    channel,
    latest: messageTs,
    inclusive: "true",
    limit: "1",
  });

  if (!result.ok) return "";

  const messages = result.messages as Array<{ text?: string }>;
  return messages?.[0]?.text ?? "";
}

export async function getMessageAttachments(
  env: Env,
  channel: string,
  messageTs: string
): Promise<Array<Record<string, string>>> {
  const result = await slackApi(env, "conversations.history", {
    channel,
    latest: messageTs,
    inclusive: "true",
    limit: "1",
  });

  if (!result.ok) return [];

  const messages = result.messages as Array<{
    attachments?: Array<Record<string, string>>;
  }>;
  return messages?.[0]?.attachments ?? [];
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
