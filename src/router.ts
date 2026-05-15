// Main router — all API + UI routes for the AI Agents System
import { Env, jsonResponse, htmlResponse, errorResponse, dbGuard, generateId, now, safeParseJSON } from './types';
import { SCHEMA_SQL, SEED_AGENTS_SQL } from './db/schema';
import { getAgents, getAgent, updateAgent, logAgentEvent } from './agents/registry';
import { createAgentRequest, createHandoff } from './agents/core';
import { coordinatorRoute } from './agents/coordinator';
import { businessDailyCommand } from './agents/business-chief';
import { personalDailyCommand } from './agents/personal-chief';
import { handleAssistantIntake } from './agents/personal-assistant';
import { runDailyReport } from './agents/reports';
import { runFinanceAnalysis } from './agents/finance';
import { runAdsAnalysis, createAdsRecommendation } from './agents/ads';
import { calculateFulfillment } from './agents/fulfillment';
import { calculateProcurement } from './agents/procurement';
import { researchNewProducts } from './agents/new-products';
import { createRoadmap, reviewProjectProgress } from './agents/personal-pm';
import { runProjectBuild, getBuildRuns, getBuildArtifacts } from './agents/project-builder';
import { getApprovals, approveAction, rejectAction } from './approvals/index';
import { getTools, checkToolPermission, seedTools } from './tools/registry';
import { getIntegrations, checkIntegrationHealth, seedIntegrations } from './integrations/index';
import { executeApprovedAction, dryRunAction, getExecutions } from './actions/executor';
import { retrieveKnowledge, createKnowledgeItem, getKnowledgeItems } from './knowledge/index';
import { runQA, mvpAcceptanceCheck } from './qa/index';
import { sendNotification, notifyApprovalRequired, getNotifications } from './notifications/index';
import { createSchedule, processDueSchedules, getSchedules, seedDefaultSchedules } from './scheduler/index';
import { runDailyAnalytics, getAnalyticsSummary } from './analytics/index';
import { checkAccess, getSecurityOverview, auditLog, seedOwnerUser } from './security/index';
import { getHardeningOverview, getRecoveryActions, recordHeartbeat, detectStuckRuns, updateCircuitBreaker, seedHardeningPolicies } from './hardening/index';
import { renderDashboard, renderSimplePage, renderAgentsPage } from './dashboard/index';
import { runDevCheck } from './dev-checks/index';

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Resolve DB (may be null — all handlers must handle gracefully)
  const db = env.AGENT_DB ?? null;

  try {
    // ============================================================
    // ROOT + HEALTH
    // ============================================================
    if (path === '/' && method === 'GET') {
      return htmlResponse(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>AI Agents System</title>
<style>body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px}
a{color:#60a5fa}h1{font-size:32px}</style></head>
<body><h1>⚡ AI Agents System</h1><p>MVP — Cloudflare Worker</p>
<a href="/agents/dashboard">→ Open Dashboard</a>
<a href="/health">→ Health Check</a>
<a href="/dev/system-check">→ System Check</a></body></html>`);
    }

    if (path === '/health') {
      return jsonResponse({
        ok: true,
        status: 'healthy',
        environment: env.ENVIRONMENT ?? 'unknown',
        db_connected: !!db,
        telegram: !!env.TELEGRAM_BOT_TOKEN,
        ai_provider: !!env.OPENAI_API_KEY,
        wb_api: !!env.WB_API_TOKEN,
        timestamp: now(),
      });
    }

    // ============================================================
    // SCHEMA INIT (dev utility)
    // ============================================================
    if (path === '/dev/ensure-schema' && method === 'POST' || path === '/dev/ensure-schema' && method === 'GET') {
      if (!db) return jsonResponse({ ok: false, warning: 'AGENT_DB not configured' }, 503);

      const statements = SCHEMA_SQL.split(';').map(s => s.trim()).filter(s => s.length > 0);
      let applied = 0;
      const errors: string[] = [];

      for (const stmt of statements) {
        try {
          await db.prepare(stmt).run();
          applied++;
        } catch (err) {
          errors.push(`${stmt.slice(0, 60)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Seed base data
      const seedStatements = SEED_AGENTS_SQL.split(';').map(s => s.trim()).filter(s => s.length > 0);
      for (const stmt of seedStatements) {
        try { await db.prepare(stmt).run(); } catch { /* ignore seed conflicts */ }
      }

      await seedTools(db);
      await seedIntegrations(db);
      await seedOwnerUser(db);
      await seedHardeningPolicies(db);
      await seedDefaultSchedules(db);

      return jsonResponse({ ok: errors.length === 0, applied, errors, message: 'Schema initialized and base data seeded' });
    }

    // ============================================================
    // DEV-CHECK ENDPOINTS
    // ============================================================
    if (path.startsWith('/dev/') && path !== '/dev/ensure-schema') {
      const checkName = path.replace('/dev/', '').replace('-check', '').replace(/-check$/, '');
      const normalizedName = path.replace('/dev/', '');

      // Schema check
      if (normalizedName === 'schema-check') {
        if (!db) return jsonResponse({ ok: false, warning: 'AGENT_DB not configured' }, 503);
        const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
        return jsonResponse({ ok: true, tables: (tables.results ?? []).map((r: Record<string, unknown>) => r.name), count: tables.results?.length ?? 0 });
      }

      const result = await runDevCheck(normalizedName, db, env);
      return jsonResponse(result, result.ok ? 200 : 500);
    }

    // ============================================================
    // TELEGRAM WEBHOOK
    // ============================================================
    if (path === '/telegram/webhook' && method === 'POST') {
      if (!db) return jsonResponse({ ok: true, warning: 'No DB — webhook received but not processed' });

      let body: Record<string, unknown> = {};
      try { body = await request.json() as Record<string, unknown>; } catch { /* ignore */ }

      const message = body.message as Record<string, unknown> | undefined;
      const callbackQuery = body.callback_query as Record<string, unknown> | undefined;

      if (callbackQuery) {
        // Handle approval callbacks from Telegram buttons
        const data = callbackQuery.data as string ?? '';
        const [action, actionId] = data.split(':');

        if (action === 'approve' && actionId) {
          const result = await approveAction(db, actionId, 'telegram_owner');
          return jsonResponse({ ok: result.ok });
        } else if (action === 'reject' && actionId) {
          const result = await rejectAction(db, actionId, 'telegram_owner');
          return jsonResponse({ ok: result.ok });
        }
      }

      if (message) {
        const text = (message.text as string) ?? '';
        if (text) {
          await handleAssistantIntake(db, env, text, 'telegram');
        }
      }

      return jsonResponse({ ok: true });
    }

    // ============================================================
    // AGENT COORDINATOR
    // ============================================================
    if (path === '/agents/coordinator/route' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'AGENT_DB not configured' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const input = (body.input as string) ?? '';
      if (!input) return errorResponse('input is required', 400);
      const result = await coordinatorRoute(db, env, input, body.context ?? {});
      return jsonResponse({ ok: true, ...result });
    }

    // ============================================================
    // AGENT RUNS API
    // ============================================================
    if (path === '/agents/run' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'AGENT_DB not configured' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const { agent_key, trigger, payload, context } = body;
      if (!agent_key || !trigger) return errorResponse('agent_key and trigger are required', 400);
      const requestId = await createAgentRequest(db, agent_key as any, 'system', trigger as string, payload ?? {}, context ?? {});
      return jsonResponse({ ok: true, request_id: requestId });
    }

    if (path === '/agents/runs' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, runs: [], warning: 'No DB' });
      const r = await db.prepare('SELECT * FROM agent_requests ORDER BY created_at DESC LIMIT 50').all();
      return jsonResponse({ ok: true, runs: r.results ?? [] });
    }

    if (path.match(/^\/agents\/runs\/[^/]+$/) && method === 'GET') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const id = path.split('/').pop()!;
      const req = await db.prepare('SELECT * FROM agent_requests WHERE id = ?').bind(id).first();
      const resp = await db.prepare('SELECT * FROM agent_responses WHERE request_id = ?').bind(id).all();
      return jsonResponse({ ok: true, request: req, responses: resp.results ?? [] });
    }

    // ============================================================
    // AGENT-SPECIFIC ENDPOINTS
    // ============================================================
    if (path === '/agents/assistant/intake' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await handleAssistantIntake(db, env, (body.message as string) ?? '', (body.source as string) ?? 'api');
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/business/daily-command' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await businessDailyCommand(db, env, body.context ?? {});
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/personal-ops/daily-command' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await personalDailyCommand(db, env, body.context ?? {});
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/reports/run' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await runDailyReport(db, env, body.context ?? {});
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/finance/analyze' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await runFinanceAnalysis(db, env, body.context ?? {});
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/ads/analyze' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await runAdsAnalysis(db, env, body.context ?? {});
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/ads/recommend' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await createAdsRecommendation(db, env, body);
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/fulfillment/calculate' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await calculateFulfillment(db, env, body.context ?? {});
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/fulfillment/create-proposal' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const result = await calculateFulfillment(db, env);
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/procurement/calculate' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await calculateProcurement(db, env, body.context ?? {});
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/procurement/proposal' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const result = await calculateProcurement(db, env);
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/new-products/research' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await researchNewProducts(db, env, body.context ?? {});
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/new-products/proposal' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const result = await researchNewProducts(db, env);
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/personal-pm/create-roadmap' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await createRoadmap(db, env, (body.project_name as string) ?? 'Unnamed Project', (body.description as string) ?? '');
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/personal-pm/review' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await reviewProjectProgress(db, env, body.project_key as string);
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/project-builder/run' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await runProjectBuild(db, env, (body.project_name as string) ?? 'Unnamed Project', body.passport ?? {}, body.roadmap ?? {});
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/project-builder/execute-next-stage' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      return jsonResponse({ ok: true, message: 'Stage execution — TODO: implement per-stage executor', note: 'Run /agents/project-builder/run with full roadmap for now' });
    }

    if (path.match(/^\/agents\/project-builder\/runs\/[^/]+\/artifacts$/) && method === 'GET') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const runId = path.split('/')[4];
      const artifacts = await getBuildArtifacts(db, runId);
      return jsonResponse({ ok: true, artifacts });
    }

    // ============================================================
    // HANDOFFS
    // ============================================================
    if (path === '/agents/handoffs/create' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const { from_agent, to_agent, reason, payload, expected_output } = body;
      if (!from_agent || !to_agent || !reason) return errorResponse('from_agent, to_agent, reason required', 400);
      const id = await createHandoff(db, from_agent as any, to_agent as any, reason as string, payload ?? {}, (expected_output as string) ?? '');
      return jsonResponse({ ok: true, handoff_id: id });
    }

    // ============================================================
    // AGENTS ADMIN
    // ============================================================
    if (path === '/agents' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, agents: [], warning: 'No DB' });
      const agents = await getAgents(db);
      return jsonResponse({ ok: true, agents });
    }

    if (path.match(/^\/agents\/[^/]+$/) && method === 'GET' && !path.startsWith('/agents/runs') && !path.startsWith('/agents/approvals') && !path.startsWith('/agents/actions') && !path.startsWith('/agents/tools') && !path.startsWith('/agents/knowledge') && !path.startsWith('/agents/notifications') && !path.startsWith('/agents/schedules') && !path.startsWith('/agents/analytics') && !path.startsWith('/agents/security') && !path.startsWith('/agents/integrations') && !path.startsWith('/agents/hardening') && !path.startsWith('/agents/deployments') && !path.startsWith('/agents/qa') && !path.startsWith('/agents/coordinator') && !path.startsWith('/agents/assistant') && !path.startsWith('/agents/reports') && !path.startsWith('/agents/finance') && !path.startsWith('/agents/business') && !path.startsWith('/agents/personal') && !path.startsWith('/agents/ads') && !path.startsWith('/agents/fulfillment') && !path.startsWith('/agents/procurement') && !path.startsWith('/agents/new-products') && !path.startsWith('/agents/project-builder') && !path.startsWith('/agents/dashboard') && !path.startsWith('/agents/control') && !path.startsWith('/agents/recovery') && !path.startsWith('/agents/settings')) {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const agentKey = path.split('/').pop()!;
      const agent = await getAgent(db, agentKey);
      if (!agent) return errorResponse('Agent not found', 404);
      return jsonResponse({ ok: true, agent });
    }

    if (path.match(/^\/agents\/[^/]+\/update$/) && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const agentKey = path.split('/')[2];
      const body = await request.json() as Record<string, string>;
      await updateAgent(db, agentKey, body);
      await logAgentEvent(db, agentKey as any, 'audit', `Agent settings updated by ${body.updated_by ?? 'api'}`, { updates: Object.keys(body) });
      return jsonResponse({ ok: true, agent_key: agentKey });
    }

    // ============================================================
    // APPROVALS
    // ============================================================
    if (path === '/agents/approvals' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, approvals: [], warning: 'No DB' });
      const status = url.searchParams.get('status') ?? undefined;
      const approvals = await getApprovals(db, status);
      return jsonResponse({ ok: true, approvals });
    }

    if (path === '/agents/approvals/create' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      return jsonResponse({ ok: true, message: 'Use /agents/coordinator/route or specific agent endpoints to create proposals' });
    }

    if (path.match(/^\/agents\/approvals\/[^/]+\/approve$/) && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const actionId = path.split('/')[3];
      const body = await request.json() as Record<string, string>;
      const result = await approveAction(db, actionId, body.approved_by ?? 'owner', body.reason);
      if (!result.ok) return errorResponse(result.error ?? 'Approve failed', 400);
      return jsonResponse({ ok: true, action_id: actionId });
    }

    if (path.match(/^\/agents\/approvals\/[^/]+\/reject$/) && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const actionId = path.split('/')[3];
      const body = await request.json() as Record<string, string>;
      const result = await rejectAction(db, actionId, body.rejected_by ?? 'owner', body.reason);
      if (!result.ok) return errorResponse(result.error ?? 'Reject failed', 400);
      return jsonResponse({ ok: true, action_id: actionId });
    }

    // ============================================================
    // ACTIONS
    // ============================================================
    if (path === '/agents/actions/executions' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, executions: [], warning: 'No DB' });
      const executions = await getExecutions(db);
      return jsonResponse({ ok: true, executions });
    }

    if (path.match(/^\/agents\/actions\/execute-approved\/[^/]+$/) && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const actionId = path.split('/').pop()!;
      const body = await request.json() as Record<string, string>;
      const result = await executeApprovedAction(db, actionId, body.idempotency_key);
      if (!result.ok) return errorResponse(result.error ?? 'Execution failed', 400);
      const { ok: _ok, ...execData } = result;
      return jsonResponse({ ok: true, ...execData });
    }

    if (path === '/agents/actions/dry-run' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, string>;
      const result = await dryRunAction(db, body.action_id);
      const { ok: _dryOk, ...dryData } = result;
      return jsonResponse({ ok: true, ...dryData });
    }

    // ============================================================
    // TOOLS
    // ============================================================
    if (path === '/agents/tools' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, tools: [], warning: 'No DB' });
      const tools = await getTools(db);
      return jsonResponse({ ok: true, tools });
    }

    if (path === '/agents/tools/check-permission' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, string>;
      const result = await checkToolPermission(db, body.tool_key, body.agent_key);
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/tools/request-call' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, string>;
      const perm = await checkToolPermission(db, body.tool_key, body.agent_key);
      if (!perm.allowed) return jsonResponse({ ok: false, blocked: true, reason: perm.reason }, 403);
      return jsonResponse({ ok: true, allowed: true, is_mock: perm.is_mock, message: perm.reason });
    }

    // ============================================================
    // INTEGRATIONS
    // ============================================================
    if (path === '/agents/integrations' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, integrations: [], warning: 'No DB' });
      const integrations = await getIntegrations(db);
      return jsonResponse({ ok: true, integrations });
    }

    if (path === '/agents/integrations/test-call' && method === 'POST') {
      const body = await request.json() as Record<string, string>;
      const health = await checkIntegrationHealth(env, body.integration_key);
      return jsonResponse({ ok: true, health });
    }

    // ============================================================
    // KNOWLEDGE BASE
    // ============================================================
    if (path === '/agents/knowledge' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, items: [], warning: 'No DB' });
      const items = await getKnowledgeItems(db, { category: url.searchParams.get('category') ?? undefined });
      return jsonResponse({ ok: true, items });
    }

    if (path === '/agents/knowledge/retrieve' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, string>;
      const items = await retrieveKnowledge(db, body.agent_key, body.project_key, body.category, body.query);
      return jsonResponse({ ok: true, items });
    }

    if (path === '/agents/knowledge/create' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await createKnowledgeItem(db, body.agent_key as string, body.category as string, body.title as string, body.content as string, (body.scope as 'local' | 'global') ?? 'local', body.project_key as string);
      return jsonResponse({ ok: true, ...result });
    }

    // ============================================================
    // QA
    // ============================================================
    if (path === '/agents/qa/run' && method === 'POST') {
      const body = await request.json() as Record<string, string>;
      const { runId, result } = await runQA(db, env, (body.run_type as 'quick' | 'standard' | 'full') ?? 'quick');
      return jsonResponse({ ok: true, run_id: runId, result });
    }

    // ============================================================
    // DEPLOYMENTS
    // ============================================================
    if (path === '/agents/deployments' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, deployments: [], warning: 'No DB' });
      const r = await db.prepare('SELECT * FROM agent_deployments ORDER BY created_at DESC LIMIT 20').all();
      return jsonResponse({ ok: true, deployments: r.results ?? [] });
    }

    if (path === '/agents/deployments/create' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const id = generateId();
      await db.prepare('INSERT INTO agent_deployments (id, environment, version, status, plan, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, (body.environment as string) ?? 'staging', (body.version as string) ?? '1.0.0', 'planned', JSON.stringify(body.plan ?? {}), now()).run();
      return jsonResponse({ ok: true, deployment_id: id });
    }

    // ============================================================
    // NOTIFICATIONS
    // ============================================================
    if (path === '/agents/notifications' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, notifications: [], warning: 'No DB' });
      const items = await getNotifications(db);
      return jsonResponse({ ok: true, notifications: items });
    }

    if (path === '/agents/notifications/event' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const { channel = 'web', body: msgBody, subject, priority } = body;
      const result = await sendNotification(env, db, channel as any, (msgBody as string) ?? 'Event', subject as string, (priority as any) ?? 'normal');
      const { ok: _notifOk, ...notifData } = result;
      return jsonResponse({ ok: true, ...notifData });
    }

    if (path === '/agents/notifications/process-queue' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const pending = await db.prepare("SELECT * FROM agent_notifications WHERE status = 'pending' LIMIT 10").all();
      return jsonResponse({ ok: true, processed: pending.results?.length ?? 0 });
    }

    // ============================================================
    // SCHEDULES
    // ============================================================
    if (path === '/agents/schedules' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, schedules: [], warning: 'No DB' });
      const schedules = await getSchedules(db);
      return jsonResponse({ ok: true, schedules });
    }

    if (path === '/agents/schedules/create' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, unknown>;
      const result = await createSchedule(db, body.schedule_key as string, body.name as string, body.agent_key as any, body.trigger_payload ?? {}, (body.schedule_type as 'simple' | 'cron' | 'interval') ?? 'interval', { intervalSeconds: (body.interval_seconds as number) ?? 3600 });
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/schedules/process-due' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const result = await processDueSchedules(db, env);
      return jsonResponse({ ok: true, ...result });
    }

    if (path.match(/^\/agents\/schedules\/[^/]+\/run-now$/) && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const scheduleId = path.split('/')[3];
      const schedule = await db.prepare('SELECT * FROM agent_schedules WHERE id = ?').bind(scheduleId).first() as Record<string, string> | null;
      if (!schedule) return errorResponse('Schedule not found', 404);
      const requestId = await createAgentRequest(db, schedule.agent_key as any, 'system', `manual_run:${schedule.schedule_key}`, JSON.parse(schedule.trigger_payload));
      return jsonResponse({ ok: true, request_id: requestId });
    }

    // ============================================================
    // ANALYTICS
    // ============================================================
    if (path === '/agents/analytics' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, analytics: {}, warning: 'No DB' });
      const summary = await getAnalyticsSummary(db);
      return jsonResponse({ ok: true, ...summary });
    }

    if (path === '/agents/analytics/run-daily' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const result = await runDailyAnalytics(db);
      return jsonResponse({ ok: true, ...result });
    }

    if (path.match(/^\/agents\/analytics\/agents\/[^/]+$/) && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, data: [], warning: 'No DB' });
      const agentKey = path.split('/').pop()!;
      const r = await db.prepare('SELECT * FROM agent_analytics_agent_daily WHERE agent_key = ? ORDER BY date DESC LIMIT 30').bind(agentKey).all();
      return jsonResponse({ ok: true, agent_key: agentKey, data: r.results ?? [] });
    }

    // ============================================================
    // SECURITY
    // ============================================================
    if (path === '/agents/security/overview' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, overview: {}, warning: 'No DB' });
      const overview = await getSecurityOverview(db);
      return jsonResponse({ ok: true, ...overview });
    }

    if (path === '/agents/security/check-access' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, string>;
      const result = await checkAccess(db, body.user_id, body.resource, body.action);
      return jsonResponse({ ok: true, ...result });
    }

    if (path === '/agents/security/audit-log' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, log: [], warning: 'No DB' });
      const r = await db.prepare('SELECT * FROM agent_security_audit_log ORDER BY created_at DESC LIMIT 100').all();
      return jsonResponse({ ok: true, log: r.results ?? [] });
    }

    // ============================================================
    // HARDENING
    // ============================================================
    if (path === '/agents/hardening/overview' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, overview: {}, warning: 'No DB' });
      const overview = await getHardeningOverview(db);
      return jsonResponse({ ok: true, ...overview });
    }

    if (path === '/agents/hardening/heartbeat' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const body = await request.json() as Record<string, string>;
      await recordHeartbeat(db, body.component ?? 'api', (body.status as any) ?? 'alive', body.detail);
      return jsonResponse({ ok: true });
    }

    if (path === '/agents/hardening/stuck-runs/detect' && method === 'POST') {
      if (!db) return jsonResponse({ ok: false, warning: 'No DB' }, 503);
      const count = await detectStuckRuns(db);
      return jsonResponse({ ok: true, stuck_detected: count });
    }

    if (path === '/agents/recovery' && method === 'GET') {
      if (!db) return jsonResponse({ ok: true, actions: [], warning: 'No DB' });
      const actions = await getRecoveryActions(db);
      return jsonResponse({ ok: true, recovery_actions: actions });
    }

    // ============================================================
    // WEB UI PAGES
    // ============================================================
    if (path === '/agents/dashboard' && method === 'GET') {
      return renderDashboard(db, env);
    }

    if (path === '/agents/control-center' && method === 'GET') {
      return renderSimplePage('Control Center', db, env, async (db, env) => {
        const handoffs = db ? (await db.prepare('SELECT * FROM agent_handoffs ORDER BY created_at DESC LIMIT 20').all()).results ?? [] : [];
        const traces = db ? (await db.prepare('SELECT * FROM agent_traces ORDER BY started_at DESC LIMIT 20').all()).results ?? [] : [];
        return `<p style="color:#64748b;margin-bottom:16px">Coordination center — handoffs and traces</p>
        <div class="section"><h2 style="margin-top:0">Recent Handoffs (${handoffs.length})</h2>
        ${handoffs.length === 0 ? '<p class="empty">No handoffs yet.</p>' : `<table class="table"><thead><tr><th>From</th><th>To</th><th>Reason</th><th>Status</th></tr></thead><tbody>
        ${(handoffs as Record<string,string>[]).map(h => `<tr><td><code>${h.from_agent}</code></td><td><code>${h.to_agent}</code></td><td>${h.reason}</td><td><span class="badge badge-gray">${h.status}</span></td></tr>`).join('')}
        </tbody></table>`}
        </div>
        <div class="section"><h2 style="margin-top:0">Recent Traces (${traces.length})</h2>
        ${traces.length === 0 ? '<p class="empty">No traces yet.</p>' : `<table class="table"><thead><tr><th>Agent</th><th>Trigger</th><th>Status</th><th>Started</th></tr></thead><tbody>
        ${(traces as Record<string,string>[]).map(t => `<tr><td><code>${t.agent_key}</code></td><td>${t.trigger}</td><td><span class="badge badge-gray">${t.status}</span></td><td style="font-size:12px">${t.started_at}</td></tr>`).join('')}
        </tbody></table>`}
        </div>`;
      });
    }

    if (path === '/agents/approvals' && method === 'GET' && request.headers.get('accept')?.includes('text/html')) {
      return renderSimplePage('Approval Center', db, env, async (db, env) => {
        const approvals = db ? await getApprovals(db, 'pending') : [];
        return `<p style="color:#64748b;margin-bottom:16px">Pending proposals awaiting your decision</p>
        <div class="section"><h2 style="margin-top:0">Pending Approvals (${approvals.length})</h2>
        ${approvals.length === 0 ? '<p class="empty">No pending approvals. ✅</p>' : `<table class="table"><thead><tr><th>Action Type</th><th>Agent</th><th>Risk</th><th>Proposal</th><th>Actions</th></tr></thead><tbody>
        ${(approvals as Record<string,string>[]).map(a => `<tr>
          <td><code>${a.action_type}</code></td>
          <td><span class="tag">${a.agent_key}</span></td>
          <td><span class="badge ${a.risk_level === 'high' || a.risk_level === 'critical' ? 'badge-red' : a.risk_level === 'medium' ? 'badge-yellow' : 'badge-green'}">${a.risk_level}</span></td>
          <td style="font-size:13px">${(a.proposal_text ?? '').slice(0, 80)}</td>
          <td><a href="#" onclick="fetch('/agents/approvals/${a.id}/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(()=>location.reload())" style="color:#86efac;margin-right:8px">✅ Approve</a>
          <a href="#" onclick="fetch('/agents/approvals/${a.id}/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(()=>location.reload())" style="color:#fca5a5">❌ Reject</a></td>
        </tr>`).join('')}
        </tbody></table>`}
        </div>`;
      });
    }

    if (path === '/agents/tools' && method === 'GET' && request.headers.get('accept')?.includes('text/html')) {
      return renderSimplePage('Tool Registry', db, env, async (db, env) => {
        const tools = db ? await getTools(db) : [];
        const byCategory: Record<string, Record<string,unknown>[]> = {};
        for (const t of tools as Record<string,unknown>[]) {
          const cat = t.category as string;
          if (!byCategory[cat]) byCategory[cat] = [];
          byCategory[cat].push(t);
        }
        return `<p style="color:#64748b;margin-bottom:16px">${tools.length} tools registered</p>
        ${Object.entries(byCategory).map(([cat, items]) => `
        <div class="section"><h2 style="margin-top:0">${cat} (${items.length})</h2>
        <table class="table"><thead><tr><th>Key</th><th>Name</th><th>Risk</th><th>Enabled</th><th>Mock</th><th>Approval</th></tr></thead><tbody>
        ${items.map(t => `<tr>
          <td><code style="font-size:11px">${t.tool_key}</code></td><td style="font-size:13px">${t.name}</td>
          <td><span class="badge ${(t.risk_level as string) === 'dangerous' ? 'badge-red' : (t.risk_level as string) === 'high' || (t.risk_level as string) === 'critical' ? 'badge-yellow' : 'badge-green'}">${t.risk_level}</span></td>
          <td>${t.is_enabled ? '✅' : '🚫'}</td>
          <td>${t.is_mock ? '📋' : '—'}</td>
          <td>${t.requires_approval ? '🔐' : '—'}</td>
        </tr>`).join('')}
        </tbody></table></div>`).join('')}`;
      });
    }

    if (path === '/agents/security' && method === 'GET' && request.headers.get('accept')?.includes('text/html')) {
      return renderSimplePage('Security & Audit', db, env, async (db, env) => {
        if (!db) return '<div class="alert">No database configured.</div>';
        const overview = await getSecurityOverview(db);
        return `<div class="grid">
          <div class="card"><div class="card-title">Open Alerts</div><div class="card-value" style="color:${overview.open_alerts > 0 ? '#f87171' : '#86efac'}">${overview.open_alerts}</div></div>
          <div class="card"><div class="card-title">Users</div><div class="card-value">${overview.users.length}</div></div>
          <div class="card"><div class="card-title">Roles</div><div class="card-value">${overview.roles.length}</div></div>
        </div>
        <div class="section"><h2 style="margin-top:0">Roles</h2>
        <table class="table"><thead><tr><th>Role</th><th>Description</th></tr></thead><tbody>
        ${(overview.roles as Record<string,string>[]).map(r => `<tr><td><span class="tag">${r.role_name}</span></td><td>${r.description ?? ''}</td></tr>`).join('')}
        </tbody></table></div>`;
      });
    }

    if (path === '/agents/hardening' && method === 'GET' && request.headers.get('accept')?.includes('text/html')) {
      return renderSimplePage('Production Hardening', db, env, async (db, env) => {
        if (!db) return '<div class="alert">No database configured.</div>';
        const overview = await getHardeningOverview(db);
        return `<div class="grid">
          <div class="card"><div class="card-title">Open Incidents</div><div class="card-value" style="color:${overview.open_incidents > 0 ? '#f87171' : '#86efac'}">${overview.open_incidents}</div></div>
          <div class="card"><div class="card-title">DLQ Pending</div><div class="card-value" style="color:${overview.dlq_pending > 0 ? '#fbbf24' : '#f8fafc'}">${overview.dlq_pending}</div></div>
          <div class="card"><div class="card-title">Stuck Runs</div><div class="card-value" style="color:${overview.stuck_runs > 0 ? '#fbbf24' : '#f8fafc'}">${overview.stuck_runs}</div></div>
        </div>
        <div class="section"><h2 style="margin-top:0">Heartbeats</h2>
        ${overview.heartbeats.length === 0 ? '<p class="empty">No heartbeats yet. POST /agents/hardening/heartbeat</p>' :
          `<table class="table"><thead><tr><th>Component</th><th>Status</th><th>Last Beat</th></tr></thead><tbody>
          ${(overview.heartbeats as Record<string,string>[]).map(h => `<tr><td><code>${h.component}</code></td><td><span class="badge ${h.status === 'alive' ? 'badge-green' : 'badge-red'}">${h.status}</span></td><td style="font-size:12px">${h.last_beat_at}</td></tr>`).join('')}
          </tbody></table>`}
        </div>
        <div class="section"><h2 style="margin-top:0">Circuit Breakers</h2>
        ${overview.circuit_breakers.length === 0 ? '<p class="empty">No circuit breakers yet.</p>' :
          `<table class="table"><thead><tr><th>Component</th><th>State</th><th>Failures</th></tr></thead><tbody>
          ${(overview.circuit_breakers as Record<string,string|number>[]).map(cb => `<tr><td><code>${cb.component}</code></td><td><span class="badge ${cb.state === 'open' ? 'badge-red' : 'badge-green'}">${cb.state}</span></td><td>${cb.failure_count}</td></tr>`).join('')}
          </tbody></table>`}
        </div>`;
      });
    }

    // Generic UI pages (fallback)
    const uiPages: Record<string, string> = {
      '/agents/actions': 'Actions',
      '/agents/integrations': 'Integrations',
      '/agents/knowledge': 'Knowledge Base',
      '/agents/qa': 'QA Layer',
      '/agents/deployments': 'Deployments',
      '/agents/notifications': 'Notifications',
      '/agents/schedules': 'Schedules',
      '/agents/analytics': 'Analytics',
      '/agents/recovery': 'Recovery Center',
      '/agents/settings': 'Settings',
      '/agents/reports': 'Reports',
    };

    const pageTitle = uiPages[path];
    if (pageTitle && method === 'GET') {
      return renderSimplePage(pageTitle, db, env, async () => {
        return `<div class="section">
          <p style="color:#64748b">Page: <strong>${pageTitle}</strong></p>
          <p style="color:#64748b;margin-top:8px">Use the API endpoints or navigate to the relevant section.</p>
          <div style="margin-top:16px">
            <a href="/agents/dashboard" class="btn">← Back to Dashboard</a>
          </div>
        </div>`;
      });
    }

    // ============================================================
    // 404
    // ============================================================
    return jsonResponse({ ok: false, error: `Route not found: ${method} ${path}` }, 404);

  } catch (err) {
    console.error('Unhandled error:', err);
    return errorResponse(
      err instanceof Error ? err.message : 'Internal server error',
      500
    );
  }
}
