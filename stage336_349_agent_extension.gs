// ============================================================
// STAGE 336–349 — Telegram Agent Extension
// Extends stage335 (agent-confirmed-actions-idempotency_v1)
// Build: планнер_этап336-349_telegram-agent-extension_v1
// ============================================================

// ============================================================
// STAGE 336 — Agent Proposal Contract v1
// ============================================================

const AGENT_PROPOSAL_BUILD = "планнер_этап336-349_telegram-agent-extension_v1";

// Detected message types
const AGENT_DETECTED_TYPES = Object.freeze({
  TASK: 'task',
  MEETING: 'meeting',
  INSIGHT: 'insight',
  IDEA: 'idea',
  QUESTION: 'question',
  REMINDER: 'reminder',
  RESOURCE: 'resource',
  PROJECT_CONTEXT: 'project_context',
  UNKNOWN: 'unknown'
});

// Action types
const AGENT_ACTION_TYPES = Object.freeze({
  SAVE_INSIGHT: 'save_insight',
  SAVE_IDEA: 'save_idea',
  SAVE_QUESTION: 'save_question',
  SAVE_RESOURCE: 'save_resource',
  CREATE_TASK: 'create_task',
  CREATE_MEETING: 'create_meeting',
  CREATE_REMINDER: 'create_reminder',
  REQUEST_CLARIFICATION: 'request_clarification',
  APPLY_PLAN: 'apply_plan'
});

// Proposal statuses
const AGENT_PROPOSAL_STATUSES = Object.freeze({
  DRAFT: 'draft',
  WAITING_CONFIRMATION: 'waiting_confirmation',
  CONFIRMED: 'confirmed',
  APPLIED: 'applied',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  FAILED: 'failed'
});

// Incoming message statuses
const AGENT_INCOMING_STATUSES = Object.freeze({
  RECEIVED: 'received',
  CLASSIFIED: 'classified',
  WAITING_CONFIRMATION: 'waiting_confirmation',
  APPLIED: 'applied',
  FAILED: 'failed',
  IGNORED: 'ignored'
});

// Allowed action types for apply-plan v1
const AGENT_ALLOWED_PLAN_ACTIONS_V1 = new Set(['create_task', 'create_meeting', 'create_reminder', 'reschedule_task']);
const AGENT_FORBIDDEN_PLAN_ACTIONS_V1 = new Set(['delete_task', 'bulk_reschedule', 'update_recurring_series', 'change_project_settings', 'change_agent_settings']);

// Proposal expiry TTL (24 hours)
const AGENT_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

// Default agent settings
const AGENT_SETTINGS_DEFAULTS = Object.freeze({
  agent_enabled: true,
  default_space: 'work',
  default_task_duration_min: 30,
  confirm_tasks: true,
  confirm_meetings: true,
  confirm_reminders: true,
  auto_save_insights: true,
  auto_save_ideas: true,
  weekly_insights_enabled: true,
  weekly_insights_day: 'Thursday',
  weekly_insights_time: '10:00',
  allowed_task_types: null,
  telegram_notifications_enabled: true
});

// ── Confirmation ID generation ────────────────────────────────
// confirmation_id = user_id + message_id + action_type + short hash of payload
function buildAgentConfirmationId(userId, messageId, actionType, payload) {
  const payloadStr = (() => { try { return JSON.stringify(payload || {}); } catch (_) { return ''; } })();
  let hash = 2166136261;
  const text = String(userId) + String(messageId) + String(actionType) + payloadStr;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const shortHash = (hash >>> 0).toString(16).slice(0, 8);
  return `confirm_${String(userId)}_${String(messageId)}_${String(actionType)}_${shortHash}`;
}

// ── Proposal ID generation ────────────────────────────────────
function buildAgentProposalId(userId, messageId) {
  const hash = buildAgentConfirmationId(userId, messageId, 'proposal', { ts: Date.now() });
  return `proposal_${String(userId)}_${String(messageId)}_${hash.slice(-8)}`;
}

// ── Schema: agent proposals + incoming messages + agent settings ──
async function ensureAgentExtensionSchema(env) {
  if (!env || !env.DB) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS agent_incoming_messages (
      id TEXT PRIMARY KEY,
      telegram_update_id INTEGER UNIQUE,
      telegram_user_id TEXT NOT NULL,
      planner_user_id TEXT,
      message_id TEXT,
      chat_id TEXT,
      text TEXT,
      received_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received',
      classification_json TEXT,
      proposal_json TEXT,
      error TEXT
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_incoming_user ON agent_incoming_messages(planner_user_id, received_at DESC)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_incoming_update ON agent_incoming_messages(telegram_update_id)`).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS agent_proposals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'telegram_agent',
      telegram_message_id TEXT,
      telegram_chat_id TEXT,
      incoming_message_id TEXT,
      detected_type TEXT,
      confidence REAL,
      summary TEXT,
      requires_confirmation INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      suggested_actions_json TEXT,
      classification_json TEXT,
      planning_context_json TEXT,
      slots_json TEXT,
      selected_slot INTEGER,
      confirmation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_proposals_user ON agent_proposals(user_id, created_at DESC)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_proposals_status ON agent_proposals(user_id, status, updated_at DESC)`).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      user_id TEXT PRIMARY KEY,
      agent_enabled INTEGER DEFAULT 1,
      default_space TEXT DEFAULT 'work',
      default_task_duration_min INTEGER DEFAULT 30,
      confirm_tasks INTEGER DEFAULT 1,
      confirm_meetings INTEGER DEFAULT 1,
      confirm_reminders INTEGER DEFAULT 1,
      auto_save_insights INTEGER DEFAULT 1,
      auto_save_ideas INTEGER DEFAULT 1,
      weekly_insights_enabled INTEGER DEFAULT 1,
      weekly_insights_day TEXT DEFAULT 'Thursday',
      weekly_insights_time TEXT DEFAULT '10:00',
      allowed_task_types TEXT,
      telegram_notifications_enabled INTEGER DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS agent_audit_log (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      user_id TEXT NOT NULL,
      telegram_message_id TEXT,
      proposal_id TEXT,
      confirmation_id TEXT,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      payload_json TEXT,
      result_json TEXT,
      error_message TEXT,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_estimate REAL,
      latency_ms INTEGER,
      build TEXT
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_audit_user ON agent_audit_log(user_id, created_at DESC)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_audit_proposal ON agent_audit_log(proposal_id, created_at DESC)`).run();
}

// ── Agent Audit logging ───────────────────────────────────────
async function logAgentAudit_(env, entry) {
  try {
    await ensureAgentExtensionSchema(env);
    const payloadStr = entry.payload != null ? (() => { try { return JSON.stringify(entry.payload).slice(0, 8000); } catch (_) { return null; } })() : null;
    const resultStr = entry.result != null ? (() => { try { return JSON.stringify(entry.result).slice(0, 8000); } catch (_) { return null; } })() : null;
    await env.DB.prepare(`
      INSERT INTO agent_audit_log (id, created_at, user_id, telegram_message_id, proposal_id, confirmation_id, event_type, status, payload_json, result_json, error_message, model, tokens_in, tokens_out, cost_estimate, latency_ms, build)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      String(entry.user_id || ''),
      entry.telegram_message_id ? String(entry.telegram_message_id) : null,
      entry.proposal_id ? String(entry.proposal_id) : null,
      entry.confirmation_id ? String(entry.confirmation_id) : null,
      String(entry.event_type || 'unknown'),
      String(entry.status || 'ok'),
      payloadStr,
      resultStr,
      entry.error_message ? String(entry.error_message).slice(0, 2000) : null,
      entry.model ? String(entry.model) : null,
      entry.tokens_in != null ? Number(entry.tokens_in) : null,
      entry.tokens_out != null ? Number(entry.tokens_out) : null,
      entry.cost_estimate != null ? Number(entry.cost_estimate) : null,
      entry.latency_ms != null ? Number(entry.latency_ms) : null,
      AGENT_PROPOSAL_BUILD
    ).run();
  } catch (err) {
    console.log('[agent_audit_log_failed]', String(err));
  }
}

// ============================================================
// STAGE 337 — Telegram Bot Intake v1
// ============================================================

async function findPlannerUserIdByTelegramId_(env, telegramUserId) {
  // Telegram user_id IS the planner user_id in this system (chatId = userId)
  return String(telegramUserId);
}

