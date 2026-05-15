// Stage A27 — Agent Analytics v1
import { Env, generateId, now } from '../types';

export async function runDailyAnalytics(db: D1Database): Promise<{ runId: string; insights: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const runId = generateId();

  await db.prepare('INSERT INTO agent_analytics_runs (id, run_type, period_start, period_end, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(runId, 'daily', today + 'T00:00:00Z', today + 'T23:59:59Z', 'running', now()).run();

  try {
    // Aggregate agent daily stats
    const agentKeys = [
      'chief_ai_coordinator', 'business_operations_ai_chief', 'personal_operations_ai_chief',
      'personal_assistant_agent', 'personal_pm_agent', 'project_builder_agent',
      'reports_agent', 'finance_analyst_agent', 'ads_agent',
      'fulfillment_agent', 'procurement_agent', 'new_products_agent',
    ];

    for (const agentKey of agentKeys) {
      const stats = await db.prepare(`
        SELECT
          COUNT(*) as requests,
          SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) as success,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM agent_requests
        WHERE agent_key = ? AND date(created_at) = ?
      `).bind(agentKey, today).first() as Record<string, number> | null;

      if (stats) {
        await db.prepare(`
          INSERT OR REPLACE INTO agent_analytics_agent_daily (id, date, agent_key, requests_count, success_count, failed_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(generateId(), today, agentKey, stats.requests ?? 0, stats.success ?? 0, stats.failed ?? 0, now()).run();
      }
    }

    // Approval stats
    const approvalStats = await db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN decision = 'rejected' THEN 1 ELSE 0 END) as rejected
      FROM agent_approvals WHERE date(created_at) = ?
    `).bind(today).first() as Record<string, number> | null;

    if (approvalStats) {
      await db.prepare('INSERT OR REPLACE INTO agent_analytics_approvals (id, date, total, approved, rejected, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(generateId(), today, approvalStats.total ?? 0, approvalStats.approved ?? 0, approvalStats.rejected ?? 0, now()).run();
    }

    // Generate insights
    let insightCount = 0;
    const totalRequests = await db.prepare("SELECT COUNT(*) as c FROM agent_requests WHERE date(created_at) = ?").bind(today).first() as Record<string, number> | null;
    if ((totalRequests?.c ?? 0) === 0) {
      await db.prepare('INSERT INTO agent_analytics_insights (id, run_id, category, insight, severity, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(generateId(), runId, 'activity', 'No agent requests today — system may be idle', 'info', now()).run();
      insightCount++;
    }

    await db.prepare("UPDATE agent_analytics_runs SET status = 'completed', completed_at = ? WHERE id = ?").bind(now(), runId).run();

    // Audit — secrets never in analytics reports
    await db.prepare('INSERT INTO agent_analytics_audit_log (id, run_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(generateId(), runId, 'completed', JSON.stringify({ today, insightCount }), now()).run();

    return { runId, insights: insightCount };
  } catch (err) {
    await db.prepare("UPDATE agent_analytics_runs SET status = 'failed', completed_at = ? WHERE id = ?").bind(now(), runId).run();
    throw err;
  }
}

export async function getAnalyticsSummary(db: D1Database) {
  const [runs, agentDaily, insights, approvals] = await Promise.all([
    db.prepare('SELECT * FROM agent_analytics_runs ORDER BY started_at DESC LIMIT 10').all(),
    db.prepare('SELECT * FROM agent_analytics_agent_daily ORDER BY date DESC, agent_key LIMIT 100').all(),
    db.prepare('SELECT * FROM agent_analytics_insights ORDER BY created_at DESC LIMIT 20').all(),
    db.prepare('SELECT * FROM agent_analytics_approvals ORDER BY date DESC LIMIT 30').all(),
  ]);

  return {
    runs: runs.results ?? [],
    agent_daily: agentDaily.results ?? [],
    insights: insights.results ?? [],
    approvals: approvals.results ?? [],
  };
}
