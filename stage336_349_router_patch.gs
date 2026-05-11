// ============================================================
// ROUTER PATCH — Stage 336–349
// Replace or extend the main fetch handler routing section.
//
// In the main worker file, REPLACE:
//   if (url.pathname === "/telegram/webhook") return handleTelegramWebhook(request, env);
// WITH:
//   if (url.pathname === "/telegram/webhook") return handleAgentTelegramWebhook(request, env);
//
// AND ADD after existing /agent/* routes:
//   if (url.pathname === '/agent/hub/records/create') return handleAgentHubRecordCreateApi(request, env);
//   if (url.pathname === '/agent/settings') return handleAgentSettingsApi(request, env);
//   if (url.pathname === '/agent/audit') return handleAgentAuditLogApi(request, env);
//   if (url.pathname === '/agent/weekly-insights') return handleAgentWeeklyInsightsApi(request, env);
//   if (url.pathname === '/agent/proposals/status') return handleAgentProposalStatusApi(request, env);
// ============================================================

// ── New endpoints summary ─────────────────────────────────────
//
// POST /telegram/webhook
//   Replaces old handler. Now routes to handleAgentTelegramWebhook.
//   - Validates X-Telegram-Bot-Api-Secret-Token
//   - Deduplicates by telegram_update_id
//   - Stores in agent_incoming_messages
//   - Classifies with LLM (Gemini/Groq)
//   - Routes to task/meeting/insight/idea/reminder/resource handler
//   - Handles inline button callbacks
//
// POST /agent/hub/records/create
//   Creates an Inbox Hub record (insight, idea, resource, etc.)
//   Body: { user_id, record_type, text, project, importance, tags, include_in_weekly_review }
//
// GET  /agent/settings?user_id=
// POST /agent/settings
//   Get or update agent settings for a user.
//   Body (POST): { user_id, settings: { agent_enabled, confirm_tasks, ... } }
//
// GET  /agent/audit?user_id=&limit=&event_type=
//   View agent audit log entries.
//
// POST /agent/weekly-insights
//   Trigger weekly insights review for a user.
//   Body: { user_id, chat_id }
//
// GET  /agent/proposals/status?proposal_id=&user_id=
//   Check status of a proposal.
//
// ── New DB tables ─────────────────────────────────────────────
//
// agent_incoming_messages  — stores all incoming Telegram messages
// agent_proposals          — stores task/meeting/reminder proposals
// agent_settings           — per-user agent configuration
// agent_audit_log          — full audit trail of agent decisions
//
// ── Idempotency guarantees ───────────────────────────────────
//
// 1. telegram_update_id UNIQUE on agent_incoming_messages
//    → duplicate Telegram webhook calls are silently ignored
//
// 2. confirmation_id on agent_action_log (existing Stage 335)
//    → create_task/create_meeting/create_reminder are idempotent
//
// 3. proposal status 'applied'
//    → double button press shows "already created" message
//
// ── Confirmation ID formula ──────────────────────────────────
//
// confirmation_id = "confirm_" + userId + "_" + messageId + "_" + actionType + "_" + hash(payload)
//
// This means:
//   - Same Telegram callback → same confirmation_id → no duplicate
//   - Safe to retry after network error
//   - Traceable: know which message triggered which action
//
// ── LLM fallback chain ───────────────────────────────────────
//
// 1. Try Gemini (env.GEMINI_API_KEY)
// 2. Try Groq/Qwen (env.GROQ_API_KEY)
// 3. If both fail → ask user to choose type manually (inline buttons)
//
// ── Message size guard ───────────────────────────────────────
//
// Messages > 2000 chars → saved as note, user asked what to do.
//
// ── Forbidden plan actions (apply-plan v1) ───────────────────
//
// delete_task, bulk_reschedule, update_recurring_series,
// change_project_settings, change_agent_settings
//
// ── Allowed plan actions v1 ──────────────────────────────────
//
// create_task, create_meeting, create_reminder, reschedule_task
