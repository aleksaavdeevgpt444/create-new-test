// ============================================================
// WB Ops Router Patch — Stage 350–361
// Build: ai_helpers_stage1_wb_operations_chief_v1
//
// HOW TO INTEGRATE into your main Worker fetch() handler:
//
// STEP 1 — Inside your main fetch(request, env, ctx) BEFORE
//          the existing /telegram/webhook route, add:
//
//   // WB Agent routes
//   const wbResponse = await handleWbAgentRoutes_(env, request);
//   if (wbResponse) return wbResponse;
//
// STEP 2 — In handleAgentTelegramWebhook (or wherever you
//          handle Telegram updates), BEFORE the existing
//          classifyMessageWithLlm_ call add:
//
//   // Handle /wb_* commands first (no LLM needed)
//   if (update.message) {
//     const handled = await routeWbTelegramCommand_(
//       env, update.message,
//       update.message.chat.id,
//       update.message.from?.id
//     );
//     if (handled) return new Response('ok');
//   }
//
// STEP 3 — In handleAgentCallbackQuery_, BEFORE existing
//          callback routing add:
//
//   const wbHandled = await routeWbCallbackQuery_(env, callbackQuery);
//   if (wbHandled) return;
//
// ── No existing routes are removed or changed. ───────────────
// ── All new routes are additive. ─────────────────────────────
// ============================================================

