// Stage A26 — Advanced Scheduler v1
import { Env, AgentKey, generateId, now } from '../types';
import { createAgentRequest } from '../agents/core';

export async function createSchedule(
  db: D1Database,
  scheduleKey: string,
  name: string,
  agentKey: AgentKey,
  triggerPayload: unknown,
  scheduleType: 'simple' | 'cron' | 'interval',
  options: { cronExpression?: string; intervalSeconds?: number; timezone?: string }
): Promise<{ id: string }> {
  const id = generateId();
  const nextRunAt = computeNextRun(scheduleType, options);

  await db.prepare(`
    INSERT OR IGNORE INTO agent_schedules (id, schedule_key, name, agent_key, trigger_payload, schedule_type, cron_expression, interval_seconds, timezone, is_enabled, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))
  `).bind(id, scheduleKey, name, agentKey, JSON.stringify(triggerPayload), scheduleType, options.cronExpression ?? null, options.intervalSeconds ?? null, options.timezone ?? 'UTC', nextRunAt).run();

  await db.prepare('INSERT INTO agent_schedule_audit_log (id, schedule_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(generateId(), id, 'created', JSON.stringify({ scheduleKey, name, scheduleType }), now()).run();

  return { id };
}

export async function processDueSchedules(db: D1Database, env: Env): Promise<{ processed: number; errors: string[] }> {
  const currentTime = now();
  const dueSchedules = await db.prepare("SELECT * FROM agent_schedules WHERE is_enabled = 1 AND next_run_at <= ? AND next_run_at IS NOT NULL LIMIT 10")
    .bind(currentTime).all();

  const schedules = dueSchedules.results ?? [];
  const errors: string[] = [];
  let processed = 0;

  for (const schedule of schedules as Array<Record<string, string | number>>) {
    const scheduleId = schedule.id as string;

    // Duplicate guard: check if already running
    const lockExists = await db.prepare('SELECT id FROM agent_schedule_locks WHERE schedule_id = ? AND expires_at > ?').bind(scheduleId, currentTime).first();
    if (lockExists) continue;

    // Acquire lock
    await db.prepare('INSERT OR REPLACE INTO agent_schedule_locks (id, schedule_id, locked_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(generateId(), scheduleId, now(), new Date(Date.now() + 300000).toISOString()).run();

    try {
      const runId = generateId();
      await db.prepare('INSERT INTO agent_schedule_runs (id, schedule_id, status, started_at) VALUES (?, ?, ?, ?)')
        .bind(runId, scheduleId, 'running', now()).run();

      // Create agent request from schedule
      const triggerPayload = JSON.parse(schedule.trigger_payload as string);
      await createAgentRequest(db, schedule.agent_key as AgentKey, 'system', `scheduled:${schedule.schedule_key}`, triggerPayload);

      await db.prepare("UPDATE agent_schedule_runs SET status = 'completed', completed_at = ? WHERE id = ?").bind(now(), runId).run();
      await db.prepare('UPDATE agent_schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
        .bind(now(), computeNextRun(schedule.schedule_type as 'simple' | 'cron' | 'interval', { intervalSeconds: schedule.interval_seconds as number }), now(), scheduleId).run();

      processed++;
    } catch (err) {
      errors.push(`Schedule ${scheduleId}: ${err instanceof Error ? err.message : String(err)}`);
      await db.prepare("UPDATE agent_schedule_runs SET status = 'failed', error = ?, completed_at = ? WHERE schedule_id = ? AND status = 'running'")
        .bind(err instanceof Error ? err.message : String(err), now(), scheduleId).run();
    } finally {
      await db.prepare('DELETE FROM agent_schedule_locks WHERE schedule_id = ?').bind(scheduleId).run();
    }
  }

  return { processed, errors };
}

function computeNextRun(scheduleType: 'simple' | 'cron' | 'interval', options: { cronExpression?: string; intervalSeconds?: number }): string {
  const defaultInterval = 3600; // 1 hour default
  const intervalMs = (options.intervalSeconds ?? defaultInterval) * 1000;
  return new Date(Date.now() + intervalMs).toISOString();
}

export async function getSchedules(db: D1Database) {
  const r = await db.prepare('SELECT * FROM agent_schedules ORDER BY next_run_at ASC').all();
  return r.results ?? [];
}

export async function seedDefaultSchedules(db: D1Database) {
  await createSchedule(db, 'daily_reports', 'Daily Reports Run', 'reports_agent', { trigger: 'daily_report' }, 'interval', { intervalSeconds: 86400 });
  await createSchedule(db, 'daily_business_command', 'Daily Business Command', 'business_operations_ai_chief', { trigger: 'daily_command' }, 'interval', { intervalSeconds: 86400 });
  await createSchedule(db, 'daily_personal_command', 'Daily Personal Command', 'personal_operations_ai_chief', { trigger: 'daily_command' }, 'interval', { intervalSeconds: 86400 });
}
