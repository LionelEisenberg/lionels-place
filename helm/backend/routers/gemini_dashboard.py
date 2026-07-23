"""LLM Router Dashboard — usage graphs + request log."""

import json
from collections import defaultdict

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session
from sqlalchemy import func, text

from ..database import get_db
from ..models import LLMJob
from .llm_jobs import _last_error

router = APIRouter(prefix="/api/llm-dash", tags=["llm-dashboard"])

# Color palette for models
MODEL_COLORS = {
    # Gemini — blue/cyan family
    "gemini-3.1-pro-preview": "#6366f1",
    "gemini-3.1-flash-preview": "#818cf8",
    "gemini-3-flash-preview": "#a5b4fc",
    "gemini-2.5-flash": "#93c5fd",
    "gemini-3.1-flash-lite-preview": "#67e8f9",
    # Claude — purple/pink family
    "claude-opus-4-6": "#c084fc",
    "claude-opus-4-6[1m]": "#c084fc",
    "claude-sonnet-4-6": "#e879f9",
    "claude-haiku-4-5": "#f0abfc",
    "claude-code-max": "#d946ef",
}

def _get_color(model: str) -> str:
    return MODEL_COLORS.get(model, "#94a3b8")


def _summary_counts(db):
    total = db.query(func.count(LLMJob.id)).scalar() or 0
    claude = db.query(func.count(LLMJob.id)).filter(LLMJob.provider == "claude").scalar() or 0
    cost = db.query(func.sum(LLMJob.estimated_cost)).scalar() or 0
    return total, claude, total - claude, cost


