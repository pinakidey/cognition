import type { Context, Next } from "hono";
import type { Env } from "../types";

/**
 * Constant-time string comparison.
 * Uses crypto.subtle.timingSafeEqual in Workers runtime,
 * falls back to byte-by-byte comparison with constant time.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  // Use timingSafeEqual if available (Workers runtime)
  if (typeof crypto !== "undefined" && crypto.subtle?.timingSafeEqual) {
    const encoder = new TextEncoder();
    const aBuf = encoder.encode(a);
    const bBuf = encoder.encode(b);
    return crypto.subtle.timingSafeEqual(
      aBuf.buffer as ArrayBuffer,
      bBuf.buffer as ArrayBuffer
    );
  }

  // Fallback: constant-time comparison
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
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

  const token =
    c.req.header("x-admin-key") ??
    c.req.header("authorization")?.replace("Bearer ", "").trim() ??
    "";

  if (!safeEqual(token, c.env.ADMIN_API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}
