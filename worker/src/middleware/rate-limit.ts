import type { Context, Next } from "hono";
import type { Env } from "../types";

const DEFAULT_MAX_REQUESTS = 30;
const DEFAULT_WINDOW_SECONDS = 60;

export async function checkRateLimit(
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> {
  const clientIp = c.req.header("cf-connecting-ip") ?? "unknown";
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - DEFAULT_WINDOW_SECONDS;

  // Count recent requests from this IP
  const result = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM rate_limits WHERE ip = ? AND timestamp > ?"
  )
    .bind(clientIp, windowStart)
    .first<{ count: number }>();

  if (result && result.count >= DEFAULT_MAX_REQUESTS) {
    return c.json({ error: "Rate limit exceeded" }, 429);
  }

  // Record this request
  await c.env.DB.prepare(
    "INSERT INTO rate_limits (ip, timestamp) VALUES (?, ?)"
  )
    .bind(clientIp, now)
    .run();

  // Cleanup old entries (non-blocking)
  c.executionCtx.waitUntil(
    c.env.DB.prepare("DELETE FROM rate_limits WHERE timestamp < ?")
      .bind(windowStart)
      .run()
  );

  await next();
}