async function storeIncomingMessage_(env, { updateId, telegramUserId, plannerUserId, messageId, chatId, text }) {
  await ensureAgentExtensionSchema(env);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO agent_incoming_messages (id, telegram_update_id, telegram_user_id, planner_user_id, message_id, chat_id, text, received_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received')
  `).bind(id, updateId ? Number(updateId) : null, String(telegramUserId), plannerUserId ? String(plannerUserId) : null, messageId ? String(messageId) : null, chatId ? String(chatId) : null, text ? String(text).slice(0, 10000) : null, now).run();
  return id;
}

async function updateIncomingMessageStatus_(env, id, status, extra = {}) {
  if (!env || !env.DB || !id) return;
  const classJson = extra.classification ? (() => { try { return JSON.stringify(extra.classification).slice(0, 8000); } catch (_) { return null; } })() : null;
  const propJson = extra.proposal ? (() => { try { return JSON.stringify(extra.proposal).slice(0, 8000); } catch (_) { return null; } })() : null;
  await env.DB.prepare(`
    UPDATE agent_incoming_messages SET status = ?, classification_json = COALESCE(?, classification_json), proposal_json = COALESCE(?, proposal_json), error = COALESCE(?, error)
    WHERE id = ?
  `).bind(status, classJson, propJson, extra.error ? String(extra.error).slice(0, 2000) : null, id).run();
}

async function isDuplicateTelegramUpdate_(env, updateId) {
  if (!updateId) return false;
  await ensureAgentExtensionSchema(env);
  const row = await env.DB.prepare(`SELECT id FROM agent_incoming_messages WHERE telegram_update_id = ? LIMIT 1`).bind(Number(updateId)).first();
  return !!row;
}

// ============================================================
// STAGE 348 — Agent Settings v1
// ============================================================

async function getAgentSettings_(env, userId) {
  await ensureAgentExtensionSchema(env);
  const row = await env.DB.prepare(`SELECT * FROM agent_settings WHERE user_id = ?`).bind(String(userId)).first();
  if (!row) return { ...AGENT_SETTINGS_DEFAULTS, user_id: userId };
  return {
    user_id: userId,
    agent_enabled: !!row.agent_enabled,
    default_space: row.default_space || AGENT_SETTINGS_DEFAULTS.default_space,
    default_task_duration_min: Number(row.default_task_duration_min) || AGENT_SETTINGS_DEFAULTS.default_task_duration_min,
    confirm_tasks: !!row.confirm_tasks,
    confirm_meetings: !!row.confirm_meetings,
    confirm_reminders: !!row.confirm_reminders,
    auto_save_insights: !!row.auto_save_insights,
    auto_save_ideas: !!row.auto_save_ideas,
    weekly_insights_enabled: !!row.weekly_insights_enabled,
    weekly_insights_day: row.weekly_insights_day || AGENT_SETTINGS_DEFAULTS.weekly_insights_day,
    weekly_insights_time: row.weekly_insights_time || AGENT_SETTINGS_DEFAULTS.weekly_insights_time,
    allowed_task_types: row.allowed_task_types ? (() => { try { return JSON.parse(row.allowed_task_types); } catch (_) { return null; } })() : null,
    telegram_notifications_enabled: !!row.telegram_notifications_enabled
  };
}

async function upsertAgentSettings_(env, userId, patch) {
  await ensureAgentExtensionSchema(env);
  const current = await getAgentSettings_(env, userId);
  const next = { ...current, ...patch };
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO agent_settings (user_id, agent_enabled, default_space, default_task_duration_min, confirm_tasks, confirm_meetings, confirm_reminders, auto_save_insights, auto_save_ideas, weekly_insights_enabled, weekly_insights_day, weekly_insights_time, allowed_task_types, telegram_notifications_enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      agent_enabled = excluded.agent_enabled,
      default_space = excluded.default_space,
      default_task_duration_min = excluded.default_task_duration_min,
      confirm_tasks = excluded.confirm_tasks,
      confirm_meetings = excluded.confirm_meetings,
      confirm_reminders = excluded.confirm_reminders,
      auto_save_insights = excluded.auto_save_insights,
      auto_save_ideas = excluded.auto_save_ideas,
      weekly_insights_enabled = excluded.weekly_insights_enabled,
      weekly_insights_day = excluded.weekly_insights_day,
      weekly_insights_time = excluded.weekly_insights_time,
      allowed_task_types = excluded.allowed_task_types,
      telegram_notifications_enabled = excluded.telegram_notifications_enabled,
      updated_at = excluded.updated_at
  `).bind(
    String(userId),
    next.agent_enabled ? 1 : 0,
    String(next.default_space),
    Number(next.default_task_duration_min),
    next.confirm_tasks ? 1 : 0,
    next.confirm_meetings ? 1 : 0,
    next.confirm_reminders ? 1 : 0,
    next.auto_save_insights ? 1 : 0,
    next.auto_save_ideas ? 1 : 0,
    next.weekly_insights_enabled ? 1 : 0,
    String(next.weekly_insights_day),
    String(next.weekly_insights_time),
    next.allowed_task_types ? JSON.stringify(next.allowed_task_types) : null,
    next.telegram_notifications_enabled ? 1 : 0,
    now
  ).run();
  return next;
}

// ============================================================
// STAGE 338 — Message Classifier v1
// ============================================================

const CLASSIFIER_SYSTEM_PROMPT = `You are a smart Telegram message classifier for a personal productivity planner system.
Analyze the user's message and return ONLY a valid JSON object with no markdown, no code fences, no extra text.

Return this exact JSON structure:
{
  "detected_type": "<task|meeting|insight|idea|question|reminder|resource|project_context|unknown>",
  "confidence": <0.0-1.0>,
  "summary": "<concise summary of the message>",
  "project": "<project name or null>",
  "task_type": "<task type or null>",
  "importance": "<critical|high|medium|low or null>",
  "urgency": "<now|today|next_2_days|this_week|next_week|someday or null>",
  "estimated_duration_min": <number or null>,
  "date": "<YYYY-MM-DD or null>",
  "time": "<HH:MM or null>",
  "url": "<url if found or null>",
  "needs_clarification": <true|false>,
  "clarification_question": "<question or null>",
  "suggested_next_action": "<action_type>"
}

Classification rules:
- task: нужно сделать, проверить, подготовить, разобрать, написать, создать, позвонить, отправить
- meeting: созвон, встреча, обсудить с командой, запланировать встречу, в [day] в [time]
- insight: понял, кажется, важная мысль, можно сделать лучше, идея о том как работает, наблюдение
- idea: добавить, можно сделать, придумал функцию, хочу реализовать
- reminder: напомни, не забыть, вернуться завтра, пингни
- resource: ссылка http/https, статья, видео, документ, нужно потом изучить
- question: вопрос, как, почему, что делать
- project_context: контекст проекта, обновление по проекту

For meetings: date and time are required. If missing, set needs_clarification=true.
For resources with URL: always set needs_clarification=true (must ask if task or reminder).
Keep summary concise (under 100 chars).`;

async function classifyMessageWithLlm_(env, { text, userId, todayYmd }) {
  const t0 = Date.now();
  const userPrompt = `Today: ${todayYmd || new Date().toISOString().slice(0, 10)}\nUser message: ${String(text || '').slice(0, 3000)}`;

  // Try Gemini first, then Groq as fallback
  const providers = [];
  if (env && env.GEMINI_API_KEY) providers.push('gemini');
  if (env && env.GROQ_API_KEY) providers.push('groq');
  if (!providers.length) return { error: 'no_llm_provider', detected_type: 'unknown', confidence: 0, summary: text, needs_clarification: true, suggested_next_action: 'request_clarification' };

  let lastError = null;
  for (const provider of providers) {
    try {
      const result = await callLlmForClassification_(env, provider, CLASSIFIER_SYSTEM_PROMPT, userPrompt);
      const latency = Date.now() - t0;
      return { ...result, _provider: provider, _latency_ms: latency };
    } catch (err) {
      lastError = err;
    }
  }
  // Fallback
  return { error: String(lastError), detected_type: 'unknown', confidence: 0, summary: String(text || '').slice(0, 100), needs_clarification: true, suggested_next_action: 'request_clarification', _latency_ms: Date.now() - t0 };
}

