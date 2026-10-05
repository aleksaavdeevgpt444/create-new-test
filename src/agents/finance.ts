// Stage A8 — Finance Analyst Agent
import { Env } from '../types';
import { runAgentWithTrace } from './core';

export async function runFinanceAnalysis(db: D1Database, env: Env, context: unknown = {}) {
  return runAgentWithTrace(db, 'finance_analyst_agent', 'business', 'finance_analysis', async (requestId, traceId) => {
    const dataStatus = env.WB_API_TOKEN ? 'partial' : 'unavailable';

    // Mock financial data when real API not configured
    const financials = {
      data_status: dataStatus,
      data_source: env.WB_API_TOKEN ? 'wb_api (not yet implemented)' : 'mock',
      period: new Date().toISOString().slice(0, 7), // YYYY-MM
      // All formulas shown explicitly
      metrics: {
        revenue_mock: { value: null, formula: 'sum(orders.revenue)', status: dataStatus },
        cogs_mock: { value: null, formula: 'sum(orders.quantity * product.cost)', status: dataStatus },
        gross_margin_mock: { value: null, formula: '(revenue - cogs) / revenue * 100', status: dataStatus },
        ads_spend_mock: { value: null, formula: 'sum(campaigns.spend)', status: dataStatus },
        net_margin_mock: { value: null, formula: '(revenue - cogs - ads_spend) / revenue * 100', status: dataStatus },
      },
      risks: [
        { severity: 'info', description: 'WB API not configured — financial data unavailable', action_required: 'Configure WB_API_TOKEN' },
      ],
      recommendations: [
        { priority: 'high', text: 'Configure WB_API_TOKEN to enable real financial analysis', type: 'setup' },
      ],
    };

    return {
      summary: `Finance analysis run. Data status: ${dataStatus}. WB API: ${env.WB_API_TOKEN ? 'configured' : 'missing'}.`,
      result: financials,
      proposals: [],
    };
  });
}
