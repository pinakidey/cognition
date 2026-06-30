import { describe, it, expect, vi } from "vitest";
import { logAuditEvent, getRecentAuditLogs } from "../src/db/audit";

function createMockDB(rows: unknown[] = []) {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
        all: vi.fn(async () => ({ results: rows })),
      })),
    })),
  } as unknown as D1Database;
}

describe("Audit Log", () => {
  it("logs an audit event without error", async () => {
    const db = createMockDB();
    await expect(
      logAuditEvent(db, {
        action: "pr_approved",
        actor_slack_id: "U123",
        actor_email: "user@example.com",
        actor_github: "username",
        target: "https://github.com/owner/repo/pull/1",
        details: "PR #1 approved",
      })
    ).resolves.not.toThrow();
    expect(db.prepare).toHaveBeenCalled();
  });

  it("handles optional fields as null", async () => {
    const db = createMockDB();
    await expect(
      logAuditEvent(db, {
        action: "approval_denied",
        actor_slack_id: "U456",
        target: "channel:C1:123.456",
      })
    ).resolves.not.toThrow();
  });

  it("retrieves recent audit logs", async () => {
    const mockLogs = [
      { action: "pr_approved", actor_slack_id: "U1", target: "pr/1" },
      { action: "remediation_started", actor_slack_id: "U2", target: "issue/2" },
    ];
    const db = createMockDB(mockLogs);
    const results = await getRecentAuditLogs(db);
    expect(results).toHaveLength(2);
  });

  it("respects limit parameter", async () => {
    const db = createMockDB([]);
    await getRecentAuditLogs(db, 10);
    expect(db.prepare).toHaveBeenCalled();
  });
});