async function callLlmForClassification_(env, provider, systemPrompt, userPrompt) {
  let rawText = '';
  let tokensIn = null, tokensOut = null, model = null;

  if (provider === 'gemini') {
    model = env.GEMINI_CLASSIFICATION_MODEL || GEMINI_GENERATION_MODEL_DEFAULT;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 512 }
      }),
      signal: AbortSignal.timeout(AI_PROVIDER_REQUEST_TIMEOUT_MS_DEFAULT)
    });
    if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    tokensIn = data?.usageMetadata?.promptTokenCount || null;
    tokensOut = data?.usageMetadata?.candidatesTokenCount || null;
  } else if (provider === 'groq') {
    model = GROQ_QWEN_MODEL_DEFAULT;
    const resp = await fetch(GROQ_API_BASE_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.1,
        max_tokens: 512
      }),
      signal: AbortSignal.timeout(AI_PROVIDER_REQUEST_TIMEOUT_MS_DEFAULT)
    });
    if (!resp.ok) throw new Error(`Groq ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    rawText = data?.choices?.[0]?.message?.content || '';
    tokensIn = data?.usage?.prompt_tokens || null;
    tokensOut = data?.usage?.completion_tokens || null;
  }

  const parsed = repairAndParseJson_(rawText);
  if (!parsed) throw new Error('LLM returned invalid JSON: ' + rawText.slice(0, 200));
  return { ...parsed, _model: model, _tokens_in: tokensIn, _tokens_out: tokensOut };
}

function repairAndParseJson_(raw) {
  const s = String(raw || '').trim();
  // Strip code fences
  const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  // Try to extract first JSON object
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch (_) {} }
  return null;
}

// ============================================================
// STAGE 337 — Enhanced Telegram Webhook (Agent Intake)
// ============================================================

async function handleAgentTelegramWebhook(request, env) {
  if (request.method !== 'POST') return textResponse('Method Not Allowed', 405);
  const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (env.TELEGRAM_WEBHOOK_SECRET && secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) return textResponse('Forbidden', 403);

  let update;
  try { update = await request.json(); } catch (_) { return jsonResponse({ ok: false, error: 'invalid json' }, { status: 400 }); }

  const updateId = update?.update_id;

  // Dedup: if already processed this update, return ok silently
  if (updateId) {
    const isDup = await isDuplicateTelegramUpdate_(env, updateId).catch(() => false);
    if (isDup) return jsonResponse({ ok: true, skipped: 'duplicate_update' });
  }

  // Handle callback_query (inline button press)
  const callbackQuery = update?.callback_query;
  if (callbackQuery) {
    return handleAgentCallbackQuery_(env, callbackQuery);
  }

  const message = update?.message;
  const chatId = message?.chat?.id;
  const telegramUserId = message?.from?.id || chatId;
  const messageId = message?.message_id;
  const text = (message?.text || '').trim();

  if (!chatId) return jsonResponse({ ok: true, skipped: 'no_chatId' });

  // Find planner user
  const plannerUserId = await findPlannerUserIdByTelegramId_(env, telegramUserId);

  // Store incoming message (idempotency on telegram_update_id)
  let incomingId = null;
  try {
    incomingId = await storeIncomingMessage_(env, {
      updateId,
      telegramUserId,
      plannerUserId,
      messageId,
      chatId,
      text
    });
  } catch (err) {
    // If UNIQUE constraint on update_id → already processed
    if (String(err).includes('UNIQUE')) return jsonResponse({ ok: true, skipped: 'duplicate_update' });
  }

  await logAgentAudit_(env, {
    user_id: String(plannerUserId),
    telegram_message_id: String(messageId || ''),
    event_type: 'incoming_message_received',
    status: 'ok',
    payload: { chat_id: chatId, text_len: text.length, update_id: updateId }
  });

  if (!text) {
    await sendTelegramMessage(env, chatId, 'Пока я понимаю только текстовые сообщения.');
    return jsonResponse({ ok: true, skipped: 'non-text' });
  }

  // Check agent enabled
  const settings = await getAgentSettings_(env, plannerUserId).catch(() => ({ ...AGENT_SETTINGS_DEFAULTS }));
  if (!settings.agent_enabled) {
    await sendTelegramMessage(env, chatId, 'Агент отключён.');
    return jsonResponse({ ok: true, skipped: 'agent_disabled' });
  }

  // Classify message
  const todayYmd = new Date().toISOString().slice(0, 10);
  let classification = null;
  try {
    classification = await classifyMessageWithLlm_(env, { text, userId: plannerUserId, todayYmd });
    await updateIncomingMessageStatus_(env, incomingId, 'classified', { classification });
    await logAgentAudit_(env, {
      user_id: String(plannerUserId),
      telegram_message_id: String(messageId || ''),
      event_type: 'message_classified',
      status: 'ok',
      payload: { detected_type: classification.detected_type, confidence: classification.confidence },
      result: classification
    });
  } catch (err) {
    await updateIncomingMessageStatus_(env, incomingId, 'failed', { error: String(err) });
    await logAgentAudit_(env, { user_id: String(plannerUserId), telegram_message_id: String(messageId || ''), event_type: 'message_classified', status: 'error', error_message: String(err) });
    // Fallback: ask user to choose manually
    await sendTelegramFallbackChoiceMessage_(env, chatId, messageId, plannerUserId, text, incomingId);
    return jsonResponse({ ok: true, handled: 'fallback_choice' });
  }

  // Route by detected type
  return handleClassifiedMessage_(env, {
    chatId, plannerUserId, messageId, text, classification, settings, incomingId, updateId
  });
}

async function handleClassifiedMessage_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId }) {
  const type = classification.detected_type;

  // Too long message → save as resource/note and ask clarification
  if (text.length > 2000) {
    await sendTelegramMessage(env, chatId, 'Сообщение очень длинное. Сохранил как заметку. Уточни, что с ним нужно сделать?', {
      reply_markup: JSON.stringify(buildInlineKeyboard_([
        [{ text: '📋 Создать задачу', callback_data: `clarify_task_${incomingId}` }],
        [{ text: '💾 Только сохранить', callback_data: `clarify_save_${incomingId}` }]
      ]))
    });
    return jsonResponse({ ok: true, handled: 'too_long_message' });
  }

  if (type === 'insight') {
    return handleIncomingInsight_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId });
  }
  if (type === 'idea') {
    return handleIncomingIdea_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId });
  }
  if (type === 'resource') {
    return handleIncomingResource_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId });
  }
  if (type === 'reminder') {
    return handleIncomingReminder_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId });
  }
  if (type === 'meeting') {
    return handleIncomingMeeting_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId });
  }
  if (type === 'task') {
    return handleIncomingTask_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId });
  }

  // Unknown / question / project_context
  if (classification.needs_clarification && classification.clarification_question) {
    await sendTelegramMessage(env, chatId, classification.clarification_question);
  } else {
    await sendTelegramMessage(env, chatId, `Не понял тип сообщения (${type}). Уточни, что с ним сделать?`, {
      reply_markup: JSON.stringify(buildInlineKeyboard_([
        [{ text: '📋 Задача', callback_data: `clarify_task_${incomingId}` }, { text: '💡 Инсайт', callback_data: `clarify_insight_${incomingId}` }],
        [{ text: '🔔 Напоминание', callback_data: `clarify_reminder_${incomingId}` }, { text: '❌ Отмена', callback_data: `clarify_cancel_${incomingId}` }]
      ]))
    });
  }
  await updateIncomingMessageStatus_(env, incomingId, 'waiting_confirmation', {});
  return jsonResponse({ ok: true, handled: 'clarification_requested' });
}

// ============================================================
// STAGE 343 — Inbox Hub Insights v1
// ============================================================

async function saveHubRecord_(env, { userId, recordType, text, project, importance, tags, include_in_weekly_review, source = 'telegram_agent' }) {
  // Try /agent/hub/records/create endpoint (internal call)
  // Or insert directly into hub_records table if available
  try {
    // Check if hub_records table exists
    const tableInfo = await env.DB.prepare(`PRAGMA table_info(hub_records)`).all();
    if (tableInfo && tableInfo.results && tableInfo.results.length > 0) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
      await env.DB.prepare(`
        INSERT INTO hub_records (id, user_id, source, record_type, text, project, importance, tags, include_in_weekly_review, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, String(userId), source, recordType, text, project || null, importance || 'medium', tagsStr, include_in_weekly_review ? 1 : 0, now, now).run();
      return { ok: true, id, created: true };
    }
  } catch (_) {}
  // Fallback: store as task with source_type=hub_record
  return { ok: false, error: 'hub_records table not available' };
}

