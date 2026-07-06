import { describe, it, expect } from "vitest";
import { parseIssueUrl } from "../src/services/github";

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
