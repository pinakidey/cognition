import { describe, it, expect } from "vitest";

function isUserAllowed(allowlist: string | undefined, userId: string): boolean {
  if (!allowlist) return true; // no allowlist = everyone allowed
  const list = allowlist.split(",").map((s) => s.trim());
  return list.includes(userId);
}

describe("Approval Allowlist", () => {
  it("allows all users when no allowlist is configured", () => {
    expect(isUserAllowed(undefined, "U123")).toBe(true);
    expect(isUserAllowed("", "U123")).toBe(true);
  });

  it("allows users in the allowlist", () => {
    expect(isUserAllowed("U123,U456,U789", "U123")).toBe(true);
    expect(isUserAllowed("U123,U456,U789", "U456")).toBe(true);
  });

  it("blocks users not in the allowlist", () => {
    expect(isUserAllowed("U123,U456", "U999")).toBe(false);
  });

  it("handles whitespace in allowlist", () => {
    expect(isUserAllowed("U123, U456, U789", "U456")).toBe(true);
    expect(isUserAllowed(" U123 , U456 ", "U123")).toBe(true);
  });

  it("single user allowlist works", () => {
    expect(isUserAllowed("U123", "U123")).toBe(true);
    expect(isUserAllowed("U123", "U456")).toBe(false);
  });
});
