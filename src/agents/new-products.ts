// Stage A12 — New Products Agent
import { Env } from '../types';
import { runAgentWithTrace, createProposal } from './core';
import { createKnowledgeItem } from '../knowledge/index';

export async function researchNewProducts(db: D1Database, env: Env, context: unknown = {}) {
  return runAgentWithTrace(db, 'new_products_agent', 'business', 'new_products_research', async (requestId, traceId) => {
    const proposals = [];

    const research = {
      data_status: 'mock',
      data_source: 'No external market data source configured',
      niches: [
        { niche: 'Example Niche', status: 'mock', source: 'manual_input' },
      ],
      unit_economics_draft: {
        template: 'unit_economics_v1',
        items: [],
        note: 'Real unit economics requires product data + supplier pricing',
      },
      commercial_proposal_draft: {
        template: 'commercial_proposal_v1',
        sections: ['executive_summary', 'market_analysis', 'unit_economics', 'risk_assessment'],
        status: 'template_only',
      },
      supplier_outreach_status: 'BLOCKED — supplier_message_send requires approval in MVP',
    };

    // Save research to knowledge base
    await createKnowledgeItem(
      db, 'new_products_agent', 'market_research',
      'New Products Research Run',
      JSON.stringify(research),
      'local'
    );

    // Supplier outreach proposal (mock/blocked)
    const { actionId } = await createProposal(
      db, 'new_products_agent', 'supplier_message_send',
      { type: 'supplier_inquiry', template: 'new_product_inquiry' },
      '[MOCK] Send product inquiry to potential supplier (requires approval)',
      'high'
    );
    proposals.push({ action_id: actionId, type: 'supplier_inquiry', note: 'Requires approval — mock only' });

    return {
      summary: 'New products research complete. Research saved to knowledge base. Supplier outreach requires approval.',
      result: research,
      proposals,
    };
  });
}
