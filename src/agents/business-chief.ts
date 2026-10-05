// Stage A15 — Business Operations AI Chief
import { Env } from '../types';
import { runAgentWithTrace, createHandoff, createProposal } from './core';

export async function businessDailyCommand(db: D1Database, env: Env, context: unknown = {}) {
  return runAgentWithTrace(db, 'business_operations_ai_chief', 'business', 'daily_business_command', async (requestId, traceId) => {
    const priorities = [
      { priority: 1, area: 'Ads', task: 'Review WB Ads performance and budget utilization', agent: 'ads_agent' },
      { priority: 2, area: 'Finance', task: 'Run daily financial analysis and margin check', agent: 'finance_analyst_agent' },
      { priority: 3, area: 'Fulfillment', task: 'Check stock levels and shipment status', agent: 'fulfillment_agent' },
      { priority: 4, area: 'Reports', task: 'Generate daily business report', agent: 'reports_agent' },
    ];

    // Create handoffs to specialized agents
    const handoffs = [];
    for (const p of priorities) {
      const handoffId = await createHandoff(
        db,
        'business_operations_ai_chief',
        p.agent as any,
        `Daily command: ${p.task}`,
        { priority: p.priority, context },
        'Analysis + recommendations + proposals if action needed'
      );
      handoffs.push({ ...p, handoff_id: handoffId });
    }

    return {
      summary: `Business daily command issued. ${handoffs.length} agents activated.`,
      result: {
        date: new Date().toISOString().slice(0, 10),
        priorities,
        handoffs,
        status: 'dispatched',
      },
      proposals: [],
    };
  });
}
