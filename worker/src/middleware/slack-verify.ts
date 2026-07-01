import type { Context, Next } from "hono";
import type { Env } from "../types";

// Verifies the HMAC-SHA256 signature on incoming Slack webhook requests.
export async function verifySlackSignature(
  c: Context<{ Bindings: Env; Variables: { rawBody: string } }>,
  next: Next
): Promise<Response | void> {
  if (!c.env.SLACK_SIGNING_SECRET) {
    return c.json({ error: "Not configured" }, 500);
  }

  const timestamp = c.req.header("x-slack-request-timestamp") ?? "";
  const signature = c.req.header("x-slack-signature") ?? "";

  // Reject requests older than 5 minutes (before reading body)
  const now = Math.floor(Date.now() / 1000);
  if (!timestamp || Math.abs(now - Number(timestamp)) > 300) {
    return c.json({ error: "Request too old" }, 403);
  }

  const body = await c.req.text();

  // Compute HMAC-SHA256 signature
  const sigBasestring = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(c.env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(sigBasestring)
  );
  const expected = `v0=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  // Constant-time comparison
  const encoder = new TextEncoder();
  const a = encoder.encode(expected);
  const b = encoder.encode(signature);

  if (a.byteLength !== b.byteLength) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const aBuffer = a.buffer as ArrayBuffer;
  const bBuffer = b.buffer as ArrayBuffer;
  const isValid = crypto.subtle.timingSafeEqual(aBuffer, bBuffer);

  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Store raw body for downstream handlers
  c.set("rawBody", body);
  await next();
}
