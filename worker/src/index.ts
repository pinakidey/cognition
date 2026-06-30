import { Hono } from "hono";
import type { Env } from "./types";
import { healthRoutes } from "./routes/health";
import { webhookRoutes } from "./routes/webhook";
import { dashboardRoutes } from "./routes/dashboard";
import { retryRoutes } from "./routes/retry";
import { pollActiveSessions } from "./services/poller";

const app = new Hono<{ Bindings: Env }>();

// Mount routes
app.route("/", healthRoutes);
app.route("/", webhookRoutes);
app.route("/", dashboardRoutes);
app.route("/", retryRoutes);

// 404 fallback
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

export default {
  fetch: app.fetch,

  // Cron Trigger handler — replaces the asyncio background poller
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(pollActiveSessions(env));
  },
};
