// Stage A18 — Tool Registry + Permissions
import { Env, AgentKey, generateId, now } from '../types';

export const TOOL_DEFINITIONS = [
  // Safe read tools
  { tool_key: 'telegram_send_message_to_owner', name: 'Telegram: Send Message to Owner', category: 'telegram', risk_level: 'low', is_enabled: 1, is_dangerous: 0, requires_approval: 0, is_mock: 0 },
  { tool_key: 'telegram_send_approval_buttons', name: 'Telegram: Send Approval Buttons', category: 'telegram', risk_level: 'low', is_enabled: 1, is_dangerous: 0, requires_approval: 0, is_mock: 0 },
  { tool_key: 'planner_read_tasks', name: 'Planner: Read Tasks', category: 'planner', risk_level: 'low', is_enabled: 1, is_dangerous: 0, requires_approval: 0, is_mock: 0 },
  { tool_key: 'planner_get_day', name: 'Planner: Get Day', category: 'planner', risk_level: 'low', is_enabled: 1, is_dangerous: 0, requires_approval: 0, is_mock: 0 },
  { tool_key: 'planner_get_week', name: 'Planner: Get Week', category: 'planner', risk_level: 'low', is_enabled: 1, is_dangerous: 0, requires_approval: 0, is_mock: 0 },
  { tool_key: 'planner_create_task_after_approval', name: 'Planner: Create Task (after approval)', category: 'planner', risk_level: 'medium', is_enabled: 1, is_dangerous: 0, requires_approval: 1, is_mock: 0 },
  { tool_key: 'planner_reschedule_after_approval', name: 'Planner: Reschedule (after approval)', category: 'planner', risk_level: 'medium', is_enabled: 1, is_dangerous: 0, requires_approval: 1, is_mock: 0 },
  { tool_key: 'hub_read_records', name: 'Hub: Read Records', category: 'hub', risk_level: 'low', is_enabled: 1, is_dangerous: 0, requires_approval: 0, is_mock: 0 },
  { tool_key: 'hub_create_idea_or_insight', name: 'Hub: Create Idea/Insight', category: 'hub', risk_level: 'low', is_enabled: 1, is_dangerous: 0, requires_approval: 0, is_mock: 0 },
  { tool_key: 'knowledge_retrieve', name: 'Knowledge: Retrieve', category: 'knowledge', risk_level: 'low', is_enabled: 1, is_dangerous: 0, requires_approval: 0, is_mock: 0 },
  { tool_key: 'qa_run', name: 'QA: Run Checks', category: 'qa', risk_level: 'low', is_enabled: 1, is_dangerous: 0, requires_approval: 0, is_mock: 0 },
  { tool_key: 'system_health_check', name: 'System: Health Check', category: 'system', risk_level: 'low', is_enabled: 1, is_dangerous: 0, requires_approval: 0, is_mock: 0 },
  { tool_key: 'project_builder_artifact_generation', name: 'Project Builder: Artifact Generation', category: 'builder', risk_level: 'low', is_enabled: 1, is_dangerous: 0, requires_approval: 0, is_mock: 0 },
  // Mock/proposal-only tools
  { tool_key: 'wb_ads_update_budget', name: 'WB Ads: Update Budget (mock)', category: 'wb_ads', risk_level: 'high', is_enabled: 1, is_dangerous: 0, requires_approval: 1, is_mock: 1 },
  { tool_key: 'wb_ads_pause_campaign', name: 'WB Ads: Pause Campaign (mock)', category: 'wb_ads', risk_level: 'high', is_enabled: 1, is_dangerous: 0, requires_approval: 1, is_mock: 1 },
  { tool_key: 'supplier_message_send', name: 'Supplier: Send Message (mock)', category: 'supplier', risk_level: 'high', is_enabled: 1, is_dangerous: 0, requires_approval: 1, is_mock: 1 },
  { tool_key: 'fulfillment_message_send', name: 'Fulfillment: Send Message (mock)', category: 'fulfillment', risk_level: 'high', is_enabled: 1, is_dangerous: 0, requires_approval: 1, is_mock: 1 },
  { tool_key: 'google_sheets_write_range', name: 'Google Sheets: Write Range (mock)', category: 'google', risk_level: 'medium', is_enabled: 1, is_dangerous: 0, requires_approval: 1, is_mock: 1 },
  { tool_key: 'drive_write_file', name: 'Drive: Write File (mock)', category: 'google', risk_level: 'medium', is_enabled: 1, is_dangerous: 0, requires_approval: 1, is_mock: 1 },
  { tool_key: 'gmail_send_email', name: 'Gmail: Send Email (mock)', category: 'google', risk_level: 'high', is_enabled: 1, is_dangerous: 0, requires_approval: 1, is_mock: 1 },
  { tool_key: 'cloudflare_worker_deploy', name: 'Cloudflare: Worker Deploy (mock)', category: 'cloudflare', risk_level: 'critical', is_enabled: 1, is_dangerous: 0, requires_approval: 1, is_mock: 1 },
  // Disabled / dangerous tools
  { tool_key: 'payment_create', name: 'Payment: Create', category: 'finance', risk_level: 'dangerous', is_enabled: 0, is_dangerous: 1, requires_approval: 1, is_mock: 0 },
  { tool_key: 'payment_confirm', name: 'Payment: Confirm', category: 'finance', risk_level: 'dangerous', is_enabled: 0, is_dangerous: 1, requires_approval: 1, is_mock: 0 },
  { tool_key: 'purchase_confirm', name: 'Purchase: Confirm', category: 'procurement', risk_level: 'dangerous', is_enabled: 0, is_dangerous: 1, requires_approval: 1, is_mock: 0 },
  { tool_key: 'wb_ads_mass_update', name: 'WB Ads: Mass Update', category: 'wb_ads', risk_level: 'dangerous', is_enabled: 0, is_dangerous: 1, requires_approval: 1, is_mock: 0 },
  { tool_key: 'wb_campaign_delete', name: 'WB Campaign: Delete', category: 'wb_ads', risk_level: 'dangerous', is_enabled: 0, is_dangerous: 1, requires_approval: 1, is_mock: 0 },
  { tool_key: 'delete_task', name: 'Task: Delete', category: 'planner', risk_level: 'dangerous', is_enabled: 0, is_dangerous: 1, requires_approval: 1, is_mock: 0 },
  { tool_key: 'delete_record', name: 'Record: Delete', category: 'system', risk_level: 'dangerous', is_enabled: 0, is_dangerous: 1, requires_approval: 1, is_mock: 0 },
  { tool_key: 'bulk_task_reschedule', name: 'Tasks: Bulk Reschedule', category: 'planner', risk_level: 'dangerous', is_enabled: 0, is_dangerous: 1, requires_approval: 1, is_mock: 0 },
  { tool_key: 'project_delete', name: 'Project: Delete', category: 'builder', risk_level: 'dangerous', is_enabled: 0, is_dangerous: 1, requires_approval: 1, is_mock: 0 },
  { tool_key: 'supplier_order_confirm', name: 'Supplier Order: Confirm', category: 'procurement', risk_level: 'dangerous', is_enabled: 0, is_dangerous: 1, requires_approval: 1, is_mock: 0 },
  { tool_key: 'production_deploy_by_agent', name: 'Production: Deploy by Agent', category: 'cloudflare', risk_level: 'dangerous', is_enabled: 0, is_dangerous: 1, requires_approval: 1, is_mock: 0 },
];

