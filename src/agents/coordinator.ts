// Stage A14 — Chief AI Coordinator
import { Env, AgentKey, generateId, now } from '../types';
import { runAgentWithTrace, createHandoff } from './core';
import { callAI } from '../integrations/index';

type RoutingDecision = {
  target_agent: AgentKey;
  contour: 'business' | 'personal';
  reason: string;
};

function routeByKeywords(input: string): RoutingDecision {
  const lower = input.toLowerCase();
  if (lower.includes('реклам') || lower.includes('ads') || lower.includes('wb ads')) {
    return { target_agent: 'ads_agent', contour: 'business', reason: 'Ads/advertising keywords detected' };
  }
  if (lower.includes('финанс') || lower.includes('маржа') || lower.includes('прибыль') || lower.includes('finance')) {
    return { target_agent: 'finance_analyst_agent', contour: 'business', reason: 'Finance keywords detected' };
  }
  if (lower.includes('отчёт') || lower.includes('отчет') || lower.includes('report')) {
    return { target_agent: 'reports_agent', contour: 'business', reason: 'Report keywords detected' };
  }
  if (lower.includes('поставк') || lower.includes('фулфилм') || lower.includes('fulfillment') || lower.includes('остат')) {
    return { target_agent: 'fulfillment_agent', contour: 'business', reason: 'Fulfillment keywords detected' };
  }
  if (lower.includes('закупк') || lower.includes('поставщик') || lower.includes('procurement')) {
    return { target_agent: 'procurement_agent', contour: 'business', reason: 'Procurement keywords detected' };
  }
  if (lower.includes('новинк') || lower.includes('нов товар') || lower.includes('new product')) {
    return { target_agent: 'new_products_agent', contour: 'business', reason: 'New products keywords detected' };
  }
  if (lower.includes('задач') || lower.includes('встреч') || lower.includes('напомн') || lower.includes('task') || lower.includes('remind')) {
    return { target_agent: 'personal_assistant_agent', contour: 'personal', reason: 'Personal task/reminder keywords' };
  }
  if (lower.includes('проект') || lower.includes('roadmap') || lower.includes('project')) {
    return { target_agent: 'personal_pm_agent', contour: 'personal', reason: 'Project keywords detected' };
  }
  if (lower.includes('бизнес') || lower.includes('wb') || lower.includes('маркетплейс')) {
    return { target_agent: 'business_operations_ai_chief', contour: 'business', reason: 'Business operations keywords' };
  }
  return { target_agent: 'personal_operations_ai_chief', contour: 'personal', reason: 'Default: personal operations' };
}

export async function coordinatorRoute(db: D1Database, env: Env, input: string, context: unknown = {}) {
  return runAgentWithTrace(db, 'chief_ai_coordinator', 'system', `route:${input.slice(0, 50)}`, async (requestId, traceId) => {
    // Route by keywords (MVP: no AI call needed for routing)
    const decision = routeByKeywords(input);

    // Create formal handoff
    const handoffId = await createHandoff(
      db,
      'chief_ai_coordinator',
      decision.target_agent,
      decision.reason,
      { original_input: input, context },
      'Agent-specific response + proposals if needed'
    );

    const result = {
      routing_decision: decision,
      handoff_id: handoffId,
      input_preview: input.slice(0, 200),
    };

    return {
      summary: `Routed to ${decision.target_agent}: ${decision.reason}`,
      result,
      proposals: [],
    };
  });
}
