// Core environment bindings
export interface Env {
  AGENT_DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  OPENAI_API_KEY?: string;
  WB_API_TOKEN?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  ENVIRONMENT?: string;
}

// Internal agent protocol types
export type AgentKey =
  | 'chief_ai_coordinator'
  | 'business_operations_ai_chief'
  | 'personal_operations_ai_chief'
  | 'personal_assistant_agent'
  | 'personal_pm_agent'
  | 'project_builder_agent'
  | 'reports_agent'
  | 'finance_analyst_agent'
  | 'ads_agent'
  | 'fulfillment_agent'
  | 'procurement_agent'
  | 'new_products_agent';

export type AgentContour = 'business' | 'personal' | 'system';

export type TaskStatus =
  | 'not_assigned'
  | 'assigned_to_agent'
  | 'in_progress'
  | 'needs_info'
  | 'ready_for_review'
  | 'approved'
  | 'applied'
  | 'failed';

export type ActionStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'failed'
  | 'expired';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'dangerous';

export interface AgentRequest {
  id: string;
  agent_key: AgentKey;
  contour: AgentContour;
  trigger: string;
  payload: string; // JSON
  context: string; // JSON
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface AgentResponse {
  id: string;
  request_id: string;
  agent_key: AgentKey;
  summary: string;
  result: string; // JSON
  proposals: string; // JSON array
  status: 'success' | 'partial' | 'failed' | 'needs_approval';
  created_at: string;
}

export interface AgentHandoff {
  id: string;
  from_agent: AgentKey;
  to_agent: AgentKey;
  reason: string;
  payload: string; // JSON
  expected_output: string;
  status: 'pending' | 'accepted' | 'completed' | 'failed';
  created_at: string;
}

export interface AgentAction {
  id: string;
  agent_key: AgentKey;
  action_type: string;
  payload: string; // JSON
  payload_hash: string;
  risk_level: RiskLevel;
  status: ActionStatus;
  proposal_text: string;
  created_at: string;
  expires_at: string;
}

export interface AgentApproval {
  id: string;
  action_id: string;
  approved_by: string;
  decision: 'approved' | 'rejected';
  reason?: string;
  created_at: string;
}

export interface DevCheckResult {
  ok: boolean;
  module: string;
  status: 'passed' | 'warning' | 'failed';
  checks: CheckItem[];
  warnings: string[];
  errors: string[];
  build: string;
}

export interface CheckItem {
  name: string;
  passed: boolean;
  message?: string;
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ ok: false, error: message }, status);
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export async function hashPayload(payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(payload);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function maskSecret(value: string): string {
  if (!value || value.length < 8) return '***';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

export function safeParseJSON(str: string, fallback: unknown = {}): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function dbGuard(env: Env): { ok: true; db: D1Database } | { ok: false; response: Response } {
  if (!env.AGENT_DB) {
    return {
      ok: false,
      response: jsonResponse(
        { ok: false, warning: 'AGENT_DB not configured. Running without database.' },
        503
      ),
    };
  }
  return { ok: true, db: env.AGENT_DB };
}
