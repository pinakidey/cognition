import { Hono } from "hono";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const checks: Record<string, string> = { worker: "ok" };

  // Verify D1 connectivity
  try {
    const result = await c.env.DB.prepare("SELECT 1 as ok").first<{ ok: number }>();
    checks.database = result?.ok === 1 ? "ok" : "degraded";
  } catch {
    checks.database = "error";
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
