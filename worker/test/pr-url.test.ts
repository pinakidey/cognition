import { describe, it, expect } from "vitest";
import { parsePrUrl } from "../src/services/github";

describe("parsePrUrl", () => {
  it("parses a valid GitHub PR URL", () => {
    const result = parsePrUrl("https://github.com/pinakidey/superset/pull/22");
    expect(result).toEqual({
      owner: "pinakidey",
      repo: "superset",
      number: 22,
    });
  });

  it("returns null for issue URLs", () => {
    expect(parsePrUrl("https://github.com/owner/repo/issues/1")).toBeNull();
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parsePrUrl("https://gitlab.com/owner/repo/pull/1")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parsePrUrl("")).toBeNull();
  });

  it("handles multi-digit PR numbers", () => {
    const result = parsePrUrl("https://github.com/org/repo/pull/12345");
    expect(result).toEqual({
      owner: "org",
      repo: "repo",
      number: 12345,
    });
  });

  it("handles hyphenated owner/repo names", () => {
    const result = parsePrUrl("https://github.com/my-org/my-repo/pull/3");
    expect(result).toEqual({
      owner: "my-org",
      repo: "my-repo",
      number: 3,
    });
  });
});
