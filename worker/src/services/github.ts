import type { Env } from "../types";

const GITHUB_API = "https://api.github.com";

export interface GitHubIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

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

export async function findPullRequestForIssue(
  env: Env,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<string | null> {
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

  if (data.total_count > 0 && data.items.length > 0) {
    return data.items[0].html_url;
  }

  return null;
}

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
