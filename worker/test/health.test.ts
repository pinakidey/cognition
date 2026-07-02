import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    SLACK_CHANNEL_IDS: "test",
    GITHUB_REPOS: "test/repo",
  };
}

describe("Health endpoint", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", healthRoutes);

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("api.github.com")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (urlStr.includes("slack.com")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("", { status: 500 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns ok with only DB check by default (no deep)", async () => {
    const env = createMockEnv();
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    const checks = body.checks as Record<string, string>;
    expect(checks.worker).toBe("ok");
    expect(checks.database).toBe("ok");
    expect(checks.github).toBeUndefined();
    expect(checks.slack).toBeUndefined();
  });

  it("returns ok with all checks when deep=true", async () => {
    const env = createMockEnv();
    const res = await app.request("/health?deep=true", {}, env);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    const checks = body.checks as Record<string, string>;
    expect(checks.github).toBe("ok");
    expect(checks.slack).toBe("ok");
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

  it("returns degraded when GitHub API is down (deep mode)", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("api.github.com")) {
        return new Response("", { status: 500 });
      }
      if (urlStr.includes("slack.com")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("", { status: 500 });
    }) as typeof fetch;

    const env = createMockEnv();
    const res = await app.request("/health?deep=true", {}, env);
    expect(res.status).toBe(503);

    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("degraded");
    expect((body.checks as Record<string, string>).github).toBe("degraded");
  });
});
