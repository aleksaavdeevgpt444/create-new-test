// Stage A20 — Action Executor v1 (safe, approval-gated)
import { Env, generateId, now, hashPayload } from '../types';

const MOCK_ONLY_ACTIONS = [
  'wb_ads_update_budget', 'wb_ads_pause_campaign', 'supplier_message_send',
  'fulfillment_message_send', 'google_sheets_write_range', 'drive_write_file',
  'gmail_send_email', 'cloudflare_worker_deploy',
];

const DISABLED_ACTIONS = [
  'payment_create', 'payment_confirm', 'purchase_confirm', 'wb_ads_mass_update',
  'wb_campaign_delete', 'delete_task', 'delete_record', 'bulk_task_reschedule',
  'project_delete', 'supplier_order_confirm', 'production_deploy_by_agent',
];

export async function executeApprovedAction(
  db: D1Database,
  actionId: string,
  idempotencyKey?: string
): Promise<{ ok: boolean; executionId?: string; result?: unknown; error?: string }> {
  // Check idempotency
  if (idempotencyKey) {
    const existing = await db.prepare('SELECT * FROM agent_action_idempotency_keys WHERE idempotency_key = ?').bind(idempotencyKey).first();
    if (existing) return { ok: false, error: 'Duplicate action — already executed (idempotency check)' };
  }

  // Load and validate action
  const action = await db.prepare('SELECT * FROM agent_actions WHERE id = ?').bind(actionId).first() as Record<string, string> | null;
  if (!action) return { ok: false, error: 'Action not found' };
  if (action.status !== 'approved') return { ok: false, error: `Action status is '${action.status}' — only approved actions can be executed` };
  if (DISABLED_ACTIONS.includes(action.action_type)) return { ok: false, error: `Action '${action.action_type}' is disabled in MVP` };
  if (new Date(action.expires_at) < new Date()) return { ok: false, error: 'Action has expired' };

  // Verify approval exists
  const approval = await db.prepare("SELECT * FROM agent_approvals WHERE action_id = ? AND decision = 'approved'").bind(actionId).first();
  if (!approval) return { ok: false, error: 'No valid approval found for this action' };

  const executionId = generateId();

  // Acquire lock
  const lockKey = `action:${actionId}`;
  const lockExists = await db.prepare('SELECT id FROM agent_action_locks WHERE lock_key = ? AND expires_at > ?').bind(lockKey, now()).first();
  if (lockExists) return { ok: false, error: 'Action is currently being executed (lock held)' };

  await db.prepare('INSERT OR REPLACE INTO agent_action_locks (id, lock_key, action_id, locked_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(generateId(), lockKey, actionId, now(), new Date(Date.now() + 60000).toISOString()).run();

  // Start execution record
  await db.prepare('INSERT INTO agent_action_executions (id, action_id, approval_id, status, started_at) VALUES (?, ?, ?, ?, ?)')
    .bind(executionId, actionId, (approval as Record<string, string>).id, 'running', now()).run();

  // Store idempotency key
  if (idempotencyKey) {
    await db.prepare('INSERT INTO agent_action_idempotency_keys (id, idempotency_key, action_id, execution_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(generateId(), idempotencyKey, actionId, executionId, now()).run();
  }

  try {
    let result: unknown;
    const isMock = MOCK_ONLY_ACTIONS.includes(action.action_type);

    if (isMock) {
      // Mock execution — never touches real systems
      result = {
        mock: true,
        action_type: action.action_type,
        message: `[MOCK] Action '${action.action_type}' would have been executed`,
        payload_preview: action.payload,
      };
    } else {
      // Safe actions that can be executed
      result = await executeSafeAction(action.action_type, JSON.parse(action.payload));
    }

    await db.prepare("UPDATE agent_action_executions SET status = 'completed', result = ?, completed_at = ? WHERE id = ?")
      .bind(JSON.stringify(result), now(), executionId).run();
    await db.prepare("UPDATE agent_actions SET status = 'executed', updated_at = ? WHERE id = ?").bind(now(), actionId).run();

    // Save result
    await db.prepare('INSERT INTO agent_action_results (id, action_id, execution_id, result_type, result, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(generateId(), actionId, executionId, isMock ? 'mock' : 'real', JSON.stringify(result), `Executed: ${action.action_type}`, now()).run();

    // Audit
    await db.prepare('INSERT INTO agent_action_executor_audit_log (id, action_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(generateId(), actionId, 'executed', JSON.stringify({ executionId, isMock }), now()).run();

    return { ok: true, executionId, result };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.prepare("UPDATE agent_action_executions SET status = 'failed', error = ?, completed_at = ? WHERE id = ?")
      .bind(errMsg, now(), executionId).run();
    await db.prepare("UPDATE agent_actions SET status = 'failed', updated_at = ? WHERE id = ?").bind(now(), actionId).run();
    return { ok: false, error: errMsg };
  } finally {
    await db.prepare('DELETE FROM agent_action_locks WHERE lock_key = ?').bind(lockKey).run();
  }
}

async function executeSafeAction(actionType: string, payload: unknown): Promise<unknown> {
  // Only truly safe actions are executed here
  // All others are mock-only or disabled
  switch (actionType) {
    case 'log_event':
      return { logged: true, payload };
    case 'knowledge_write':
      return { stored: true, payload };
    default:
      return { executed: true, action_type: actionType, note: 'Safe no-op execution' };
  }
}

export async function dryRunAction(db: D1Database, actionId: string): Promise<{ ok: boolean; preview?: unknown; error?: string }> {
  const action = await db.prepare('SELECT * FROM agent_actions WHERE id = ?').bind(actionId).first() as Record<string, string> | null;
  if (!action) return { ok: false, error: 'Action not found' };

  const isMock = MOCK_ONLY_ACTIONS.includes(action.action_type);
  const isDisabled = DISABLED_ACTIONS.includes(action.action_type);

  return {
    ok: true,
    preview: {
      action_id: actionId,
      action_type: action.action_type,
      is_mock: isMock,
      is_disabled: isDisabled,
      risk_level: action.risk_level,
      status: action.status,
      would_execute: !isDisabled && action.status === 'approved',
    },
  };
}

export async function getExecutions(db: D1Database) {
  const r = await db.prepare(`
    SELECT ae.*, aa.action_type, aa.agent_key, aa.risk_level
    FROM agent_action_executions ae
    JOIN agent_actions aa ON ae.action_id = aa.id
    ORDER BY ae.started_at DESC LIMIT 50
  `).all();
  return r.results ?? [];
}
