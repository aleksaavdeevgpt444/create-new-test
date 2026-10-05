// Stage A3 — Agent Core API: request/response/handoff lifecycle
import { Env, AgentKey, AgentContour, generateId, now, hashPayload } from '../types';
import { logAgentEvent, createTrace, completeTrace, addTraceStep } from './registry';

export async function createAgentRequest(
  db: D1Database,
  agentKey: AgentKey,
  contour: AgentContour,
  trigger: string,
  payload: unknown = {},
  context: unknown = {}
): Promise<string> {
  const id = generateId();
  await db.prepare(
    'INSERT INTO agent_requests (id, agent_key, contour, trigger, payload, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, agentKey, contour, trigger, JSON.stringify(payload), JSON.stringify(context), 'assigned_to_agent', now(), now()).run();
  await logAgentEvent(db, agentKey, 'info', `Request created: ${trigger}`, { requestId: id });
  return id;
}

export async function createAgentResponse(
  db: D1Database,
  requestId: string,
  agentKey: AgentKey,
  summary: string,
  result: unknown,
  proposals: unknown[] = [],
  status: 'success' | 'partial' | 'failed' | 'needs_approval' = 'success'
): Promise<string> {
  const id = generateId();
  await db.prepare(
    'INSERT INTO agent_responses (id, request_id, agent_key, summary, result, proposals, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, requestId, agentKey, summary, JSON.stringify(result), JSON.stringify(proposals), status, now()).run();
  await db.prepare('UPDATE agent_requests SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status === 'needs_approval' ? 'ready_for_review' : 'applied', now(), requestId).run();
  await logAgentEvent(db, agentKey, 'info', `Response created: ${summary}`, { requestId, responseId: id, status });
  return id;
}

export async function createHandoff(
  db: D1Database,
  fromAgent: AgentKey,
  toAgent: AgentKey,
  reason: string,
  payload: unknown = {},
  expectedOutput: string
): Promise<string> {
  const id = generateId();
  await db.prepare(
    'INSERT INTO agent_handoffs (id, from_agent, to_agent, reason, payload, expected_output, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, fromAgent, toAgent, reason, JSON.stringify(payload), expectedOutput, 'pending', now(), now()).run();
  await logAgentEvent(db, fromAgent, 'info', `Handoff to ${toAgent}: ${reason}`, { handoffId: id });
  return id;
}

export async function createProposal(
  db: D1Database,
  agentKey: AgentKey,
  actionType: string,
  payload: unknown,
  proposalText: string,
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'dangerous' = 'low',
  ttlHours = 24
): Promise<{ actionId: string; payloadHash: string }> {
  // Block dangerous actions in MVP
  const DANGEROUS_ACTIONS = [
    'payment_create', 'payment_confirm', 'purchase_confirm',
    'wb_ads_mass_update', 'wb_campaign_delete', 'delete_task',
    'delete_record', 'bulk_task_reschedule', 'project_delete',
    'supplier_order_confirm', 'production_deploy_by_agent',
  ];
  if (DANGEROUS_ACTIONS.includes(actionType)) {
    throw new Error(`Action '${actionType}' is disabled in MVP Safe Policy`);
  }

  const id = generateId();
  const payloadStr = JSON.stringify(payload);
  const payloadHash = await hashPayload(payloadStr);
  const expiresAt = new Date(Date.now() + ttlHours * 3600000).toISOString();

  await db.prepare(
    'INSERT INTO agent_actions (id, agent_key, action_type, payload, payload_hash, risk_level, status, proposal_text, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, agentKey, actionType, payloadStr, payloadHash, riskLevel, 'pending', proposalText, now(), expiresAt, now()).run();

  await logAgentEvent(db, agentKey, 'info', `Proposal created: ${actionType}`, { actionId: id, riskLevel });
  return { actionId: id, payloadHash };
}

export async function runAgentWithTrace(
  db: D1Database,
  agentKey: AgentKey,
  contour: AgentContour,
  trigger: string,
  handler: (requestId: string, traceId: string) => Promise<{ summary: string; result: unknown; proposals?: unknown[] }>
): Promise<{ requestId: string; responseId: string; summary: string }> {
  const requestId = await createAgentRequest(db, agentKey, contour, trigger);
  const traceId = await createTrace(db, requestId, agentKey, trigger);

  try {
    await addTraceStep(db, traceId, 1, 'start', `Agent ${agentKey} started`, { trigger });
    const { summary, result, proposals = [] } = await handler(requestId, traceId);
    await addTraceStep(db, traceId, 2, 'complete', 'Agent completed', {}, { summary });
    const responseId = await createAgentResponse(db, requestId, agentKey, summary, result, proposals, proposals.length > 0 ? 'needs_approval' : 'success');
    await completeTrace(db, traceId, summary);
    return { requestId, responseId, summary };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await addTraceStep(db, traceId, 2, 'error', errMsg, {}, {});
    await completeTrace(db, traceId, errMsg, 'failed');
    await createAgentResponse(db, requestId, agentKey, `Error: ${errMsg}`, { error: errMsg }, [], 'failed');
    throw err;
  }
}
