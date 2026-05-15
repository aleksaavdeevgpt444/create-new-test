// Stage A22 — Agent Memory / Knowledge Base v1
import { Env, AgentKey, generateId, now } from '../types';

export async function retrieveKnowledge(
  db: D1Database,
  agentKey?: string,
  projectKey?: string,
  category?: string,
  query?: string
): Promise<unknown[]> {
  let sql = "SELECT * FROM agent_knowledge_items WHERE status = 'active'";
  const params: string[] = [];

  if (agentKey) { sql += ' AND (agent_key = ? OR scope = \'global\')'; params.push(agentKey); }
  if (projectKey) { sql += ' AND (project_key = ? OR project_key IS NULL)'; params.push(projectKey); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY updated_at DESC LIMIT 20';

  const r = await db.prepare(sql).bind(...params).all();
  const items = r.results ?? [];

  // Log retrieval
  if (agentKey) {
    await db.prepare('INSERT INTO agent_knowledge_retrievals (id, agent_key, query, item_ids, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(generateId(), agentKey, query ?? null, JSON.stringify(items.map((i: Record<string, unknown>) => i.id)), now()).run();
  }

  return items;
}

export async function createKnowledgeItem(
  db: D1Database,
  agentKey: string | undefined,
  category: string,
  title: string,
  content: string,
  scope: 'local' | 'global' = 'local',
  projectKey?: string,
  tags: string[] = []
): Promise<{ id: string; requires_approval: boolean }> {
  // Global or guardrail/roadmap changes require approval
  const requiresApproval = scope === 'global' || category === 'guardrail' || category === 'roadmap';

  if (requiresApproval) {
    const reqId = generateId();
    await db.prepare('INSERT INTO agent_knowledge_write_requests (id, agent_key, category, title, content, scope, requires_approval, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(reqId, agentKey ?? 'system', category, title, content, scope, 1, 'pending', now()).run();
    return { id: reqId, requires_approval: true };
  }

  const id = generateId();
  await db.prepare('INSERT INTO agent_knowledge_items (id, agent_key, project_key, category, title, content, status, scope, tags, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, agentKey ?? null, projectKey ?? null, category, title, content, 'active', scope, JSON.stringify(tags), 1, now(), now()).run();

  // Audit
  await db.prepare('INSERT INTO agent_knowledge_audit_log (id, item_id, agent_key, event, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(generateId(), id, agentKey ?? 'system', 'created', JSON.stringify({ category, title, scope }), now()).run();

  return { id, requires_approval: false };
}

export async function getKnowledgeItems(db: D1Database, filter?: { category?: string; status?: string; scope?: string }) {
  let sql = 'SELECT * FROM agent_knowledge_items WHERE 1=1';
  const params: string[] = [];

  if (filter?.category) { sql += ' AND category = ?'; params.push(filter.category); }
  if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }
  else { sql += " AND status != 'deprecated'"; }
  if (filter?.scope) { sql += ' AND scope = ?'; params.push(filter.scope); }

  sql += ' ORDER BY updated_at DESC LIMIT 100';
  const r = await db.prepare(sql).bind(...params).all();
  return r.results ?? [];
}
