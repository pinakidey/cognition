import type { Env } from "../types";
import { getCached, setCache } from "../db/cache";

const GITHUB_API = "https://api.github.com";

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

// Makes an authenticated GET request to the GitHub API.
async function githubFetch(
  env: Env,
  path: string
): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `token ${env.GH_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "devin-remediation-service",
    },
  });
}

// Fetches a single GitHub issue by number.
export async function getIssue(
  env: Env,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<GitHubIssue | null> {
  const response = await githubFetch(
    env,
    `/repos/${owner}/${repo}/issues/${issueNumber}`
  );

  if (!response.ok) return null;

  const data = (await response.json()) as GitHubIssue;
  return data;
}

// Checks whether any open PRs reference the given issue number.
export async function hasOpenPullRequests(
  env: Env,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<boolean> {
  // Search for PRs that reference this issue
  const response = await githubFetch(
    env,
    `/search/issues?q=repo:${owner}/${repo}+is:pr+is:open+${issueNumber}+in:title`
  );

  if (!response.ok) return false;

  const data = (await response.json()) as { total_count: number };
  return data.total_count > 0;
}

// Searches for an open PR referencing the issue, with D1-backed caching.
export async function findPullRequestForIssue(
  env: Env,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<string | null> {
  const cacheKey = `pr_search:${owner}/${repo}:${issueNumber}`;

  // Check cache first (5-minute TTL)
  const cached = await getCached(env.DB, cacheKey);
  if (cached !== null) {
    return cached === "" ? null : cached;
  }

  // Search for open PRs that reference this issue number in title
  const response = await githubFetch(
    env,
    `/search/issues?q=repo:${owner}/${repo}+is:pr+is:open+${issueNumber}+in:title`
  );

  if (!response.ok) return null;

  const data = (await response.json()) as {
    total_count: number;
    items: Array<{ html_url: string; title: string }>;
  };

  const result = data.total_count > 0 && data.items.length > 0
    ? data.items[0].html_url
    : null;

  // Only cache positive results — negative results should not be cached
  // because the poller runs every 60s specifically to detect new PRs quickly
  if (result) {
    await setCache(env.DB, cacheKey, result);
  }

  return result;
}

// Resolves a GitHub username from an email address via search API.
export async function findGitHubUserByEmail(
  env: Env,
  email: string
): Promise<string | null> {
  const cacheKey = `user_email:${email}`;

  // Check cache (longer TTL for user lookups — 30 min)
  const cached = await getCached(env.DB, cacheKey, 1800);
  if (cached !== null) {
    return cached === "" ? null : cached;
  }

  const response = await githubFetch(
    env,
    `/search/users?q=${encodeURIComponent(email)}+in:email`
  );

  if (!response.ok) return null;

  const data = (await response.json()) as {
    total_count: number;
    items: Array<{ login: string }>;
  };

  const result = data.total_count > 0 && data.items.length > 0
    ? data.items[0].login
    : null;

  await setCache(env.DB, cacheKey, result ?? "");

  return result;
}

// Submits an APPROVE review on a GitHub pull request with attribution.
export async function approvePullRequest(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${env.GH_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "devin-remediation-service",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event: "APPROVE",
        body,
      }),
    }
  );

  return response.ok;
}

// Adds a user as an assignee on a GitHub issue.
export async function assignIssue(
  env: Env,
  owner: string,
  repo: string,
  issueNumber: number,
  assignee: string
): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/assignees`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${env.GH_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "devin-remediation-service",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assignees: [assignee],
      }),
    }
  );

  return response.ok;
}

// Checks whether all CI status checks on a PR are passing.
export async function arePrChecksPassing(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ passing: boolean; sha: string | null; merged?: boolean }> {
  // Get the PR to find the head SHA
  const prResponse = await githubFetch(
    env,
    `/repos/${owner}/${repo}/pulls/${prNumber}`
  );
  if (!prResponse.ok) return { passing: false, sha: null };

  const pr = (await prResponse.json()) as { head: { sha: string }; state: string; merged: boolean };

  // Short-circuit if PR is already merged or closed
  if (pr.merged) return { passing: true, sha: pr.head.sha, merged: true };
  if (pr.state === "closed") return { passing: false, sha: null, merged: false };

  const sha = pr.head.sha;

  // Check combined status
  const statusResponse = await githubFetch(
    env,
    `/repos/${owner}/${repo}/commits/${sha}/status`
  );
  if (!statusResponse.ok) return { passing: false, sha };

  const status = (await statusResponse.json()) as { state: string; total_count: number };

  // Also check check-runs (GitHub Actions use check-runs, not statuses)
  const checksResponse = await githubFetch(
    env,
    `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`
  );

  if (!checksResponse.ok) return { passing: false, sha };

  const checks = (await checksResponse.json()) as {
    total_count: number;
    check_runs: Array<{ status: string; conclusion: string | null }>;
  };

  // If there are check runs, all must be completed and successful
  if (checks.total_count > 0) {
    // Guard against pagination: if we didn't fetch all checks, assume not passing
    if (checks.check_runs.length < checks.total_count) {
      return { passing: false, sha };
    }
    const allPassed = checks.check_runs.every(
      (cr) => cr.status === "completed" && (cr.conclusion === "success" || cr.conclusion === "neutral" || cr.conclusion === "skipped")
    );
    if (!allPassed) return { passing: false, sha };
  }

  // If there are commit statuses, verify they pass too
  if (status.total_count > 0 && status.state !== "success") {
    return { passing: false, sha };
  }

  // If no checks exist at all, treat as not passing (CI may not have registered yet)
  if (checks.total_count === 0 && status.total_count === 0) {
    return { passing: false, sha };
  }

  return { passing: true, sha };
}

// Merges a pull request using the squash method.
export async function mergePullRequest(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  sha: string
): Promise<boolean> {
  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
    {
      method: "PUT",
      headers: {
        Authorization: `token ${env.GH_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "devin-remediation-service",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        merge_method: "squash",
        sha,
      }),
    }
  );

  return response.ok;
}

// Extracts owner, repo, and PR number from a GitHub pull request URL.
export function parsePrUrl(url: string): {
  owner: string;
  repo: string;
  number: number;
} | null {
  const match = url.match(
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

// Extracts owner, repo, and issue number from a GitHub issue URL.
export function parseIssueUrl(url: string): {
  owner: string;
  repo: string;
  number: number;
} | null {
  const match = url.match(
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}