async function handleIncomingInsight_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId }) {
  if (settings.auto_save_insights) {
    const result = await saveHubRecord_(env, {
      userId: plannerUserId,
      recordType: 'insight',
      text,
      project: classification.project || 'Planner',
      importance: classification.importance || 'medium',
      tags: ['telegram', 'weekly_review'],
      include_in_weekly_review: true
    });
    await updateIncomingMessageStatus_(env, incomingId, 'applied', {});
    await logAgentAudit_(env, { user_id: plannerUserId, telegram_message_id: String(messageId || ''), event_type: 'hub_record_created', status: 'ok', result });
    await sendTelegramMessage(env, chatId, `✅ Инсайт сохранён в Inbox Hub.\n\n«${classification.summary || text.slice(0, 100)}»`);
  } else {
    await sendTelegramMessage(env, chatId, `💡 Инсайт: «${classification.summary || text.slice(0, 100)}»\n\nСохранить?`, {
      reply_markup: JSON.stringify(buildInlineKeyboard_([
        [{ text: '✅ Сохранить', callback_data: `save_insight_${incomingId}` }, { text: '❌ Отмена', callback_data: `cancel_${incomingId}` }]
      ]))
    });
    await updateIncomingMessageStatus_(env, incomingId, 'waiting_confirmation', {});
  }
  return jsonResponse({ ok: true, handled: 'insight' });
}

async function handleIncomingIdea_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId }) {
  if (settings.auto_save_ideas) {
    const result = await saveHubRecord_(env, {
      userId: plannerUserId,
      recordType: 'idea',
      text,
      project: classification.project || 'Inbox Hub',
      importance: classification.importance || 'medium',
      tags: ['telegram'],
      include_in_weekly_review: false
    });
    await updateIncomingMessageStatus_(env, incomingId, 'applied', {});
    await logAgentAudit_(env, { user_id: plannerUserId, telegram_message_id: String(messageId || ''), event_type: 'hub_record_created', status: 'ok', result });
    await sendTelegramMessage(env, chatId, `✅ Идея сохранена.\n\n«${classification.summary || text.slice(0, 100)}»\n\nСоздать задачу на её основе?`, {
      reply_markup: JSON.stringify(buildInlineKeyboard_([
        [{ text: '📋 Создать задачу', callback_data: `idea_to_task_${incomingId}` }, { text: '✖ Нет', callback_data: `cancel_${incomingId}` }]
      ]))
    });
  } else {
    await sendTelegramMessage(env, chatId, `💡 Идея сохранена: «${classification.summary || text.slice(0, 100)}»`);
    await updateIncomingMessageStatus_(env, incomingId, 'applied', {});
  }
  return jsonResponse({ ok: true, handled: 'idea' });
}

// ============================================================
// STAGE 345 — Resource Handling v1
// ============================================================

async function handleIncomingResource_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId }) {
  // Always ask user what to do with a resource
  await sendTelegramMessage(env, chatId, `🔗 Обнаружена ссылка или ресурс:\n«${classification.summary || text.slice(0, 100)}»\n\nЧто с ним сделать?`, {
    reply_markup: JSON.stringify(buildInlineKeyboard_([
      [{ text: '📋 Создать задачу', callback_data: `resource_task_${incomingId}` }],
      [{ text: '🔔 Напоминание', callback_data: `resource_reminder_${incomingId}` }],
      [{ text: '💾 Только сохранить', callback_data: `resource_save_${incomingId}` }]
    ]))
  });
  await updateIncomingMessageStatus_(env, incomingId, 'waiting_confirmation', {});
  await logAgentAudit_(env, { user_id: plannerUserId, telegram_message_id: String(messageId || ''), event_type: 'proposal_created', status: 'ok', payload: { type: 'resource', url: classification.url } });
  return jsonResponse({ ok: true, handled: 'resource_choice_requested' });
}

// ============================================================
// STAGE 342 — Reminders v1
// ============================================================

async function handleIncomingReminder_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId }) {
  if (classification.needs_clarification || !classification.date) {
    await sendTelegramMessage(env, chatId, `🔔 Напоминание: «${classification.summary || text.slice(0, 100)}»\n\nКогда напомнить?`, {
      reply_markup: JSON.stringify(buildInlineKeyboard_([
        [{ text: '🌙 Сегодня вечером', callback_data: `reminder_tonight_${incomingId}` }],
        [{ text: '🌅 Завтра утром', callback_data: `reminder_tomorrow_${incomingId}` }],
        [{ text: '📅 Выбрать время', callback_data: `reminder_custom_${incomingId}` }]
      ]))
    });
    await updateIncomingMessageStatus_(env, incomingId, 'waiting_confirmation', {});
    return jsonResponse({ ok: true, handled: 'reminder_clarification' });
  }

  const proposalId = buildAgentProposalId(plannerUserId, messageId);
  const confirmationId = buildAgentConfirmationId(plannerUserId, messageId, 'create_reminder', { text });
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + AGENT_PROPOSAL_TTL_MS).toISOString();
  const remindAt = classification.date ? `${classification.date}T${classification.time || '09:00'}:00` : null;

  await ensureAgentExtensionSchema(env);
  await env.DB.prepare(`
    INSERT OR IGNORE INTO agent_proposals (id, user_id, source, telegram_message_id, incoming_message_id, detected_type, confidence, summary, requires_confirmation, status, classification_json, confirmation_id, created_at, updated_at, expires_at)
    VALUES (?, ?, 'telegram_agent', ?, ?, 'reminder', ?, ?, 1, 'waiting_confirmation', ?, ?, ?, ?, ?)
  `).bind(proposalId, String(plannerUserId), String(messageId || ''), incomingId, classification.confidence || 0, classification.summary || text.slice(0, 100), JSON.stringify(classification), confirmationId, now, now, expiresAt).run();

  const remindText = remindAt ? new Date(remindAt).toLocaleString('ru-RU') : 'без времени';
  await sendTelegramMessage(env, chatId, `🔔 Создать напоминание?\n\n«${classification.summary || text.slice(0, 80)}»\nВремя: ${remindText}`, {
    reply_markup: JSON.stringify(buildInlineKeyboard_([
      [{ text: '✅ Создать', callback_data: `confirm_reminder_${proposalId}` }, { text: '❌ Отмена', callback_data: `cancel_${proposalId}` }]
    ]))
  });
  await updateIncomingMessageStatus_(env, incomingId, 'waiting_confirmation', {});
  return jsonResponse({ ok: true, handled: 'reminder_proposal' });
}

// ============================================================
// STAGE 341 — Meetings v1
// ============================================================

async function handleIncomingMeeting_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId }) {
  if (classification.needs_clarification || !classification.date || !classification.time) {
    const missing = [];
    if (!classification.date) missing.push('дату');
    if (!classification.time) missing.push('время');
    await sendTelegramMessage(env, chatId, `📅 Встреча: «${classification.summary || text.slice(0, 80)}»\n\nУточни ${missing.join(' и ')}.`);
    await updateIncomingMessageStatus_(env, incomingId, 'waiting_confirmation', {});
    return jsonResponse({ ok: true, handled: 'meeting_clarification' });
  }

  // Check for conflicts
  const conflictWarning = await checkMeetingConflict_(env, plannerUserId, classification.date, classification.time, classification.estimated_duration_min || 60);

  const proposalId = buildAgentProposalId(plannerUserId, messageId);
  const confirmationId = buildAgentConfirmationId(plannerUserId, messageId, 'create_meeting', { text });
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + AGENT_PROPOSAL_TTL_MS).toISOString();

  await ensureAgentExtensionSchema(env);
  await env.DB.prepare(`
    INSERT OR IGNORE INTO agent_proposals (id, user_id, source, telegram_message_id, incoming_message_id, detected_type, confidence, summary, requires_confirmation, status, classification_json, confirmation_id, created_at, updated_at, expires_at)
    VALUES (?, ?, 'telegram_agent', ?, ?, 'meeting', ?, ?, 1, 'waiting_confirmation', ?, ?, ?, ?, ?)
  `).bind(proposalId, String(plannerUserId), String(messageId || ''), incomingId, classification.confidence || 0, classification.summary || text.slice(0, 100), JSON.stringify(classification), confirmationId, now, now, expiresAt).run();

  const durationMin = classification.estimated_duration_min || 60;
  let msg = `📅 Встреча: «${classification.summary || text.slice(0, 80)}»\n`;
  msg += `Дата: ${classification.date} в ${classification.time}\n`;
  msg += `Длительность: ${durationMin} мин\n`;
  if (conflictWarning) msg += `\n⚠️ ${conflictWarning}\n`;
  msg += '\nСоздать встречу?';

  await sendTelegramMessage(env, chatId, msg, {
    reply_markup: JSON.stringify(buildInlineKeyboard_([
      [{ text: '✅ Создать', callback_data: `confirm_meeting_${proposalId}` }, { text: '❌ Отмена', callback_data: `cancel_${proposalId}` }]
    ]))
  });
  await updateIncomingMessageStatus_(env, incomingId, 'waiting_confirmation', {});
  await logAgentAudit_(env, { user_id: plannerUserId, telegram_message_id: String(messageId || ''), proposal_id: proposalId, event_type: 'proposal_created', status: 'ok', payload: { type: 'meeting', date: classification.date, time: classification.time } });
  return jsonResponse({ ok: true, handled: 'meeting_proposal', proposal_id: proposalId });
}

