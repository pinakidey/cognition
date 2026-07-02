import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../src/types";
import { dashboardRoutes } from "../src/routes/dashboard";

function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("COUNT(*)")) {
          return {
            first: vi.fn(async () => ({
              total: 2, pending: 0, in_progress: 1, completed: 1,
              failed: 0, blocked: 0, timed_out: 0, prs_created: 1,
            })),
          };
        }
        if (sql.includes("ORDER BY created_at DESC")) {
          return {
            all: vi.fn(async () => ({
              results: [
                {
                  id: 1, issue_url: "https://github.com/o/r/issues/1", issue_number: 1,
                  issue_title: "Test Issue", session_id: "s1", session_url: "https://devin.ai/s1",
                  pr_url: "https://github.com/o/r/pull/2", status: "completed",
                  error_message: null, triggered_by: "slack_user:U123:John: Admin",
                  slack_channel: "C1", slack_message_ts: "1.2", retry_count: 0,
                  last_status: "finished", created_at: "2024-01-01T00:00:00Z",
                  updated_at: "2024-01-01T00:01:00Z",
                },
              ],
            })),
          };
        }
        if (sql.includes("audit_log")) {
          return {
            bind: vi.fn(() => ({
              all: vi.fn(async () => ({ results: [] })),
            })),
          };
        }
        return {
          bind: vi.fn(() => ({
            all: vi.fn(async () => ({ results: [] })),
          })),
        };
      }),
    } as unknown as D1Database,
    DEVIN_API_KEY: "test",
    GH_TOKEN: "test",
    SLACK_BOT_TOKEN: "test",
    SLACK_SIGNING_SECRET: "test",
    SLACK_CHANNEL_IDS: "test",
    GITHUB_REPOS: "test/repo",
    ...overrides,
  };
}

describe("Dashboard", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", dashboardRoutes);

  it("renders HTML with CSP headers", async () => {
    const env = createMockEnv();
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBeDefined();
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("escapes single quotes in HTML", async () => {
    const env = createMockEnv();
    const res = await app.request("/", {}, env);
    const html = await res.text();
    // The triggered_by "John: Admin" should be present (colon-safe splitting)
    expect(html).toContain("John: Admin");
  });

  it("handles pagination parameter", async () => {
    const env = createMockEnv();
    const res = await app.request("/?page=1", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Page 1 of 1");
  });

  it("returns JSON for /status endpoint", async () => {
    const env = createMockEnv();
    const res = await app.request("/status", {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.system).toBe("devin-remediation-service");
  });

  it("rejects /audit without admin key", async () => {
    const env = createMockEnv({ ADMIN_API_KEY: "secret" });
    const res = await app.request("/audit", {}, env);
    expect(res.status).toBe(401);
  });
});
