// Extracts a GitHub issue URL from message text or attachments.
export function extractGithubIssueUrl(
  text: string,
  attachments: Array<Record<string, string>> | null
): string | null {
  const pattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/;

  if (attachments) {
    for (const att of attachments) {
      const title = att["title"] ?? "";
      const titleMatch = title.match(pattern);
      if (titleMatch) return titleMatch[0];
    }
  }

  const match = text.match(pattern);
  if (match) return match[0];

  if (attachments) {
    for (const att of attachments) {
      for (const field of ["title_link", "fallback", "text"]) {
        const val = att[field] ?? "";
        const attMatch = val.match(pattern);
        if (attMatch) return attMatch[0];
      }
    }
  }

  return null;
}

// Extracts a GitHub pull request URL from message text or attachments.
export function extractGithubPrUrl(
  text: string,
  attachments: Array<Record<string, string>> | null
): string | null {
  const pattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

  if (attachments) {
    for (const att of attachments) {
      const title = att["title"] ?? "";
      const titleMatch = title.match(pattern);
      if (titleMatch) return titleMatch[0];
    }
  }

  const match = text.match(pattern);
  if (match) return match[0];

  if (attachments) {
    for (const att of attachments) {
      for (const field of ["title_link", "fallback", "text"]) {
        const val = att[field] ?? "";
        const attMatch = val.match(pattern);
        if (attMatch) return attMatch[0];
      }
    }
  }

  return null;
}