async function checkMeetingConflict_(env, userId, date, time, durationMin) {
  try {
    const tasks = await env.DB.prepare(`
      SELECT title, due_at, duration_minutes FROM tasks
      WHERE user_id = ? AND task_type = 'meeting' AND status NOT IN ('done','canceled','postponed')
      AND due_at LIKE ?
      LIMIT 10
    `).bind(String(userId), `${date}%`).all();
    const startMin = timeToMinutes_(time);
    const endMin = startMin + Number(durationMin || 60);
    for (const t of (tasks.results || [])) {
      if (!t.due_at) continue;
      const tStart = timeToMinutes_(t.due_at.slice(11, 16));
      const tEnd = tStart + Number(t.duration_minutes || 60);
      if (startMin < tEnd && endMin > tStart) {
        return `Конфликт со встречей «${t.title}»`;
      }
    }
  } catch (_) {}
  return null;
}

function timeToMinutes_(hhmm) {
  if (!hhmm) return 0;
  const parts = String(hhmm).slice(0, 5).split(':');
  return Number(parts[0] || 0) * 60 + Number(parts[1] || 0);
}

// ============================================================
// STAGE 339 — Task Proposal v1
// ============================================================

async function handleIncomingTask_(env, { chatId, plannerUserId, messageId, text, classification, settings, incomingId }) {
  if (classification.needs_clarification && classification.clarification_question) {
    await sendTelegramMessage(env, chatId, classification.clarification_question);
    await updateIncomingMessageStatus_(env, incomingId, 'waiting_confirmation', {});
    return jsonResponse({ ok: true, handled: 'task_clarification' });
  }

  const durationMin = classification.estimated_duration_min || settings.default_task_duration_min || 30;
  const todayYmd = new Date().toISOString().slice(0, 10);

  // Request planning context
  let planningCtx = null;
  try {
    const urgencyRange = mapUrgencyToDateRange_(classification.urgency || 'today', todayYmd);
    const ctxParams = {
      user_id: plannerUserId,
      from: urgencyRange.from,
      to: urgencyRange.to,
      space: settings.default_space || 'work',
      task_type: classification.task_type || '',
      duration_min: durationMin,
      importance: classification.importance || 'medium',
      urgency: classification.urgency || 'today'
    };
    planningCtx = await getAgentPlanningContext_(env, ctxParams);
    await logAgentAudit_(env, { user_id: plannerUserId, event_type: 'planning_context_requested', status: 'ok', result: { has_slots: !!(planningCtx.best_slots && planningCtx.best_slots.length) } });
  } catch (err) {
    await logAgentAudit_(env, { user_id: plannerUserId, event_type: 'planning_context_requested', status: 'error', error_message: String(err) });
  }

  // Build 2-3 slot proposals
  const slots = buildTaskSlotProposals_(planningCtx, classification, durationMin);

  // Save proposal
  const proposalId = buildAgentProposalId(plannerUserId, messageId);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + AGENT_PROPOSAL_TTL_MS).toISOString();

  await ensureAgentExtensionSchema(env);
  await env.DB.prepare(`
    INSERT OR IGNORE INTO agent_proposals (id, user_id, source, telegram_message_id, incoming_message_id, detected_type, confidence, summary, requires_confirmation, status, classification_json, planning_context_json, slots_json, created_at, updated_at, expires_at)
    VALUES (?, ?, 'telegram_agent', ?, ?, 'task', ?, ?, 1, 'waiting_confirmation', ?, ?, ?, ?, ?, ?)
  `).bind(
    proposalId, String(plannerUserId), String(messageId || ''), incomingId,
    classification.confidence || 0, classification.summary || text.slice(0, 100),
    JSON.stringify(classification), planningCtx ? JSON.stringify(planningCtx) : null,
    JSON.stringify(slots), now, now, expiresAt
  ).run();

  // Format Telegram message
  const msg = buildTaskProposalMessage_(classification, slots, durationMin);
  const buttons = buildTaskSlotButtons_(proposalId, slots);

  await sendTelegramMessage(env, chatId, msg, { reply_markup: JSON.stringify(buildInlineKeyboard_(buttons)) });
  await updateIncomingMessageStatus_(env, incomingId, 'waiting_confirmation', { proposal: { proposal_id: proposalId, slots } });
  await logAgentAudit_(env, { user_id: plannerUserId, telegram_message_id: String(messageId || ''), proposal_id: proposalId, event_type: 'proposal_created', status: 'ok', payload: { type: 'task', slots_count: slots.length } });

  return jsonResponse({ ok: true, handled: 'task_proposal', proposal_id: proposalId });
}

function mapUrgencyToDateRange_(urgency, todayYmd) {
  const d = new Date(todayYmd + 'T00:00:00Z');
  const addDays = (n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const endOfWeek = () => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + (7 - x.getUTCDay())); return x.toISOString().slice(0, 10); };
  const startNextWeek = () => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + (8 - x.getUTCDay())); return x.toISOString().slice(0, 10); };
  const endNextWeek = () => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + (14 - x.getUTCDay())); return x.toISOString().slice(0, 10); };
  if (urgency === 'now' || urgency === 'today') return { from: todayYmd, to: todayYmd, urgency };
  if (urgency === 'next_2_days') return { from: todayYmd, to: addDays(2), urgency };
  if (urgency === 'this_week') return { from: todayYmd, to: endOfWeek(), urgency };
  if (urgency === 'next_week') return { from: startNextWeek(), to: endNextWeek(), urgency };
  return { from: todayYmd, to: addDays(7), urgency: urgency || 'this_week' };
}

function buildTaskSlotProposals_(planningCtx, classification, durationMin) {
  const slots = [];
  const bestSlots = planningCtx && Array.isArray(planningCtx.best_slots) ? planningCtx.best_slots : [];
  const fallbackSlots = planningCtx && Array.isArray(planningCtx.fallback_slots) ? planningCtx.fallback_slots : [];
  const reschedule = planningCtx && Array.isArray(planningCtx.reschedule_candidates) ? planningCtx.reschedule_candidates : [];

  if (bestSlots[0]) slots.push({ index: 1, type: 'best', slot: bestSlots[0], label: formatSlotLabel_(bestSlots[0]) });
  if (bestSlots[1] || fallbackSlots[0]) {
    const alt = bestSlots[1] || fallbackSlots[0];
    slots.push({ index: 2, type: 'alternative', slot: alt, label: formatSlotLabel_(alt) });
  }
  if (reschedule[0] && slots.length < 3) {
    slots.push({ index: 3, type: 'reschedule', candidate: reschedule[0], label: formatRescheduleLabel_(reschedule[0], durationMin) });
  }
  // If no slots at all, add a generic "schedule manually" option
  if (!slots.length) {
    slots.push({ index: 1, type: 'manual', label: 'Создать без точного слота (Inbox)' });
  }
  return slots;
}

function formatSlotLabel_(slot) {
  if (!slot) return 'Свободный слот';
  const date = slot.date || '';
  const start = slot.start_time || '';
  const end = slot.end_time || '';
  const block = slot.block_title ? ` — ${slot.block_title}` : '';
  return `${date} ${start}–${end}${block}`.trim();
}

function formatRescheduleLabel_(candidate, durationMin) {
  if (!candidate) return 'Перенос задачи';
  const suggested = candidate.suggested_new_slot;
  return `Сдвинуть «${String(candidate.title || '').slice(0, 30)}»${suggested ? ` → ${suggested.date} ${suggested.start_time}` : ''}`;
}

