import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { healthRoutes } from "../src/routes/health";

describe("Health endpoint", () => {
  const app = new Hono();
  app.route("/", healthRoutes);

  it("returns ok status", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      service: "devin-remediation-service",
    });
  });
});
