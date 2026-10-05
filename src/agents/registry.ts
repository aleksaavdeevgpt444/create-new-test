// Stage A1/A4 — Agent Registry helpers
import { Env, AgentKey, generateId, now } from '../types';

export async function getAgents(db: D1Database) {
  const result = await db.prepare('SELECT * FROM agent_registry ORDER BY contour, name').all();
  return result.results ?? [];
}

export async function getAgent(db: D1Database, agentKey: string) {
  const result = await db.prepare('SELECT * FROM agent_registry WHERE agent_key = ?').bind(agentKey).first();
  return result ?? null;
}

export async function updateAgent(db: D1Database, agentKey: string, updates: Record<string, string>) {
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(now(), agentKey);
  await db.prepare(`UPDATE agent_registry SET ${fields}, updated_at = ? WHERE agent_key = ?`).bind(...values).run();
}

export async function logAgentEvent(db: D1Database, agentKey: string, level: string, message: string, context: unknown = {}, requestId?: string) {
  await db.prepare(
    'INSERT INTO agent_logs (id, agent_key, level, message, context, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(generateId(), agentKey, level, message, JSON.stringify(context), requestId ?? null, now()).run();
}

export async function createTrace(db: D1Database, requestId: string, agentKey: AgentKey, trigger: string) {
  const id = generateId();
  await db.prepare(
    'INSERT INTO agent_traces (id, request_id, agent_key, trigger, status, started_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, requestId, agentKey, trigger, 'running', now()).run();
  return id;
}

export async function completeTrace(db: D1Database, traceId: string, summary: string, status = 'completed') {
  await db.prepare(
    'UPDATE agent_traces SET status = ?, completed_at = ?, summary = ? WHERE id = ?'
  ).bind(status, now(), summary, traceId).run();
}

export async function addTraceStep(db: D1Database, traceId: string, stepNumber: number, stepType: string, description: string, input: unknown = {}, output: unknown = {}) {
  await db.prepare(
    'INSERT INTO agent_trace_steps (id, trace_id, step_number, step_type, description, input, output, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(generateId(), traceId, stepNumber, stepType, description, JSON.stringify(input), JSON.stringify(output), 'completed', now()).run();
}