function buildTaskProposalMessage_(classification, slots, durationMin) {
  const importanceMap = { critical: 'критическая', high: 'высокая', medium: 'средняя', low: 'низкая' };
  const urgencyMap = { now: 'прямо сейчас', today: 'сегодня', next_2_days: 'в ближайшие 2 дня', this_week: 'на этой неделе', next_week: 'на следующей неделе', someday: 'когда-нибудь' };
  let msg = `📋 Похоже, это задача.\n\n`;
  msg += `Название: ${classification.summary || '—'}\n`;
  if (classification.project) msg += `Проект: ${classification.project}\n`;
  if (classification.task_type) msg += `Тип: ${classification.task_type}\n`;
  msg += `Важность: ${importanceMap[classification.importance] || classification.importance || '—'}\n`;
  msg += `Срочность: ${urgencyMap[classification.urgency] || classification.urgency || '—'}\n`;
  msg += `Длительность: ${durationMin} мин\n`;
  if (slots.length) {
    msg += '\nПредлагаю варианты:\n';
    for (const s of slots) {
      msg += `\n${s.index}. ${s.label}`;
      if (s.type === 'reschedule' && s.candidate) {
        msg += `\n   ↳ Нужно сдвинуть задачу «${String(s.candidate.title || '').slice(0, 40)}»`;
      }
    }
  }
  msg += '\n\nСоздать задачу?';
  return msg;
}

function buildTaskSlotButtons_(proposalId, slots) {
  const rows = [];
  for (const s of slots) {
    rows.push([{ text: `✅ Вариант ${s.index}`, callback_data: `confirm_slot_${s.index}_${proposalId}` }]);
  }
  rows.push([
    { text: '✏️ Изменить', callback_data: `edit_${proposalId}` },
    { text: '❌ Отмена', callback_data: `cancel_${proposalId}` }
  ]);
  return rows;
}

function buildInlineKeyboard_(rows) {
  return { inline_keyboard: rows };
}

// ============================================================
// STAGE 340 — Confirmed Task Creation v1 (Callback Handler)
// ============================================================

async function handleAgentCallbackQuery_(env, callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id;
  const callbackId = callbackQuery?.id;
  const data = String(callbackQuery?.data || '');
  const fromId = callbackQuery?.from?.id || chatId;

  if (!chatId || !data) return jsonResponse({ ok: true, skipped: 'no_callback_data' });

  // Answer callback immediately to remove loading state
  try {
    await telegramAnswerCallback_(env, callbackId, '');
  } catch (_) {}

  const plannerUserId = String(fromId);

  // Parse callback patterns
  if (data.startsWith('confirm_slot_')) {
    return handleConfirmSlotCallback_(env, chatId, plannerUserId, data);
  }
  if (data.startsWith('confirm_meeting_')) {
    return handleConfirmMeetingCallback_(env, chatId, plannerUserId, data);
  }
  if (data.startsWith('confirm_reminder_')) {
    return handleConfirmReminderCallback_(env, chatId, plannerUserId, data);
  }
  if (data.startsWith('cancel_')) {
    await sendTelegramMessage(env, chatId, '✖ Отменено.');
    return jsonResponse({ ok: true, handled: 'cancel' });
  }
  if (data.startsWith('resource_')) {
    return handleResourceCallback_(env, chatId, plannerUserId, data);
  }
  if (data.startsWith('save_insight_')) {
    return handleSaveInsightCallback_(env, chatId, plannerUserId, data);
  }

  return jsonResponse({ ok: true, handled: 'unknown_callback' });
}

async function loadAndValidateProposal_(env, proposalId, userId) {
  await ensureAgentExtensionSchema(env);
  const proposal = await env.DB.prepare(`SELECT * FROM agent_proposals WHERE id = ?`).bind(String(proposalId)).first();
  if (!proposal) return { error: 'proposal_not_found' };
  if (String(proposal.user_id) !== String(userId)) return { error: 'forbidden' };
  if (proposal.status === 'applied') return { error: 'already_applied', proposal };
  if (proposal.status === 'cancelled') return { error: 'cancelled', proposal };
  if (proposal.expires_at && new Date(proposal.expires_at) < new Date()) return { error: 'expired', proposal };
  return { proposal };
}

