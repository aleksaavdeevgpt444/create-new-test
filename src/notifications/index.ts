// Stage A25 — Notification Center v1
import { Env, generateId, now } from '../types';
import { sendTelegramMessage, sendTelegramApprovalButtons } from '../integrations/index';

export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical';
export type NotificationChannel = 'web' | 'telegram' | 'internal_log';

export async function sendNotification(
  env: Env,
  db: D1Database,
  channel: NotificationChannel,
  body: string,
  subject?: string,
  priority: NotificationPriority = 'normal',
  dedupeKey?: string
): Promise<{ ok: boolean; notificationId?: string; deduplicated?: boolean }> {
  // Dedupe check
  if (dedupeKey) {
    const existing = await db.prepare('SELECT id FROM agent_notification_dedupe_keys WHERE dedupe_key = ? AND expires_at > ?')
      .bind(dedupeKey, now()).first();
    if (existing) return { ok: true, deduplicated: true };
  }

  // Quiet hours check (skip for critical)
  if (priority !== 'critical' && channel === 'telegram') {
    const pref = await db.prepare("SELECT * FROM agent_notification_preferences WHERE user_id = 'owner' AND channel = 'telegram'").first() as Record<string, string> | null;
    if (pref?.is_enabled === '0') return { ok: false, notificationId: undefined };
  }

  const notificationId = generateId();
  await db.prepare('INSERT INTO agent_notifications (id, channel, subject, body, status, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(notificationId, channel, subject ?? null, body, 'pending', priority, now()).run();

  let sent = false;
  if (channel === 'telegram') {
    sent = await sendTelegramMessage(env, body);
  } else if (channel === 'web' || channel === 'internal_log') {
    console.log(`[NOTIFICATION][${priority.toUpperCase()}]`, subject ?? '', body);
    sent = true;
  }

  await db.prepare('UPDATE agent_notifications SET status = ?, sent_at = ? WHERE id = ?')
    .bind(sent ? 'sent' : 'failed', now(), notificationId).run();

  // Store dedupe key
  if (dedupeKey) {
    await db.prepare('INSERT OR REPLACE INTO agent_notification_dedupe_keys (id, dedupe_key, notification_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(generateId(), dedupeKey, notificationId, new Date(Date.now() + 3600000).toISOString(), now()).run();
  }

  // Audit
  await db.prepare('INSERT INTO agent_notification_audit_log (id, notification_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(generateId(), notificationId, 'sent', JSON.stringify({ channel, priority, sent }), now()).run();

  return { ok: true, notificationId };
}

export async function notifyApprovalRequired(env: Env, db: D1Database, actionId: string, actionType: string, proposalText: string) {
  await sendTelegramApprovalButtons(env, `🔔 <b>Approval Required</b>\n\nAction: <code>${actionType}</code>\n\n${proposalText}`, actionId);

  await db.prepare('INSERT INTO agent_notification_events (id, event_type, source_agent, payload, processed, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(generateId(), 'approval_required', 'system', JSON.stringify({ actionId, actionType }), 1, now()).run();
}

export async function getNotifications(db: D1Database, limit = 50) {
  const r = await db.prepare('SELECT * FROM agent_notifications ORDER BY created_at DESC LIMIT ?').bind(limit).all();
  return r.results ?? [];
}
