import type { Context, Next } from "hono";
import type { Env } from "../types";

/**
 * Constant-time string comparison.
 * Uses crypto.subtle.timingSafeEqual in Workers runtime,
 * falls back to byte-by-byte comparison with constant time.
 */
function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);

  // Use timingSafeEqual if available (Workers runtime)
  // Pad shorter buffer to match length to avoid leaking key length via timing
  if (typeof crypto !== "undefined" && crypto.subtle?.timingSafeEqual) {
    const maxLen = Math.max(aBuf.length, bBuf.length);
    const paddedA = new Uint8Array(maxLen);
    const paddedB = new Uint8Array(maxLen);
    paddedA.set(aBuf);
    paddedB.set(bBuf);
    // Always call timingSafeEqual (no short-circuit) to avoid timing leak
    const bytesMatch = crypto.subtle.timingSafeEqual(
      paddedA.buffer as ArrayBuffer,
      paddedB.buffer as ArrayBuffer
    );
    return aBuf.length === bBuf.length && bytesMatch;
  }

  // Fallback: constant-time comparison (pad to equal length)
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length; // non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

export async function verifyAdminKey(
  c: Context<{ Bindings: Env }>,
  next: Next
): Promise<Response | void> {
  // If no admin key is configured, allow unrestricted access
  if (!c.env.ADMIN_API_KEY) {
    await next();
    return;
  }

  const authHeader = c.req.header("authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";

  const token = c.req.header("x-admin-key") ?? (bearerToken || "");

  if (!safeEqual(token, c.env.ADMIN_API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}
