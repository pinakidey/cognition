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

// Returns the set of allowed GitHub repos as "owner/repo" (supports ALLOWED_REPOS and legacy GITHUB_REPO).
export function getAllowedRepos(env: Env): Set<string> {
  const repos = parseList(env.ALLOWED_REPOS);
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

// Parses APPROVAL_ALLOWLIST into per-repo and global user sets.
// Format: "repo1:user1,user2;repo2:user3" with bare "user4" as global.
function parseApprovalAllowlist(value: string | undefined): { perRepo: Map<string, Set<string>>; global: Set<string> } {
  const perRepo = new Map<string, Set<string>>();
  const global = new Set<string>();
  if (!value) return { perRepo, global };

  for (const segment of value.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      // No colon — treat each comma-separated entry as a global user
      for (const u of trimmed.split(",")) {
        const id = u.trim();
        if (id) global.add(id);
      }
    } else {
      const repo = trimmed.slice(0, colonIdx).trim();
      const users = trimmed.slice(colonIdx + 1);
      if (!repo) continue;
      const set = perRepo.get(repo) ?? new Set<string>();
      for (const u of users.split(",")) {
        const id = u.trim();
        if (id) set.add(id);
      }
      perRepo.set(repo, set);
    }
  }
  return { perRepo, global };
}

// Checks whether the given Slack user is allowed to approve PRs for the given repo.
export function isApprovalAllowed(env: Env, slackUserId: string, repo: string): boolean {
  if (!env.APPROVAL_ALLOWLIST) return true;
  const { perRepo, global } = parseApprovalAllowlist(env.APPROVAL_ALLOWLIST);
  if (global.has(slackUserId)) return true;
  const repoSet = perRepo.get(repo);
  if (repoSet && repoSet.has(slackUserId)) return true;
  return false;
}
