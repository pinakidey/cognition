import type { Env } from "../types";

// Parses a comma-separated string into a trimmed, non-empty Set.
function parseList(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
}

// Returns the set of allowed Slack channel IDs (supports SLACK_CHANNEL_IDS and legacy SLACK_CHANNEL_ID).
export function getAllowedChannels(env: Env): Set<string> {
  const channels = parseList(env.SLACK_CHANNEL_IDS);
  if (env.SLACK_CHANNEL_ID) channels.add(env.SLACK_CHANNEL_ID.trim());
  return channels;
}

// Returns the set of allowed GitHub repos as "owner/repo" (supports GITHUB_REPOS and legacy GITHUB_REPO).
export function getAllowedRepos(env: Env): Set<string> {
  const repos = parseList(env.GITHUB_REPOS);
  if (env.GITHUB_REPO) repos.add(env.GITHUB_REPO.trim());
  return repos;
}

// Checks whether the given channel is allowed (empty set = all channels allowed).
export function isChannelAllowed(env: Env, channel: string): boolean {
  const allowed = getAllowedChannels(env);
  return allowed.size === 0 || allowed.has(channel);
}

// Checks whether the given repo is allowed (empty set = all repos allowed).
export function isRepoAllowed(env: Env, repo: string): boolean {
  const allowed = getAllowedRepos(env);
  return allowed.size === 0 || allowed.has(repo);
}