async function markProposalApplied_(env, proposalId) {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE agent_proposals SET status = 'applied', updated_at = ? WHERE id = ?`).bind(now, proposalId).run();
}

async function handleConfirmSlotCallback_(env, chatId, plannerUserId, data) {
  // Pattern: confirm_slot_{slotIndex}_{proposalId}
  const match = data.match(/^confirm_slot_(\d+)_(.+)$/);
  if (!match) return jsonResponse({ ok: true, handled: 'confirm_slot_bad_format' });
  const slotIndex = Number(match[1]);
  const proposalId = match[2];

  const { proposal, error } = await loadAndValidateProposal_(env, proposalId, plannerUserId);
  if (error === 'already_applied') {
    await sendTelegramMessage(env, chatId, '✅ Задача уже была создана по этому подтверждению.');
    return jsonResponse({ ok: true, already_applied: true });
  }
  if (error) {
    await sendTelegramMessage(env, chatId, `⚠️ Не удалось применить: ${error}`);
    return jsonResponse({ ok: false, error });
  }

  const classification = repairAndParseJson_(proposal.classification_json) || {};
  const slots = repairAndParseJson_(proposal.slots_json) || [];
  const selectedSlot = slots.find((s) => s.index === slotIndex) || slots[0];

  const confirmationId = buildAgentConfirmationId(plannerUserId, proposal.telegram_message_id || proposalId, 'create_task', { proposalId, slotIndex });

  // Build task payload
  const taskPayload = buildTaskPayloadFromProposal_(classification, selectedSlot, plannerUserId);

  try {
    const createResp = await callCreateConfirmedInternal_(env, plannerUserId, confirmationId, taskPayload);
    if (createResp.already_applied) {
      await sendTelegramMessage(env, chatId, `✅ Задача уже создана: «${classification.summary || ''}»`);
      await markProposalApplied_(env, proposalId);
      return jsonResponse({ ok: true, already_applied: true });
    }
    if (!createResp.ok) {
      await sendTelegramMessage(env, chatId, `⚠️ Ошибка создания задачи: ${createResp.error || 'неизвестная ошибка'}\n\nПопробуй ещё раз.`);
      return jsonResponse({ ok: false, error: createResp.error });
    }

    await markProposalApplied_(env, proposalId);
    await logAgentAudit_(env, { user_id: plannerUserId, proposal_id: proposalId, confirmation_id: confirmationId, event_type: 'planner_action_applied', status: 'ok', result: { task_id: createResp.task_id } });

    const slotLabel = selectedSlot && selectedSlot.label ? `\n🕐 ${selectedSlot.label}` : '';
    await sendTelegramMessage(env, chatId, `✅ Задача создана!\n\n«${classification.summary || ''}»${slotLabel}`);
    return jsonResponse({ ok: true, task_id: createResp.task_id });
  } catch (err) {
    await logAgentAudit_(env, { user_id: plannerUserId, proposal_id: proposalId, event_type: 'planner_action_applied', status: 'error', error_message: String(err) });
    await sendTelegramMessage(env, chatId, `⚠️ Ошибка: ${String(err).slice(0, 200)}\n\nПопробуй ещё раз.`);
    return jsonResponse({ ok: false, error: String(err) });
  }
}

async function handleConfirmMeetingCallback_(env, chatId, plannerUserId, data) {
  const proposalId = data.replace('confirm_meeting_', '');
  const { proposal, error } = await loadAndValidateProposal_(env, proposalId, plannerUserId);
  if (error === 'already_applied') {
    await sendTelegramMessage(env, chatId, '✅ Встреча уже создана.');
    return jsonResponse({ ok: true, already_applied: true });
  }
  if (error) {
    await sendTelegramMessage(env, chatId, `⚠️ ${error}`);
    return jsonResponse({ ok: false, error });
  }

  const classification = repairAndParseJson_(proposal.classification_json) || {};
  const confirmationId = buildAgentConfirmationId(plannerUserId, proposal.telegram_message_id || proposalId, 'create_meeting', { proposalId });
  const taskPayload = {
    user_id: plannerUserId,
    source: 'telegram_agent',
    confirmation_id: confirmationId,
    task: {
      title: classification.summary || 'Встреча',
      task_type: 'meeting',
      date: classification.date,
      start_time: classification.time || '10:00',
      duration_min: classification.estimated_duration_min || 60,
      project: classification.project,
      importance: classification.importance || 'medium',
      urgency: classification.urgency || 'today'
    }
  };

  try {
    const resp = await callCreateConfirmedInternal_(env, plannerUserId, confirmationId, taskPayload);
    if (resp.already_applied) {
      await sendTelegramMessage(env, chatId, '✅ Встреча уже создана.');
      return jsonResponse({ ok: true, already_applied: true });
    }
    await markProposalApplied_(env, proposalId);
    await sendTelegramMessage(env, chatId, `✅ Встреча создана: «${classification.summary || ''}»\n📅 ${classification.date} ${classification.time}`);
    return jsonResponse({ ok: true, task_id: resp.task_id });
  } catch (err) {
    await sendTelegramMessage(env, chatId, `⚠️ Ошибка: ${String(err).slice(0, 200)}`);
    return jsonResponse({ ok: false, error: String(err) });
  }
}

async function handleConfirmReminderCallback_(env, chatId, plannerUserId, data) {
  const proposalId = data.replace('confirm_reminder_', '');
  const { proposal, error } = await loadAndValidateProposal_(env, proposalId, plannerUserId);
  if (error === 'already_applied') {
    await sendTelegramMessage(env, chatId, '✅ Напоминание уже создано.');
    return jsonResponse({ ok: true, already_applied: true });
  }
  if (error) {
    await sendTelegramMessage(env, chatId, `⚠️ ${error}`);
    return jsonResponse({ ok: false, error });
  }

  const classification = repairAndParseJson_(proposal.classification_json) || {};
  const confirmationId = buildAgentConfirmationId(plannerUserId, proposal.telegram_message_id || proposalId, 'create_reminder', { proposalId });
  const taskPayload = {
    user_id: plannerUserId,
    source: 'telegram_agent',
    confirmation_id: confirmationId,
    task: {
      title: classification.summary || 'Напоминание',
      task_type: 'reminder',
      date: classification.date,
      start_time: classification.time || '09:00',
      duration_min: 10,
      project: classification.project,
      importance: classification.importance || 'medium',
      urgency: classification.urgency || 'today'
    }
  };

  try {
    const resp = await callCreateConfirmedInternal_(env, plannerUserId, confirmationId, taskPayload);
    await markProposalApplied_(env, proposalId);
    await sendTelegramMessage(env, chatId, `✅ Напоминание создано: «${classification.summary || ''}»`);
    return jsonResponse({ ok: true, task_id: resp.task_id });
  } catch (err) {
    await sendTelegramMessage(env, chatId, `⚠️ Ошибка: ${String(err).slice(0, 200)}`);
    return jsonResponse({ ok: false, error: String(err) });
  }
}

async function handleResourceCallback_(env, chatId, plannerUserId, data) {
  const parts = data.split('_');
  const action = parts[1]; // task | reminder | save
  const incomingId = parts.slice(2).join('_');

  const row = await env.DB.prepare(`SELECT * FROM agent_incoming_messages WHERE id = ?`).bind(incomingId).first().catch(() => null);
  const classification = row && row.classification_json ? (repairAndParseJson_(row.classification_json) || {}) : {};
  const text = row && row.text ? row.text : '';

  if (action === 'save') {
    await saveHubRecord_(env, { userId: plannerUserId, recordType: 'resource', text, project: classification.project, importance: 'medium', tags: ['telegram'], include_in_weekly_review: false });
    await sendTelegramMessage(env, chatId, '✅ Ресурс сохранён в Inbox Hub.');
    await updateIncomingMessageStatus_(env, incomingId, 'applied', {});
  } else if (action === 'task') {
    // Treat as a task, re-route
    const messageId = row && row.message_id ? row.message_id : crypto.randomUUID();
    await handleIncomingTask_(env, { chatId, plannerUserId, messageId, text, classification: { ...classification, detected_type: 'task' }, settings: await getAgentSettings_(env, plannerUserId), incomingId });
  } else if (action === 'reminder') {
    const messageId = row && row.message_id ? row.message_id : crypto.randomUUID();
    await handleIncomingReminder_(env, { chatId, plannerUserId, messageId, text, classification: { ...classification, detected_type: 'reminder' }, settings: await getAgentSettings_(env, plannerUserId), incomingId });
  }
  return jsonResponse({ ok: true, handled: `resource_${action}` });
}

async function handleSaveInsightCallback_(env, chatId, plannerUserId, data) {
  const incomingId = data.replace('save_insight_', '');
  const row = await env.DB.prepare(`SELECT * FROM agent_incoming_messages WHERE id = ?`).bind(incomingId).first().catch(() => null);
  const classification = row && row.classification_json ? (repairAndParseJson_(row.classification_json) || {}) : {};
  const text = row && row.text ? row.text : '';
  await saveHubRecord_(env, { userId: plannerUserId, recordType: 'insight', text, project: classification.project || 'Planner', importance: classification.importance || 'medium', tags: ['telegram', 'weekly_review'], include_in_weekly_review: true });
  await updateIncomingMessageStatus_(env, incomingId, 'applied', {});
  await sendTelegramMessage(env, chatId, `✅ Инсайт сохранён.`);
  return jsonResponse({ ok: true, handled: 'save_insight' });
}

function buildTaskPayloadFromProposal_(classification, selectedSlot, plannerUserId) {
  const slot = selectedSlot && selectedSlot.slot ? selectedSlot.slot : null;
  return {
    user_id: plannerUserId,
    source: 'telegram_agent',
    task: {
      title: classification.summary || 'Задача из Telegram',
      project: classification.project,
      task_type: classification.task_type || 'personal',
      importance: classification.importance || 'medium',
      urgency: classification.urgency || 'today',
      date: slot ? slot.date : classification.date,
      start_time: slot ? slot.start_time : classification.time,
      duration_min: classification.estimated_duration_min || 30
    }
  };
}

async function callCreateConfirmedInternal_(env, userId, confirmationId, payload) {
  const body = { ...payload, user_id: String(userId), confirmation_id: confirmationId };
  const req = new Request('https://internal/agent/tasks/create-confirmed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const resp = await handleAgentTaskCreateConfirmedApi(req, env);
  const result = await resp.json();
  return result;
}

async function telegramAnswerCallback_(env, callbackQueryId, text) {
  if (!env || !env.TELEGRAM_BOT_TOKEN || !callbackQueryId) return;
  await telegramApi(env, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '' });
}

async function sendTelegramFallbackChoiceMessage_(env, chatId, messageId, plannerUserId, text, incomingId) {
  await sendTelegramMessage(env, chatId, `Не смог автоматически разобрать сообщение.\n\nЧто это?`, {
    reply_markup: JSON.stringify(buildInlineKeyboard_([
      [{ text: '📋 Задача', callback_data: `clarify_task_${incomingId}` }, { text: '📅 Встреча', callback_data: `clarify_meeting_${incomingId}` }],
      [{ text: '💡 Инсайт', callback_data: `clarify_insight_${incomingId}` }, { text: '🔔 Напоминание', callback_data: `clarify_reminder_${incomingId}` }],
      [{ text: '❌ Отмена', callback_data: `cancel_${incomingId}` }]
    ]))
  });
}

// ============================================================
// STAGE 344 — Weekly Insights Review v1
// ============================================================

async function runWeeklyInsightsReview_(env, userId, chatId) {
  const settings = await getAgentSettings_(env, userId);
  if (!settings.weekly_insights_enabled) return { ok: false, reason: 'disabled' };

  // Gather insights from last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let insights = [];
  try {
    const rows = await env.DB.prepare(`
      SELECT id, text, project, importance, created_at FROM hub_records
      WHERE user_id = ? AND record_type = 'insight' AND include_in_weekly_review = 1 AND created_at >= ?
      ORDER BY created_at DESC LIMIT 30
    `).bind(String(userId), sevenDaysAgo).all();
    insights = rows.results || [];
  } catch (_) {}

  if (!insights.length) {
    if (chatId) await sendTelegramMessage(env, chatId, 'За эту неделю инсайтов не найдено.');
    return { ok: true, insights_count: 0 };
  }

  // LLM analysis
  let analysis = null;
  try {
    analysis = await analyzeInsightsWithLlm_(env, insights);
  } catch (err) {
    if (chatId) await sendTelegramMessage(env, chatId, 'Не удалось проанализировать инсайты: ' + String(err).slice(0, 100));
    return { ok: false, error: String(err) };
  }

  const topInsights = analysis && Array.isArray(analysis.top_insights) ? analysis.top_insights : [];
  if (!topInsights.length) {
    if (chatId) await sendTelegramMessage(env, chatId, 'Инсайты за неделю проанализированы, но нет выделенных топ-инсайтов.');
    return { ok: true, insights_count: insights.length, top_count: 0 };
  }

  let msg = `📊 На этой неделе я выбрал ${topInsights.length} инсайта для обсуждения:\n`;
  for (let i = 0; i < topInsights.length; i++) {
    const ins = topInsights[i];
    msg += `\n${i + 1}. ${ins.title || '—'}\n`;
    if (ins.why_selected) msg += `   Почему важно: ${ins.why_selected}\n`;
    if (ins.discussion_question) msg += `   Вопрос: ${ins.discussion_question}\n`;
  }

  if (chatId) {
    await sendTelegramMessage(env, chatId, msg, {
      reply_markup: JSON.stringify(buildInlineKeyboard_([
        [{ text: '📅 В координацию', callback_data: `weekly_to_coordination_${userId}` }],
        [{ text: '📋 Создать задачи', callback_data: `weekly_to_tasks_${userId}` }],
        [{ text: '💾 Сохранить', callback_data: `weekly_save_${userId}` }, { text: '✖ Пропустить', callback_data: `weekly_skip_${userId}` }]
      ]))
    });
  }

  await logAgentAudit_(env, { user_id: userId, event_type: 'weekly_insights_generated', status: 'ok', result: { insights_count: insights.length, top_count: topInsights.length } });
  return { ok: true, insights_count: insights.length, top_insights: topInsights };
}

async function analyzeInsightsWithLlm_(env, insights) {
  const insightTexts = insights.map((ins, i) => `${i + 1}. ${ins.text || ''} [${ins.project || ''}]`).join('\n');
  const systemPrompt = `You are analyzing weekly insights for a planner system. Select top 3 most important insights. Return ONLY JSON: {"top_insights": [{"title": "...", "why_selected": "...", "discussion_question": "...", "related_project": "..."}]}`;
  const userPrompt = `Insights this week:\n${insightTexts.slice(0, 3000)}`;

  const providers = [];
  if (env && env.GEMINI_API_KEY) providers.push('gemini');
  if (env && env.GROQ_API_KEY) providers.push('groq');
  for (const provider of providers) {
    try {
      const result = await callLlmForClassification_(env, provider, systemPrompt, userPrompt);
      return result;
    } catch (_) {}
  }
  throw new Error('No LLM provider available');
}

// ============================================================
// STAGE 343 / 346 — Hub Records API endpoint
// ============================================================

async function handleAgentHubRecordCreateApi(request, env) {
  if (String(request.method || 'POST').toUpperCase() !== 'POST') return textResponse('Method Not Allowed', 405);
  const body = await readJsonBodySafe(request);
  const url = new URL(request.url);
  const userId = readRequestUserIdFromUrlBodyOrHeader(url, body, request);
  if (!userId) return buildMissingUserIdJsonResponse('/agent/hub/records/create');

  const recordType = String(body.record_type || 'insight').trim();
  const text = String(body.text || '').trim();
  if (!text) return jsonResponse({ ok: false, error: 'text is required' }, { status: 400 });

  const result = await saveHubRecord_(env, {
    userId: String(userId),
    recordType,
    text,
    project: body.project || null,
    importance: body.importance || 'medium',
    tags: body.tags || [],
    include_in_weekly_review: body.include_in_weekly_review !== false,
    source: body.source || 'telegram_agent'
  });

  await logAgentAudit_(env, { user_id: String(userId), event_type: 'hub_record_created', status: result.ok ? 'ok' : 'error', result });
  return jsonResponse({ ...result, build: AGENT_PROPOSAL_BUILD }, { status: result.ok ? 200 : 500 });
}

// ============================================================
// STAGE 348 — Agent Settings API endpoint
// ============================================================

async function handleAgentSettingsApi(request, env) {
  const url = new URL(request.url);
  const method = String(request.method || 'GET').toUpperCase();
  const body = method === 'POST' || method === 'PUT' ? await readJsonBodySafe(request) : {};
  const userId = readRequestUserIdFromUrlBodyOrHeader(url, body, request);
  if (!userId) return buildMissingUserIdJsonResponse('/agent/settings');

  if (method === 'GET') {
    const settings = await getAgentSettings_(env, String(userId));
    return jsonResponse({ ok: true, settings, build: AGENT_PROPOSAL_BUILD });
  }
  if (method === 'POST' || method === 'PUT') {
    const updated = await upsertAgentSettings_(env, String(userId), body.settings || body);
    return jsonResponse({ ok: true, settings: updated, build: AGENT_PROPOSAL_BUILD });
  }
  return textResponse('Method Not Allowed', 405);
}

// ============================================================
// STAGE 347 — Agent Audit API endpoint
// ============================================================

async function handleAgentAuditLogApi(request, env) {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  if (!userId) return buildMissingUserIdJsonResponse('/agent/audit');
  await ensureAgentExtensionSchema(env);
  const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
  const eventType = url.searchParams.get('event_type') || null;
  let rows;
  if (eventType) {
    rows = await env.DB.prepare(`SELECT * FROM agent_audit_log WHERE user_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT ?`).bind(String(userId), eventType, limit).all();
  } else {
    rows = await env.DB.prepare(`SELECT * FROM agent_audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).bind(String(userId), limit).all();
  }
  return jsonResponse({ ok: true, items: rows.results || [], build: AGENT_PROPOSAL_BUILD });
}

