import { describe, it, expect } from "vitest";
import { extractGithubIssueUrl } from "./helpers/utils";

describe("extractGithubIssueUrl", () => {
  it("extracts issue URL from plain text", () => {
    const text = "Check out https://github.com/owner/repo/issues/42 for details";
    expect(extractGithubIssueUrl(text, null)).toBe(
      "https://github.com/owner/repo/issues/42"
    );
  });

  it("extracts issue URL from attachments", () => {
    const attachments = [
      { title_link: "https://github.com/owner/repo/issues/7" },
    ];
    expect(extractGithubIssueUrl("", attachments)).toBe(
      "https://github.com/owner/repo/issues/7"
    );
  });

  it("returns null when no URL found", () => {
    expect(extractGithubIssueUrl("no url here", null)).toBeNull();
  });

  it("extracts from attachment fallback text", () => {
    const attachments = [
      { fallback: "Issue: https://github.com/org/project/issues/123" },
    ];
    expect(extractGithubIssueUrl("", attachments)).toBe(
      "https://github.com/org/project/issues/123"
    );
  });
});
