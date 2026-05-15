// Stage A29 — Production Hardening v1
import { Env, generateId, now } from '../types';

export async function recordHeartbeat(db: D1Database, component: string, status: 'alive' | 'degraded' | 'dead' = 'alive', detail?: string) {
  await db.prepare('INSERT OR REPLACE INTO agent_heartbeats (id, component, status, last_beat_at, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(generateId(), component, status, now(), detail ?? null).run();
}

export async function detectStuckRuns(db: D1Database, thresholdMinutes = 30): Promise<number> {
  const thresholdTime = new Date(Date.now() - thresholdMinutes * 60000).toISOString();

  // Detect stuck agent requests
  const stuckRequests = await db.prepare(`
    SELECT * FROM agent_requests WHERE status IN ('assigned_to_agent', 'in_progress') AND created_at < ?
  `).bind(thresholdTime).all();

  const stuck = stuckRequests.results ?? [];
  for (const run of stuck as Array<Record<string, string>>) {
    const exists = await db.prepare("SELECT id FROM agent_stuck_runs WHERE run_type = 'agent_request' AND run_id = ?").bind(run.id).first();
    if (!exists) {
      await db.prepare('INSERT INTO agent_stuck_runs (id, run_type, run_id, started_at, detected_at, status) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(generateId(), 'agent_request', run.id, run.created_at, now(), 'detected').run();
    }
  }

  return stuck.length;
}

export async function updateCircuitBreaker(db: D1Database, component: string, failed: boolean) {
  const cb = await db.prepare('SELECT * FROM agent_circuit_breakers WHERE component = ?').bind(component).first() as Record<string, string | number> | null;

  if (!cb) {
    await db.prepare('INSERT INTO agent_circuit_breakers (id, component, state, failure_count, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(generateId(), component, failed ? 'closed' : 'closed', failed ? 1 : 0, now()).run();
    return;
  }

  const newFailureCount = failed ? (Number(cb.failure_count) + 1) : 0;
  const threshold = 5;
  let state = cb.state as string;

  if (failed && newFailureCount >= threshold) {
    state = 'open';
    await createIncident(db, 'high', `Circuit breaker opened: ${component}`, `${newFailureCount} consecutive failures detected.`);
  } else if (!failed && state === 'open') {
    state = 'closed';
  }

  await db.prepare('UPDATE agent_circuit_breakers SET state = ?, failure_count = ?, last_failure_at = ?, updated_at = ? WHERE component = ?')
    .bind(state, newFailureCount, failed ? now() : cb.last_failure_at, now(), component).run();
}

export async function sendToDLQ(db: D1Database, originalType: string, originalId: string, payload: unknown, error: string) {
  await db.prepare('INSERT INTO agent_dead_letter_queue (id, original_type, original_id, payload, error, attempts, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(generateId(), originalType, originalId, JSON.stringify(payload), error, 1, 'pending', now()).run();

  await db.prepare('INSERT INTO agent_hardening_audit_log (id, component, event, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(generateId(), originalType, 'dlq_entry', JSON.stringify({ originalId, error }), now()).run();
}

export async function createIncident(db: D1Database, severity: 'low' | 'medium' | 'high' | 'critical', title: string, description: string, components: string[] = []) {
  await db.prepare('INSERT INTO agent_incidents (id, severity, title, description, status, affected_components, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(generateId(), severity, title, description, 'open', JSON.stringify(components), now()).run();
}

export async function getHardeningOverview(db: D1Database) {
  const [heartbeats, circuitBreakers, dlq, stuckRuns, incidents] = await Promise.all([
    db.prepare('SELECT * FROM agent_heartbeats ORDER BY last_beat_at DESC').all(),
    db.prepare('SELECT * FROM agent_circuit_breakers ORDER BY component').all(),
    db.prepare("SELECT COUNT(*) as count FROM agent_dead_letter_queue WHERE status = 'pending'").first(),
    db.prepare("SELECT COUNT(*) as count FROM agent_stuck_runs WHERE status = 'detected'").first(),
    db.prepare("SELECT COUNT(*) as count FROM agent_incidents WHERE status = 'open'").first(),
  ]);

  return {
    heartbeats: heartbeats.results ?? [],
    circuit_breakers: circuitBreakers.results ?? [],
    dlq_pending: (dlq as Record<string, number>)?.count ?? 0,
    stuck_runs: (stuckRuns as Record<string, number>)?.count ?? 0,
    open_incidents: (incidents as Record<string, number>)?.count ?? 0,
  };
}

export async function getRecoveryActions(db: D1Database) {
  const r = await db.prepare('SELECT * FROM agent_recovery_actions ORDER BY created_at DESC LIMIT 50').all();
  return r.results ?? [];
}

export async function seedHardeningPolicies(db: D1Database) {
  const policies = [
    { policy_key: 'default', timeout_ms: 30000, max_retries: 3, rate_limit_rpm: 60, circuit_breaker_threshold: 5 },
    { policy_key: 'ai_provider', timeout_ms: 60000, max_retries: 2, rate_limit_rpm: 30, circuit_breaker_threshold: 3 },
    { policy_key: 'telegram', timeout_ms: 10000, max_retries: 3, rate_limit_rpm: 30, circuit_breaker_threshold: 5 },
    { policy_key: 'wb_api', timeout_ms: 15000, max_retries: 2, rate_limit_rpm: 20, circuit_breaker_threshold: 3 },
  ];

  for (const p of policies) {
    await db.prepare(`
      INSERT OR IGNORE INTO agent_hardening_policies (id, policy_key, timeout_ms, max_retries, rate_limit_rpm, circuit_breaker_threshold, is_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `).bind(generateId(), p.policy_key, p.timeout_ms, p.max_retries, p.rate_limit_rpm, p.circuit_breaker_threshold).run();
  }
}
