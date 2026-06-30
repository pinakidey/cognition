import { Hono } from "hono";
import { html } from "hono/html";
import type { Env } from "../types";
import { getAllJobs, getJobStats } from "../db/queries";

const app = new Hono<{ Bindings: Env }>();

app.get("/status", async (c) => {
  const stats = await getJobStats(c.env.DB);
  const jobs = await getAllJobs(c.env.DB);

  const active = jobs.filter((j) =>
    ["pending", "in_progress", "blocked"].includes(j.status)
  );
  const recentCompleted = jobs
    .filter((j) => j.status === "completed")
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
  const inProgress = stats.in_progress ?? 0;
  const failed = stats.failed ?? 0;
  const prsCreated = stats.prs_created ?? 0;
  const successRate = total > 0 ? `${Math.round((completed / total) * 100)}%` : "N/A";

  const statusIcons: Record<string, string> = {
    pending: "⏳",
    in_progress: "🔄",
    completed: "✅",
    failed: "❌",
    blocked: "⏸",
    finished_no_pr: "⚠",
    timed_out: "⏰",
  };

  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const rows = jobs
    .slice(0, 25)
    .map((job) => {
      const icon = statusIcons[job.status] ?? "❓";
      const prLink = job.pr_url
        ? `<a href="${escapeHtml(job.pr_url)}">${escapeHtml(job.pr_url.split("/").pop() ?? "")}</a>`
        : "—";
      const sessionLink = job.session_url
        ? `<a href="${escapeHtml(job.session_url)}">View</a>`
        : "—";

      return `<tr>
        <td>#${job.issue_number}</td>
        <td>${escapeHtml(job.issue_title.slice(0, 60))}</td>
        <td>${icon} ${escapeHtml(job.status)}</td>
        <td>${sessionLink}</td>
        <td>${prLink}</td>
        <td>${escapeHtml(job.triggered_by ?? "")}</td>
        <td>${escapeHtml(job.created_at.slice(0, 16))}</td>
      </tr>`;
    })
    .join("");

  const page = `<!DOCTYPE html>
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
</body>
</html>`;

  return c.html(page);
});

export const dashboardRoutes = app;