// ── New endpoints ─────────────────────────────────────────────
//
// GET  /agent/wb/health
//   Health check. Returns agent status and which env vars are set.
//
// POST /agent/wb/report/run
//   Run WB Operations report for a date.
//   Body: { date?: "YYYY-MM-DD", user_id?: string }
//   Returns: { ok, date, report }
//
// GET  /agent/wb/report/latest
//   Get the most recent saved report.
//   Returns: { ok, date, report }
//
// GET  /agent/wb/risks?date=YYYY-MM-DD
//   List all alerts for a date.
//
// GET  /agent/wb/sku?nm_id=...&date=YYYY-MM-DD
//   Full snapshot for one SKU: sku + finance + ads + stock.
//
// GET  /agent/wb/ads?date=YYYY-MM-DD
//   All ads snapshots, sorted by DRR desc.
//
// GET  /agent/wb/finance?date=YYYY-MM-DD
//   All finance snapshots, sorted by profit_after_ads asc.
//
// GET  /agent/wb/stock?date=YYYY-MM-DD
//   All stock snapshots, sorted by days_of_stock asc.
//
// GET  /agent/wb/log?entity_id=&event_type=&limit=50
//   WB action log entries.
//
// POST /agent/wb/cost
//   Upsert cost/unit economics data for an SKU.
//   Body: { nm_id, effective_date, cost_per_unit, commission_pct,
//           logistics_rub, storage_per_day_rub, tax_pct, notes }
//
// POST /agent/wb/proposals/:id/confirm
//   Confirm a proposal. Triggers Planner task creation if INTERNAL_API_BASE is set.
//   Body: { user_id? }
//
// POST /agent/wb/proposals/:id/cancel
//   Cancel a proposal.
//   Body: { user_id? }
//
// ── New Telegram commands ─────────────────────────────────────
//
// /wb_today      — отчёт за вчера
// /wb_run        — запустить отчёт прямо сейчас
// /wb_risks      — критичные риски
// /wb_sku <id>   — анализ конкретного артикула
// /wb_ads        — рекламные риски
// /wb_finance    — убыточные артикулы
// /wb_stock      — риски остатков
// /wb_tasks      — предложенные задачи
//
// ── New DB tables (auto-created on first call) ────────────────
//
// wb_daily_snapshot    — дневной снепшот по маркетплейсу
// wb_sku_snapshot      — снепшот по каждому артикулу
// wb_ads_snapshot      — снепшот рекламных кампаний
// wb_finance_snapshot  — юнит-экономика по артикулу
// wb_stock_snapshot    — остатки по артикулу
// wb_agent_report      — сводный отчёт AI-шефа
// wb_agent_alerts      — критичные alerts (дедуплицированы)
// wb_agent_proposals   — предложения действий (требуют подтверждения)
// wb_action_log        — полный лог всех событий агента
// wb_cost_data         — себестоимость (заполняется вручную или импортом)
//
// ── New env variables required ───────────────────────────────
//
// WB_API_TOKEN         — токен WB API (пока: интеграция готовится)
// INTERNAL_API_BASE    — base URL вашего Worker (для Planner integration)
//
// Already used (from stage 336-349), no changes needed:
// TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// GEMINI_API_KEY, GEMINI_CLASSIFICATION_MODEL
// GROQ_API_KEY, GROQ_API_BASE, GROQ_MODEL
// DB (Cloudflare D1 binding)
//
// ── Idempotency guarantees ───────────────────────────────────
//
// 1. wb_agent_alerts: idempotency_key UNIQUE per (date, alert_type, nm_id)
//    → running alerts agent twice for same date does NOT duplicate alerts
//
// 2. wb_agent_proposals: confirmation_id UNIQUE
//    → pressing Telegram confirm button twice is safe — shows "уже создано"
//
// 3. wb_agent_report: UNIQUE(date, chief)
//    → re-running report for same date updates, does not duplicate
//
// 4. All snapshots: UNIQUE constraints with ON CONFLICT DO UPDATE
//    → safe to re-run snapshot builder any number of times
//
// ── Safety guarantees ────────────────────────────────────────
//
// • No ad budgets or bids are changed automatically
// • No tasks are created without confirmation_id confirmation
// • No supply orders are submitted automatically
// • Missing data is reported as "нет данных", never fabricated
// • If AI provider is down: code-calculated snapshots still saved,
//   summary falls back to template text
// • All errors are written to wb_action_log
//
// ── WB API integration TODO ──────────────────────────────────
//
// The following functions have stub implementations.
// Replace with real API calls when WB_API_TOKEN is available:
//
//   loadWbSkuData_()     → WB Statistics API v5
//                          GET https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod
//                          + WB Content API v2 for titles/brands
//
//   loadWbAdsData_()     → WB Ads API
//                          GET https://advert-api.wildberries.ru/adv/v2/adverts
//                          GET https://advert-api.wildberries.ru/adv/v2/fullstats
//
//   loadWbStockData_()   → WB Marketplace API
//                          GET https://marketplace-api.wildberries.ru/api/v3/warehouses
//                          GET https://statistics-api.wildberries.ru/api/v1/supplier/stocks
//
// Cost data (wb_cost_data) is populated via:
//   POST /agent/wb/cost   (manual entry or batch import)
//
// ── Manual checks after deployment ───────────────────────────
//
// 1.  GET /agent/wb/health → status: ok
// 2.  POST /agent/wb/report/run → report returns, no crash even with no data
// 3.  GET /agent/wb/report/latest → returns last report
// 4.  Telegram /wb_today → показывает отчёт или "не найден"
// 5.  Telegram /wb_run   → запускает отчёт, отвечает в Telegram
// 6.  Telegram /wb_risks → показывает alerts или "нет рисков"
// 7.  Telegram /wb_tasks → показывает proposals или "нет задач"
// 8.  Кнопка [✅ Создать] → proposal переходит в confirmed, дубль не создаётся
// 9.  Повторное нажатие кнопки → "задача уже создана"
// 10. POST /agent/wb/cost с данными → wb_cost_data заполняется
// 11. GET /agent/wb/log → видны все события
// 12. Повторный /wb_run за ту же дату → отчёт обновляется, не дублируется
// 13. Telegram /wb_sku 575556886 → карточка артикула (или "не найден")
// 14. При недоступном AI: отчёт всё равно собирается (fallback summary)
// 15. При пустом WB API: система пишет "нет данных", не падает
// ============================================================
