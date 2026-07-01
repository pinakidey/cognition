import { describe, it, expect, vi } from "vitest";
import { enqueuePendingMerge, getPendingMerges, updatePendingMerge, cleanupOldPendingMerges } from "../src/db/pending-merges";

function createMockDb(overrides: Record<string, unknown> = {}) {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((..._args: unknown[]) => ({
        run: vi.fn(async () => ({ meta: { changes: 1 } })),
        all: vi.fn(async () => ({ results: overrides.results ?? [] })),
      })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
      all: vi.fn(async () => ({ results: overrides.results ?? [] })),
    })),
  } as unknown as D1Database;
}

describe("Pending merges DB", () => {
  it("enqueuePendingMerge inserts a record", async () => {
    const db = createMockDb();
    await enqueuePendingMerge(db, {
      pr_url: "https://github.com/o/r/pull/1",
      owner: "o", repo: "r", pr_number: 1,
      slack_channel: "C1", slack_message_ts: "1.2",
    });
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("INSERT OR IGNORE"));
  });

  it("getPendingMerges returns pending entries", async () => {
    const mockEntry = {
      id: 1, pr_url: "url", owner: "o", repo: "r", pr_number: 1,
      slack_channel: null, slack_message_ts: null, attempts: 0,
      status: "pending", created_at: "", updated_at: "",
    };
    const db = createMockDb({ results: [mockEntry] });
    const results = await getPendingMerges(db);
    expect(results).toHaveLength(1);
  });

  it("updatePendingMerge sets status to merged", async () => {
    const db = createMockDb();
    await updatePendingMerge(db, 1, "merged");
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE pending_merges"));
  });

  it("updatePendingMerge increments attempt", async () => {
    const db = createMockDb();
    await updatePendingMerge(db, 1, "pending", true);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("attempts = attempts + 1"));
  });

  it("cleanupOldPendingMerges removes old entries", async () => {
    const db = createMockDb();
    await cleanupOldPendingMerges(db);
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM pending_merges"));
  });
});
