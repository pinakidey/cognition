import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/types";
import { healthRoutes } from "../src/routes/health";

function createMockEnv(): Env {
  return {
    DB: {
      prepare: vi.fn(() => ({
        first: vi.fn(async () => ({ ok: 1 })),
      })),
    } as unknown as D1Database,
    DEVIN_API_KEY: "test",
    GH_TOKEN: "test",
    SLACK_BOT_TOKEN: "test",
    SLACK_SIGNING_SECRET: "test",
    SLACK_CHANNEL_ID: "test",
    GITHUB_REPO: "test/repo",
  };
}

describe("Health endpoint", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", healthRoutes);

  it("returns ok status when DB is healthy", async () => {
    const env = createMockEnv();
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("devin-remediation-service");
    expect((body.checks as Record<string, string>).worker).toBe("ok");
    expect((body.checks as Record<string, string>).database).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });

  it("returns 503 when DB is down", async () => {
    const env = createMockEnv();
    (env.DB.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      first: vi.fn(async () => { throw new Error("DB error"); }),
    });
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(503);

    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect((body.checks as Record<string, string>).database).toBe("error");
  });
});
