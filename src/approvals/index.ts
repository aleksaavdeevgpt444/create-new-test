// Stage A5 — Proposal + Approval Center
import { Env, generateId, now, hashPayload } from '../types';
import { logAgentEvent } from '../agents/registry';

export async function getApprovals(db: D1Database, status?: string) {
  if (status) {
    const r = await db.prepare('SELECT * FROM agent_actions WHERE status = ? ORDER BY created_at DESC LIMIT 50').bind(status).all();
    return r.results ?? [];
  }
  const r = await db.prepare("SELECT * FROM agent_actions WHERE status IN ('pending','approved','rejected') ORDER BY created_at DESC LIMIT 50").all();
  return r.results ?? [];
}

export async function approveAction(db: D1Database, actionId: string, approvedBy = 'owner', reason?: string): Promise<{ ok: boolean; error?: string }> {
  const action = await db.prepare('SELECT * FROM agent_actions WHERE id = ?').bind(actionId).first() as Record<string, string> | null;
  if (!action) return { ok: false, error: 'Action not found' };
  if (action.status !== 'pending') return { ok: false, error: `Action status is '${action.status}', cannot approve` };
  if (new Date(action.expires_at) < new Date()) {
    await db.prepare("UPDATE agent_actions SET status = 'expired', updated_at = ? WHERE id = ?").bind(now(), actionId).run();
    return { ok: false, error: 'Action approval has expired' };
  }

  const approvalId = generateId();
  await db.prepare('INSERT INTO agent_approvals (id, action_id, approved_by, decision, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(approvalId, actionId, approvedBy, 'approved', reason ?? null, now()).run();
  await db.prepare("UPDATE agent_actions SET status = 'approved', updated_at = ? WHERE id = ?").bind(now(), actionId).run();

  const agentKey = action.agent_key as string;
  await logAgentEvent(db, agentKey as any, 'info', `Action approved: ${action.action_type}`, { actionId, approvedBy });
  return { ok: true };
}

export async function rejectAction(db: D1Database, actionId: string, rejectedBy = 'owner', reason?: string): Promise<{ ok: boolean; error?: string }> {
  const action = await db.prepare('SELECT * FROM agent_actions WHERE id = ?').bind(actionId).first() as Record<string, string> | null;
  if (!action) return { ok: false, error: 'Action not found' };
  if (action.status !== 'pending') return { ok: false, error: `Action status is '${action.status}', cannot reject` };

  const approvalId = generateId();
  await db.prepare('INSERT INTO agent_approvals (id, action_id, approved_by, decision, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(approvalId, actionId, rejectedBy, 'rejected', reason ?? null, now()).run();
  await db.prepare("UPDATE agent_actions SET status = 'rejected', updated_at = ? WHERE id = ?").bind(now(), actionId).run();

  const agentKey = action.agent_key as string;
  await logAgentEvent(db, agentKey as any, 'info', `Action rejected: ${action.action_type}`, { actionId, rejectedBy, reason });
  return { ok: true };
}

export async function validatePayloadHash(db: D1Database, actionId: string, submittedPayload: string): Promise<boolean> {
  const action = await db.prepare('SELECT payload_hash FROM agent_actions WHERE id = ?').bind(actionId).first() as Record<string, string> | null;
  if (!action) return false;
  const computedHash = await hashPayload(submittedPayload);
  return computedHash === action.payload_hash;
}
