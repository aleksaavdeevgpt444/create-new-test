// Stage A9 — Ads Agent
import { Env } from '../types';
import { runAgentWithTrace, createProposal } from './core';

export async function runAdsAnalysis(db: D1Database, env: Env, context: unknown = {}) {
  return runAgentWithTrace(db, 'ads_agent', 'business', 'ads_analysis', async (requestId, traceId) => {
    const proposals = [];
    const dataStatus = env.WB_API_TOKEN ? 'partial' : 'unavailable';

    const analysis = {
      data_status: dataStatus,
      data_source: env.WB_API_TOKEN ? 'wb_api (not yet implemented)' : 'mock',
      campaigns: [], // Would be populated from WB API
      recommendations: [
        { type: 'info', text: 'WB API integration required for real campaign data' },
        { type: 'tip', text: 'Once connected, system will analyze CPO, CTR, budget efficiency per campaign' },
      ],
      note: 'All WB Ads changes are mock/proposal-only in MVP. No real changes will be made without approval.',
    };

    // Example: if we had a campaign over budget, create mock proposal
    // In real implementation, this would come from WB API data
    if (env.WB_API_TOKEN) {
      try {
        const { actionId } = await createProposal(
          db, 'ads_agent', 'wb_ads_update_budget',
          { campaign_id: 'mock-001', new_budget: 1000, reason: 'Over-performing campaign' },
          '[MOCK] Increase budget for campaign mock-001 to 1000 RUB (over-performing)',
          'high'
        );
        proposals.push({ action_id: actionId, type: 'budget_update', note: 'mock proposal' });
      } catch { /* skip if blocked */ }
    }

    return {
      summary: `Ads analysis complete. Data: ${dataStatus}. ${proposals.length} proposals created (all mock/proposal-only).`,
      result: analysis,
      proposals,
    };
  });
}

export async function createAdsRecommendation(db: D1Database, env: Env, payload: unknown) {
  return runAgentWithTrace(db, 'ads_agent', 'business', 'ads_recommend', async (requestId, traceId) => {
    return {
      summary: 'Ads recommendation created (mock/proposal-only)',
      result: { recommendation: payload, is_mock: true, requires_approval: true },
      proposals: [],
    };
  });
}
