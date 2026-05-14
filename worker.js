/**
 * Cloudflare Worker — Unified Entry Point
 *
 * Required env vars (set in wrangler.toml or Cloudflare dashboard):
 *   TELEGRAM_BOT_TOKEN           — bot token for Telegram API calls
 *   TELEGRAM_WEBHOOK_SECRET      — secret validated on every webhook POST
 *   GEMINI_API_KEY               — Google Gemini API key
 *   GEMINI_CLASSIFICATION_MODEL  — (optional) default: gemini-1.5-flash-latest
 *   GROQ_API_KEY                 — Groq API key
 *   GROQ_API_BASE                — (optional) default: https://api.groq.com/openai/v1
 *   GROQ_MODEL                   — (optional) default: llama3-8b-8192
 *   WB_API_TOKEN                 — (pending) WB API integration token
 *   INTERNAL_API_BASE            — Planner integration base URL
 *   DB                           — Cloudflare D1 binding
 *
 * Module load order (all exported functions are in global scope):
 *   stage336_349_agent_extension.gs
 *   wb_operations_stage1_v1.gs
 *   wb_operations_stage2_v1.gs
 *   wb_operations_stage2_patch.gs
 *   cs_operations_stage1_v1.gs
 *   cs_operations_stage2_v1.gs
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Bot-Api-Secret-Token',
  };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ---------------------------------------------------------------------------
// Telegram webhook routing (body parsed once, passed around)
// ---------------------------------------------------------------------------

async function handleTelegramUpdate(update, request, env) {
  if (update.message) {
    const msg    = update.message;
    const chatId = msg.chat?.id;
    const userId = msg.from?.id;

    if (await routeWbTelegramCommandV2_(env, msg, chatId, userId)) return jsonResponse({ ok: true });
    if (await routeWbTelegramCommand_(env, msg, chatId, userId))   return jsonResponse({ ok: true });
    if (await routeCsTelegramCommandV2_(env, msg, chatId, userId)) return jsonResponse({ ok: true });
    if (await routeCsTelegramCommand_(env, msg, chatId, userId))   return jsonResponse({ ok: true });
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    if (await routeWbCallbackQuery_(env, cq))     return jsonResponse({ ok: true });
    if (await routeCsCallbackQueryV2_(env, cq))   return jsonResponse({ ok: true });
    if (await routeCsCallbackQuery_(env, cq))     return jsonResponse({ ok: true });
  }

  // Fallback: reconstruct a readable Request so the agent handler can parse it
  const syntheticReq = new Request(request.url, {
    method: 'POST',
    body: JSON.stringify(update),
    headers: request.headers,
  });
  return handleAgentTelegramWebhook(syntheticReq, env);
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    try {
      // 1. CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 200, headers: corsHeaders() });
      }

      const url      = new URL(request.url);
      const pathname = url.pathname;

      // 2. Health check
      if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
        return jsonResponse({
          ok: true,
          build: 'ai_helpers_worker_v1',
          modules: ['stage336_349', 'wb_ops_stage1', 'wb_ops_stage2', 'wb_ops_stage2_patch', 'cs_stage1', 'cs_stage2'],
          timestamp: new Date().toISOString(),
        });
      }

      // 3. Telegram webhook
      if (pathname === '/telegram/webhook' && request.method === 'POST') {
        const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
          return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
        }
        const update = await request.json();
        return handleTelegramUpdate(update, request, env);
      }

      // 4. WB agent routes
      if (pathname.startsWith('/agent/wb/')) {
        const r = await handleWbStage2Routes_(env, request);
        if (r) return r;
        const r2 = await handleWbAgentRoutes_(env, request);
        if (r2) return r2;
      }

      // 5. CS agent routes
      if (pathname.startsWith('/agent/cs/')) {
        const r = await handleCsStage2Routes_(env, request);
        if (r) return r;
        const r2 = await handleCsAgentRoutes_(env, request);
        if (r2) return r2;
      }

      // 6-10. Specific agent API routes
      if (pathname === '/agent/hub/records/create') return handleAgentHubRecordCreateApi(request, env);
      if (pathname === '/agent/settings')           return handleAgentSettingsApi(request, env);
      if (pathname === '/agent/audit')              return handleAgentAuditLogApi(request, env);
      if (pathname === '/agent/weekly-insights')    return handleAgentWeeklyInsightsApi(request, env);
      if (pathname === '/agent/proposals/status')   return handleAgentProposalStatusApi(request, env);

      // 11. 404 fallback
      return jsonResponse({ ok: false, error: 'Not found', path: pathname }, 404);

    } catch (err) {
      return jsonResponse({ ok: false, error: err.message || String(err) }, 500);
    }
  },

  // -------------------------------------------------------------------------
  // Scheduled handler (cron triggers)
  // -------------------------------------------------------------------------
  async scheduled(event, env, ctx) {
    // Placeholder for future cron jobs.
    // e.g. daily WB operations report at 06:00 Athens time:
    // ctx.waitUntil(runWbOperationsChiefV2_(env, null, 'scheduled'));
    console.log('Scheduled event fired:', event.cron);
  },
};
