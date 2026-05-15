// Stage A17 — Unified Agent Dashboard (Web UI)
import { Env, htmlResponse, maskSecret } from '../types';

function navLinks(): string {
  const pages = [
    ['/agents/dashboard', 'Dashboard'],
    ['/agents/control-center', 'Control Center'],
    ['/agents/approvals', 'Approvals'],
    ['/agents/actions', 'Actions'],
    ['/agents/tools', 'Tools'],
    ['/agents/integrations', 'Integrations'],
    ['/agents/knowledge', 'Knowledge'],
    ['/agents/qa', 'QA'],
    ['/agents/deployments', 'Deployments'],
    ['/agents/notifications', 'Notifications'],
    ['/agents/schedules', 'Schedules'],
    ['/agents/analytics', 'Analytics'],
    ['/agents/security', 'Security'],
    ['/agents/hardening', 'Hardening'],
    ['/agents/recovery', 'Recovery'],
    ['/agents/settings', 'Settings'],
  ];
  return pages.map(([href, label]) => `<a href="${href}" style="color:#60a5fa;text-decoration:none;padding:4px 8px;border-radius:4px;">${label}</a>`).join(' ');
}

function shell(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — AI Agents System</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
  .nav{background:#1e293b;padding:12px 24px;border-bottom:1px solid #334155;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .nav-brand{color:#f8fafc;font-weight:700;font-size:18px;margin-right:16px}
  .main{padding:24px;max-width:1400px;margin:0 auto}
  h1{font-size:28px;font-weight:700;color:#f8fafc;margin-bottom:8px}
  h2{font-size:20px;font-weight:600;color:#cbd5e1;margin:24px 0 12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin-bottom:24px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px}
  .card-title{font-size:13px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
  .card-value{font-size:32px;font-weight:700;color:#f8fafc}
  .card-sub{font-size:13px;color:#64748b;margin-top:4px}
  .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600}
  .badge-green{background:#166534;color:#86efac}
  .badge-yellow{background:#713f12;color:#fde68a}
  .badge-red{background:#7f1d1d;color:#fca5a5}
  .badge-blue{background:#1e3a5f;color:#93c5fd}
  .badge-gray{background:#1e293b;color:#94a3b8;border:1px solid #334155}
  .table{width:100%;border-collapse:collapse;font-size:14px}
  .table th{text-align:left;padding:8px 12px;color:#94a3b8;font-weight:600;font-size:12px;text-transform:uppercase;border-bottom:1px solid #334155}
  .table td{padding:10px 12px;border-bottom:1px solid #1e293b;color:#cbd5e1}
  .table tr:hover td{background:#1e293b}
  .section{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px;margin-bottom:16px}
  .empty{color:#475569;font-style:italic;padding:16px 0}
  .tag{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;background:#334155;color:#94a3b8;margin:1px}
  a.btn{display:inline-block;padding:6px 14px;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;background:#3b82f6;color:white}
  a.btn:hover{background:#2563eb}
  .alert{background:#7f1d1d;border:1px solid #dc2626;border-radius:8px;padding:12px 16px;color:#fca5a5;margin-bottom:12px}
</style>
</head>
<body>
<nav class="nav">
  <span class="nav-brand">⚡ AI Agents</span>
  ${navLinks()}
</nav>
<main class="main">
  <h1>${title}</h1>
  ${content}
</main>
</body>
</html>`;
}

export async function renderDashboard(db: D1Database | null, env: Env): Promise<Response> {
  let agentCount = 0, pendingApprovals = 0, recentRequests = 0, failedCount = 0;
  let agents: Record<string, string>[] = [];
  let recentActions: Record<string, string>[] = [];
  let dbWarning = '';

  if (db) {
    try {
      const [ac, pa, rr, fc, ag, ra] = await Promise.all([
        db.prepare('SELECT COUNT(*) as c FROM agent_registry').first() as Promise<Record<string, number> | null>,
        db.prepare("SELECT COUNT(*) as c FROM agent_actions WHERE status = 'pending'").first() as Promise<Record<string, number> | null>,
        db.prepare("SELECT COUNT(*) as c FROM agent_requests WHERE date(created_at) = date('now')").first() as Promise<Record<string, number> | null>,
        db.prepare("SELECT COUNT(*) as c FROM agent_requests WHERE status = 'failed'").first() as Promise<Record<string, number> | null>,
        db.prepare('SELECT * FROM agent_registry ORDER BY contour, name').all(),
        db.prepare('SELECT * FROM agent_actions ORDER BY created_at DESC LIMIT 5').all(),
      ]);
      agentCount = ac?.c ?? 0;
      pendingApprovals = pa?.c ?? 0;
      recentRequests = rr?.c ?? 0;
      failedCount = fc?.c ?? 0;
      agents = (ag.results ?? []) as Record<string, string>[];
      recentActions = (ra.results ?? []) as Record<string, string>[];
    } catch (err) {
      dbWarning = `<div class="alert">Database warning: ${err instanceof Error ? err.message : String(err)}. Run <a href="/dev/ensure-schema" style="color:#fca5a5">/dev/ensure-schema</a> to initialize.</div>`;
    }
  } else {
    dbWarning = '<div class="alert">AGENT_DB not configured. Dashboard running in demo mode.</div>';
  }

  const statusBadge = (s: string) => {
    const m: Record<string, string> = { active: 'badge-green', inactive: 'badge-gray', error: 'badge-red' };
    return `<span class="badge ${m[s] ?? 'badge-gray'}">${s}</span>`;
  };

  const agentRows = agents.length > 0
    ? agents.map(a => `<tr><td><strong>${a.name}</strong></td><td><span class="tag">${a.contour}</span></td><td>${statusBadge(a.status ?? 'active')}</td><td style="color:#64748b;font-size:12px">${(a.description ?? '').slice(0, 60)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">No agents registered. Run <a href="/dev/ensure-schema" style="color:#60a5fa">/dev/ensure-schema</a> to seed.</td></tr>`;

  const actionRows = recentActions.length > 0
    ? recentActions.map(a => `<tr><td><code style="font-size:12px">${a.action_type}</code></td><td><span class="tag">${a.agent_key}</span></td><td><span class="badge ${a.status === 'pending' ? 'badge-yellow' : a.status === 'approved' ? 'badge-green' : a.status === 'rejected' ? 'badge-red' : 'badge-gray'}">${a.status}</span></td><td style="font-size:12px;color:#94a3b8">${(a.proposal_text ?? '').slice(0, 60)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">No recent actions.</td></tr>`;

  const content = `
    ${dbWarning}
    <p style="color:#64748b;margin-bottom:20px">AI Agents System — MVP Dashboard</p>
    <div class="grid">
      <div class="card">
        <div class="card-title">Active Agents</div>
        <div class="card-value">${agentCount}</div>
        <div class="card-sub">Registered in system</div>
      </div>
      <div class="card">
        <div class="card-title">Pending Approvals</div>
        <div class="card-value" style="color:${pendingApprovals > 0 ? '#fbbf24' : '#f8fafc'}">${pendingApprovals}</div>
        <div class="card-sub"><a href="/agents/approvals" style="color:#60a5fa">Review approvals →</a></div>
      </div>
      <div class="card">
        <div class="card-title">Requests Today</div>
        <div class="card-value">${recentRequests}</div>
        <div class="card-sub">Agent requests processed</div>
      </div>
      <div class="card">
        <div class="card-title">Failed</div>
        <div class="card-value" style="color:${failedCount > 0 ? '#f87171' : '#f8fafc'}">${failedCount}</div>
        <div class="card-sub">Total failed requests</div>
      </div>
    </div>
    <div class="section">
      <h2 style="margin-top:0">Active Agents</h2>
      <table class="table">
        <thead><tr><th>Name</th><th>Contour</th><th>Status</th><th>Description</th></tr></thead>
        <tbody>${agentRows}</tbody>
      </table>
    </div>
    <div class="section">
      <h2 style="margin-top:0">Recent Actions</h2>
      <table class="table">
        <thead><tr><th>Action</th><th>Agent</th><th>Status</th><th>Proposal</th></tr></thead>
        <tbody>${actionRows}</tbody>
      </table>
      <div style="margin-top:12px"><a href="/agents/approvals" class="btn">View All Approvals</a></div>
    </div>
    <div class="section">
      <h2 style="margin-top:0">Quick Links</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a href="/dev/system-check" class="btn" style="background:#1e3a5f">System Check</a>
        <a href="/dev/mvp-acceptance-check" class="btn" style="background:#166534">MVP Acceptance</a>
        <a href="/dev/ensure-schema" class="btn" style="background:#4c1d95">Init Schema</a>
        <a href="/health" class="btn" style="background:#334155">Health</a>
      </div>
    </div>
  `;

  return htmlResponse(shell('Dashboard', content));
}

export async function renderSimplePage(title: string, db: D1Database | null, env: Env, contentFn: (db: D1Database | null, env: Env) => Promise<string>): Promise<Response> {
  let content = '';
  try {
    content = await contentFn(db, env);
  } catch (err) {
    content = `<div class="alert">Error loading page: ${err instanceof Error ? err.message : String(err)}</div>`;
  }
  return htmlResponse(shell(title, content));
}

export function renderAgentsPage(agents: Record<string, unknown>[]): string {
  if (!agents.length) return '<div class="section"><p class="empty">No agents registered.</p></div>';
  return `<div class="section">
    <table class="table">
      <thead><tr><th>Key</th><th>Name</th><th>Contour</th><th>Role</th><th>Status</th></tr></thead>
      <tbody>${agents.map(a => `<tr>
        <td><code style="font-size:12px">${a.agent_key}</code></td>
        <td>${a.name}</td>
        <td><span class="tag">${a.contour}</span></td>
        <td><span class="tag">${a.role ?? ''}</span></td>
        <td><span class="badge ${a.status === 'active' ? 'badge-green' : 'badge-gray'}">${a.status}</span></td>
      </tr>`).join('')}</tbody>
    </table>
  </div>`;
}
