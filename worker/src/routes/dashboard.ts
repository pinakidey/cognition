import { Hono } from "hono";
import { html } from "hono/html";
import type { Env } from "../types";
import { getAllJobs, getJobStats } from "../db/queries";
import { getRecentAuditLogs } from "../db/audit";
import { verifyAdminKey } from "../middleware/auth";

// Extracts display name from composite triggered_by format (slack_user:<id>:<name>).
function formatTriggeredBy(value: string | null): string {
  if (!value) return "";
  if (value.startsWith("slack_user:")) {
    const firstColon = value.indexOf(":");
    const secondColon = value.indexOf(":", firstColon + 1);
    if (secondColon !== -1) return value.slice(secondColon + 1);
    return value.slice(firstColon + 1);
  }
  return value;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/status", async (c) => {
  const stats = await getJobStats(c.env.DB);
  const jobs = await getAllJobs(c.env.DB);

  const active = jobs.filter((j) =>
    ["pending", "in_progress", "blocked"].includes(j.status)
  );
  const recentCompleted = jobs
    .filter((j) => j.status === "completed" || j.status === "merged")
    .slice(0, 10);

  return c.json({
    system: "devin-remediation-service",
    stats,
    active_jobs: active,
    recent_completed: recentCompleted,
  });
});

app.get("/", async (c) => {
  const stats = await getJobStats(c.env.DB);
  const jobs = await getAllJobs(c.env.DB);

  const total = stats.total ?? 0;
  const completed = stats.completed ?? 0;
  const merged = stats.merged ?? 0;
  const inProgress = stats.in_progress ?? 0;
  const failed = stats.failed ?? 0;
  const prsCreated = stats.prs_created ?? 0;
  const successRate = total > 0 ? `${Math.round(((completed + merged) / total) * 100)}%` : "N/A";

  // GitHub "git-merge" octicon, colored with GitHub's merged-purple.
  const mergeIcon =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="#8250df" style="vertical-align:middle"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0-8a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5 4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"></path></svg>';

  const statusIcons: Record<string, string> = {
    pending: "⏳",
    in_progress: "🔄",
    completed: "✅",
    merged: mergeIcon,
    failed: "❌",
    blocked: "⏸",
    finished_no_pr: "⚠",
    timed_out: "⏰",
  };

  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const rawPage = parseInt(new URL(c.req.url).searchParams.get("page") ?? "1", 10);
  const page = Number.isNaN(rawPage) ? 1 : rawPage;
  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(jobs.length / pageSize));
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const pageJobs = jobs.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const rows = pageJobs
    .map((job) => {
      const icon = statusIcons[job.status] ?? "❓";
      const prLink = job.pr_url
        ? `<a href="${escapeHtml(job.pr_url)}" target="_blank">${escapeHtml(job.pr_url.split("/").pop() ?? "")}</a>`
        : "—";
      const sessionLink = job.session_url
        ? `<a href="${escapeHtml(job.session_url)}" target="_blank">View</a>`
        : "—";

      return `<tr>
        <td><a href="${escapeHtml(job.issue_url)}" target="_blank">#${job.issue_number}</a></td>
        <td>${escapeHtml(job.issue_title.slice(0, 60))}</td>
        <td>${icon} ${escapeHtml(job.status)}</td>
        <td>${sessionLink}</td>
        <td>${prLink}</td>
        <td>${escapeHtml(formatTriggeredBy(job.triggered_by))}</td>
        <td>${escapeHtml(job.created_at.slice(0, 16))}</td>
      </tr>`;
    })
    .join("");

  const htmlPage = `<!DOCTYPE html>
<html>
<head>
  <title>Devin Remediation Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f8f9fa; }
    .header { background: #1a1a2e; color: white; padding: 24px 32px; border-radius: 12px; margin-bottom: 24px; }
    .header h1 { margin: 0 0 8px 0; font-size: 24px; }
    .header p { margin: 0; opacity: 0.8; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .stat-card .value { font-size: 32px; font-weight: bold; color: #1a1a2e; }
    .stat-card .label { font-size: 14px; color: #666; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f1f3f5; font-weight: 600; color: #333; }
    tr:hover { background: #f8f9fa; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .pagination { margin-top: 16px; text-align: center; padding: 12px; }
    .pagination a { display: inline-block; padding: 8px 16px; margin: 0 4px; background: #0066cc; color: white; border-radius: 4px; text-decoration: none; }
    .pagination a:hover { background: #0052a3; }
    .pagination span { display: inline-block; padding: 8px 16px; margin: 0 4px; color: #666; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Devin Remediation Dashboard</h1>
    <p>Automated issue remediation via Devin AI</p>
  </div>
  <div class="stats">
    <div class="stat-card"><div class="value">${total}</div><div class="label">Total Jobs</div></div>
    <div class="stat-card"><div class="value">${inProgress}</div><div class="label">In Progress</div></div>
    <div class="stat-card"><div class="value">${completed}</div><div class="label">Completed</div></div>
    <div class="stat-card"><div class="value">${merged}</div><div class="label">Merged</div></div>
    <div class="stat-card"><div class="value">${failed}</div><div class="label">Failed</div></div>
    <div class="stat-card"><div class="value">${prsCreated}</div><div class="label">PRs Created</div></div>
    <div class="stat-card"><div class="value">${successRate}</div><div class="label">Success Rate</div></div>
  </div>
  <table>
    <thead>
      <tr><th>Issue</th><th>Title</th><th>Status</th><th>Session</th><th>PR</th><th>Triggered By</th><th>Created</th></tr>
    </thead>
    <tbody>${rows || "<tr><td colspan='7' style='text-align:center;color:#666;'>No jobs yet</td></tr>"}</tbody>
  </table>
  <div class="pagination">
    ${currentPage > 1 ? `<a href="?page=${currentPage - 1}">&laquo; Prev</a>` : ""}
    <span>Page ${currentPage} of ${totalPages}</span>
    ${currentPage < totalPages ? `<a href="?page=${currentPage + 1}">Next &raquo;</a>` : ""}
  </div>
</body>
</html>`;

  return c.html(htmlPage, 200, {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https:; connect-src 'self'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
});

app.get("/audit", verifyAdminKey, async (c) => {
  const logs = await getRecentAuditLogs(c.env.DB, 100);
  return c.json({ audit_log: logs });
});

export const dashboardRoutes = app;