// ============================================================
// STAGE 344 — Weekly Insights Trigger API
// ============================================================

async function handleAgentWeeklyInsightsApi(request, env) {
  const url = new URL(request.url);
  const body = await readJsonBodySafe(request).catch(() => ({}));
  const userId = readRequestUserIdFromUrlBodyOrHeader(url, body, request);
  if (!userId) return buildMissingUserIdJsonResponse('/agent/weekly-insights');
  const chatId = body.chat_id || url.searchParams.get('chat_id') || String(userId);
  const result = await runWeeklyInsightsReview_(env, String(userId), chatId);
  return jsonResponse({ ...result, build: AGENT_PROPOSAL_BUILD });
}

// ============================================================
// STAGE 349 — Fallback / QA Helpers
// ============================================================

function isSafeAgentPayload_(payload, actionType) {
  if (!payload || !actionType) return false;
  const task = payload.task || payload;
  if (!String(task.title || '').trim()) return false;
  if (!String(payload.user_id || '').trim()) return false;
  if (!String(payload.confirmation_id || '').trim()) return false;
  return true;
}

async function handleAgentProposalStatusApi(request, env) {
  const url = new URL(request.url);
  const proposalId = url.searchParams.get('proposal_id');
  const userId = url.searchParams.get('user_id');
  if (!proposalId || !userId) return jsonResponse({ ok: false, error: 'proposal_id and user_id required' }, { status: 400 });
  await ensureAgentExtensionSchema(env);
  const proposal = await env.DB.prepare(`SELECT id, user_id, detected_type, status, summary, confidence, created_at, expires_at FROM agent_proposals WHERE id = ? AND user_id = ?`).bind(proposalId, String(userId)).first();
  if (!proposal) return jsonResponse({ ok: false, error: 'not_found' }, { status: 404 });
  return jsonResponse({ ok: true, proposal, build: AGENT_PROPOSAL_BUILD });
}

// ============================================================
// ROUTE REGISTRATIONS — add to main router
// All new routes for stages 336–349
// ============================================================

// To wire these into the main Cloudflare Worker router, add the following
// routing stanzas in the main fetch handler (doFetch / handleRequest):
//
//   if (url.pathname === '/telegram/webhook') return handleAgentTelegramWebhook(request, env);
//   if (url.pathname === '/agent/hub/records/create') return handleAgentHubRecordCreateApi(request, env);
//   if (url.pathname === '/agent/settings') return handleAgentSettingsApi(request, env);
//   if (url.pathname === '/agent/audit') return handleAgentAuditLogApi(request, env);
//   if (url.pathname === '/agent/weekly-insights') return handleAgentWeeklyInsightsApi(request, env);
//   if (url.pathname === '/agent/proposals/status') return handleAgentProposalStatusApi(request, env);

// ============================================================
// END STAGE 336–349 — Telegram Agent Extension v1
// ============================================================
