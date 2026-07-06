import { describe, it, expect, vi, afterEach } from "vitest";
import { parseIssueUrl, isPullRequestMerged } from "../src/services/github";
import type { Env } from "../src/types";

describe("parseIssueUrl", () => {
  it("parses a valid GitHub issue URL", () => {
    const result = parseIssueUrl("https://github.com/pinakidey/superset/issues/42");
    expect(result).toEqual({
      owner: "pinakidey",
      repo: "superset",
      number: 42,
    });
  });

  it("returns null for invalid URLs", () => {
    expect(parseIssueUrl("https://github.com/owner/repo/pull/1")).toBeNull();
    expect(parseIssueUrl("not a url")).toBeNull();
    expect(parseIssueUrl("")).toBeNull();
  });

  it("handles URLs with different owners and repos", () => {
    const result = parseIssueUrl("https://github.com/org-name/my-repo/issues/999");
    expect(result).toEqual({
      owner: "org-name",
      repo: "my-repo",
      number: 999,
    });
  });
});

describe("isPullRequestMerged", () => {
  const env = { GH_TOKEN: "test" } as unknown as Env;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when the PR is merged", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ merged: true }), { status: 200 })
    );
    expect(await isPullRequestMerged(env, "o", "r", 1)).toBe(true);
  });

  it("returns false when the PR is not merged", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ merged: false }), { status: 200 })
    );
    expect(await isPullRequestMerged(env, "o", "r", 1)).toBe(false);
  });

  it("returns null when the PR can't be fetched", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 })
    );
    expect(await isPullRequestMerged(env, "o", "r", 1)).toBeNull();
  });
});
