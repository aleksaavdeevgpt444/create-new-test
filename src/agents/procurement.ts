// Stage A11 — Procurement Agent
import { Env } from '../types';
import { runAgentWithTrace, createProposal } from './core';

export async function calculateProcurement(db: D1Database, env: Env, context: unknown = {}) {
  return runAgentWithTrace(db, 'procurement_agent', 'business', 'procurement_calculate', async (requestId, traceId) => {
    const proposals = [];

    const calculation = {
      data_status: env.WB_API_TOKEN ? 'partial' : 'unavailable',
      products: [],
      procurement_plan: {
        items: [],
        total_units: 0,
        estimated_cost: null,
        note: 'Real data requires WB API + supplier integration',
      },
      payment_status: 'DISABLED in MVP — payment_create and payment_confirm are blocked',
    };

    // Supplier draft message — mock only, requires approval
    const { actionId } = await createProposal(
      db, 'procurement_agent', 'supplier_message_send',
      { type: 'procurement_draft', supplier_id: 'mock-supplier-001' },
      '[MOCK] Send procurement draft to supplier (mock — no real message will be sent)',
      'high'
    );
    proposals.push({ action_id: actionId, type: 'supplier_draft', note: 'Mock/proposal-only' });

    return {
      summary: 'Procurement calculation complete. Payment actions disabled in MVP. All supplier communications are mock/proposal-only.',
      result: calculation,
      proposals,
    };
  });
}
