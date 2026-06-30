import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCached, setCache, cleanupCache } from "../src/db/cache";

function createMockDB() {
  const store = new Map<string, { response: string; created_at: number }>();

  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => ({
        first: vi.fn(async () => {
          if (sql.includes("SELECT")) {
            const key = args[0] as string;
            const cutoff = args[1] as number;
            const entry = store.get(key);
            if (entry && entry.created_at > cutoff) {
              return { response: entry.response };
            }
            return null;
          }
          return null;
        }),
        run: vi.fn(async () => {
          if (sql.includes("INSERT OR REPLACE")) {
            store.set(args[0] as string, {
              response: args[1] as string,
              created_at: args[2] as number,
            });
          }
          if (sql.includes("DELETE")) {
            const cutoff = args[0] as number;
            for (const [key, val] of store.entries()) {
              if (val.created_at < cutoff) store.delete(key);
            }
          }
          return { meta: { changes: 1 } };
        }),
      })),
    })),
  } as unknown as D1Database;
}

describe("API Cache", () => {
  let db: D1Database;

  beforeEach(() => {
    db = createMockDB();
  });

  it("returns null for cache miss", async () => {
    const result = await getCached(db, "nonexistent");
    expect(result).toBeNull();
  });

  it("stores and retrieves cached values", async () => {
    await setCache(db, "test-key", "test-value");
    const result = await getCached(db, "test-key");
    expect(result).toBe("test-value");
  });

  it("respects TTL", async () => {
    await setCache(db, "old-key", "old-value");
    // getCached with TTL=0 would expire immediately
    const result = await getCached(db, "old-key", 300);
    expect(result).toBe("old-value");
  });

  it("cleanupCache runs without error", async () => {
    await expect(cleanupCache(db)).resolves.not.toThrow();
  });
});
