import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

// Returns service health; add ?deep=true for external API connectivity checks.
app.get("/health", async (c) => {
  const checks: Record<string, string> = { worker: "ok" };
  const deep = c.req.query("deep") === "true";

  // Verify D1 connectivity
  try {
    const result = await c.env.DB.prepare("SELECT 1 as ok").first<{ ok: number }>();
    checks.database = result?.ok === 1 ? "ok" : "degraded";
  } catch {
    checks.database = "error";
  }

  if (deep) {
    // Verify GitHub API connectivity (rate limit endpoint is lightweight)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const resp = await fetch("https://api.github.com/rate_limit", {
          headers: {
            Authorization: `token ${c.env.GH_TOKEN}`,
            "User-Agent": "devin-remediation-service",
          },
          signal: controller.signal,
        });
        checks.github = resp.ok ? "ok" : "degraded";
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      checks.github = "error";
    }

    // Verify Slack API connectivity
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const resp = await fetch("https://slack.com/api/auth.test", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${c.env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: "{}",
          signal: controller.signal,
        });
        const data = (await resp.json()) as { ok: boolean };
        checks.slack = data.ok ? "ok" : "degraded";
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      checks.slack = "error";
    }
  }

  const overallStatus = Object.values(checks).every((v) => v === "ok")
    ? "ok"
    : "degraded";

  return c.json({
    status: overallStatus,
    service: "devin-remediation-service",
    checks,
    timestamp: new Date().toISOString(),
  }, overallStatus === "ok" ? 200 : 503);
});

export const healthRoutes = app;