export async function seedTools(db: D1Database) {
  for (const tool of TOOL_DEFINITIONS) {
    await db.prepare(`
      INSERT OR IGNORE INTO agent_tool_registry (id, tool_key, name, category, risk_level, is_enabled, is_dangerous, requires_approval, is_mock, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).bind(generateId(), tool.tool_key, tool.name, tool.category, tool.risk_level, tool.is_enabled, tool.is_dangerous, tool.requires_approval, tool.is_mock).run();
  }
}

export async function checkToolPermission(
  db: D1Database,
  toolKey: string,
  agentKey: string
): Promise<{ allowed: boolean; reason: string; is_mock?: boolean }> {
  const tool = await db.prepare('SELECT * FROM agent_tool_registry WHERE tool_key = ?').bind(toolKey).first() as Record<string, number | string> | null;

  if (!tool) return { allowed: false, reason: 'Unknown tool — blocked by Tool Registry' };
  if (!tool.is_enabled) return { allowed: false, reason: `Tool '${toolKey}' is disabled in MVP Safe Policy` };
  if (tool.is_dangerous) return { allowed: false, reason: `Tool '${toolKey}' is a dangerous tool — blocked in MVP` };

  // Log the permission check
  await db.prepare('INSERT INTO agent_tool_guardrail_results (id, tool_key, agent_key, check_name, passed, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(generateId(), toolKey, agentKey, 'permission_check', 1, 'Allowed', now()).run();

  return {
    allowed: true,
    reason: tool.requires_approval ? 'Tool requires approval before execution' : 'Tool allowed',
    is_mock: Boolean(tool.is_mock),
  };
}

export async function logToolCall(db: D1Database, toolKey: string, agentKey: string, requestId: string | null, input: unknown, output: unknown, status: string, durationMs: number) {
  await db.prepare(
    'INSERT INTO agent_tool_calls (id, tool_key, agent_key, request_id, input, output, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(generateId(), toolKey, agentKey, requestId, JSON.stringify(input), JSON.stringify(output), status, durationMs, now()).run();
}

export async function getTools(db: D1Database) {
  const r = await db.prepare('SELECT * FROM agent_tool_registry ORDER BY category, tool_key').all();
  return r.results ?? [];
}
