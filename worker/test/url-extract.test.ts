import { describe, it, expect } from "vitest";
import { extractGithubIssueUrl, extractGithubPrUrl } from "../src/services/url-extract";

describe("extractGithubIssueUrl", () => {
  it("extracts from plain text", () => {
    expect(extractGithubIssueUrl("Check https://github.com/owner/repo/issues/42 please", null))
      .toBe("https://github.com/owner/repo/issues/42");
  });

  it("extracts from attachment title first", () => {
    const attachments = [{ title: "<https://github.com/owner/repo/issues/10|#10 Bug>" }];
    expect(extractGithubIssueUrl("other text", attachments))
      .toBe("https://github.com/owner/repo/issues/10");
  });

  it("falls back to attachment fallback field", () => {
    const attachments = [{ fallback: "https://github.com/owner/repo/issues/5" }];
    expect(extractGithubIssueUrl("no url here", attachments))
      .toBe("https://github.com/owner/repo/issues/5");
  });

  it("returns null when no URL found", () => {
    expect(extractGithubIssueUrl("just some text", null)).toBeNull();
  });

  it("returns null for PR URLs (not issues)", () => {
    expect(extractGithubIssueUrl("https://github.com/owner/repo/pull/42", null)).toBeNull();
  });
});

describe("extractGithubPrUrl", () => {
  it("extracts PR URL from text", () => {
    expect(extractGithubPrUrl("PR: https://github.com/owner/repo/pull/99", null))
      .toBe("https://github.com/owner/repo/pull/99");
  });

  it("extracts from attachment title", () => {
    const attachments = [{ title: "https://github.com/owner/repo/pull/7" }];
    expect(extractGithubPrUrl("no url", attachments))
      .toBe("https://github.com/owner/repo/pull/7");
  });

  it("returns null for issue URLs (not PRs)", () => {
    expect(extractGithubPrUrl("https://github.com/owner/repo/issues/42", null)).toBeNull();
  });
});
