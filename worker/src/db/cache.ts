const DEFAULT_TTL_SECONDS = 300; // 5 minutes

export async function getCached(
  db: D1Database,
  key: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<string | null> {
  const cutoff = Math.floor(Date.now() / 1000) - ttlSeconds;

  const row = await db
    .prepare("SELECT response FROM api_cache WHERE cache_key = ? AND created_at > ?")
    .bind(key, cutoff)
    .first<{ response: string }>();

  return row?.response ?? null;
}

export async function setCache(
  db: D1Database,
  key: string,
  response: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT OR REPLACE INTO api_cache (cache_key, response, created_at) VALUES (?, ?, ?)"
    )
    .bind(key, response, now)
    .run();
}

export async function cleanupCache(db: D1Database): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 600; // 10 min expiry for cleanup
  await db
    .prepare("DELETE FROM api_cache WHERE created_at < ?")
    .bind(cutoff)
    .run();
}
