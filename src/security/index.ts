// Stage A28 — Security / Roles / Audit v1
import { Env, generateId, now } from '../types';

export type UserRole = 'owner' | 'admin' | 'operator' | 'viewer' | 'system';

const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  owner: ['*'],
  admin: ['agents:read', 'agents:write', 'approvals:read', 'approvals:write', 'tools:read', 'knowledge:read', 'knowledge:write', 'analytics:read', 'security:read'],
  operator: ['agents:read', 'approvals:read', 'approvals:write', 'tools:read', 'knowledge:read'],
  viewer: ['agents:read', 'approvals:read', 'tools:read', 'knowledge:read', 'analytics:read'],
  system: ['agents:read', 'agents:write', 'knowledge:read', 'knowledge:write', 'tools:read'],
};

// Agents cannot approve, grant permissions, or access secrets
const AGENT_FORBIDDEN_ACTIONS = ['approval:approve', 'approval:grant', 'security:grant', 'secret:read', 'security:modify'];

export function checkRolePermission(role: UserRole, permission: string): boolean {
  const perms = ROLE_PERMISSIONS[role] ?? [];
  return perms.includes('*') || perms.includes(permission);
}

export function checkAgentAccess(action: string): { allowed: boolean; reason: string } {
  if (AGENT_FORBIDDEN_ACTIONS.includes(action)) {
    return { allowed: false, reason: `Agents cannot perform action '${action}'` };
  }
  return { allowed: true, reason: 'Allowed' };
}

export async function auditLog(db: D1Database, event: string, options: {
  userId?: string;
  agentKey?: string;
  resource?: string;
  action?: string;
  result?: string;
}) {
  await db.prepare('INSERT INTO agent_security_audit_log (id, user_id, agent_key, event, resource, action, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(generateId(), options.userId ?? null, options.agentKey ?? null, event, options.resource ?? null, options.action ?? null, options.result ?? null, now()).run();
}

export async function createSecurityAlert(db: D1Database, alertType: string, description: string, severity: 'low' | 'medium' | 'high' | 'critical' = 'medium', userId?: string) {
  await db.prepare('INSERT INTO agent_security_alerts (id, severity, alert_type, description, user_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(generateId(), severity, alertType, description, userId ?? null, 'open', now()).run();
}

export async function checkAccess(db: D1Database, userId: string, resource: string, action: string): Promise<{ allowed: boolean; reason: string }> {
  const userRole = await db.prepare(`
    SELECT r.role_name FROM agent_user_roles ur
    JOIN agent_roles r ON ur.role_name = r.role_name
    WHERE ur.user_id = ?
    ORDER BY CASE r.role_name WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'operator' THEN 3 ELSE 4 END
    LIMIT 1
  `).bind(userId).first() as Record<string, string> | null;

  const role = (userRole?.role_name ?? 'viewer') as UserRole;
  const permission = `${resource}:${action}`;
  const allowed = checkRolePermission(role, permission);

  // Log the check
  await db.prepare('INSERT INTO agent_security_checks (id, check_name, user_id, resource, action, result, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(generateId(), 'access_check', userId, resource, action, allowed ? 'allowed' : 'denied', `Role: ${role}`, now()).run();

  if (!allowed) {
    await auditLog(db, 'access_denied', { userId, resource, action: permission, result: 'denied' });
  }

  return { allowed, reason: `Role '${role}' ${allowed ? 'has' : 'does not have'} permission '${permission}'` };
}

export async function getSecurityOverview(db: D1Database) {
  const [alerts, recentChecks, users, roles] = await Promise.all([
    db.prepare("SELECT * FROM agent_security_alerts WHERE status = 'open' ORDER BY created_at DESC LIMIT 10").all(),
    db.prepare('SELECT * FROM agent_security_checks ORDER BY created_at DESC LIMIT 10').all(),
    db.prepare('SELECT * FROM agent_users WHERE is_active = 1 ORDER BY created_at').all(),
    db.prepare('SELECT * FROM agent_roles ORDER BY role_name').all(),
  ]);

  return {
    open_alerts: alerts.results?.length ?? 0,
    alerts: alerts.results ?? [],
    recent_checks: recentChecks.results ?? [],
    users: users.results ?? [],
    roles: roles.results ?? [],
  };
}

export async function seedOwnerUser(db: D1Database) {
  const userId = 'user-owner-001';
  await db.prepare("INSERT OR IGNORE INTO agent_users (id, username, display_name, is_owner, is_active, created_at, updated_at) VALUES (?, 'owner', 'System Owner', 1, 1, datetime('now'), datetime('now'))")
    .bind(userId).run();
  await db.prepare("INSERT OR IGNORE INTO agent_user_roles (id, user_id, role_name, granted_by, created_at) VALUES (?, ?, 'owner', 'system', datetime('now'))")
    .bind(generateId(), userId).run();
}
