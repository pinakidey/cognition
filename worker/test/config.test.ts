import { describe, it, expect } from "vitest";
import { isChannelAllowed, isRepoAllowed, isApprovalAllowed, getAllowedChannels, getAllowedRepos } from "../src/services/config";
import type { Env } from "../src/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    DEVIN_API_KEY: "test",
    GH_TOKEN: "test",
    SLACK_BOT_TOKEN: "test",
    SLACK_SIGNING_SECRET: "test",
    ...overrides,
  } as Env;
}

describe("config utilities", () => {
  describe("getAllowedChannels", () => {
    it("returns empty set when no channel config", () => {
      const env = makeEnv();
      expect(getAllowedChannels(env).size).toBe(0);
    });

    it("parses SLACK_CHANNEL_IDS (comma-separated)", () => {
      const env = makeEnv({ SLACK_CHANNEL_IDS: "C001,C002,C003" });
      const channels = getAllowedChannels(env);
      expect(channels.size).toBe(3);
      expect(channels.has("C001")).toBe(true);
      expect(channels.has("C002")).toBe(true);
      expect(channels.has("C003")).toBe(true);
    });

    it("merges legacy SLACK_CHANNEL_ID with SLACK_CHANNEL_IDS", () => {
      const env = makeEnv({ SLACK_CHANNEL_IDS: "C001", SLACK_CHANNEL_ID: "C002" });
      const channels = getAllowedChannels(env);
      expect(channels.size).toBe(2);
      expect(channels.has("C001")).toBe(true);
      expect(channels.has("C002")).toBe(true);
    });

    it("deduplicates across legacy and new", () => {
      const env = makeEnv({ SLACK_CHANNEL_IDS: "C001", SLACK_CHANNEL_ID: "C001" });
      expect(getAllowedChannels(env).size).toBe(1);
    });
  });

  describe("getAllowedRepos", () => {
    it("returns empty set when no repo config", () => {
      const env = makeEnv();
      expect(getAllowedRepos(env).size).toBe(0);
    });

    it("parses ALLOWED_REPOS (comma-separated)", () => {
      const env = makeEnv({ ALLOWED_REPOS: "org/repo1,org/repo2" });
      const repos = getAllowedRepos(env);
      expect(repos.size).toBe(2);
      expect(repos.has("org/repo1")).toBe(true);
      expect(repos.has("org/repo2")).toBe(true);
    });

    it("merges legacy GITHUB_REPO with ALLOWED_REPOS", () => {
      const env = makeEnv({ ALLOWED_REPOS: "org/repo1", GITHUB_REPO: "org/repo2" });
      const repos = getAllowedRepos(env);
      expect(repos.size).toBe(2);
    });
  });

  describe("isChannelAllowed", () => {
    it("allows all channels when no restriction set", () => {
      const env = makeEnv();
      expect(isChannelAllowed(env, "C_ANY")).toBe(true);
    });

    it("allows listed channel", () => {
      const env = makeEnv({ SLACK_CHANNEL_IDS: "C001,C002" });
      expect(isChannelAllowed(env, "C001")).toBe(true);
    });

    it("rejects unlisted channel", () => {
      const env = makeEnv({ SLACK_CHANNEL_IDS: "C001,C002" });
      expect(isChannelAllowed(env, "C999")).toBe(false);
    });
  });

  describe("isRepoAllowed", () => {
    it("allows all repos when no restriction set", () => {
      const env = makeEnv();
      expect(isRepoAllowed(env, "any/repo")).toBe(true);
    });

    it("allows listed repo", () => {
      const env = makeEnv({ ALLOWED_REPOS: "org/repo1,org/repo2" });
      expect(isRepoAllowed(env, "org/repo1")).toBe(true);
    });

    it("rejects unlisted repo", () => {
      const env = makeEnv({ ALLOWED_REPOS: "org/repo1" });
      expect(isRepoAllowed(env, "other/repo")).toBe(false);
    });
  });

  describe("isApprovalAllowed", () => {
    it("allows all users when no allowlist set", () => {
      const env = makeEnv();
      expect(isApprovalAllowed(env, "U001", "org/repo1")).toBe(true);
    });

    it("allows global users for any repo", () => {
      const env = makeEnv({ APPROVAL_ALLOWLIST: "U001,U002" });
      expect(isApprovalAllowed(env, "U001", "org/repo1")).toBe(true);
      expect(isApprovalAllowed(env, "U002", "org/repo2")).toBe(true);
    });

    it("allows per-repo users only for their repo", () => {
      const env = makeEnv({ APPROVAL_ALLOWLIST: "org/repo1:U001,U002;org/repo2:U003" });
      expect(isApprovalAllowed(env, "U001", "org/repo1")).toBe(true);
      expect(isApprovalAllowed(env, "U002", "org/repo1")).toBe(true);
      expect(isApprovalAllowed(env, "U003", "org/repo2")).toBe(true);
      expect(isApprovalAllowed(env, "U001", "org/repo2")).toBe(false);
      expect(isApprovalAllowed(env, "U003", "org/repo1")).toBe(false);
    });

    it("global users override per-repo restrictions", () => {
      const env = makeEnv({ APPROVAL_ALLOWLIST: "U001;org/repo1:U002" });
      expect(isApprovalAllowed(env, "U001", "org/repo1")).toBe(true);
      expect(isApprovalAllowed(env, "U001", "org/repo2")).toBe(true);
      expect(isApprovalAllowed(env, "U002", "org/repo1")).toBe(true);
      expect(isApprovalAllowed(env, "U002", "org/repo2")).toBe(false);
    });

    it("rejects unlisted users", () => {
      const env = makeEnv({ APPROVAL_ALLOWLIST: "org/repo1:U001" });
      expect(isApprovalAllowed(env, "U999", "org/repo1")).toBe(false);
    });
  });
});
