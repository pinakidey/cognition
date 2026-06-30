import type { DevinSession, Env } from "../types";

const DEVIN_API = "https://api.devin.ai/v1";
const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 4000, 8000]; // exponential backoff

async function devinFetch(
  env: Env,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${DEVIN_API}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${env.DEVIN_API_KEY}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (response.status >= 500) {
        lastError = new Error(`Devin API ${response.status}: ${await response.text()}`);
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
        throw lastError;
      }

      return response;
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }

  throw lastError ?? new Error("Devin API request failed after retries");
}

export async function createSession(
  env: Env,
  prompt: string
): Promise<{ sessionId: string; url: string }> {
  const response = await devinFetch(env, "/sessions", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create Devin session: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    session_id: string;
    url: string;
  };

  return { sessionId: data.session_id, url: data.url };
}

export async function getSession(
  env: Env,
  sessionId: string
): Promise<DevinSession> {
  const response = await devinFetch(env, `/sessions/${sessionId}`);

  if (!response.ok) {
    throw new Error(`Failed to get session ${sessionId}: ${response.status}`);
  }

  const data = (await response.json()) as {
    session_id: string;
    status: string;
    url: string;
    structured_output?: {
      pull_request_url?: string;
    };
    pull_requests?: Array<{ url: string }>;
    title?: string;
  };

  // Check structured_output first, then pull_requests array
  const prUrl =
    data.structured_output?.pull_request_url ??
    data.pull_requests?.[0]?.url ??
    undefined;

  return {
    session_id: data.session_id,
    status: data.status,
    url: data.url,
    pull_request_url: prUrl,
    title: data.title,
  };
}
