/**
 * Extract a GitHub issue URL from message text or attachments.
 * Duplicated here for unit testing without Worker bindings.
 * Must stay in sync with worker/src/routes/webhook.ts extractGithubIssueUrl.
 */
export function extractGithubIssueUrl(
  text: string,
  attachments: Array<Record<string, string>> | null
): string | null {
  const pattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/;

  // Check attachment title first — GitHub puts the canonical issue URL here
  if (attachments) {
    for (const att of attachments) {
      const title = att["title"] ?? "";
      const titleMatch = title.match(pattern);
      if (titleMatch) return titleMatch[0];
    }
  }

  // Try message text
  const match = text.match(pattern);
  if (match) return match[0];

  // Fallback to other attachment fields
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
