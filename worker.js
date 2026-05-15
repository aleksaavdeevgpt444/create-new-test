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
 *   WB_API_TOKEN                 — Wildberries API token (active)
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
 *   approval_flow_v1.gs
 *   qa_runner_v1.gs
 *   handoff_events_v1.gs
 *   scheduler_v1.gs
 *   design_chief_v1.gs
 *   rop_chief_v1.gs
 *   fulfillment_chief_v1.gs
 *   procurement_chief_v1.gs
 *   wb_sync_v1.gs         ← WB data sync pipeline (runs before chiefs)
 *   wb_pricing_v1.gs      ← WB Price & Discount Advisor
 *   supplier_management_v1.gs ← Supplier Directory & Price History
 *   bot_setup_v1.gs       ← /start /help /status, webhook registration
 *   alerts_v1.gs          ← Real-time alert system
 *   wb_analytics_v1.gs    ← Week-over-week business analytics
 *   wb_api_client_v1.gs   ← LAST: overrides WB/CS stubs with real API calls
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

    if (await routeWbTelegramCommandV2_(env, msg, chatId, userId))   return jsonResponse({ ok: true });
    if (await routeWbTelegramCommand_(env, msg, chatId, userId))     return jsonResponse({ ok: true });
    if (await routeCsTelegramCommandV2_(env, msg, chatId, userId))   return jsonResponse({ ok: true });
    if (await routeCsTelegramCommand_(env, msg, chatId, userId))     return jsonResponse({ ok: true });
    if (await routeApprovalTelegramCommand_(env, msg, chatId, userId))  return jsonResponse({ ok: true });
    if (await routeHandoffTelegramCommand_(env, msg, chatId, userId))  return jsonResponse({ ok: true });
    if (await routeSchedulerTelegramCommand_(env, msg, chatId, userId)) return jsonResponse({ ok: true });
    if (await routeQaTelegramCommand_(env, msg, chatId, userId))       return jsonResponse({ ok: true });
    if (await routeDesignTelegramCommand_(env, msg, chatId, userId))   return jsonResponse({ ok: true });
    if (await routeRopTelegramCommand_(env, msg, chatId, userId))      return jsonResponse({ ok: true });
    if (await routeFulfillmentTelegramCommand_(env, msg, chatId, userId)) return jsonResponse({ ok: true });
    if (await routeProcurementTelegramCommand_(env, msg, chatId, userId)) return jsonResponse({ ok: true });
    if (await routeWbSyncTelegramCommand_(env, msg, chatId, userId))      return jsonResponse({ ok: true });
    if (await routePricingTelegramCommand_(env, msg, chatId, userId))     return jsonResponse({ ok: true });
    if (await routeSupplierTelegramCommand_(env, msg, chatId, userId))    return jsonResponse({ ok: true });
    if (await routeBotSetupTelegramCommand_(env, msg, chatId, userId))   return jsonResponse({ ok: true });
    if (await routeAlertsCommand_(env, msg, chatId, userId))              return jsonResponse({ ok: true });
    if (await routeAnalyticsTelegramCommand_(env, msg, chatId, userId))   return jsonResponse({ ok: true });
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    if (await routeApprovalCallbackQuery_(env, cq))      return jsonResponse({ ok: true });
    if (await routeHandoffCallbackQuery_(env, cq))        return jsonResponse({ ok: true });
    if (await routeWbCallbackQuery_(env, cq))             return jsonResponse({ ok: true });
    if (await routeDesignCallbackQuery_(env, cq))         return jsonResponse({ ok: true });
    if (await routeRopCallbackQuery_(env, cq))            return jsonResponse({ ok: true });
    if (await routeFulfillmentCallbackQuery_(env, cq))    return jsonResponse({ ok: true });
    if (await routeProcurementCallbackQuery_(env, cq))    return jsonResponse({ ok: true });
    if (await routePricingCallbackQuery_(env, cq))         return jsonResponse({ ok: true });
    if (await routeCsCallbackQueryV2_(env, cq))           return jsonResponse({ ok: true });
    if (await routeCsCallbackQuery_(env, cq))             return jsonResponse({ ok: true });
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
          modules: ['stage336_349', 'wb_ops_stage1', 'wb_ops_stage2', 'wb_ops_stage2_patch', 'cs_stage1', 'cs_stage2', 'approval_flow', 'qa_runner', 'design_chief', 'rop_chief', 'fulfillment_chief', 'procurement_chief', 'wb_sync', 'wb_pricing', 'supplier_mgmt', 'bot_setup', 'alerts', 'wb_analytics', 'wb_api_client'],
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
        const rs = await handleWbSyncRoutes_(env, request);
        if (rs) return rs;
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

      // 6. Approval flow routes
      if (pathname.startsWith('/agent/proposals/')) {
        const r = await handleApprovalFlowRoutes_(env, request);
        if (r) return r;
      }

      // 7. QA routes
      if (pathname.startsWith('/agent/qa/')) {
        const r = await handleQaRoutes_(env, request);
        if (r) return r;
      }

      // 8. Handoff routes
      if (pathname.startsWith('/agent/handoffs')) {
        const r = await handleHandoffRoutes_(env, request);
        if (r) return r;
      }

      // 9. Scheduler routes
      if (pathname.startsWith('/agent/scheduler/')) {
        const r = await handleSchedulerRoutes_(env, request);
        if (r) return r;
      }

      // 10. WB API client routes
      if (pathname.startsWith('/agent/wb/api/')) {
        const r = await handleWbApiClientRoutes_(env, request);
        if (r) return r;
      }

      // 11. Design Chief routes
      if (pathname.startsWith('/agent/design/')) {
        const r = await handleDesignRoutes_(env, request);
        if (r) return r;
      }

      // 12. ROP Chief routes
      if (pathname.startsWith('/agent/rop/')) {
        const r = await handleRopRoutes_(env, request);
        if (r) return r;
      }

      // 13. Fulfillment Chief routes
      if (pathname.startsWith('/agent/fulfillment/')) {
        const r = await handleFulfillmentRoutes_(env, request);
        if (r) return r;
      }

      // 14. Procurement Chief routes
      if (pathname.startsWith('/agent/procurement/')) {
        const r = await handleProcurementRoutes_(env, request);
        if (r) return r;
      }

      // 15. Pricing Advisor routes
      if (pathname.startsWith('/agent/pricing/')) {
        const r = await handlePricingRoutes_(env, request);
        if (r) return r;
      }

      // 16. Supplier Management routes
      if (pathname.startsWith('/agent/suppliers')) {
        const r = await handleSupplierRoutes_(env, request);
        if (r) return r;
      }

      // 17. Alerts routes
      if (pathname.startsWith('/agent/alerts')) {
        const r = await handleAlertsRoutes_(env, request);
        if (r) return r;
      }

      // 18. Bot setup routes (webhook/setup lives outside /agent/)
      if (pathname === '/webhook/setup' || pathname.startsWith('/agent/bot/')) {
        const r = await handleBotSetupRoutes_(env, request);
        if (r) return r;
      }

      // 19. Analytics routes
      if (pathname.startsWith('/agent/analytics')) {
        const r = await handleAnalyticsRoutes_(env, request);
        if (r) return r;
      }

      // 16-20. Specific agent API routes
      if (pathname === '/agent/hub/records/create') return handleAgentHubRecordCreateApi(request, env);
      if (pathname === '/agent/settings')           return handleAgentSettingsApi(request, env);
      if (pathname === '/agent/audit')              return handleAgentAuditLogApi(request, env);
      if (pathname === '/agent/weekly-insights')    return handleAgentWeeklyInsightsApi(request, env);
      if (pathname === '/agent/proposals/status')   return handleAgentProposalStatusApi(request, env);

      // 19. 404 fallback
      return jsonResponse({ ok: false, error: 'Not found', path: pathname }, 404);

    } catch (err) {
      return jsonResponse({ ok: false, error: err.message || String(err) }, 500);
    }
  },

  // -------------------------------------------------------------------------
  // Scheduled handler (cron triggers)
  // -------------------------------------------------------------------------
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledEvent_(event, env, ctx));
  },
};