@router.get("", response_class=HTMLResponse)
def llm_dashboard(db: Session = Depends(get_db)):
    # Summary stats
    total_requests, claude_requests, gemini_requests, total_cost = _summary_counts(db)

    # Daily usage by model (last 14 days)
    daily_rows = db.execute(text("""
        SELECT DATE(created_at) as day, COALESCE(provider, 'gemini') as provider, model,
               COUNT(*) as cnt, COALESCE(SUM(total_tokens), 0) as tokens,
               COALESCE(SUM(estimated_cost), 0) as cost
        FROM llm_jobs
        WHERE status = 'succeeded' AND created_at >= DATE('now', '-14 days')
        GROUP BY day, provider, model
        ORDER BY day
    """)).fetchall()

    # Build chart data structure
    days = []
    day_data = defaultdict(lambda: defaultdict(lambda: {"count": 0, "tokens": 0, "cost": 0.0, "provider": "gemini"}))
    all_models = set()

    for row in daily_rows:
        day, provider, model, cnt, tokens, cost = row
        if day not in days:
            days.append(day)
        day_data[day][model]["count"] += cnt
        day_data[day][model]["tokens"] += tokens
        day_data[day][model]["cost"] += cost
        day_data[day][model]["provider"] = provider
        all_models.add(model)

    # Build chart JSON for inline JS
    chart_data = json.dumps({
        "days": days,
        "models": sorted(all_models),
        "data": {day: {m: day_data[day][m] for m in day_data[day]} for day in days},
        "colors": {m: _get_color(m) for m in all_models},
    })

    # Recent request logs (last 50)
    logs = db.query(LLMJob).order_by(LLMJob.id.desc()).limit(50).all()

    log_rows = ""
    for l in logs:
        cost_str = f"${l.estimated_cost:.4f}" if l.estimated_cost else "-"
        last_err = _last_error(l)
        err = f'<span style="color:#f87171">{last_err[:60]}...</span>' if last_err else "-"
        prov = getattr(l, 'provider', 'gemini') or 'gemini'
        prov_badge = (
            f'<span style="color:#e879f9">{prov}</span>' if prov == 'claude'
            else f'<span style="color:#818cf8">{prov}</span>'
        )
        effort = getattr(l, 'effort', None) or '-'
        conf = ''
        avg_c = getattr(l, 'avg_confidence', None)
        if avg_c is not None:
            conf = f'{avg_c:.2f}'
        retry_btn = (
            f'<button onclick="retry(\'{l.job_id}\')">↻</button>' if l.status == 'failed' else ''
        )
        log_rows += (
            f"<tr><td>{l.created_at.strftime('%m/%d %H:%M') if l.created_at else '-'}</td>"
            f"<td>{l.service}</td><td>{l.task_type}</td>"
            f"<td>{prov_badge}</td><td>{effort}</td>"
            f"<td style='color:{_get_color(l.model or '')}'>{l.model or '-'}</td>"
            f"<td>{l.total_tokens or 0}</td><td>{cost_str}</td>"
            f"<td>{conf}</td>"
            f"<td>{'Y' if l.json_valid else 'N' if l.json_valid is False else '-'}</td>"
            f"<td>{l.latency_ms or 0}ms</td>"
            f"<td>{err}</td><td>{retry_btn}</td></tr>\n"
        )

    return f"""<!DOCTYPE html>
<html><head>
<title>LLM Router Dashboard</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: 'SF Mono', 'Fira Code', monospace; background: #0a0a0f; color: #e0e0e0; padding: 20px; margin: 0; }}
  h1 {{ color: #818cf8; margin: 0 0 16px; font-size: 1.3rem; }}
  h2 {{ color: #a5b4fc; margin: 30px 0 10px; font-size: 1rem; }}
  .stats {{ display: flex; gap: 16px; margin: 16px 0; flex-wrap: wrap; }}
  .stat {{ background: #12121f; padding: 14px 20px; border-radius: 10px; border: 1px solid #1e1e2e; min-width: 120px; }}
  .stat-val {{ font-size: 22px; font-weight: 700; }}
  .stat-label {{ font-size: 11px; color: #666; margin-top: 2px; }}
  .chart-container {{ background: #12121f; border: 1px solid #1e1e2e; border-radius: 10px; padding: 20px; margin: 16px 0; }}
  .chart-header {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }}
  .chart-title {{ font-size: 0.85rem; font-weight: 600; color: #a5b4fc; }}
  .chart-toggle {{ display: flex; gap: 4px; }}
  .chart-toggle button {{ background: #1e1e2e; border: 1px solid #333; color: #888; padding: 3px 10px; border-radius: 4px; font-size: 0.7rem; cursor: pointer; font-family: inherit; }}
  .chart-toggle button.active {{ background: #818cf8; color: #fff; border-color: #818cf8; }}
  .chart-area {{ position: relative; height: 200px; display: flex; align-items: flex-end; gap: 3px; padding-bottom: 20px; }}
  .chart-bar-group {{ flex: 1; display: flex; flex-direction: column; align-items: stretch; justify-content: flex-end; height: 100%; position: relative; }}
  .chart-bar {{ border-radius: 3px 3px 0 0; min-height: 2px; transition: opacity 0.2s; cursor: default; position: relative; }}
  .chart-bar:hover {{ opacity: 0.8; }}
  .chart-bar:hover::after {{ content: attr(data-tip); position: absolute; bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%); background: #1e1e2e; color: #e0e0e0; padding: 3px 8px; border-radius: 4px; font-size: 0.65rem; white-space: nowrap; z-index: 10; border: 1px solid #333; pointer-events: none; }}
  .chart-date {{ position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); font-size: 0.55rem; color: #555; white-space: nowrap; }}
  .legend {{ display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }}
  .legend-item {{ display: flex; align-items: center; gap: 5px; font-size: 0.65rem; color: #888; }}
  .legend-dot {{ width: 8px; height: 8px; border-radius: 2px; }}
  table {{ border-collapse: collapse; width: 100%; margin-top: 10px; }}
  th, td {{ border: 1px solid #1e1e2e; padding: 5px 8px; text-align: left; font-size: 12px; }}
  th {{ background: #12121f; color: #818cf8; font-weight: 600; position: sticky; top: 0; }}
  tr:nth-child(even) {{ background: #0f0f18; }}
  tr:hover {{ background: #16162a; }}
</style>
</head><body>
<h1>LLM Router Dashboard</h1>

<div class="stats">
  <div class="stat"><div class="stat-val" style="color:#818cf8">{total_requests}</div><div class="stat-label">Total Requests</div></div>
  <div class="stat"><div class="stat-val" style="color:#818cf8">{gemini_requests}</div><div class="stat-label">Gemini</div></div>
  <div class="stat"><div class="stat-val" style="color:#e879f9">{claude_requests}</div><div class="stat-label">Claude</div></div>
  <div class="stat"><div class="stat-val" style="color:#34d399">${total_cost:.2f}</div><div class="stat-label">Total Cost (API eq.)</div></div>
</div>

<div class="chart-container">
  <div class="chart-header">
    <span class="chart-title">Daily Usage by Model</span>
    <div class="chart-toggle">
      <button class="active" onclick="setMetric('count')">Requests</button>
      <button onclick="setMetric('tokens')">Tokens</button>
      <button onclick="setMetric('cost')">Cost</button>
    </div>
  </div>
  <div class="chart-area" id="chart"></div>
  <div class="legend" id="legend"></div>
</div>

<h2>Recent Requests</h2>
<table>
<tr><th>Time</th><th>Service</th><th>Task</th><th>Provider</th><th>Effort</th><th>Model</th><th>Tokens</th><th>Cost</th><th>Conf</th><th>JSON</th><th>Latency</th><th>Error</th><th>Retry</th></tr>
{log_rows if log_rows else '<tr><td colspan="13" style="color:#666">No requests logged yet</td></tr>'}
</table>

<script>
const D = {chart_data};
let metric = 'count';

function setMetric(m) {{
  metric = m;
  document.querySelectorAll('.chart-toggle button').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  render();
}}

function render() {{
  const chart = document.getElementById('chart');
  const legend = document.getElementById('legend');
  if (!D.days.length) {{ chart.innerHTML = '<div style="color:#555;margin:auto">No data</div>'; return; }}

  // Compute max for scaling
  let maxVal = 0;
  for (const day of D.days) {{
    let dayTotal = 0;
    for (const model in D.data[day]) dayTotal += D.data[day][model][metric] || 0;
    maxVal = Math.max(maxVal, dayTotal);
  }}
  if (maxVal === 0) maxVal = 1;

  let html = '';
  for (const day of D.days) {{
    let bars = '';
    const models = Object.keys(D.data[day]).sort();
    for (const model of models) {{
      const val = D.data[day][model][metric] || 0;
      const pct = (val / maxVal) * 100;
      const color = D.colors[model] || '#94a3b8';
      const label = metric === 'cost' ? '$' + val.toFixed(3) : val.toLocaleString();
      bars += `<div class="chart-bar" style="height:${{pct}}%;background:${{color}}" data-tip="${{model}}: ${{label}}"></div>`;
    }}
    const shortDay = day.slice(5); // MM-DD
    html += `<div class="chart-bar-group">${{bars}}<span class="chart-date">${{shortDay}}</span></div>`;
  }}
  chart.innerHTML = html;

  // Legend
  const seen = new Set();
  let legendHtml = '';
  for (const model of D.models) {{
    if (seen.has(model)) continue;
    seen.add(model);
    const color = D.colors[model] || '#94a3b8';
    legendHtml += `<div class="legend-item"><div class="legend-dot" style="background:${{color}}"></div>${{model}}</div>`;
  }}
  legend.innerHTML = legendHtml;
}}

function retry(id) {{
  fetch('/api/llm-jobs/' + id + '/retry', {{
    method: 'POST',
    headers: {{ Authorization: 'Bearer ' + localStorage.helm_auth_token }},
  }}).then(() => location.reload());
}}

render();
setTimeout(() => location.reload(), 30000);
</script>
</body></html>"""
