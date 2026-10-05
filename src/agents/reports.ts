// Stage A7 — Reports Agent
import { Env } from '../types';
import { runAgentWithTrace } from './core';
import { callAI } from '../integrations/index';

export async function runDailyReport(db: D1Database, env: Env, context: unknown = {}) {
  return runAgentWithTrace(db, 'reports_agent', 'business', 'daily_report', async (requestId, traceId) => {
    const today = new Date().toISOString().slice(0, 10);

    // Gather available data
    const [agentStats, pendingApprovals, recentActions] = await Promise.all([
      db.prepare("SELECT agent_key, COUNT(*) as count, SUM(CASE WHEN status='applied' THEN 1 ELSE 0 END) as success FROM agent_requests WHERE date(created_at) = ? GROUP BY agent_key").bind(today).all(),
      db.prepare("SELECT COUNT(*) as count FROM agent_actions WHERE status = 'pending'").first(),
      db.prepare("SELECT * FROM agent_actions ORDER BY created_at DESC LIMIT 5").all(),
    ]);

    const dataStatus = {
      wb_api: env.WB_API_TOKEN ? 'connected' : 'not_configured',
      planner: 'mock',
      hub: 'mock',
    };

    const report = {
      date: today,
      data_status: dataStatus,
      agent_activity: agentStats.results ?? [],
      pending_approvals: (pendingApprovals as Record<string, number>)?.count ?? 0,
      recent_actions_count: recentActions.results?.length ?? 0,
      hypotheses: [
        'System is operating normally based on available data.',
        env.WB_API_TOKEN ? 'WB API connected — live data available.' : 'WB API not configured — using mock data.',
      ],
      recommendations: [
        { priority: 'high', text: 'Review pending approvals if any exist' },
        { priority: 'normal', text: 'Configure WB_API_TOKEN to enable live marketplace data' },
      ],
      data_quality_note: 'Report based on system data only. External data sources not yet configured.',
    };

    return {
      summary: `Daily report generated for ${today}. Data status: WB=${dataStatus.wb_api}.`,
      result: report,
      proposals: [],
    };
  });
}
