// Stage A10 — Fulfillment Agent
import { Env } from '../types';
import { runAgentWithTrace, createProposal } from './core';

export async function calculateFulfillment(db: D1Database, env: Env, context: unknown = {}) {
  return runAgentWithTrace(db, 'fulfillment_agent', 'business', 'fulfillment_calculate', async (requestId, traceId) => {
    const proposals = [];

    const calculation = {
      data_status: env.WB_API_TOKEN ? 'partial' : 'unavailable',
      products: [], // From WB API: stock levels, sales velocity
      supply_calculations: [], // days_of_stock, reorder_point, recommended_quantity
      stock_risks: [
        { severity: 'info', text: 'WB API required for real stock data', sku: 'all' },
      ],
      spec: {
        template: 'fulfillment_spec_v1',
        note: 'ТЗ для фулфилмента формируется после подтверждения поставки',
      },
    };

    // Create a mock supply proposal — requires approval before any shipment
    const { actionId } = await createProposal(
      db, 'fulfillment_agent', 'fulfillment_message_send',
      { type: 'supply_draft', content: 'Mock supply calculation draft — configure WB API for real data' },
      '[MOCK] Create supply draft for fulfillment review',
      'medium'
    );
    proposals.push({ action_id: actionId, type: 'fulfillment_draft', note: 'Requires approval' });

    return {
      summary: `Fulfillment calculation complete. ${proposals.length} proposals (approval required for all shipment actions).`,
      result: calculation,
      proposals,
    };
  });
}
