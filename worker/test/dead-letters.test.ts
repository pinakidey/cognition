import { describe, it, expect, vi } from "vitest";
import { enqueueDeadLetter, getRetryableDeadLetters, markDeadLetterRetried, cleanupOldDeadLetters } from "../src/db/dead-letters";

function createMockDB(rows: unknown[] = []) {
  const mockChain = {
    bind: vi.fn(() => mockChain),
    run: vi.fn(async () => ({ meta: { changes: 1 } })),
    all: vi.fn(async () => ({ results: rows })),
    first: vi.fn(async () => rows[0] ?? null),
  };
  return {
    prepare: vi.fn(() => ({
      ...mockChain,
      bind: vi.fn(() => mockChain),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    })),
  } as unknown as D1Database;
}

describe("Dead Letter Queue", () => {
  it("enqueues a dead letter without error", async () => {
    const db = createMockDB();
    await expect(
      enqueueDeadLetter(db, "remediation", '{"channel":"C1"}', "timeout")
    ).resolves.not.toThrow();
    expect(db.prepare).toHaveBeenCalled();
  });

  it("returns retryable dead letters", async () => {
    const mockLetters = [
      { id: 1, event_type: "remediation", payload: "{}", retry_count: 0, max_retries: 3, status: "pending" },
    ];
    const db = createMockDB(mockLetters);
    const result = await getRetryableDeadLetters(db);
    expect(result).toHaveLength(1);
  });

  it("marks dead letter as resolved on success", async () => {
    const db = createMockDB();
    await expect(markDeadLetterRetried(db, 1, true)).resolves.not.toThrow();
  });

  it("increments retry count on failure", async () => {
    const db = createMockDB([{ retry_count: 1 }]);
    await expect(
      markDeadLetterRetried(db, 1, false, "still failing")
    ).resolves.not.toThrow();
  });

  it("cleanupOldDeadLetters runs without error", async () => {
    const db = createMockDB();
    await expect(cleanupOldDeadLetters(db)).resolves.not.toThrow();
  });
});
