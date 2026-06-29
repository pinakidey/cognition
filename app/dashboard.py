from html import escape

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse

from app.database import get_all_jobs, get_job_by_id, get_job_stats, update_job
from app.security import verify_admin_key

router = APIRouter()


@router.get("/status", response_class=JSONResponse, dependencies=[Depends(verify_admin_key)])
async def status():
    """Observability endpoint — JSON summary of system health."""
    stats = await get_job_stats()
    jobs = await get_all_jobs()

    active = [j for j in jobs if j["status"] in ("pending", "in_progress", "blocked")]
    recent_completed = [j for j in jobs if j["status"] == "completed"][:10]

    return {
        "system": "devin-remediation-service",
        "stats": stats,
        "active_jobs": active,
        "recent_completed": recent_completed,
    }


@router.get("/", response_class=HTMLResponse, dependencies=[Depends(verify_admin_key)])
async def dashboard():
    """HTML dashboard for engineering leadership visibility."""
    stats = await get_job_stats()
    jobs = await get_all_jobs()

    total = stats.get("total", 0)
    completed = stats.get("completed", 0)
    in_progress = stats.get("in_progress", 0)
    failed = stats.get("failed", 0)
    prs_created = stats.get("prs_created", 0)
    success_rate = f"{(completed / total * 100):.0f}%" if total > 0 else "N/A"

    rows = ""
    for job in jobs[:25]:
        status_icon = {
            "pending": "⏳",
            "in_progress": "🔄",
            "completed": "✅",
            "failed": "❌",
            "blocked": "⏸️",
            "finished_no_pr": "⚠️",
        }.get(job["status"], "❓")

        pr_url = escape(job["pr_url"]) if job.get("pr_url") else ""
        pr_link = f'<a href="{pr_url}">{pr_url.split("/")[-1]}</a>' if pr_url else "—"
        session_url = escape(job["session_url"]) if job.get("session_url") else ""
        session_link = f'<a href="{session_url}">View</a>' if session_url else "—"

        rows += f"""
        <tr>
            <td>#{job['issue_number']}</td>
            <td>{escape(job['issue_title'][:60])}</td>
            <td>{status_icon} {escape(job['status'])}</td>
            <td>{session_link}</td>
            <td>{pr_link}</td>
            <td>{escape(job['triggered_by'] or '')}</td>
            <td>{escape(job['created_at'][:16])}</td>
        </tr>"""

    html = f"""<!DOCTYPE html>
<html>
<head>
    <title>Devin Remediation Dashboard</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f8f9fa; }}
        .header {{ background: #1a1a2e; color: white; padding: 24px 32px; border-radius: 12px; margin-bottom: 24px; }}
        .header h1 {{ margin: 0 0 8px 0; font-size: 24px; }}
        .header p {{ margin: 0; opacity: 0.8; }}
        .metrics {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }}
        .metric {{ background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }}
        .metric .value {{ font-size: 32px; font-weight: 700; color: #1a1a2e; }}
        .metric .label {{ font-size: 13px; color: #666; margin-top: 4px; }}
        table {{ width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }}
        th {{ background: #f1f3f5; padding: 12px 16px; text-align: left; font-size: 13px; color: #495057; }}
        td {{ padding: 12px 16px; border-top: 1px solid #eee; font-size: 14px; }}
        a {{ color: #228be6; text-decoration: none; }}
        a:hover {{ text-decoration: underline; }}
        .refresh {{ text-align: right; margin-bottom: 12px; }}
        .refresh a {{ font-size: 13px; color: #666; }}
    </style>
    <meta http-equiv="refresh" content="30">
</head>
<body>
    <div class="header">
        <h1>Devin Remediation Service</h1>
        <p>Event-driven issue remediation for pinakidey/superset</p>
    </div>

    <div class="metrics">
        <div class="metric">
            <div class="value">{total}</div>
            <div class="label">Total Jobs</div>
        </div>
        <div class="metric">
            <div class="value">{in_progress}</div>
            <div class="label">In Progress</div>
        </div>
        <div class="metric">
            <div class="value">{completed}</div>
            <div class="label">Completed</div>
        </div>
        <div class="metric">
            <div class="value">{prs_created}</div>
            <div class="label">PRs Created</div>
        </div>
        <div class="metric">
            <div class="value">{success_rate}</div>
            <div class="label">Success Rate</div>
        </div>
        <div class="metric">
            <div class="value">{failed}</div>
            <div class="label">Failed</div>
        </div>
    </div>

    <div class="refresh"><a href="/">Auto-refreshes every 30s</a></div>

    <table>
        <thead>
            <tr>
                <th>Issue</th>
                <th>Title</th>
                <th>Status</th>
                <th>Session</th>
                <th>PR</th>
                <th>Triggered By</th>
                <th>Created</th>
            </tr>
        </thead>
        <tbody>
            {rows if rows else '<tr><td colspan="7" style="text-align:center;padding:32px;color:#666;">No remediation jobs yet. React with 🚀 on an issue in Slack to get started.</td></tr>'}
        </tbody>
    </table>
</body>
</html>"""

    return HTMLResponse(content=html)


@router.post("/retry/{job_id}", response_class=JSONResponse, dependencies=[Depends(verify_admin_key)])
async def retry_job(job_id: int):
    """Manually retry a failed or timed-out remediation job."""
    from app.remediation import trigger_remediation

    job = await get_job_by_id(job_id)
    if not job:
        return JSONResponse(status_code=404, content={"error": "Job not found"})

    retryable_statuses = ("failed", "timed_out", "finished_no_pr")
    if job["status"] not in retryable_statuses:
        return JSONResponse(
            status_code=400,
            content={
                "error": f"Job is in '{job['status']}' state — only {', '.join(retryable_statuses)} jobs can be retried"
            },
        )

    result = await trigger_remediation(
        issue_url=job["issue_url"],
        triggered_by=f"retry(job_id={job_id})",
        slack_channel=job.get("slack_channel"),
        slack_message_ts=job.get("slack_message_ts"),
    )
    return JSONResponse(content=result)
