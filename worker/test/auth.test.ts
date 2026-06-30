import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { verifyAdminKey } from "../src/middleware/auth";

describe("Admin auth middleware", () => {
  it("allows access when no ADMIN_API_KEY is configured", async () => {
    const app = new Hono<{ Bindings: { ADMIN_API_KEY?: string } }>();
    app.use("*", verifyAdminKey as any);
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {}, { ADMIN_API_KEY: undefined });
    expect(res.status).toBe(200);
  });

  it("rejects requests without the key", async () => {
    const app = new Hono<{ Bindings: { ADMIN_API_KEY?: string } }>();
    app.use("*", verifyAdminKey as any);
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {}, { ADMIN_API_KEY: "secret123" });
    expect(res.status).toBe(401);
  });

  it("allows requests with the correct key", async () => {
    const app = new Hono<{ Bindings: { ADMIN_API_KEY?: string } }>();
    app.use("*", verifyAdminKey as any);
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request(
      "/test",
      { headers: { "x-admin-key": "secret123" } },
      { ADMIN_API_KEY: "secret123" }
    );
    expect(res.status).toBe(200);
  });

  it("rejects requests with wrong key", async () => {
    const app = new Hono<{ Bindings: { ADMIN_API_KEY?: string } }>();
    app.use("*", verifyAdminKey as any);
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request(
      "/test",
      { headers: { "x-admin-key": "wrong" } },
      { ADMIN_API_KEY: "secret123" }
    );
    expect(res.status).toBe(401);
  });
});
