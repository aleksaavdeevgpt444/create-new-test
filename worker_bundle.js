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
// ============================================================
// WB Operations Chief — Stage 1 (v1)
// Build: ai_helpers_stage1_wb_operations_chief_v1
// Stages: 350–361
//
// Covers:
//   Stage 1.1 — Data Contracts / Snapshot Layer
//   Stage 1.2 — WB Operations Chief Core
//   Stage 1.3 — Daily Marketplace Report Agent
//   Stage 1.4 — SKU Monitor Agent
//   Stage 1.5 — Ads Control Agent
//   Stage 1.6 — Finance / Unit Economics Agent
//   Stage 1.7 — Critical WB Alerts Agent
//   Stage 1.8 — Action Proposal Layer
//   Stage 1.9 — Telegram Report Layer
//   Stage 1.10 — Planner Integration
//   Stage 1.11 — Logging / Audit
//
// Rules:
//   - Calculations are done by code, NOT by AI.
//   - AI is used only for summary text and recommendations.
//   - All risky actions require requires_confirmation: true.
//   - All confirmations require a confirmation_id.
//   - All actions are idempotent.
//   - System never falls if data is missing — writes "нет данных".
//   - System never falls if AI is unavailable — uses fallback summary.
// ============================================================

const WB_OPS_BUILD = 'ai_helpers_stage1_wb_operations_chief_v1';
const WB_OPS_CHIEF = 'wb_operations_chief';
const WB_OPS_MARKETPLACE = 'WB';

// ── SKU Statuses ─────────────────────────────────────────────
const WB_SKU_STATUS = {
  SCALE:   'scale',
  STABLE:  'stable',
  WATCH:   'watch',
  FIX:     'fix',
  RISK:    'risk',
  PAUSE:   'pause',
  EXIT:    'exit',
  UNKNOWN: 'unknown'
};

// ── Finance Statuses ─────────────────────────────────────────
const WB_FINANCE_STATUS = {
  PROFITABLE:    'profitable',
  LOW_MARGIN:    'low_margin',
  BREAK_EVEN:    'break_even',
  LOSS:          'loss',
  CRITICAL_LOSS: 'critical_loss',
  UNKNOWN:       'unknown'
};

// ── Ads Statuses ─────────────────────────────────────────────
const WB_ADS_STATUS = {
  GOOD:     'good',
  WATCH:    'watch',
  RISK:     'risk',
  CRITICAL: 'critical',
  UNKNOWN:  'unknown'
};

// ── Stock Statuses ────────────────────────────────────────────
const WB_STOCK_STATUS = {
  OK:       'ok',
  WATCH:    'watch',
  LOW:      'low',
  CRITICAL: 'critical',
  UNKNOWN:  'unknown'
};

// ── Risk Levels ───────────────────────────────────────────────
const WB_RISK_LEVEL = {
  LOW:      'low',
  MEDIUM:   'medium',
  HIGH:     'high',
  CRITICAL: 'critical'
};

// ── Proposal Statuses ─────────────────────────────────────────
const WB_PROPOSAL_STATUS = {
  WAITING:   'waiting_confirmation',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  APPLIED:   'applied',
  EXPIRED:   'expired'
};

// ── Source Statuses ───────────────────────────────────────────
const WB_SOURCE_STATUS = {
  READY:   'ready',
  PARTIAL: 'partial',
  MISSING: 'missing'
};

// ── Thresholds (CODE logic, not AI) ──────────────────────────
const WB_STOCK_DAYS = { CRITICAL: 3, LOW: 7, WATCH: 14 };
const WB_DRR_LIMIT  = { RISK: 0.30, CRITICAL: 0.50 };
const WB_MARGIN_MIN = { LOW: 0.05, BREAK_EVEN: 0.02 };
const WB_PROPOSAL_TTL_H = 48;

// ============================================================
// Stage 1.1 — DB SCHEMA (9 new tables)
// ============================================================

async function ensureWbOperationsSchema_(db) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS wb_daily_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'WB',
      total_orders INTEGER,
      total_sales_rub REAL,
      total_returns INTEGER,
      total_ad_spend REAL,
      total_profit_before_ads REAL,
      total_profit_after_ads REAL,
      sku_count INTEGER,
      risk_sku_count INTEGER,
      source_status TEXT NOT NULL DEFAULT 'missing',
      missing_sources TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(date, marketplace)
    )`,
    `CREATE TABLE IF NOT EXISTS wb_sku_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'WB',
      nm_id TEXT NOT NULL,
      vendor_code TEXT,
      title TEXT,
      brand TEXT,
      subject TEXT,
      orders_count INTEGER,
      sales_rub REAL,
      returns_count INTEGER,
      stock_total INTEGER,
      days_of_stock REAL,
      ad_spend REAL,
      drr REAL,
      ctr REAL,
      cpc REAL,
      cr_to_cart REAL,
      profit_before_ads REAL,
      profit_after_ads REAL,
      margin_pct_after_ads REAL,
      sku_status TEXT NOT NULL DEFAULT 'unknown',
      missing_fields TEXT,
      source_status TEXT NOT NULL DEFAULT 'missing',
      updated_at TEXT NOT NULL,
      UNIQUE(date, marketplace, nm_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wb_ads_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      nm_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL DEFAULT '',
      campaign_name TEXT,
      ad_spend REAL,
      ad_orders INTEGER,
      ad_sales REAL,
      impressions INTEGER,
      clicks INTEGER,
      ctr REAL,
      cpc REAL,
      cpm REAL,
      cr REAL,
      drr REAL,
      ads_status TEXT NOT NULL DEFAULT 'unknown',
      reason TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(date, nm_id, campaign_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wb_finance_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      nm_id TEXT NOT NULL,
      actual_order_price REAL,
      buyer_price REAL,
      cost_per_unit REAL,
      commission_rub REAL,
      logistics_rub REAL,
      storage_rub REAL,
      tax_rub REAL,
      ad_spend_per_order REAL,
      profit_before_ads REAL,
      profit_after_ads REAL,
      margin_pct_before_ads REAL,
      margin_pct_after_ads REAL,
      finance_status TEXT NOT NULL DEFAULT 'unknown',
      missing_fields TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(date, nm_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wb_stock_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      nm_id TEXT NOT NULL,
      stock_total INTEGER,
      avg_daily_orders_7d REAL,
      avg_daily_orders_14d REAL,
      days_of_stock REAL,
      stock_status TEXT NOT NULL DEFAULT 'unknown',
      recommended_supply_qty INTEGER,
      reason TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(date, nm_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wb_agent_report (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      chief TEXT NOT NULL DEFAULT 'wb_operations_chief',
      summary TEXT,
      source_status TEXT NOT NULL DEFAULT 'missing',
      critical_issues TEXT,
      sku_risks TEXT,
      ads_risks TEXT,
      finance_risks TEXT,
      stock_risks TEXT,
      recommended_actions TEXT,
      proposals TEXT,
      needs_rop_attention TEXT,
      missing_sources TEXT,
      generated_at TEXT NOT NULL,
      UNIQUE(date, chief)
    )`,
    `CREATE TABLE IF NOT EXISTS wb_agent_alerts (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      nm_id TEXT,
      risk_level TEXT NOT NULL,
      message TEXT NOT NULL,
      recommended_action TEXT,
      sent_to_telegram INTEGER DEFAULT 0,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS wb_agent_proposals (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      source_agent TEXT NOT NULL DEFAULT 'wb_operations_chief',
      action_type TEXT NOT NULL,
      title TEXT NOT NULL,
      reason TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      requires_confirmation INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'waiting_confirmation',
      confirmation_id TEXT UNIQUE,
      telegram_chat_id TEXT,
      telegram_message_id TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS wb_action_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      source_agent TEXT NOT NULL DEFAULT 'wb_operations_chief',
      subagent TEXT,
      event_type TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      payload_json TEXT,
      result_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS wb_cost_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nm_id TEXT NOT NULL,
      effective_date TEXT NOT NULL,
      cost_per_unit REAL,
      commission_pct REAL,
      logistics_rub REAL,
      storage_per_day_rub REAL,
      tax_pct REAL,
      notes TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(nm_id, effective_date)
    )`
  ];

  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_wb_sku_date       ON wb_sku_snapshot(date, marketplace)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_ads_date        ON wb_ads_snapshot(date, nm_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_finance_date    ON wb_finance_snapshot(date, nm_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_stock_date      ON wb_stock_snapshot(date, nm_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_alerts_date     ON wb_agent_alerts(date, alert_type)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_proposals_date  ON wb_agent_proposals(date, status)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_action_log_date ON wb_action_log(created_at DESC)`
  ];

  for (const ddl of [...tables, ...indexes]) {
    try {
      await db.prepare(ddl).run();
    } catch (e) {
      if (e.message && !e.message.includes('already exists')) throw e;
    }
  }
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function wbNow_() {
  return new Date().toISOString();
}

function wbYesterday_() {
  const now = new Date();
  now.setDate(now.getDate() - 1);
  // Use Europe/Athens timezone
  const athens = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Athens' }));
  return athens.toISOString().split('T')[0];
}

function wbFormatDate_(isoDate) {
  // YYYY-MM-DD → дд.мм.гггг (user-facing format)
  if (!isoDate) return 'нет даты';
  const p = isoDate.split('-');
  if (p.length !== 3) return isoDate;
  return `${p[2]}.${p[1]}.${p[0]}`;
}

function wbGenerateId_(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function wbSafeJson_(val, fallback = null) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return val;
}

function wbRound_(val, decimals = 2) {
  if (val === null || val === undefined || isNaN(val)) return null;
  const f = Math.pow(10, decimals);
  return Math.round(val * f) / f;
}

function wbPct_(num, denom) {
  if (denom === null || denom === undefined || denom === 0) return null;
  return num / denom;
}

// ============================================================
// Stage 1.11 — AUDIT LOG
// ============================================================

async function wbLog_(db, opts) {
  const {
    user_id = null, source_agent = WB_OPS_CHIEF, subagent = null,
    event_type, entity_type = null, entity_id = null,
    status = 'success', payload = null, result = null, error = null
  } = opts;
  try {
    await db.prepare(`
      INSERT INTO wb_action_log
        (user_id, source_agent, subagent, event_type, entity_type, entity_id,
         status, payload_json, result_json, error_message, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      user_id, source_agent, subagent, event_type, entity_type, entity_id,
      status,
      payload ? JSON.stringify(payload) : null,
      result  ? JSON.stringify(result)  : null,
      error,
      wbNow_()
    ).run();
  } catch (e) {
    console.error('[WB_LOG_ERROR]', e.message);
  }
}

// ============================================================
// Stage 1.1 — DATA LOADING LAYER
// Defines contracts. Replace stubs with real WB API calls.
// ============================================================

async function loadWbSkuData_(env, date) {
  // CONTRACT: { skus: Array<RawSku>, source_status, missing_sources }
  // TODO: WB Statistics API v5 + Content API v2
  if (!env.WB_API_TOKEN) {
    return { skus: [], source_status: WB_SOURCE_STATUS.MISSING, missing_sources: ['WB_API_TOKEN не настроен'] };
  }
  // Placeholder — real integration stub
  return { skus: [], source_status: WB_SOURCE_STATUS.MISSING, missing_sources: ['WB SKU API — интеграция не подключена. Добавьте WB_API_TOKEN и раскомментируйте вызовы API.'] };
}

async function loadWbAdsData_(env, date) {
  // CONTRACT: { ads: Array<RawAds>, source_status, missing_sources }
  // TODO: WB Ads API v2 (adverts/list, adverts/stat)
  if (!env.WB_API_TOKEN) {
    return { ads: [], source_status: WB_SOURCE_STATUS.MISSING, missing_sources: ['WB_API_TOKEN не настроен'] };
  }
  return { ads: [], source_status: WB_SOURCE_STATUS.MISSING, missing_sources: ['WB Ads API — интеграция не подключена'] };
}

async function loadWbStockData_(env, date) {
  // CONTRACT: { stocks: Array<RawStock>, source_status, missing_sources }
  // TODO: WB Warehouse API (warehouses/stocks)
  if (!env.WB_API_TOKEN) {
    return { stocks: [], source_status: WB_SOURCE_STATUS.MISSING, missing_sources: ['WB_API_TOKEN не настроен'] };
  }
  return { stocks: [], source_status: WB_SOURCE_STATUS.MISSING, missing_sources: ['WB Stock API — интеграция не подключена'] };
}

async function loadWbFinanceData_(env, db, date) {
  // CONTRACT: { finance: Array<CostRow>, source_status, missing_sources }
  // Source: wb_cost_data table (populated manually or via import)
  try {
    const rows = await db.prepare(
      `SELECT * FROM wb_cost_data WHERE effective_date <= ? ORDER BY effective_date DESC`
    ).bind(date).all();
    const finance = rows.results || [];
    if (finance.length === 0) {
      return { finance: [], source_status: WB_SOURCE_STATUS.MISSING, missing_sources: ['Себестоимость не внесена — таблица wb_cost_data пуста'] };
    }
    return { finance, source_status: WB_SOURCE_STATUS.READY, missing_sources: [] };
  } catch (e) {
    return { finance: [], source_status: WB_SOURCE_STATUS.MISSING, missing_sources: [`Ошибка загрузки себестоимости: ${e.message}`] };
  }
}

// ============================================================
// Stage 1.1 — SNAPSHOT BUILDERS (pure CODE, no AI)
// ============================================================

function buildSkuSnapshot_(date, rawSku, rawAds, rawFin, rawStock) {
  const nm_id = String(rawSku.nm_id || rawSku.nmId || '');
  if (!nm_id) return null;
  const now = wbNow_();
  const missingFields = [];

  const orders_count  = rawSku.orders_count  ?? rawSku.ordersCount  ?? null;
  const sales_rub     = rawSku.sales_rub     ?? rawSku.salesRub     ?? null;
  const returns_count = rawSku.returns_count ?? rawSku.returnsCount ?? null;

  if (orders_count === null)  missingFields.push('orders_count');
  if (sales_rub    === null)  missingFields.push('sales_rub');

  const stock_total        = rawStock?.quantity    ?? rawStock?.stockTotal    ?? null;
  const avg_daily_orders_7d = rawStock?.avg_7d     ?? null;
  const days_of_stock      = (stock_total !== null && avg_daily_orders_7d && avg_daily_orders_7d > 0)
    ? wbRound_(stock_total / avg_daily_orders_7d, 1) : null;
  if (stock_total === null) missingFields.push('stock_total');

  const ad_spend   = rawAds?.ad_spend   ?? rawAds?.adSpend   ?? null;
  const ad_orders  = rawAds?.ad_orders  ?? rawAds?.adOrders  ?? null;
  const impressions = rawAds?.impressions ?? null;
  const clicks      = rawAds?.clicks     ?? null;

  // All metrics calculated by code
  const drr = (ad_spend !== null && sales_rub && sales_rub > 0)
    ? wbRound_(wbPct_(ad_spend, sales_rub)) : null;
  const ctr = (clicks !== null && impressions && impressions > 0)
    ? wbRound_(wbPct_(clicks, impressions), 4) : null;
  const cpc = (ad_spend !== null && clicks && clicks > 0)
    ? wbRound_(ad_spend / clicks) : null;

  // Finance (code only — requires cost data)
  const cost_per_unit  = rawFin?.cost_per_unit  ?? null;
  const commission_rub = rawFin?.commission_rub ?? null;
  const logistics_rub  = rawFin?.logistics_rub  ?? null;
  const storage_rub    = rawFin?.storage_rub    ?? null;
  const tax_rub        = rawFin?.tax_rub        ?? null;

  let profit_before_ads = null;
  let profit_after_ads  = null;
  let margin_pct_after_ads = null;

  if (sales_rub !== null && cost_per_unit !== null && commission_rub !== null) {
    const units = orders_count ?? 1;
    const total_costs = (cost_per_unit + commission_rub + (logistics_rub ?? 0) + (storage_rub ?? 0) + (tax_rub ?? 0)) * units;
    profit_before_ads = wbRound_(sales_rub - total_costs);
    if (ad_spend !== null) {
      profit_after_ads = wbRound_(profit_before_ads - ad_spend);
      margin_pct_after_ads = sales_rub > 0 ? wbRound_(wbPct_(profit_after_ads, sales_rub)) : null;
    }
  } else {
    if (cost_per_unit  === null) missingFields.push('cost_per_unit');
    if (commission_rub === null) missingFields.push('commission_rub');
  }

  const sku_status = calcSkuStatus_({ orders_count, profit_after_ads, drr, days_of_stock });
  const src = missingFields.length === 0 ? WB_SOURCE_STATUS.READY
    : missingFields.length < 3 ? WB_SOURCE_STATUS.PARTIAL : WB_SOURCE_STATUS.MISSING;

  return {
    date, marketplace: WB_OPS_MARKETPLACE, nm_id,
    vendor_code: rawSku.vendor_code ?? rawSku.vendorCode ?? null,
    title: rawSku.title ?? rawSku.name ?? null,
    brand: rawSku.brand ?? null, subject: rawSku.subject ?? null,
    orders_count, sales_rub, returns_count,
    stock_total, days_of_stock,
    ad_spend, drr, ctr, cpc, cr_to_cart: null,
    profit_before_ads, profit_after_ads, margin_pct_after_ads,
    sku_status, missing_fields: missingFields, source_status: src, updated_at: now
  };
}

function calcSkuStatus_({ orders_count, profit_after_ads, drr, days_of_stock }) {
  if (orders_count === null && profit_after_ads === null) return WB_SKU_STATUS.UNKNOWN;

  if (days_of_stock !== null && days_of_stock <= WB_STOCK_DAYS.CRITICAL) return WB_SKU_STATUS.RISK;
  if (profit_after_ads !== null && profit_after_ads < 0 && drr !== null && drr > WB_DRR_LIMIT.CRITICAL) return WB_SKU_STATUS.RISK;
  if (profit_after_ads !== null && profit_after_ads < 0) return WB_SKU_STATUS.FIX;
  if (drr !== null && drr > WB_DRR_LIMIT.RISK) return WB_SKU_STATUS.WATCH;
  if (days_of_stock !== null && days_of_stock <= WB_STOCK_DAYS.LOW) return WB_SKU_STATUS.WATCH;

  if (profit_after_ads !== null && profit_after_ads > 0 && orders_count !== null && orders_count > 5) {
    return drr !== null && drr < 0.15 ? WB_SKU_STATUS.SCALE : WB_SKU_STATUS.STABLE;
  }
  if (orders_count !== null && orders_count > 0) return WB_SKU_STATUS.STABLE;
  return WB_SKU_STATUS.UNKNOWN;
}

function buildAdsSnapshot_(date, nm_id, rawAds) {
  if (!nm_id || !rawAds) return null;
  const ad_spend   = rawAds.ad_spend   ?? rawAds.adSpend   ?? null;
  const ad_orders  = rawAds.ad_orders  ?? rawAds.adOrders  ?? null;
  const ad_sales   = rawAds.ad_sales   ?? rawAds.adSales   ?? null;
  const impressions = rawAds.impressions ?? null;
  const clicks      = rawAds.clicks     ?? null;

  const ctr = (clicks && impressions && impressions > 0) ? wbRound_(wbPct_(clicks, impressions), 4) : null;
  const cpc = (ad_spend && clicks && clicks > 0)         ? wbRound_(ad_spend / clicks)              : null;
  const cpm = (ad_spend && impressions && impressions > 0)? wbRound_(ad_spend / impressions * 1000)  : null;
  const cr  = (ad_orders !== null && clicks && clicks > 0)? wbRound_(wbPct_(ad_orders, clicks), 4)  : null;
  const drr = (ad_spend !== null && ad_sales && ad_sales > 0) ? wbRound_(wbPct_(ad_spend, ad_sales)) : null;

  const { ads_status, reason } = calcAdsStatus_({ ad_spend, ad_orders, drr, ctr });
  return {
    date, nm_id: String(nm_id),
    campaign_id: rawAds.campaign_id ?? rawAds.campaignId ?? '',
    campaign_name: rawAds.campaign_name ?? rawAds.campaignName ?? null,
    ad_spend, ad_orders, ad_sales, impressions, clicks, ctr, cpc, cpm, cr, drr,
    ads_status, reason, updated_at: wbNow_()
  };
}

function calcAdsStatus_({ ad_spend, ad_orders, drr, ctr }) {
  if (ad_spend === null) return { ads_status: WB_ADS_STATUS.UNKNOWN, reason: 'нет данных о расходе' };
  if (ad_spend > 0 && ad_orders !== null && ad_orders === 0)
    return { ads_status: WB_ADS_STATUS.CRITICAL, reason: 'расход есть, заказов нет' };
  if (drr !== null && drr > WB_DRR_LIMIT.CRITICAL)
    return { ads_status: WB_ADS_STATUS.CRITICAL, reason: `ДРР ${wbRound_(drr * 100)}% — критично` };
  if (drr !== null && drr > WB_DRR_LIMIT.RISK)
    return { ads_status: WB_ADS_STATUS.RISK, reason: `ДРР ${wbRound_(drr * 100)}% — выше нормы` };
  if (ctr !== null && ctr < 0.01 && ad_spend > 0)
    return { ads_status: WB_ADS_STATUS.WATCH, reason: 'низкий CTR — возможна проблема с карточкой' };
  return { ads_status: WB_ADS_STATUS.GOOD, reason: null };
}

function buildFinanceSnapshot_(date, rawSku, rawFin, rawAds) {
  const nm_id = String(rawSku?.nm_id || rawSku?.nmId || '');
  if (!nm_id) return null;
  const missingFields = [];

  const actual_order_price = rawSku?.sales_rub ?? rawSku?.salesRub ?? null;
  const buyer_price        = rawSku?.buyer_price ?? rawSku?.buyerPrice ?? null;
  const orders_count       = rawSku?.orders_count ?? 1;
  const cost_per_unit      = rawFin?.cost_per_unit  ?? null;
  const commission_rub     = rawFin?.commission_rub ?? null;
  const logistics_rub      = rawFin?.logistics_rub  ?? null;
  const storage_rub        = rawFin?.storage_rub    ?? null;
  const tax_rub            = rawFin?.tax_rub        ?? null;
  const ad_spend           = rawAds?.ad_spend ?? rawAds?.adSpend ?? null;

  if (cost_per_unit  === null) missingFields.push('cost_per_unit');
  if (commission_rub === null) missingFields.push('commission_rub');

  const ad_spend_per_order = (ad_spend !== null && orders_count > 0) ? wbRound_(ad_spend / orders_count) : null;

  let profit_before_ads = null, profit_after_ads = null;
  let margin_pct_before_ads = null, margin_pct_after_ads = null;

  if (actual_order_price !== null && cost_per_unit !== null && commission_rub !== null) {
    const cost = cost_per_unit + commission_rub + (logistics_rub ?? 0) + (storage_rub ?? 0) + (tax_rub ?? 0);
    profit_before_ads = wbRound_(actual_order_price - cost);
    margin_pct_before_ads = actual_order_price > 0 ? wbRound_(wbPct_(profit_before_ads, actual_order_price)) : null;
    if (ad_spend_per_order !== null) {
      profit_after_ads  = wbRound_(profit_before_ads - ad_spend_per_order);
      margin_pct_after_ads = actual_order_price > 0 ? wbRound_(wbPct_(profit_after_ads, actual_order_price)) : null;
    }
  }

  return {
    date, nm_id, actual_order_price, buyer_price, cost_per_unit,
    commission_rub, logistics_rub, storage_rub, tax_rub, ad_spend_per_order,
    profit_before_ads, profit_after_ads, margin_pct_before_ads, margin_pct_after_ads,
    finance_status: calcFinanceStatus_({ profit_after_ads, margin_pct_after_ads, missingFields }),
    missing_fields: missingFields, updated_at: wbNow_()
  };
}

function calcFinanceStatus_({ profit_after_ads, margin_pct_after_ads, missingFields }) {
  if (missingFields && missingFields.includes('cost_per_unit')) return WB_FINANCE_STATUS.UNKNOWN;
  if (profit_after_ads === null) return WB_FINANCE_STATUS.UNKNOWN;
  if (profit_after_ads < -100) return WB_FINANCE_STATUS.CRITICAL_LOSS;
  if (profit_after_ads < 0)    return WB_FINANCE_STATUS.LOSS;
  if (margin_pct_after_ads !== null && margin_pct_after_ads <= WB_MARGIN_MIN.BREAK_EVEN) return WB_FINANCE_STATUS.BREAK_EVEN;
  if (margin_pct_after_ads !== null && margin_pct_after_ads <= WB_MARGIN_MIN.LOW)        return WB_FINANCE_STATUS.LOW_MARGIN;
  return WB_FINANCE_STATUS.PROFITABLE;
}

function buildStockSnapshot_(date, nm_id, rawStock) {
  if (!nm_id) return null;
  const stock_total          = rawStock?.quantity          ?? rawStock?.stockTotal        ?? null;
  const avg_daily_orders_7d  = rawStock?.avg_7d            ?? null;
  const avg_daily_orders_14d = rawStock?.avg_14d           ?? null;
  const days_of_stock        = (stock_total !== null && avg_daily_orders_7d && avg_daily_orders_7d > 0)
    ? wbRound_(stock_total / avg_daily_orders_7d, 1) : null;

  const { stock_status, reason, recommended_supply_qty } = calcStockStatus_({ stock_total, days_of_stock, avg_daily_orders_7d });
  return {
    date, nm_id: String(nm_id),
    stock_total, avg_daily_orders_7d, avg_daily_orders_14d, days_of_stock,
    stock_status, recommended_supply_qty, reason, updated_at: wbNow_()
  };
}

function calcStockStatus_({ stock_total, days_of_stock, avg_daily_orders_7d }) {
  if (stock_total === null) return { stock_status: WB_STOCK_STATUS.UNKNOWN, reason: 'нет данных об остатках', recommended_supply_qty: null };
  if (days_of_stock === null) return { stock_status: WB_STOCK_STATUS.UNKNOWN, reason: 'нет данных о заказах для расчёта', recommended_supply_qty: null };

  const supplyQty = avg_daily_orders_7d ? Math.ceil(avg_daily_orders_7d * 30) : null;
  if (days_of_stock <= WB_STOCK_DAYS.CRITICAL)
    return { stock_status: WB_STOCK_STATUS.CRITICAL, reason: `осталось ${days_of_stock} дн. — критично`, recommended_supply_qty: supplyQty };
  if (days_of_stock <= WB_STOCK_DAYS.LOW)
    return { stock_status: WB_STOCK_STATUS.LOW, reason: `осталось ${days_of_stock} дн. — нужна поставка`, recommended_supply_qty: supplyQty };
  if (days_of_stock <= WB_STOCK_DAYS.WATCH)
    return { stock_status: WB_STOCK_STATUS.WATCH, reason: `осталось ${days_of_stock} дн. — следить`, recommended_supply_qty: null };
  return { stock_status: WB_STOCK_STATUS.OK, reason: null, recommended_supply_qty: null };
}

// ============================================================
// SNAPSHOT PERSISTENCE (upsert pattern)
// ============================================================

async function saveSkuSnapshot_(db, s) {
  await db.prepare(`
    INSERT INTO wb_sku_snapshot
      (date,marketplace,nm_id,vendor_code,title,brand,subject,orders_count,sales_rub,returns_count,
       stock_total,days_of_stock,ad_spend,drr,ctr,cpc,cr_to_cart,profit_before_ads,profit_after_ads,
       margin_pct_after_ads,sku_status,missing_fields,source_status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(date,marketplace,nm_id) DO UPDATE SET
      orders_count=excluded.orders_count,sales_rub=excluded.sales_rub,
      returns_count=excluded.returns_count,stock_total=excluded.stock_total,
      days_of_stock=excluded.days_of_stock,ad_spend=excluded.ad_spend,
      drr=excluded.drr,ctr=excluded.ctr,cpc=excluded.cpc,
      profit_before_ads=excluded.profit_before_ads,profit_after_ads=excluded.profit_after_ads,
      margin_pct_after_ads=excluded.margin_pct_after_ads,sku_status=excluded.sku_status,
      missing_fields=excluded.missing_fields,source_status=excluded.source_status,
      updated_at=excluded.updated_at
  `).bind(
    s.date,s.marketplace,s.nm_id,s.vendor_code,s.title,s.brand,s.subject,
    s.orders_count,s.sales_rub,s.returns_count,s.stock_total,s.days_of_stock,
    s.ad_spend,s.drr,s.ctr,s.cpc,s.cr_to_cart,
    s.profit_before_ads,s.profit_after_ads,s.margin_pct_after_ads,
    s.sku_status,JSON.stringify(s.missing_fields||[]),s.source_status,s.updated_at
  ).run();
}

async function saveAdsSnapshot_(db, s) {
  await db.prepare(`
    INSERT INTO wb_ads_snapshot
      (date,nm_id,campaign_id,campaign_name,ad_spend,ad_orders,ad_sales,
       impressions,clicks,ctr,cpc,cpm,cr,drr,ads_status,reason,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(date,nm_id,campaign_id) DO UPDATE SET
      ad_spend=excluded.ad_spend,ad_orders=excluded.ad_orders,ad_sales=excluded.ad_sales,
      impressions=excluded.impressions,clicks=excluded.clicks,ctr=excluded.ctr,
      cpc=excluded.cpc,cpm=excluded.cpm,cr=excluded.cr,drr=excluded.drr,
      ads_status=excluded.ads_status,reason=excluded.reason,updated_at=excluded.updated_at
  `).bind(
    s.date,s.nm_id,s.campaign_id||'',s.campaign_name,s.ad_spend,s.ad_orders,s.ad_sales,
    s.impressions,s.clicks,s.ctr,s.cpc,s.cpm,s.cr,s.drr,s.ads_status,s.reason,s.updated_at
  ).run();
}

async function saveFinanceSnapshot_(db, s) {
  await db.prepare(`
    INSERT INTO wb_finance_snapshot
      (date,nm_id,actual_order_price,buyer_price,cost_per_unit,commission_rub,
       logistics_rub,storage_rub,tax_rub,ad_spend_per_order,profit_before_ads,
       profit_after_ads,margin_pct_before_ads,margin_pct_after_ads,finance_status,
       missing_fields,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(date,nm_id) DO UPDATE SET
      profit_before_ads=excluded.profit_before_ads,profit_after_ads=excluded.profit_after_ads,
      margin_pct_before_ads=excluded.margin_pct_before_ads,
      margin_pct_after_ads=excluded.margin_pct_after_ads,finance_status=excluded.finance_status,
      missing_fields=excluded.missing_fields,updated_at=excluded.updated_at
  `).bind(
    s.date,s.nm_id,s.actual_order_price,s.buyer_price,s.cost_per_unit,s.commission_rub,
    s.logistics_rub,s.storage_rub,s.tax_rub,s.ad_spend_per_order,
    s.profit_before_ads,s.profit_after_ads,s.margin_pct_before_ads,s.margin_pct_after_ads,
    s.finance_status,JSON.stringify(s.missing_fields||[]),s.updated_at
  ).run();
}

async function saveStockSnapshot_(db, s) {
  await db.prepare(`
    INSERT INTO wb_stock_snapshot
      (date,nm_id,stock_total,avg_daily_orders_7d,avg_daily_orders_14d,
       days_of_stock,stock_status,recommended_supply_qty,reason,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(date,nm_id) DO UPDATE SET
      stock_total=excluded.stock_total,days_of_stock=excluded.days_of_stock,
      stock_status=excluded.stock_status,recommended_supply_qty=excluded.recommended_supply_qty,
      reason=excluded.reason,updated_at=excluded.updated_at
  `).bind(
    s.date,s.nm_id,s.stock_total,s.avg_daily_orders_7d,s.avg_daily_orders_14d,
    s.days_of_stock,s.stock_status,s.recommended_supply_qty,s.reason,s.updated_at
  ).run();
}

// ============================================================
// Stage 1.3 — DAILY MARKETPLACE REPORT AGENT
// ============================================================

async function runDailyReportAgent_(db, date) {
  const { results: skus = [] } = await db.prepare(
    `SELECT * FROM wb_sku_snapshot WHERE date=? AND marketplace=?`
  ).bind(date, WB_OPS_MARKETPLACE).all();

  const totalOrders  = skus.reduce((s, r) => s + (r.orders_count ?? 0), 0);
  const totalSales   = skus.reduce((s, r) => s + (r.sales_rub   ?? 0), 0);
  const totalReturns = skus.reduce((s, r) => s + (r.returns_count ?? 0), 0);
  const totalAdSpend = skus.reduce((s, r) => s + (r.ad_spend    ?? 0), 0);
  const totalProfit  = skus.reduce((s, r) => s + (r.profit_after_ads ?? 0), 0);
  const riskSkus     = skus.filter(s => [WB_SKU_STATUS.RISK, WB_SKU_STATUS.FIX].includes(s.sku_status));

  const topSkus  = [...skus].sort((a, b) => (b.sales_rub ?? 0) - (a.sales_rub ?? 0)).slice(0, 5);
  const worstSkus = skus
    .filter(s => s.profit_after_ads !== null)
    .sort((a, b) => (a.profit_after_ads ?? 0) - (b.profit_after_ads ?? 0))
    .slice(0, 5);

  return {
    agent: 'daily_marketplace_report_agent',
    date,
    summary: {
      total_orders:           totalOrders,
      total_sales_rub:        wbRound_(totalSales),
      total_returns:          totalReturns,
      total_ad_spend:         wbRound_(totalAdSpend),
      total_profit_after_ads: wbRound_(totalProfit),
      sku_count:              skus.length,
      risk_sku_count:         riskSkus.length,
      source_status:          skus.length === 0 ? WB_SOURCE_STATUS.MISSING : WB_SOURCE_STATUS.PARTIAL
    },
    top_skus:   topSkus.map(s => ({ nm_id: s.nm_id, title: s.title, sales_rub: s.sales_rub, orders_count: s.orders_count })),
    worst_skus: worstSkus.map(s => ({ nm_id: s.nm_id, title: s.title, profit_after_ads: s.profit_after_ads })),
    risk_skus:  riskSkus.map(s => ({ nm_id: s.nm_id, status: s.sku_status, drr: s.drr, profit_after_ads: s.profit_after_ads })),
    data_available: skus.length > 0
  };
}

// ============================================================
// Stage 1.4 — SKU MONITOR AGENT
// ============================================================

async function runSkuMonitorAgent_(db, date) {
  const { results: skus = [] } = await db.prepare(
    `SELECT * FROM wb_sku_snapshot WHERE date=? AND marketplace=?`
  ).bind(date, WB_OPS_MARKETPLACE).all();

  const cards = skus.map(sku => {
    let main_problem = null;
    let recommended_action = null;

    if (sku.sku_status === WB_SKU_STATUS.RISK) {
      if (sku.profit_after_ads !== null && sku.profit_after_ads < 0) {
        main_problem = 'артикул в убытке';
        recommended_action = 'проверить рекламу, карточку и цену';
      } else if (sku.drr !== null && sku.drr > WB_DRR_LIMIT.CRITICAL) {
        main_problem = `высокий ДРР ${wbRound_(sku.drr * 100)}%`;
        recommended_action = 'снизить рекламный бюджет или остановить кампанию';
      } else {
        main_problem = `критически мало остатков (${sku.days_of_stock} дн.)`;
        recommended_action = 'срочно подготовить поставку';
      }
    } else if (sku.sku_status === WB_SKU_STATUS.FIX) {
      main_problem = 'показатели требуют улучшения';
      recommended_action = 'проверить карточку, рекламу и цену';
    } else if (sku.sku_status === WB_SKU_STATUS.WATCH) {
      main_problem = sku.drr !== null && sku.drr > WB_DRR_LIMIT.RISK
        ? `ДРР ${wbRound_(sku.drr * 100)}% — выше нормы`
        : `остатков на ${sku.days_of_stock} дн.`;
      recommended_action = 'мониторить ежедневно';
    }

    const priority = sku.sku_status === WB_SKU_STATUS.RISK ? 'high'
      : [WB_SKU_STATUS.FIX, WB_SKU_STATUS.WATCH].includes(sku.sku_status) ? 'medium' : 'low';

    return {
      sku: sku.nm_id, title: sku.title, status: sku.sku_status,
      orders_count: sku.orders_count, profit_after_ads: sku.profit_after_ads,
      drr: sku.drr, days_of_stock: sku.days_of_stock,
      main_problem, recommended_action, priority,
      missing_data: (wbSafeJson_(sku.missing_fields, [])).length > 0
    };
  });

  return {
    agent: 'sku_monitor_agent',
    date,
    total_skus: cards.length,
    cards,
    attention_needed: cards.filter(c => c.priority !== 'low')
  };
}

// ============================================================
// Stage 1.5 — ADS CONTROL AGENT
// ============================================================

async function runAdsControlAgent_(db, date) {
  const { results: ads = [] } = await db.prepare(
    `SELECT * FROM wb_ads_snapshot WHERE date=?`
  ).bind(date).all();

  const risks = [];
  const opportunities = [];

  for (const ad of ads) {
    if ([WB_ADS_STATUS.CRITICAL, WB_ADS_STATUS.RISK].includes(ad.ads_status)) {
      risks.push({
        type: 'ads_risk',
        sku: ad.nm_id,
        campaign_id: ad.campaign_id || null,
        problem: ad.reason,
        risk_level: ad.ads_status === WB_ADS_STATUS.CRITICAL ? WB_RISK_LEVEL.CRITICAL : WB_RISK_LEVEL.HIGH,
        recommendation: (ad.ad_spend > 0 && ad.ad_orders === 0)
          ? 'остановить кампанию: расход без заказов'
          : 'снизить бюджет и проверить карточку',
        requires_confirmation: true
      });
    }
    if (ad.ads_status === WB_ADS_STATUS.GOOD && ad.drr !== null && ad.drr < 0.10) {
      opportunities.push({
        sku: ad.nm_id,
        type: 'scale_opportunity',
        reason: `ДРР ${wbRound_(ad.drr * 100)}% — реклама эффективна`,
        recommendation: 'рассмотреть увеличение бюджета'
      });
    }
  }

  return { agent: 'ads_control_agent', date, total_campaigns: ads.length, risks, opportunities, data_available: ads.length > 0 };
}

// ============================================================
// Stage 1.6 — FINANCE / UNIT ECONOMICS AGENT
// ============================================================

async function runFinanceAgent_(db, date) {
  const { results: fins = [] } = await db.prepare(
    `SELECT * FROM wb_finance_snapshot WHERE date=?`
  ).bind(date).all();

  const risks    = [];
  const unknowns = [];

  for (const fin of fins) {
    if (fin.finance_status === WB_FINANCE_STATUS.UNKNOWN) {
      unknowns.push({ sku: fin.nm_id, missing_fields: wbSafeJson_(fin.missing_fields, []) });
      continue;
    }
    if ([WB_FINANCE_STATUS.LOSS, WB_FINANCE_STATUS.CRITICAL_LOSS].includes(fin.finance_status)) {
      risks.push({
        sku: fin.nm_id,
        finance_status: fin.finance_status,
        profit_after_ads: fin.profit_after_ads,
        margin_pct_after_ads: fin.margin_pct_after_ads,
        main_loss_factor: (fin.ad_spend_per_order && fin.profit_before_ads > 0) ? 'ad_spend' : 'cost_or_commission',
        recommendation: 'проверить рекламу и карточку до масштабирования'
      });
    }
  }

  return {
    agent: 'finance_unit_economics_agent', date,
    total_skus:          fins.length,
    loss_count:          risks.filter(r => r.finance_status === WB_FINANCE_STATUS.LOSS).length,
    critical_loss_count: risks.filter(r => r.finance_status === WB_FINANCE_STATUS.CRITICAL_LOSS).length,
    risks, no_cost_data: unknowns,
    data_available: fins.length > 0
  };
}

// ============================================================
// Stage 1.7 — CRITICAL WB ALERTS AGENT
// ============================================================

async function runCriticalAlertsAgent_(db, date, skuMonitor, adsControl, financeResult) {
  const rawAlerts = [];

  // Consecutive loss check (2 days in a row)
  const prevDate = (() => {
    const d = new Date(date);
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  })();
  const { results: prevFins = [] } = await db.prepare(
    `SELECT nm_id FROM wb_finance_snapshot WHERE date=? AND finance_status IN ('loss','critical_loss')`
  ).bind(prevDate).all();
  const prevLossSet = new Set(prevFins.map(f => f.nm_id));

  for (const risk of financeResult.risks || []) {
    if (prevLossSet.has(risk.sku)) {
      rawAlerts.push({
        alert_type: 'consecutive_loss', sku: risk.sku,
        risk_level: WB_RISK_LEVEL.CRITICAL,
        message: `Артикул ${risk.sku} минусовой 2 дня подряд`,
        recommended_action: 'проверить рекламу, карточку и цену сегодня'
      });
    } else {
      rawAlerts.push({
        alert_type: 'critical_loss', sku: risk.sku,
        risk_level: WB_RISK_LEVEL.HIGH,
        message: `Артикул ${risk.sku} в убытке: ${risk.profit_after_ads} руб.`,
        recommended_action: 'проверить рекламу и цену'
      });
    }
  }

  // Ads: spend with no orders
  for (const risk of adsControl.risks || []) {
    if (risk.risk_level === WB_RISK_LEVEL.CRITICAL) {
      rawAlerts.push({
        alert_type: 'ads_spend_no_orders', sku: risk.sku,
        risk_level: WB_RISK_LEVEL.CRITICAL,
        message: `Артикул ${risk.sku}: ${risk.problem}`,
        recommended_action: risk.recommendation
      });
    }
  }

  // Stock critical
  const { results: stockCritical = [] } = await db.prepare(
    `SELECT * FROM wb_stock_snapshot WHERE date=? AND stock_status IN ('critical','low')`
  ).bind(date).all();
  for (const st of stockCritical) {
    rawAlerts.push({
      alert_type: st.stock_status === WB_STOCK_STATUS.CRITICAL ? 'stock_critical' : 'stock_low',
      sku: st.nm_id,
      risk_level: st.stock_status === WB_STOCK_STATUS.CRITICAL ? WB_RISK_LEVEL.CRITICAL : WB_RISK_LEVEL.HIGH,
      message: st.reason || `Остатки SKU ${st.nm_id}: ${st.days_of_stock} дн.`,
      recommended_action: st.recommended_supply_qty
        ? `подготовить поставку ~${st.recommended_supply_qty} шт.`
        : 'проверить остатки и подготовить поставку'
    });
  }

  // Deduplicate via idempotency_key — same alert per day is saved only once
  const savedAlerts = [];
  for (const alert of rawAlerts) {
    const idem_key = `${date}_${alert.alert_type}_${alert.sku || 'global'}`;
    try {
      const id = wbGenerateId_('alert');
      await db.prepare(`
        INSERT INTO wb_agent_alerts
          (id,date,alert_type,nm_id,risk_level,message,recommended_action,idempotency_key,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(idempotency_key) DO NOTHING
      `).bind(id, date, alert.alert_type, alert.sku ?? null, alert.risk_level,
               alert.message, alert.recommended_action, idem_key, wbNow_()).run();
      savedAlerts.push({ ...alert, idempotency_key: idem_key });
    } catch (e) {
      console.error('[WB_ALERTS] save error', e.message);
    }
  }

  return {
    agent: 'critical_wb_alerts_agent', date,
    total_alerts: savedAlerts.length,
    critical_count: savedAlerts.filter(a => a.risk_level === WB_RISK_LEVEL.CRITICAL).length,
    alerts: savedAlerts
  };
}

// ============================================================
// Stage 1.8 — ACTION PROPOSAL LAYER
// ============================================================

async function createWbProposal_(db, opts) {
  const {
    date, source_agent = WB_OPS_CHIEF, action_type,
    title, reason, priority = 'medium',
    telegram_chat_id = null, payload = null
  } = opts;

  const id             = wbGenerateId_('prop');
  const confirmation_id = `conf_wb_${id}`;
  const now            = wbNow_();
  const expires_at     = new Date(Date.now() + WB_PROPOSAL_TTL_H * 3600000).toISOString();

  await db.prepare(`
    INSERT INTO wb_agent_proposals
      (id,date,source_agent,action_type,title,reason,priority,requires_confirmation,
       status,confirmation_id,telegram_chat_id,payload_json,created_at,updated_at,expires_at)
    VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)
  `).bind(
    id, date, source_agent, action_type, title, reason, priority,
    WB_PROPOSAL_STATUS.WAITING, confirmation_id, telegram_chat_id,
    payload ? JSON.stringify(payload) : null,
    now, now, expires_at
  ).run();

  return { id, confirmation_id, title, action_type, priority, status: WB_PROPOSAL_STATUS.WAITING };
}

async function buildWbProposals_(db, date, skuMonitor, adsControl, financeResult) {
  const proposals = [];

  // High-risk SKUs → check_ads proposal
  for (const card of (skuMonitor.attention_needed || []).filter(c => c.priority === 'high').slice(0, 5)) {
    const prop = await createWbProposal_(db, {
      date, action_type: 'check_ads',
      title: `Проверить артикул ${card.sku}${card.title ? ' — ' + card.title.slice(0, 30) : ''}`,
      reason: card.main_problem || 'высокий риск',
      priority: 'high',
      payload: { nm_id: card.sku, status: card.status }
    });
    proposals.push(prop);
  }

  // Critical ads risks → check_ads proposal
  for (const risk of (adsControl.risks || []).filter(r => r.risk_level === WB_RISK_LEVEL.CRITICAL).slice(0, 3)) {
    const prop = await createWbProposal_(db, {
      date, action_type: 'check_ads',
      title: `Проверить рекламу SKU ${risk.sku}`,
      reason: risk.problem,
      priority: 'high',
      payload: { nm_id: risk.sku, campaign_id: risk.campaign_id }
    });
    proposals.push(prop);
  }

  // Stock critical → prepare_supply proposal
  const { results: critStocks = [] } = await db.prepare(
    `SELECT * FROM wb_stock_snapshot WHERE date=? AND stock_status='critical'`
  ).bind(date).all();
  for (const st of critStocks.slice(0, 3)) {
    const prop = await createWbProposal_(db, {
      date, action_type: 'prepare_supply',
      title: `Подготовить поставку SKU ${st.nm_id}`,
      reason: st.reason || 'критически мало остатков',
      priority: 'high',
      payload: { nm_id: st.nm_id, qty: st.recommended_supply_qty }
    });
    proposals.push(prop);
  }

  return proposals;
}

// ============================================================
// MODEL GATEWAY (Gemini → Groq fallback)
// ============================================================

async function generateWbSummaryWithAi_(env, ctx) {
  const { date, dailyReport, skuMonitor, adsControl, financeResult, alertsResult } = ctx;
  const d  = dailyReport.summary;
  const top = skuMonitor.cards.filter(c => c.status === WB_SKU_STATUS.RISK).slice(0, 5);

  const prompt = `Ты — AI-шеф WB Operations. Напиши рабочее summary отчёта.

Дата: ${wbFormatDate_(date)}
РАСЧЁТНЫЕ ДАННЫЕ (не придумывай цифры):
• Продажи: ${d.total_sales_rub ?? 'нет данных'} руб.
• Заказы: ${d.total_orders ?? 'нет данных'}
• Возвраты: ${d.total_returns ?? 'нет данных'}
• Расход рекламы: ${d.total_ad_spend ?? 'нет данных'} руб.
• Прибыль после рекламы: ${d.total_profit_after_ads ?? 'нет данных'} руб.
• Артикулов в риске: ${d.risk_sku_count}
• Критичных alert: ${alertsResult.critical_count}
• Убыточных SKU: ${financeResult.loss_count + financeResult.critical_loss_count}
• SKU в риске: ${top.map(s => `${s.sku} (${s.main_problem || 'риск'})`).join(', ') || 'нет'}
• Проблемы рекламы: ${adsControl.risks.slice(0,3).map(r => r.problem).join(', ') || 'нет'}
• Статус данных: ${d.source_status}

ТРЕБОВАНИЯ: не придумывай цифры. Если данных нет — пиши "нет данных".
Пиши по-русски, кратко, деловой стиль, 3–5 предложений.
Начни с главного: что важно сегодня.`;

  if (env.GEMINI_API_KEY) {
    try {
      const model = env.GEMINI_CLASSIFICATION_MODEL || 'gemini-1.5-flash-latest';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
      );
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
    } catch (e) {
      console.error('[WB_AI] Gemini failed:', e.message);
    }
  }

  if (env.GROQ_API_KEY) {
    const base  = env.GROQ_API_BASE  || 'https://api.groq.com/openai/v1';
    const model = env.GROQ_MODEL     || 'llama3-8b-8192';
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 500 })
    });
    if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (text) return text;
  }

  throw new Error('Нет доступного AI-провайдера');
}

function buildFallbackSummary_({ date, dailyReport, alertsResult }) {
  const d = dailyReport.summary;
  const parts = [`Отчёт WB Operations за ${wbFormatDate_(date)}.`];
  if (d.source_status === WB_SOURCE_STATUS.MISSING) {
    parts.push('Данные WB API не получены. AI-summary временно недоступен.');
  } else {
    if (d.total_sales_rub)     parts.push(`Продажи: ${d.total_sales_rub} руб., заказы: ${d.total_orders}.`);
    if (d.risk_sku_count > 0)  parts.push(`Артикулов в риске: ${d.risk_sku_count}.`);
    if (alertsResult.critical_count > 0) parts.push(`Критичных alert: ${alertsResult.critical_count}.`);
  }
  return parts.join(' ');
}

// ============================================================
// Stage 1.2 — WB OPERATIONS CHIEF (Orchestrator)
// ============================================================

async function runWbOperationsChief_(env, date, userId) {
  const db       = env.DB;
  const reportId = `wb_report_${date}`;
  const now      = wbNow_();

  await ensureWbOperationsSchema_(db);
  await wbLog_(db, { user_id: userId, event_type: 'report_started', entity_type: 'report', entity_id: reportId, payload: { date } });

  // 1. Load raw data in parallel (fail-safe: each loader returns empty on error)
  const [rawSkuResult, rawAdsResult, rawFinanceResult, rawStockResult] = await Promise.all([
    loadWbSkuData_(env, date),
    loadWbAdsData_(env, date),
    loadWbFinanceData_(env, db, date),
    loadWbStockData_(env, date)
  ]);

  const allMissingSources = [
    ...(rawSkuResult.missing_sources  || []),
    ...(rawAdsResult.missing_sources  || []),
    ...(rawFinanceResult.missing_sources || []),
    ...(rawStockResult.missing_sources || [])
  ];

  // 2. Build index maps
  const skus     = rawSkuResult.skus     || [];
  const adsMap   = {};
  const finMap   = {};
  const stockMap = {};
  for (const ad of rawAdsResult.ads    || []) adsMap[String(ad.nm_id   || ad.nmId   || '')] = ad;
  for (const f  of rawFinanceResult.finance || []) finMap[String(f.nm_id    || f.nmId    || '')] = f;
  for (const st of rawStockResult.stocks || []) stockMap[String(st.nm_id  || st.nmId  || '')] = st;

  // 3. Save snapshots (checkpoint per SKU — safe to retry)
  for (const rawSku of skus) {
    const nm_id = String(rawSku.nm_id || rawSku.nmId || '');
    if (!nm_id) continue;
    try {
      const skuSnap   = buildSkuSnapshot_(date, rawSku, adsMap[nm_id], finMap[nm_id], stockMap[nm_id]);
      const adsSnap   = adsMap[nm_id]   ? buildAdsSnapshot_(date, nm_id, adsMap[nm_id])               : null;
      const finSnap   = buildFinanceSnapshot_(date, rawSku, finMap[nm_id], adsMap[nm_id]);
      const stockSnap = buildStockSnapshot_(date, nm_id, stockMap[nm_id]);

      if (skuSnap)   await saveSkuSnapshot_(db, skuSnap);
      if (adsSnap)   await saveAdsSnapshot_(db, adsSnap);
      if (finSnap)   await saveFinanceSnapshot_(db, finSnap);
      if (stockSnap) await saveStockSnapshot_(db, stockSnap);
    } catch (e) {
      await wbLog_(db, { user_id: userId, subagent: 'snapshot_builder', event_type: 'snapshot_error', entity_id: nm_id, status: 'error', error: e.message });
    }
  }

  await wbLog_(db, { user_id: userId, event_type: 'snapshots_saved', payload: { sku_count: skus.length } });

  // 4. Run sub-agents (read from DB snapshots — code logic only)
  const [dailyReport, skuMonitor, adsControl, financeResult] = await Promise.all([
    runDailyReportAgent_(db, date),
    runSkuMonitorAgent_(db, date),
    runAdsControlAgent_(db, date),
    runFinanceAgent_(db, date)
  ]);
  const alertsResult = await runCriticalAlertsAgent_(db, date, skuMonitor, adsControl, financeResult);

  await wbLog_(db, { user_id: userId, event_type: 'subagents_complete',
    payload: { alerts: alertsResult.total_alerts, risks_sku: skuMonitor.attention_needed.length }
  });

  // 5. Build proposals (safe idempotent — new proposals only)
  const proposals = await buildWbProposals_(db, date, skuMonitor, adsControl, financeResult);
  await wbLog_(db, { user_id: userId, event_type: 'proposals_created', payload: { count: proposals.length } });

  // 6. AI summary (graceful degradation if AI is unavailable)
  let summary = null;
  try {
    summary = await generateWbSummaryWithAi_(env, { date, dailyReport, skuMonitor, adsControl, financeResult, alertsResult });
  } catch (e) {
    summary = buildFallbackSummary_({ date, dailyReport, alertsResult });
    await wbLog_(db, { user_id: userId, subagent: 'model_gateway', event_type: 'ai_summary_fallback', status: 'warn', error: e.message });
  }

  // 7. Compile report object
  const sourceStatus = allMissingSources.length === 0 ? WB_SOURCE_STATUS.READY
    : skus.length > 0 ? WB_SOURCE_STATUS.PARTIAL : WB_SOURCE_STATUS.MISSING;

  const report = {
    chief: WB_OPS_CHIEF, period: date, summary, source_status: sourceStatus,
    critical_issues:      alertsResult.alerts.filter(a => a.risk_level === WB_RISK_LEVEL.CRITICAL),
    sku_risks:            skuMonitor.attention_needed,
    ads_risks:            adsControl.risks,
    finance_risks:        financeResult.risks,
    stock_risks:          [],
    recommended_actions:  proposals.map(p => ({ title: p.title, priority: p.priority, proposal_id: p.id })),
    proposals,
    needs_rop_attention:  alertsResult.alerts.filter(a => a.alert_type === 'consecutive_loss'),
    missing_sources:      allMissingSources,
    generated_at:         now
  };

  // 8. Save report (upsert — safe for re-runs on same date)
  await db.prepare(`
    INSERT INTO wb_agent_report
      (id,date,chief,summary,source_status,critical_issues,sku_risks,ads_risks,
       finance_risks,stock_risks,recommended_actions,proposals,needs_rop_attention,
       missing_sources,generated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(date,chief) DO UPDATE SET
      summary=excluded.summary,source_status=excluded.source_status,
      critical_issues=excluded.critical_issues,sku_risks=excluded.sku_risks,
      ads_risks=excluded.ads_risks,finance_risks=excluded.finance_risks,
      recommended_actions=excluded.recommended_actions,proposals=excluded.proposals,
      missing_sources=excluded.missing_sources,generated_at=excluded.generated_at
  `).bind(
    reportId, date, WB_OPS_CHIEF, summary, sourceStatus,
    JSON.stringify(report.critical_issues),  JSON.stringify(report.sku_risks),
    JSON.stringify(report.ads_risks),        JSON.stringify(report.finance_risks),
    JSON.stringify(report.stock_risks),      JSON.stringify(report.recommended_actions),
    JSON.stringify(proposals),               JSON.stringify(report.needs_rop_attention),
    JSON.stringify(allMissingSources),       now
  ).run();

  await wbLog_(db, { user_id: userId, event_type: 'report_complete', entity_id: reportId,
    result: { proposals: proposals.length, alerts: alertsResult.total_alerts, source_status: sourceStatus }
  });

  return report;
}

// ============================================================
// Stage 1.9 — TELEGRAM REPORT LAYER
// ============================================================

function formatWbTelegramReport_(report, date) {
  const d = wbFormatDate_(date);
  const lines = [`📊 *WB Operations — отчёт за ${d}*\n`];

  if (report.source_status === WB_SOURCE_STATUS.MISSING) {
    lines.push('⚠️ *Данные не получены*');
    if (report.missing_sources?.length) lines.push(`Источники: ${report.missing_sources.slice(0, 3).join('; ')}`);
    lines.push('\nДля настройки: добавьте WB\\_API\\_TOKEN и подключите интеграции.');
    return lines.join('\n');
  }

  if (report.summary) {
    lines.push('*1\\. Общая картина:*');
    lines.push(report.summary.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&'));
    lines.push('');
  }

  if (report.critical_issues?.length) {
    lines.push(`*🚨 Критичные проблемы (${report.critical_issues.length}):*`);
    for (const iss of report.critical_issues.slice(0, 5)) {
      lines.push(`• ${iss.message}`);
    }
    lines.push('');
  }

  if (report.sku_risks?.length) {
    lines.push(`*2\\. Артикулы в риске (${report.sku_risks.length}):*`);
    for (const s of report.sku_risks.slice(0, 5)) {
      lines.push(`• SKU ${s.sku}${s.title ? ' — ' + s.title.slice(0, 25) : ''}: ${s.main_problem || s.status}`);
    }
    lines.push('');
  }

  if (report.ads_risks?.length) {
    lines.push(`*3\\. Реклама — проблемы (${report.ads_risks.length}):*`);
    for (const r of report.ads_risks.slice(0, 3)) {
      lines.push(`• SKU ${r.sku}: ${r.problem}`);
    }
    lines.push('');
  }

  if (report.finance_risks?.length) {
    lines.push(`*4\\. Финансы — убыточные (${report.finance_risks.length}):*`);
    for (const f of report.finance_risks.slice(0, 3)) {
      lines.push(`• SKU ${f.sku}: ${f.profit_after_ads} руб\\. (${f.finance_status})`);
    }
    lines.push('');
  }

  if (report.recommended_actions?.length) {
    lines.push('*5\\. Что сделать сегодня:*');
    report.recommended_actions.slice(0, 5).forEach((a, i) => {
      lines.push(`${i + 1}\\. ${a.title} \\[${a.priority}\\]`);
    });
  }

  if (report.missing_sources?.length) {
    lines.push('');
    lines.push(`_⚠️ Недостаточно данных: ${report.missing_sources.slice(0, 2).join('; ')}_`);
  }

  return lines.join('\n');
}

function buildWbReportKeyboard_(proposals) {
  if (!proposals?.length) return null;
  const rows = proposals.slice(0, 3).map(p => ([{
    text: `✅ ${p.title.slice(0, 35)}`,
    callback_data: `wb_confirm_${p.id}`
  }]));
  rows.push([
    { text: '📋 Задачи',    callback_data: 'wb_cmd_tasks'   },
    { text: '🚨 Риски',     callback_data: 'wb_cmd_risks'   },
    { text: '📊 Реклама',   callback_data: 'wb_cmd_ads'     }
  ]);
  return { inline_keyboard: rows };
}

async function sendWbTelegramMessage_(env, chatId, text, keyboard) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return false;
  const MAX = 3800;
  const chunks = [];
  let rem = text;
  while (rem.length > MAX) {
    let split = rem.lastIndexOf('\n', MAX);
    if (split < 0) split = MAX;
    chunks.push(rem.slice(0, split));
    rem = rem.slice(split).trimStart();
  }
  if (rem.length) chunks.push(rem);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const payload = {
      chat_id: chatId, text: chunks[i], parse_mode: 'MarkdownV2',
      ...(isLast && keyboard ? { reply_markup: keyboard } : {})
    };
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      if (!res.ok) {
        const err = await res.text();
        console.error('[WB_TG] sendMessage error:', err);
      }
    } catch (e) {
      console.error('[WB_TG] fetch error:', e.message);
    }
  }
  return true;
}

// ── Telegram Command Handlers ────────────────────────────────

async function handleWbTodayCommand_(env, chatId, userId) {
  const db   = env.DB;
  const date = wbYesterday_();
  await ensureWbOperationsSchema_(db);

  const row = await db.prepare(
    `SELECT * FROM wb_agent_report WHERE date=? AND chief=?`
  ).bind(date, WB_OPS_CHIEF).first();

  if (!row) {
    await sendWbTelegramMessage_(env, chatId,
      `📊 WB Operations\n\nОтчёт за ${wbFormatDate_(date)} не найден\\.\n\nЗапустите: /wb\\_run`, null);
    return;
  }

  const report = {
    source_status:      row.source_status,
    summary:            row.summary,
    critical_issues:    wbSafeJson_(row.critical_issues,    []),
    sku_risks:          wbSafeJson_(row.sku_risks,          []),
    ads_risks:          wbSafeJson_(row.ads_risks,          []),
    finance_risks:      wbSafeJson_(row.finance_risks,      []),
    recommended_actions:wbSafeJson_(row.recommended_actions,[]),
    missing_sources:    wbSafeJson_(row.missing_sources,    []),
    proposals:          wbSafeJson_(row.proposals,          [])
  };
  const text     = formatWbTelegramReport_(report, date);
  const keyboard = buildWbReportKeyboard_(report.proposals);
  await sendWbTelegramMessage_(env, chatId, text, keyboard);
}

async function handleWbRunCommand_(env, chatId, userId) {
  const date = wbYesterday_();
  await sendWbTelegramMessage_(env, chatId,
    `🔄 Запускаю WB Operations отчёт за ${wbFormatDate_(date)}\\.\\.\\. Это займёт несколько секунд\\.`, null);
  try {
    const report   = await runWbOperationsChief_(env, date, String(userId));
    const text     = formatWbTelegramReport_(report, date);
    const keyboard = buildWbReportKeyboard_(report.proposals);
    await sendWbTelegramMessage_(env, chatId, text, keyboard);
  } catch (e) {
    await sendWbTelegramMessage_(env, chatId, `❌ Ошибка при формировании отчёта: ${e.message}`, null);
  }
}

async function handleWbRisksCommand_(env, chatId) {
  const db   = env.DB;
  const date = wbYesterday_();
  await ensureWbOperationsSchema_(db);

  const { results: rows = [] } = await db.prepare(
    `SELECT * FROM wb_agent_alerts WHERE date=? ORDER BY risk_level DESC LIMIT 20`
  ).bind(date).all();

  if (!rows.length) {
    await sendWbTelegramMessage_(env, chatId, `✅ WB — нет критичных рисков за ${wbFormatDate_(date)}`, null);
    return;
  }
  const lines = [`🚨 *WB — Риски за ${wbFormatDate_(date)}*\n`];
  for (const a of rows) {
    const icon = a.risk_level === WB_RISK_LEVEL.CRITICAL ? '🔴' : a.risk_level === WB_RISK_LEVEL.HIGH ? '🟠' : '🟡';
    lines.push(`${icon} *${a.alert_type}*${a.nm_id ? ` — SKU ${a.nm_id}` : ''}`);
    lines.push(`   ${a.message}`);
    if (a.recommended_action) lines.push(`   → ${a.recommended_action}`);
    lines.push('');
  }
  await sendWbTelegramMessage_(env, chatId, lines.join('\n'), null);
}

async function handleWbSkuCommand_(env, chatId, nmId) {
  if (!nmId) {
    await sendWbTelegramMessage_(env, chatId, '❌ Укажите артикул: /wb\\_sku 575556886', null);
    return;
  }
  const db   = env.DB;
  const date = wbYesterday_();
  await ensureWbOperationsSchema_(db);

  const [skuRow, finRow, adsRow, stockRow] = await Promise.all([
    db.prepare(`SELECT * FROM wb_sku_snapshot     WHERE date=? AND nm_id=?`).bind(date, nmId).first(),
    db.prepare(`SELECT * FROM wb_finance_snapshot WHERE date=? AND nm_id=?`).bind(date, nmId).first(),
    db.prepare(`SELECT * FROM wb_ads_snapshot     WHERE date=? AND nm_id=?`).bind(date, nmId).first(),
    db.prepare(`SELECT * FROM wb_stock_snapshot   WHERE date=? AND nm_id=?`).bind(date, nmId).first()
  ]);

  if (!skuRow) {
    await sendWbTelegramMessage_(env, chatId, `❌ Артикул ${nmId} не найден за ${wbFormatDate_(date)}`, null);
    return;
  }

  const lines = [
    `📦 *Артикул ${nmId}*${skuRow.title ? '\n' + skuRow.title.slice(0, 50) : ''}\n`,
    `Дата: ${wbFormatDate_(date)} | Статус: *${skuRow.sku_status}*\n`,
    `*Продажи:*`,
    `• Заказы: ${skuRow.orders_count ?? 'нет данных'}`,
    `• Выручка: ${skuRow.sales_rub ?? 'нет данных'} руб\\.`,
    `• Возвраты: ${skuRow.returns_count ?? 'нет данных'}`,
    ''
  ];
  if (finRow) {
    lines.push('*Финансы:*');
    lines.push(`• Прибыль до рекламы: ${finRow.profit_before_ads ?? 'нет данных'} руб\\.`);
    lines.push(`• Прибыль после рекламы: ${finRow.profit_after_ads ?? 'нет данных'} руб\\.`);
    lines.push(`• Маржа: ${finRow.margin_pct_after_ads !== null ? wbRound_(finRow.margin_pct_after_ads * 100) + '%' : 'нет данных'}`);
    lines.push(`• Статус: ${finRow.finance_status}`);
    lines.push('');
  }
  if (adsRow) {
    lines.push('*Реклама:*');
    lines.push(`• Расход: ${adsRow.ad_spend ?? 'нет данных'} руб\\.`);
    lines.push(`• ДРР: ${adsRow.drr !== null ? wbRound_(adsRow.drr * 100) + '%' : 'нет данных'}`);
    lines.push(`• CTR: ${adsRow.ctr !== null ? wbRound_(adsRow.ctr * 100, 2) + '%' : 'нет данных'}`);
    lines.push(`• Статус: ${adsRow.ads_status}`);
    lines.push('');
  }
  if (stockRow) {
    lines.push('*Остатки:*');
    lines.push(`• Остаток: ${stockRow.stock_total ?? 'нет данных'} шт\\.`);
    lines.push(`• Дней: ${stockRow.days_of_stock ?? 'нет данных'}`);
    lines.push(`• Статус: ${stockRow.stock_status}`);
    if (stockRow.recommended_supply_qty) lines.push(`• Рекоменд\\. поставка: ${stockRow.recommended_supply_qty} шт\\.`);
  }
  await sendWbTelegramMessage_(env, chatId, lines.join('\n'), null);
}

async function handleWbAdsCommand_(env, chatId) {
  const db   = env.DB;
  const date = wbYesterday_();
  await ensureWbOperationsSchema_(db);

  const { results: ads = [] } = await db.prepare(
    `SELECT * FROM wb_ads_snapshot WHERE date=? AND ads_status IN ('risk','critical') ORDER BY drr DESC LIMIT 15`
  ).bind(date).all();

  if (!ads.length) {
    await sendWbTelegramMessage_(env, chatId, `✅ WB Реклама — нет критичных рисков за ${wbFormatDate_(date)}`, null);
    return;
  }
  const lines = [`📢 *WB Реклама — риски за ${wbFormatDate_(date)}*\n`];
  for (const ad of ads) {
    const icon = ad.ads_status === WB_ADS_STATUS.CRITICAL ? '🔴' : '🟠';
    lines.push(`${icon} SKU *${ad.nm_id}*${ad.campaign_name ? ' — ' + ad.campaign_name.slice(0, 25) : ''}`);
    lines.push(`   Расход: ${ad.ad_spend ?? 'н/д'} руб\\. | ДРР: ${ad.drr !== null ? wbRound_(ad.drr * 100) + '%' : 'н/д'}`);
    lines.push(`   Заказы: ${ad.ad_orders ?? 'н/д'} | CTR: ${ad.ctr !== null ? wbRound_(ad.ctr * 100, 2) + '%' : 'н/д'}`);
    if (ad.reason) lines.push(`   ⚠️ ${ad.reason}`);
    lines.push('');
  }
  await sendWbTelegramMessage_(env, chatId, lines.join('\n'), null);
}

async function handleWbFinanceCommand_(env, chatId) {
  const db   = env.DB;
  const date = wbYesterday_();
  await ensureWbOperationsSchema_(db);

  const { results: fins = [] } = await db.prepare(
    `SELECT * FROM wb_finance_snapshot WHERE date=? AND finance_status IN ('loss','critical_loss') ORDER BY profit_after_ads ASC LIMIT 15`
  ).bind(date).all();

  if (!fins.length) {
    await sendWbTelegramMessage_(env, chatId, `✅ WB Финансы — убыточных артикулов нет за ${wbFormatDate_(date)}`, null);
    return;
  }
  const lines = [`💸 *WB Финансы — убыточные за ${wbFormatDate_(date)}*\n`];
  for (const fin of fins) {
    const icon = fin.finance_status === WB_FINANCE_STATUS.CRITICAL_LOSS ? '🔴' : '🟠';
    lines.push(`${icon} SKU *${fin.nm_id}*`);
    lines.push(`   Прибыль: ${fin.profit_after_ads ?? 'н/д'} руб\\. | Маржа: ${fin.margin_pct_after_ads !== null ? wbRound_(fin.margin_pct_after_ads * 100) + '%' : 'н/д'}`);
    lines.push(`   Себестоимость: ${fin.cost_per_unit ?? 'н/д'} | Статус: ${fin.finance_status}`);
    lines.push('');
  }
  await sendWbTelegramMessage_(env, chatId, lines.join('\n'), null);
}

async function handleWbStockCommand_(env, chatId) {
  const db   = env.DB;
  const date = wbYesterday_();
  await ensureWbOperationsSchema_(db);

  const { results: stocks = [] } = await db.prepare(
    `SELECT * FROM wb_stock_snapshot WHERE date=? AND stock_status IN ('critical','low') ORDER BY days_of_stock ASC LIMIT 15`
  ).bind(date).all();

  if (!stocks.length) {
    await sendWbTelegramMessage_(env, chatId, `✅ WB Остатки — всё в порядке за ${wbFormatDate_(date)}`, null);
    return;
  }
  const lines = [`📦 *WB Остатки — риски за ${wbFormatDate_(date)}*\n`];
  for (const st of stocks) {
    const icon = st.stock_status === WB_STOCK_STATUS.CRITICAL ? '🔴' : '🟠';
    lines.push(`${icon} SKU *${st.nm_id}*`);
    lines.push(`   Остаток: ${st.stock_total ?? 'н/д'} шт\\. | Дней: ${st.days_of_stock ?? 'н/д'}`);
    if (st.reason) lines.push(`   ${st.reason}`);
    if (st.recommended_supply_qty) lines.push(`   Поставка: ~${st.recommended_supply_qty} шт\\.`);
    lines.push('');
  }
  await sendWbTelegramMessage_(env, chatId, lines.join('\n'), null);
}

async function handleWbTasksCommand_(env, chatId) {
  const db   = env.DB;
  const date = wbYesterday_();
  await ensureWbOperationsSchema_(db);

  const { results: props = [] } = await db.prepare(
    `SELECT * FROM wb_agent_proposals WHERE date=? AND status=? ORDER BY priority DESC LIMIT 10`
  ).bind(date, WB_PROPOSAL_STATUS.WAITING).all();

  if (!props.length) {
    await sendWbTelegramMessage_(env, chatId, `📋 WB — нет ожидающих задач за ${wbFormatDate_(date)}`, null);
    return;
  }
  const lines = [`📋 *WB — Предложенные задачи за ${wbFormatDate_(date)}*\n`];
  for (const p of props) {
    const icon = p.priority === 'high' ? '🔴' : p.priority === 'medium' ? '🟡' : '🟢';
    lines.push(`${icon} *${p.title}*`);
    if (p.reason) lines.push(`   Причина: ${p.reason}`);
    lines.push(`   Тип: ${p.action_type} | Статус: ${p.status}`);
    lines.push('');
  }
  const keyboard = {
    inline_keyboard: props.slice(0, 3).map(p => ([{
      text: `✅ Создать: ${p.title.slice(0, 35)}`,
      callback_data: `wb_confirm_${p.id}`
    }]))
  };
  await sendWbTelegramMessage_(env, chatId, lines.join('\n'), keyboard);
}

// ── Proposal Confirm / Cancel (idempotent) ───────────────────

async function handleWbConfirmCallback_(env, chatId, userId, proposalId) {
  const db = env.DB;
  await ensureWbOperationsSchema_(db);

  const prop = await db.prepare(`SELECT * FROM wb_agent_proposals WHERE id=?`).bind(proposalId).first();

  if (!prop) {
    if (chatId) await sendWbTelegramMessage_(env, chatId, '❌ Предложение не найдено', null);
    return;
  }
  if (prop.status === WB_PROPOSAL_STATUS.APPLIED) {
    if (chatId) await sendWbTelegramMessage_(env, chatId, `✅ Задача уже создана: ${prop.title}`, null);
    return;
  }
  if (prop.status === WB_PROPOSAL_STATUS.CANCELLED) {
    if (chatId) await sendWbTelegramMessage_(env, chatId, `🚫 Предложение отменено: ${prop.title}`, null);
    return;
  }
  if (new Date(prop.expires_at) < new Date()) {
    await db.prepare(`UPDATE wb_agent_proposals SET status=?,updated_at=? WHERE id=?`)
      .bind(WB_PROPOSAL_STATUS.EXPIRED, wbNow_(), proposalId).run();
    if (chatId) await sendWbTelegramMessage_(env, chatId, `⏰ Предложение истекло: ${prop.title}`, null);
    return;
  }

  await db.prepare(`UPDATE wb_agent_proposals SET status=?,updated_at=? WHERE id=?`)
    .bind(WB_PROPOSAL_STATUS.CONFIRMED, wbNow_(), proposalId).run();

  await wbLog_(db, { user_id: String(userId), event_type: 'proposal_confirmed', entity_type: 'proposal', entity_id: proposalId,
    payload: { action_type: prop.action_type, title: prop.title }
  });

  // Stage 1.10 — Planner integration (requires_confirmation guard is already satisfied here)
  let taskCreated = false;
  if (env.INTERNAL_API_BASE) {
    try {
      const res = await fetch(`${env.INTERNAL_API_BASE}/agent/tasks/create-confirmed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id:         String(userId),
          confirmation_id: prop.confirmation_id,
          source:          WB_OPS_CHIEF,
          title:           prop.title,
          description:     `Причина: ${prop.reason || 'WB Operations Agent'}\nАртикул: ${wbSafeJson_(prop.payload_json, {})?.nm_id || 'н/д'}`,
          priority:        prop.priority,
          project:         'WB',
          task_type:       'wb_ops',
          suggested_date:  prop.date,
          duration_min:    30
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.task_id) {
          await db.prepare(`UPDATE wb_agent_proposals SET status=?,updated_at=? WHERE id=?`)
            .bind(WB_PROPOSAL_STATUS.APPLIED, wbNow_(), proposalId).run();
          await wbLog_(db, { user_id: String(userId), event_type: 'planner_task_created', entity_id: proposalId, result: { task_id: data.task_id } });
          if (chatId) await sendWbTelegramMessage_(env, chatId, `✅ Задача создана: *${prop.title}*\nID: ${data.task_id}`, null);
          taskCreated = true;
        }
      }
    } catch (e) {
      await wbLog_(db, { user_id: String(userId), event_type: 'planner_create_failed', entity_id: proposalId, status: 'error', error: e.message });
    }
  }

  if (!taskCreated && chatId) {
    await sendWbTelegramMessage_(env, chatId, `✅ Подтверждено: *${prop.title}*\n\nЗадача будет создана в Planner при наличии подключения\\.`, null);
  }
}

async function handleWbCancelCallback_(env, chatId, userId, proposalId) {
  const db = env.DB;
  await ensureWbOperationsSchema_(db);

  const prop = await db.prepare(`SELECT * FROM wb_agent_proposals WHERE id=?`).bind(proposalId).first();
  if (!prop) { if (chatId) await sendWbTelegramMessage_(env, chatId, '❌ Не найдено', null); return; }
  if (prop.status === WB_PROPOSAL_STATUS.CANCELLED) { if (chatId) await sendWbTelegramMessage_(env, chatId, '✅ Уже отменено', null); return; }

  await db.prepare(`UPDATE wb_agent_proposals SET status=?,updated_at=? WHERE id=?`)
    .bind(WB_PROPOSAL_STATUS.CANCELLED, wbNow_(), proposalId).run();
  await wbLog_(db, { user_id: String(userId), event_type: 'proposal_cancelled', entity_id: proposalId });
  if (chatId) await sendWbTelegramMessage_(env, chatId, `🚫 Отменено: ${prop.title}`, null);
}

// ── Main Telegram Command Router ─────────────────────────────

async function routeWbTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();

  if (text === '/wb' || text === '/wb_today')   { await handleWbTodayCommand_(env, chatId, userId);       return true; }
  if (text === '/wb_proposals' || text === '/wb_run') { await handleWbRunCommand_(env, chatId, userId);  return true; }
  if (text === '/wb_risks')                    { await handleWbRisksCommand_(env, chatId);               return true; }
  if (text === '/wb_ads')                      { await handleWbAdsCommand_(env, chatId);                 return true; }
  if (text === '/wb_finance')                  { await handleWbFinanceCommand_(env, chatId);             return true; }
  if (text === '/wb_stock')                    { await handleWbStockCommand_(env, chatId);               return true; }
  if (text === '/wb_tasks')                    { await handleWbTasksCommand_(env, chatId);               return true; }

  if (text.startsWith('/wb_sku')) {
    const nmId = text.split(' ')[1] || null;
    await handleWbSkuCommand_(env, chatId, nmId);
    return true;
  }

  return false;
}

async function routeWbCallbackQuery_(env, callbackQuery) {
  const data    = callbackQuery.data || '';
  const chatId  = callbackQuery.message?.chat?.id;
  const userId  = callbackQuery.from?.id;
  if (!chatId || !userId) return false;

  if (data.startsWith('wb_confirm_'))   { await handleWbConfirmCallback_(env, chatId, userId, data.replace('wb_confirm_', '')); return true; }
  if (data.startsWith('wb_cancel_'))    { await handleWbCancelCallback_(env, chatId, userId,  data.replace('wb_cancel_',  '')); return true; }
  if (data === 'wb_cmd_tasks')          { await handleWbTasksCommand_(env, chatId);    return true; }
  if (data === 'wb_cmd_risks')          { await handleWbRisksCommand_(env, chatId);    return true; }
  if (data === 'wb_cmd_ads')            { await handleWbAdsCommand_(env, chatId);      return true; }

  return false;
}

// ============================================================
// API ROUTE HANDLERS
// ============================================================

async function handleWbHealthApi_(env) {
  try {
    await ensureWbOperationsSchema_(env.DB);
    return new Response(JSON.stringify({
      status: 'ok', agent: WB_OPS_CHIEF, build: WB_OPS_BUILD,
      timestamp: wbNow_(),
      wb_api_configured:       !!env.WB_API_TOKEN,
      telegram_configured:     !!env.TELEGRAM_BOT_TOKEN,
      gemini_configured:       !!env.GEMINI_API_KEY,
      groq_configured:         !!env.GROQ_API_KEY,
      planner_configured:      !!env.INTERNAL_API_BASE
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ status: 'error', message: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleWbReportRunApi_(env, request) {
  try {
    const body   = await request.json().catch(() => ({}));
    const date   = body.date    || wbYesterday_();
    const userId = body.user_id || 'api';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response(JSON.stringify({ error: 'Неверный формат даты. Используйте YYYY-MM-DD' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const report = await runWbOperationsChief_(env, date, userId);
    return new Response(JSON.stringify({ ok: true, date, report }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleWbReportLatestApi_(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM wb_agent_report WHERE chief=? ORDER BY date DESC LIMIT 1`
    ).bind(WB_OPS_CHIEF).first();
    if (!row) return new Response(JSON.stringify({ ok: true, report: null, message: 'Нет отчётов' }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({
      ok: true, date: row.date,
      report: {
        ...row,
        critical_issues:     wbSafeJson_(row.critical_issues,     []),
        sku_risks:           wbSafeJson_(row.sku_risks,           []),
        ads_risks:           wbSafeJson_(row.ads_risks,           []),
        finance_risks:       wbSafeJson_(row.finance_risks,       []),
        recommended_actions: wbSafeJson_(row.recommended_actions, []),
        missing_sources:     wbSafeJson_(row.missing_sources,     [])
      }
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleWbRisksApi_(env, url) {
  try {
    await ensureWbOperationsSchema_(env.DB);
    const date = url.searchParams.get('date') || wbYesterday_();
    const { results: alerts = [] } = await env.DB.prepare(
      `SELECT * FROM wb_agent_alerts WHERE date=? ORDER BY risk_level DESC`
    ).bind(date).all();
    return new Response(JSON.stringify({ ok: true, date, alerts }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleWbSkuApi_(env, url) {
  try {
    await ensureWbOperationsSchema_(env.DB);
    const nm_id = url.searchParams.get('nm_id');
    const date  = url.searchParams.get('date') || wbYesterday_();
    if (!nm_id) return new Response(JSON.stringify({ error: 'nm_id обязателен' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const [skuRow, finRow, adsRow, stockRow] = await Promise.all([
      env.DB.prepare(`SELECT * FROM wb_sku_snapshot     WHERE date=? AND nm_id=?`).bind(date, nm_id).first(),
      env.DB.prepare(`SELECT * FROM wb_finance_snapshot WHERE date=? AND nm_id=?`).bind(date, nm_id).first(),
      env.DB.prepare(`SELECT * FROM wb_ads_snapshot     WHERE date=? AND nm_id=?`).bind(date, nm_id).first(),
      env.DB.prepare(`SELECT * FROM wb_stock_snapshot   WHERE date=? AND nm_id=?`).bind(date, nm_id).first()
    ]);
    return new Response(JSON.stringify({ ok: true, date, nm_id, sku: skuRow, finance: finRow, ads: adsRow, stock: stockRow }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleWbAdsApi_(env, url) {
  try {
    await ensureWbOperationsSchema_(env.DB);
    const date = url.searchParams.get('date') || wbYesterday_();
    const { results: ads = [] } = await env.DB.prepare(`SELECT * FROM wb_ads_snapshot WHERE date=? ORDER BY drr DESC LIMIT 50`).bind(date).all();
    return new Response(JSON.stringify({ ok: true, date, ads }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleWbFinanceApi_(env, url) {
  try {
    await ensureWbOperationsSchema_(env.DB);
    const date = url.searchParams.get('date') || wbYesterday_();
    const { results: finance = [] } = await env.DB.prepare(`SELECT * FROM wb_finance_snapshot WHERE date=? ORDER BY profit_after_ads ASC LIMIT 50`).bind(date).all();
    return new Response(JSON.stringify({ ok: true, date, finance }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleWbStockApi_(env, url) {
  try {
    await ensureWbOperationsSchema_(env.DB);
    const date = url.searchParams.get('date') || wbYesterday_();
    const { results: stocks = [] } = await env.DB.prepare(`SELECT * FROM wb_stock_snapshot WHERE date=? ORDER BY days_of_stock ASC LIMIT 50`).bind(date).all();
    return new Response(JSON.stringify({ ok: true, date, stocks }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleWbProposalConfirmApi_(env, request, proposalId) {
  try {
    const body   = await request.json().catch(() => ({}));
    const userId = body.user_id || 'api';
    await handleWbConfirmCallback_(env, null, userId, proposalId);
    const updated = await env.DB.prepare(`SELECT status FROM wb_agent_proposals WHERE id=?`).bind(proposalId).first();
    return new Response(JSON.stringify({ ok: true, proposal_id: proposalId, status: updated?.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleWbProposalCancelApi_(env, request, proposalId) {
  try {
    const body   = await request.json().catch(() => ({}));
    const userId = body.user_id || 'api';
    await handleWbCancelCallback_(env, null, userId, proposalId);
    return new Response(JSON.stringify({ ok: true, proposal_id: proposalId, status: WB_PROPOSAL_STATUS.CANCELLED }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleWbActionLogApi_(env, url) {
  try {
    await ensureWbOperationsSchema_(env.DB);
    const limit      = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const entity_id  = url.searchParams.get('entity_id')  || null;
    const event_type = url.searchParams.get('event_type') || null;

    let q = `SELECT * FROM wb_action_log WHERE 1=1`;
    const params = [];
    if (entity_id)  { q += ` AND entity_id=?`;  params.push(entity_id); }
    if (event_type) { q += ` AND event_type=?`; params.push(event_type); }
    q += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const { results: rows = [] } = await env.DB.prepare(q).bind(...params).all();
    return new Response(JSON.stringify({ ok: true, logs: rows }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

// ── Cost Data Upsert (manual data entry endpoint) ────────────
async function handleWbCostDataUpsertApi_(env, request) {
  try {
    await ensureWbOperationsSchema_(env.DB);
    const body = await request.json().catch(() => null);
    if (!body || !body.nm_id || !body.effective_date) {
      return new Response(JSON.stringify({ error: 'nm_id и effective_date обязательны' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    await env.DB.prepare(`
      INSERT INTO wb_cost_data (nm_id,effective_date,cost_per_unit,commission_pct,logistics_rub,storage_per_day_rub,tax_pct,notes,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(nm_id,effective_date) DO UPDATE SET
        cost_per_unit=excluded.cost_per_unit,commission_pct=excluded.commission_pct,
        logistics_rub=excluded.logistics_rub,storage_per_day_rub=excluded.storage_per_day_rub,
        tax_pct=excluded.tax_pct,notes=excluded.notes,updated_at=excluded.updated_at
    `).bind(
      body.nm_id, body.effective_date,
      body.cost_per_unit ?? null, body.commission_pct ?? null,
      body.logistics_rub ?? null, body.storage_per_day_rub ?? null,
      body.tax_pct ?? null, body.notes ?? null, wbNow_()
    ).run();
    return new Response(JSON.stringify({ ok: true, nm_id: body.nm_id, effective_date: body.effective_date }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

// ============================================================
// MAIN WB AGENT ROUTE DISPATCHER
// Call this from your main fetch() handler.
// Returns Response or null (not handled).
// ============================================================

async function handleWbAgentRoutes_(env, request) {
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  if (path === '/agent/wb/health'          && method === 'GET')  return handleWbHealthApi_(env);
  if (path === '/agent/wb/report/run'      && method === 'POST') return handleWbReportRunApi_(env, request);
  if (path === '/agent/wb/report/latest'   && method === 'GET')  return handleWbReportLatestApi_(env);
  if (path === '/agent/wb/risks'           && method === 'GET')  return handleWbRisksApi_(env, url);
  if (path === '/agent/wb/sku'             && method === 'GET')  return handleWbSkuApi_(env, url);
  if (path === '/agent/wb/ads'             && method === 'GET')  return handleWbAdsApi_(env, url);
  if (path === '/agent/wb/finance'         && method === 'GET')  return handleWbFinanceApi_(env, url);
  if (path === '/agent/wb/stock'           && method === 'GET')  return handleWbStockApi_(env, url);
  if (path === '/agent/wb/log'             && method === 'GET')  return handleWbActionLogApi_(env, url);
  if (path === '/agent/wb/cost'            && method === 'POST') return handleWbCostDataUpsertApi_(env, request);

  const confirmMatch = path.match(/^\/agent\/wb\/proposals\/([^/]+)\/confirm$/);
  if (confirmMatch && method === 'POST') return handleWbProposalConfirmApi_(env, request, confirmMatch[1]);

  const cancelMatch = path.match(/^\/agent\/wb\/proposals\/([^/]+)\/cancel$/);
  if (cancelMatch  && method === 'POST') return handleWbProposalCancelApi_(env, request, cancelMatch[1]);

  return null; // not a WB agent route
}
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
// ============================================================
// WB Operations Chief — Stage 2 (v1)
// Build: ai_helpers_stage2_wb_operations_v1
// Extends: wb_operations_stage1_v1.gs (do NOT rewrite Stage 1)
//
// NEW TABLES:
//   wb_stock_snapshot_v2           — enhanced stock with transit, safety, supply qty
//   wb_procurement_snapshot        — procurement planning per SKU
//   supplier_directory             — supplier contact and lead-time data
//   wb_report_consistency_check    — individual data quality checks
//   wb_report_health_summary       — per-date overall data health summary
//
// NEW FUNCTIONS (sub-agents):
//   ensureWbStage2Schema_(db)
//   calculateAvgDailyOrders_(orders7d, orders30d)
//   calculateDaysOfStock_(stock_total, avg_daily_orders)
//   calculateSafetyStock_(avg_daily_orders, safety_days)
//   calculateRecommendedSupplyQty_(stock_total, avg_daily_orders, target_days, safety_days, in_transit)
//   classifyStockStatus_v2_(days_of_stock, stock_total, rules)
//   detectStockRisks_(snapshot)
//   runStockFulfillmentAgent_(db, date, rawStockData)
//   calculateTotalLeadDays_(production_days, delivery_days)
//   calculateLatestOrderDate_(date, days_of_stock, total_lead_days, safety_days)
//   calculateProcurementOrderQty_(avg_daily_orders, target_days, safety_days, min_order_qty)
//   classifyProcurementStatus_(days_of_stock, latest_order_date_iso, today_iso, has_supplier, rules)
//   detectProcurementRisks_(snapshot, today_iso)
//   runProcurementAgent_(db, date, stockAgentResult)
//   checkDataCompleteness_(db, date)
//   checkDataFreshness_(db, date)
//   checkForDuplicates_(db, date)
//   checkAnomalousValues_(db, date)
//   checkSourceHealth_(rawDataFlags)
//   runReportsConsistencyAgent_(db, date, rawDataFlags)
//   runWbOperationsChiefV2_(env, date, userId)
//   routeWbTelegramCommandV2_(env, msg, chatId, userId)
//   handleWbStage2Routes_(env, request)
//
// NEW TELEGRAM COMMANDS:
//   /wb_procurement       — procurement risks table
//   /wb_stock_v2          — enhanced stock report
//   /wb_report_health     — data quality report
//   /wb_supply <nm_id>    — supply recommendation for one SKU
//
// NEW API ENDPOINTS:
//   GET  /agent/wb/stock/v2?date=        — all stock v2 snapshots
//   GET  /agent/wb/procurement?date=     — all procurement snapshots
//   GET  /agent/wb/report/health?date=   — consistency check results
//   GET  /agent/wb/suppliers             — list supplier directory
//   POST /agent/wb/suppliers             — add/update supplier
//   POST /agent/wb/report/run/v2         — run V2 chief
// ============================================================

const WB_OPS_BUILD_V2 = 'ai_helpers_stage2_wb_operations_v1';

// ── Stock Rules V2 ─────────────────────────────────────────────
const WB_STOCK_RULES_V2 = {
  critical_days: 5,
  low_days: 10,
  watch_days: 20,
  target_days: 30,
  max_days: 60,
  safety_days: 5,
};

// ── Stock Status V2 ────────────────────────────────────────────
const WB_STOCK_STATUS_V2 = {
  OK:        'ok',
  WATCH:     'watch',
  LOW:       'low',
  CRITICAL:  'critical',
  OVERSTOCK: 'overstock',
  UNKNOWN:   'unknown',
};

// ── Procurement Rules ──────────────────────────────────────────
const WB_PROCUREMENT_RULES = {
  default_production_days:    14,
  default_delivery_days:       7,
  default_target_days:        30,
  default_safety_days:         5,
  price_risk_threshold_pct:  0.15,
  urgent_order_days_threshold: 3,
};

// ── Procurement Status ─────────────────────────────────────────
const WB_PROCUREMENT_STATUS = {
  NOT_NEEDED:       'not_needed',
  NEED_LATER:       'need_later',
  NEED_SOON:        'need_soon',
  URGENT:           'urgent',
  PRICE_RISK:       'price_risk',
  SUPPLIER_NEEDED:  'supplier_needed',
  UNKNOWN:          'unknown',
};

// ── Consistency Check Types ────────────────────────────────────
const WB_CONSISTENCY_CHECK_TYPES = {
  COMPLETENESS:    'completeness',
  FRESHNESS:       'freshness',
  RECONCILIATION:  'reconciliation',
  DUPLICATE:       'duplicate',
  DATE_INTEGRITY:  'date_integrity',
  ANOMALY:         'anomaly',
  SOURCE_HEALTH:   'source_health',
};

// ── Data Quality Statuses ──────────────────────────────────────
const WB_DATA_QUALITY = {
  READY:               'ready',
  READY_WITH_WARNINGS: 'ready_with_warnings',
  PARTIAL:             'partial',
  INCONSISTENT:        'inconsistent',
  STALE:               'stale',
  FAILED:              'failed',
  UNKNOWN:             'unknown',
};

// ============================================================
// SECTION 1 — SCHEMA EXTENSION
// ============================================================

async function ensureWbStage2Schema_(db) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS wb_stock_snapshot_v2 (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      nm_id INTEGER NOT NULL,
      sku_title TEXT,
      user_id TEXT,
      stock_total INTEGER DEFAULT 0,
      stock_by_warehouse_json TEXT DEFAULT '{}',
      stock_in_transit INTEGER DEFAULT 0,
      stock_reserved INTEGER DEFAULT 0,
      avg_daily_orders_7d REAL DEFAULT 0,
      avg_daily_orders_30d REAL DEFAULT 0,
      days_of_stock REAL DEFAULT 0,
      safety_stock_qty INTEGER DEFAULT 0,
      recommended_supply_qty INTEGER DEFAULT 0,
      latest_supply_date TEXT,
      stock_status TEXT DEFAULT 'unknown',
      stock_risks_json TEXT DEFAULT '[]',
      source_status TEXT DEFAULT 'missing',
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date, nm_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wb_procurement_snapshot (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      nm_id INTEGER NOT NULL,
      sku_title TEXT,
      user_id TEXT,
      avg_daily_orders_30d REAL DEFAULT 0,
      days_of_stock REAL DEFAULT 0,
      target_days_of_stock INTEGER DEFAULT 30,
      safety_days INTEGER DEFAULT 5,
      production_days INTEGER DEFAULT 14,
      delivery_days INTEGER DEFAULT 7,
      total_lead_days INTEGER DEFAULT 21,
      latest_order_date TEXT,
      recommended_order_qty INTEGER DEFAULT 0,
      cost_per_unit REAL DEFAULT 0,
      estimated_order_cost REAL DEFAULT 0,
      supplier_id TEXT,
      supplier_name TEXT,
      price_risk INTEGER DEFAULT 0,
      procurement_status TEXT DEFAULT 'unknown',
      procurement_risks_json TEXT DEFAULT '[]',
      source_status TEXT DEFAULT 'missing',
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date, nm_id)
    )`,
    `CREATE TABLE IF NOT EXISTS supplier_directory (
      id TEXT PRIMARY KEY,
      supplier_name TEXT NOT NULL,
      contact_person TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      default_production_days INTEGER DEFAULT 14,
      default_delivery_days INTEGER DEFAULT 7,
      min_order_qty INTEGER DEFAULT 1,
      min_order_amount REAL DEFAULT 0,
      currency TEXT DEFAULT 'RUB',
      payment_terms TEXT,
      notes TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS wb_report_consistency_check (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      check_type TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      status TEXT DEFAULT 'unknown',
      severity TEXT DEFAULT 'info',
      details_json TEXT DEFAULT '{}',
      is_blocking INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date, check_type, entity_type, entity_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wb_report_health_summary (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      overall_status TEXT DEFAULT 'unknown',
      safe_mode INTEGER DEFAULT 0,
      checks_total INTEGER DEFAULT 0,
      checks_passed INTEGER DEFAULT 0,
      checks_warnings INTEGER DEFAULT 0,
      checks_failed INTEGER DEFAULT 0,
      blocking_issues_json TEXT DEFAULT '[]',
      warnings_json TEXT DEFAULT '[]',
      summary_text TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
  ];

  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_wb_stock_v2_date         ON wb_stock_snapshot_v2(date, nm_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_procurement_date      ON wb_procurement_snapshot(date, nm_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_consistency_date      ON wb_report_consistency_check(date, check_type)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_health_summary_date   ON wb_report_health_summary(date)`,
    `CREATE INDEX IF NOT EXISTS idx_supplier_directory_name  ON supplier_directory(supplier_name)`,
  ];

  for (const ddl of [...tables, ...indexes]) {
    try {
      await db.prepare(ddl).run();
    } catch (e) {
      if (e.message && !e.message.includes('already exists')) {
        wbLog_(db, { event_type: 'schema_error', status: 'error', error: e.message,
          source_agent: WB_OPS_BUILD_V2 });
      }
    }
  }
}

// ============================================================
// SECTION 2 — STOCK & FULFILLMENT AGENT
// ============================================================

// -- Pure calculation helpers ---------------------------------

/**
 * Returns { avg_7d, avg_30d, preferred }
 * preferred = avg_30d if available (> 0), else avg_7d.
 */
function calculateAvgDailyOrders_(orders7d, orders30d) {
  const avg_7d  = (orders7d  != null && !isNaN(orders7d)  && orders7d  > 0) ? orders7d  / 7  : 0;
  const avg_30d = (orders30d != null && !isNaN(orders30d) && orders30d > 0) ? orders30d / 30 : 0;
  const preferred = avg_30d > 0 ? avg_30d : avg_7d;
  return { avg_7d: wbRound_(avg_7d, 4), avg_30d: wbRound_(avg_30d, 4), preferred: wbRound_(preferred, 4) };
}

/**
 * Days of stock.
 * - avg 0, stock > 0 → 999 (has stock but no sales)
 * - both 0            → 0
 */
function calculateDaysOfStock_(stock_total, avg_daily_orders) {
  const s = Number(stock_total)      || 0;
  const a = Number(avg_daily_orders) || 0;
  if (a === 0 && s > 0) return 999;
  if (a === 0) return 0;
  return wbRound_(s / a, 1);
}

/**
 * Safety stock quantity.
 */
function calculateSafetyStock_(avg_daily_orders, safety_days) {
  const a = Number(avg_daily_orders) || 0;
  const d = Number(safety_days)      || 0;
  return Math.ceil(a * d);
}

/**
 * Recommended supply quantity (never negative).
 * = max(0, ceil((avg * (target + safety)) - stock - in_transit))
 */
function calculateRecommendedSupplyQty_(stock_total, avg_daily_orders, target_days, safety_days, in_transit) {
  const s  = Number(stock_total)      || 0;
  const a  = Number(avg_daily_orders) || 0;
  const td = Number(target_days)      || WB_STOCK_RULES_V2.target_days;
  const sd = Number(safety_days)      || WB_STOCK_RULES_V2.safety_days;
  const t  = Number(in_transit)       || 0;
  return Math.max(0, Math.ceil((a * (td + sd)) - s - t));
}

/**
 * Classify stock status using WB_STOCK_RULES_V2 thresholds.
 */
function classifyStockStatus_v2_(days_of_stock, stock_total, rules) {
  const r = rules || WB_STOCK_RULES_V2;
  const s = Number(stock_total)  || 0;
  const d = Number(days_of_stock);
  if (isNaN(d)) return WB_STOCK_STATUS_V2.UNKNOWN;
  if (s === 0)              return WB_STOCK_STATUS_V2.CRITICAL;
  if (d > r.max_days)       return WB_STOCK_STATUS_V2.OVERSTOCK;
  if (d <= r.critical_days) return WB_STOCK_STATUS_V2.CRITICAL;
  if (d <= r.low_days)      return WB_STOCK_STATUS_V2.LOW;
  if (d <= r.watch_days)    return WB_STOCK_STATUS_V2.WATCH;
  return WB_STOCK_STATUS_V2.OK;
}

/**
 * Detect stock risks — returns array of human-readable Russian strings.
 */
function detectStockRisks_(snapshot) {
  const risks = [];
  const d = Number(snapshot.days_of_stock) || 0;
  const s = Number(snapshot.stock_total)   || 0;

  if (s === 0) {
    risks.push('Товар закончился: остатка нет на складе');
  } else if (d <= WB_STOCK_RULES_V2.critical_days && d > 0) {
    risks.push(`Остаток критический: ${d} дн.`);
  } else if (d <= WB_STOCK_RULES_V2.low_days) {
    risks.push(`Остаток низкий: ${d} дн.`);
  }

  if (!snapshot.avg_daily_orders_30d && !snapshot.avg_daily_orders_7d) {
    risks.push('Нет данных по продажам (7д и 30д)');
  }

  if (d > WB_STOCK_RULES_V2.max_days) {
    risks.push(`Перегруз склада: ${d} дн. (максимум ${WB_STOCK_RULES_V2.max_days} дн.)`);
  }

  const in_transit = Number(snapshot.stock_in_transit);
  if (!snapshot.stock_in_transit && in_transit !== 0) {
    risks.push('Нет данных о транзитных товарах');
  }

  if (snapshot.source_status === 'missing') {
    risks.push('Источник данных недоступен: данные по остаткам отсутствуют');
  } else if (snapshot.source_status === 'partial') {
    risks.push('Данные по остаткам получены частично');
  }

  return risks;
}

// -- Sub-agent ------------------------------------------------

async function runStockFulfillmentAgent_(db, date, rawStockData) {
  const result = {
    date,
    skus_analyzed:   0,
    critical_count:  0,
    low_count:       0,
    watch_count:     0,
    overstock_count: 0,
    proposals:       [],
    risks:           [],
    source_status:   'missing',
  };

  try {
    const stocks = (rawStockData && Array.isArray(rawStockData.stocks))
      ? rawStockData.stocks : [];
    const overallSourceStatus = rawStockData?.source_status || 'missing';
    result.source_status = overallSourceStatus;

    if (stocks.length === 0) {
      // Still upsert a placeholder so health checks can detect missing data
      await wbLog_(db, {
        event_type: 'stock_agent_no_data', status: 'warning',
        source_agent: WB_OPS_BUILD_V2, subagent: 'stock_fulfillment',
        payload: { date, source_status: overallSourceStatus },
      });
      return result;
    }

    for (const raw of stocks) {
      try {
        const nm_id = Number(raw.nm_id || raw.nmId || 0);
        if (!nm_id) continue;

        const stock_total      = Number(raw.quantity     ?? raw.stock_total    ?? 0);
        const stock_in_transit = Number(raw.in_transit   ?? raw.inTransit      ?? 0);
        const stock_reserved   = Number(raw.reserved     ?? 0);
        const sku_title        = raw.title ?? raw.name ?? null;
        const user_id          = raw.user_id ?? null;

        const warehouseMap = raw.warehouses ?? raw.stock_by_warehouse ?? {};
        const stock_by_warehouse_json = JSON.stringify(warehouseMap);

        const orders7d  = Number(raw.orders_7d  ?? raw.orders7d  ?? 0);
        const orders30d = Number(raw.orders_30d ?? raw.orders30d ?? 0);
        const avgObj    = calculateAvgDailyOrders_(orders7d > 0 ? orders7d : null, orders30d > 0 ? orders30d : null);

        const days_of_stock       = calculateDaysOfStock_(stock_total, avgObj.preferred);
        const safety_stock_qty    = calculateSafetyStock_(avgObj.preferred, WB_STOCK_RULES_V2.safety_days);
        const recommended_supply_qty = calculateRecommendedSupplyQty_(
          stock_total, avgObj.preferred, WB_STOCK_RULES_V2.target_days,
          WB_STOCK_RULES_V2.safety_days, stock_in_transit
        );
        const stock_status   = classifyStockStatus_v2_(days_of_stock, stock_total, WB_STOCK_RULES_V2);
        const latest_supply_date = raw.latest_supply_date ?? null;

        const snapshotObj = {
          nm_id, sku_title, stock_total, stock_in_transit, stock_reserved,
          avg_daily_orders_7d: avgObj.avg_7d, avg_daily_orders_30d: avgObj.avg_30d,
          days_of_stock, safety_stock_qty, recommended_supply_qty,
          stock_status, source_status: overallSourceStatus,
        };
        const stock_risks  = detectStockRisks_(snapshotObj);
        const stock_risks_json = JSON.stringify(stock_risks);
        const payload_json = JSON.stringify({ raw_orders_7d: orders7d, raw_orders_30d: orders30d });

        const id  = wbGenerateId_('stk2');
        const now = new Date().toISOString();

        await db.prepare(`
          INSERT INTO wb_stock_snapshot_v2
            (id, date, nm_id, sku_title, user_id,
             stock_total, stock_by_warehouse_json, stock_in_transit, stock_reserved,
             avg_daily_orders_7d, avg_daily_orders_30d,
             days_of_stock, safety_stock_qty, recommended_supply_qty,
             latest_supply_date, stock_status, stock_risks_json,
             source_status, payload_json, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(date, nm_id) DO UPDATE SET
            sku_title               = excluded.sku_title,
            stock_total             = excluded.stock_total,
            stock_by_warehouse_json = excluded.stock_by_warehouse_json,
            stock_in_transit        = excluded.stock_in_transit,
            stock_reserved          = excluded.stock_reserved,
            avg_daily_orders_7d     = excluded.avg_daily_orders_7d,
            avg_daily_orders_30d    = excluded.avg_daily_orders_30d,
            days_of_stock           = excluded.days_of_stock,
            safety_stock_qty        = excluded.safety_stock_qty,
            recommended_supply_qty  = excluded.recommended_supply_qty,
            latest_supply_date      = excluded.latest_supply_date,
            stock_status            = excluded.stock_status,
            stock_risks_json        = excluded.stock_risks_json,
            source_status           = excluded.source_status,
            payload_json            = excluded.payload_json,
            updated_at              = excluded.updated_at
        `).bind(
          id, date, nm_id, sku_title, user_id,
          stock_total, stock_by_warehouse_json, stock_in_transit, stock_reserved,
          avgObj.avg_7d, avgObj.avg_30d,
          days_of_stock, safety_stock_qty, recommended_supply_qty,
          latest_supply_date, stock_status, stock_risks_json,
          overallSourceStatus, payload_json, now, now
        ).run();

        result.skus_analyzed++;
        if (stock_status === WB_STOCK_STATUS_V2.CRITICAL)  result.critical_count++;
        if (stock_status === WB_STOCK_STATUS_V2.LOW)        result.low_count++;
        if (stock_status === WB_STOCK_STATUS_V2.WATCH)      result.watch_count++;
        if (stock_status === WB_STOCK_STATUS_V2.OVERSTOCK)  result.overstock_count++;
        if (stock_risks.length > 0) result.risks.push(...stock_risks);

        // Proposals
        if (stock_status === WB_STOCK_STATUS_V2.CRITICAL || stock_status === WB_STOCK_STATUS_V2.LOW) {
          result.proposals.push({
            id: wbGenerateId_('stk_prop'),
            date,
            source_agent: WB_OPS_BUILD_V2,
            action_type: 'prepare_supply_task',
            title: `Подготовить поставку для SKU ${nm_id} (${sku_title || 'без названия'})`,
            reason: `Статус остатка: ${stock_status}, дней: ${days_of_stock}`,
            priority: stock_status === WB_STOCK_STATUS_V2.CRITICAL ? 'critical' : 'high',
            requires_confirmation: true,
            confirmation_id: wbGenerateId_('stk_prop'),
            payload_json: JSON.stringify({ nm_id, stock_status, days_of_stock, recommended_supply_qty }),
          });
        }

        if (recommended_supply_qty > 0 && days_of_stock < WB_STOCK_RULES_V2.target_days) {
          result.proposals.push({
            id: wbGenerateId_('stk_prop'),
            date,
            source_agent: WB_OPS_BUILD_V2,
            action_type: 'create_fulfillment_tz',
            title: `Создать ТЗ на поставку SKU ${nm_id}: ${recommended_supply_qty} ед.`,
            reason: `Рекомендуемое кол-во поставки: ${recommended_supply_qty}, дней остатка: ${days_of_stock}`,
            priority: 'medium',
            requires_confirmation: true,
            confirmation_id: wbGenerateId_('stk_prop'),
            payload_json: JSON.stringify({ nm_id, recommended_supply_qty, days_of_stock }),
          });
        }

        if (overallSourceStatus === 'missing' || overallSourceStatus === 'partial') {
          const alreadyHasCheckProposal = result.proposals.some(
            p => p.action_type === 'check_stock_data'
          );
          if (!alreadyHasCheckProposal) {
            result.proposals.push({
              id: wbGenerateId_('stk_prop'),
              date,
              source_agent: WB_OPS_BUILD_V2,
              action_type: 'check_stock_data',
              title: 'Проверить источник данных по остаткам WB',
              reason: `Статус источника: ${overallSourceStatus}`,
              priority: 'high',
              requires_confirmation: true,
              confirmation_id: wbGenerateId_('stk_prop'),
              payload_json: JSON.stringify({ source_status: overallSourceStatus }),
            });
          }
        }

      } catch (skuErr) {
        await wbLog_(db, {
          event_type: 'stock_sku_error', status: 'error',
          source_agent: WB_OPS_BUILD_V2, subagent: 'stock_fulfillment',
          error: skuErr.message,
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      event_type: 'stock_agent_error', status: 'error',
      source_agent: WB_OPS_BUILD_V2, subagent: 'stock_fulfillment',
      error: e.message,
    });
    result.error = e.message;
  }

  return result;
}

// ============================================================
// SECTION 3 — PROCUREMENT AGENT
// ============================================================

// -- Pure calculation helpers ---------------------------------

function calculateTotalLeadDays_(production_days, delivery_days) {
  return (Number(production_days) || 0) + (Number(delivery_days) || 0);
}

/**
 * Date by which an order must be placed.
 * = date + days_of_stock - total_lead_days - safety_days
 * Returns ISO date string or null.
 */
function calculateLatestOrderDate_(date, days_of_stock, total_lead_days, safety_days) {
  try {
    if (!date || days_of_stock == null || total_lead_days == null) return null;
    const base   = new Date(date);
    const offset = Math.floor(Number(days_of_stock) - Number(total_lead_days) - (Number(safety_days) || 0));
    if (isNaN(offset)) return null;
    base.setDate(base.getDate() + offset);
    return base.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

/**
 * Procurement order quantity.
 * = max(min_order_qty, ceil(avg_daily_orders * (target_days + safety_days)))
 */
function calculateProcurementOrderQty_(avg_daily_orders, target_days, safety_days, min_order_qty) {
  const a   = Number(avg_daily_orders) || 0;
  const td  = Number(target_days)      || WB_PROCUREMENT_RULES.default_target_days;
  const sd  = Number(safety_days)      || WB_PROCUREMENT_RULES.default_safety_days;
  const moq = Number(min_order_qty)    || 1;
  return Math.max(moq, Math.ceil(a * (td + sd)));
}

/**
 * Classify procurement status.
 */
function classifyProcurementStatus_(days_of_stock, latest_order_date_iso, today_iso, has_supplier, rules) {
  const r   = rules || WB_PROCUREMENT_RULES;
  const dos = Number(days_of_stock);

  if (isNaN(dos) || dos === 0) return WB_PROCUREMENT_STATUS.UNKNOWN;
  if (!has_supplier)           return WB_PROCUREMENT_STATUS.SUPPLIER_NEEDED;
  if (dos > r.default_target_days + 10) return WB_PROCUREMENT_STATUS.NOT_NEEDED;

  if (!latest_order_date_iso || !today_iso) return WB_PROCUREMENT_STATUS.NEED_LATER;

  try {
    const orderDate = new Date(latest_order_date_iso);
    const today     = new Date(today_iso);
    if (isNaN(orderDate) || isNaN(today)) return WB_PROCUREMENT_STATUS.UNKNOWN;

    const diffDays = Math.floor((orderDate - today) / 86400000);

    if (diffDays < 0)  return WB_PROCUREMENT_STATUS.URGENT;   // past due
    if (diffDays <= r.urgent_order_days_threshold) return WB_PROCUREMENT_STATUS.URGENT;
    if (diffDays <= 7) return WB_PROCUREMENT_STATUS.NEED_SOON;
    return WB_PROCUREMENT_STATUS.NEED_LATER;
  } catch {
    return WB_PROCUREMENT_STATUS.UNKNOWN;
  }
}

/**
 * Detect procurement risks — returns array of Russian strings.
 */
function detectProcurementRisks_(snapshot, today_iso) {
  const risks = [];
  const status = snapshot.procurement_status;

  if (status === WB_PROCUREMENT_STATUS.SUPPLIER_NEEDED) {
    risks.push('Поставщик не назначен для данного SKU');
  }
  if (status === WB_PROCUREMENT_STATUS.URGENT) {
    risks.push(`Заказ у поставщика просрочен или необходим сегодня (дата: ${snapshot.latest_order_date || 'неизвестна'})`);
  }
  if (status === WB_PROCUREMENT_STATUS.NEED_SOON) {
    risks.push(`Заказ нужно разместить в ближайшие 7 дней (дата: ${snapshot.latest_order_date || 'неизвестна'})`);
  }
  if (snapshot.price_risk) {
    risks.push('Ценовой риск: возможен рост себестоимости > 15%');
  }
  if (!snapshot.avg_daily_orders_30d || Number(snapshot.avg_daily_orders_30d) === 0) {
    risks.push('Нет данных о средних продажах за 30 дней — оценка неточная');
  }
  if (!snapshot.cost_per_unit || Number(snapshot.cost_per_unit) === 0) {
    risks.push('Себестоимость не указана — невозможно рассчитать бюджет заказа');
  }
  if (snapshot.source_status === 'missing') {
    risks.push('Источник данных недоступен: данные о поставках отсутствуют');
  }
  return risks;
}

// -- Sub-agent ------------------------------------------------

async function runProcurementAgent_(db, date, stockAgentResult) {
  const result = {
    date,
    skus_analyzed:         0,
    urgent_count:          0,
    need_soon_count:       0,
    supplier_missing_count: 0,
    proposals:             [],
    risks:                 [],
  };

  try {
    // Load supplier directory
    let supplierMap = {};
    try {
      const suppRows = await db.prepare(
        `SELECT * FROM supplier_directory WHERE is_active = 1`
      ).all();
      for (const s of (suppRows.results || [])) {
        supplierMap[s.id] = s;
      }
    } catch (e) {
      await wbLog_(db, {
        event_type: 'procurement_supplier_load_error', status: 'warning',
        source_agent: WB_OPS_BUILD_V2, subagent: 'procurement',
        error: e.message,
      });
    }

    // Load stock v2 records for this date
    let stockRows = [];
    try {
      const r = await db.prepare(
        `SELECT * FROM wb_stock_snapshot_v2 WHERE date = ?`
      ).bind(date).all();
      stockRows = r.results || [];
    } catch (e) {
      await wbLog_(db, {
        event_type: 'procurement_stock_load_error', status: 'warning',
        source_agent: WB_OPS_BUILD_V2, subagent: 'procurement',
        error: e.message,
      });
    }

    // Also consider critical/low from stockAgentResult if DB rows are empty
    const skusToProcess = stockRows.length > 0 ? stockRows : [];

    for (const stockRow of skusToProcess) {
      try {
        const nm_id = Number(stockRow.nm_id);
        if (!nm_id) continue;

        const avg_daily = Number(stockRow.avg_daily_orders_30d) || Number(stockRow.avg_daily_orders_7d) || 0;
        const days_of_stock = Number(stockRow.days_of_stock) || 0;

        // Find supplier — try by nm_id in payload or just take first active supplier as default
        let supplier = null;
        if (stockRow.payload_json) {
          try {
            const payload = JSON.parse(stockRow.payload_json);
            if (payload.supplier_id && supplierMap[payload.supplier_id]) {
              supplier = supplierMap[payload.supplier_id];
            }
          } catch {}
        }
        // Fallback: check if any supplier maps this nm_id (simple heuristic — real impl would use a mapping table)
        if (!supplier && Object.keys(supplierMap).length > 0) {
          // Use first active supplier as placeholder
          supplier = Object.values(supplierMap)[0];
        }

        const production_days = supplier?.default_production_days ?? WB_PROCUREMENT_RULES.default_production_days;
        const delivery_days   = supplier?.default_delivery_days   ?? WB_PROCUREMENT_RULES.default_delivery_days;
        const min_order_qty   = supplier?.min_order_qty           ?? 1;
        const total_lead_days = calculateTotalLeadDays_(production_days, delivery_days);

        const latest_order_date = calculateLatestOrderDate_(
          date, days_of_stock, total_lead_days, WB_PROCUREMENT_RULES.default_safety_days
        );

        const recommended_order_qty = calculateProcurementOrderQty_(
          avg_daily,
          WB_PROCUREMENT_RULES.default_target_days,
          WB_PROCUREMENT_RULES.default_safety_days,
          min_order_qty
        );

        // Cost per unit from cost data if available
        let cost_per_unit = 0;
        try {
          const costRow = await db.prepare(
            `SELECT cost_per_unit FROM wb_cost_data WHERE nm_id = ? AND effective_date <= ? ORDER BY effective_date DESC LIMIT 1`
          ).bind(String(nm_id), date).first();
          cost_per_unit = wbRound_(costRow?.cost_per_unit ?? 0, 2);
        } catch {}

        const estimated_order_cost = wbRound_(recommended_order_qty * cost_per_unit, 2);
        const has_supplier = !!supplier;

        const procurement_status = classifyProcurementStatus_(
          days_of_stock, latest_order_date, date, has_supplier, WB_PROCUREMENT_RULES
        );

        const snapshotForRisks = {
          procurement_status, latest_order_date, price_risk: 0,
          avg_daily_orders_30d: avg_daily, cost_per_unit,
          source_status: stockRow.source_status || 'missing',
        };
        const procurement_risks = detectProcurementRisks_(snapshotForRisks, date);

        const id  = wbGenerateId_('proc');
        const now = new Date().toISOString();

        await db.prepare(`
          INSERT INTO wb_procurement_snapshot
            (id, date, nm_id, sku_title, user_id,
             avg_daily_orders_30d, days_of_stock,
             target_days_of_stock, safety_days,
             production_days, delivery_days, total_lead_days,
             latest_order_date, recommended_order_qty,
             cost_per_unit, estimated_order_cost,
             supplier_id, supplier_name, price_risk,
             procurement_status, procurement_risks_json,
             source_status, payload_json, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(date, nm_id) DO UPDATE SET
            avg_daily_orders_30d    = excluded.avg_daily_orders_30d,
            days_of_stock           = excluded.days_of_stock,
            latest_order_date       = excluded.latest_order_date,
            recommended_order_qty   = excluded.recommended_order_qty,
            cost_per_unit           = excluded.cost_per_unit,
            estimated_order_cost    = excluded.estimated_order_cost,
            supplier_id             = excluded.supplier_id,
            supplier_name           = excluded.supplier_name,
            procurement_status      = excluded.procurement_status,
            procurement_risks_json  = excluded.procurement_risks_json,
            source_status           = excluded.source_status,
            payload_json            = excluded.payload_json,
            updated_at              = excluded.updated_at
        `).bind(
          id, date, nm_id, stockRow.sku_title ?? null, stockRow.user_id ?? null,
          wbRound_(avg_daily, 4), wbRound_(days_of_stock, 1),
          WB_PROCUREMENT_RULES.default_target_days, WB_PROCUREMENT_RULES.default_safety_days,
          production_days, delivery_days, total_lead_days,
          latest_order_date, recommended_order_qty,
          cost_per_unit, estimated_order_cost,
          supplier?.id ?? null, supplier?.supplier_name ?? null, 0,
          procurement_status, JSON.stringify(procurement_risks),
          stockRow.source_status || 'missing',
          JSON.stringify({ stock_status: stockRow.stock_status }),
          now, now
        ).run();

        result.skus_analyzed++;
        if (!has_supplier) result.supplier_missing_count++;
        if (procurement_status === WB_PROCUREMENT_STATUS.URGENT)    result.urgent_count++;
        if (procurement_status === WB_PROCUREMENT_STATUS.NEED_SOON) result.need_soon_count++;
        if (procurement_risks.length > 0) result.risks.push(...procurement_risks);

        // Proposals
        if (procurement_status === WB_PROCUREMENT_STATUS.URGENT && has_supplier) {
          result.proposals.push({
            id: wbGenerateId_('proc_prop'),
            date,
            source_agent: WB_OPS_BUILD_V2,
            action_type: 'request_supplier_invoice',
            title: `Запросить счёт у поставщика для SKU ${nm_id}`,
            reason: `Срочный заказ: дата заказа ${latest_order_date}, осталось ${wbRound_(days_of_stock, 0)} дн.`,
            priority: 'critical',
            requires_confirmation: true,
            confirmation_id: wbGenerateId_('proc_prop'),
            payload_json: JSON.stringify({ nm_id, supplier_id: supplier?.id, recommended_order_qty, estimated_order_cost }),
          });
        }

        if (procurement_status === WB_PROCUREMENT_STATUS.NEED_SOON) {
          result.proposals.push({
            id: wbGenerateId_('proc_prop'),
            date,
            source_agent: WB_OPS_BUILD_V2,
            action_type: 'create_procurement_task',
            title: `Создать задачу на закупку SKU ${nm_id} (${stockRow.sku_title || 'без названия'})`,
            reason: `Нужно заказать в течение 7 дней, дата дедлайна: ${latest_order_date}`,
            priority: 'high',
            requires_confirmation: true,
            confirmation_id: wbGenerateId_('proc_prop'),
            payload_json: JSON.stringify({ nm_id, latest_order_date, recommended_order_qty }),
          });
        }

        if (estimated_order_cost > 0 && procurement_status === WB_PROCUREMENT_STATUS.URGENT) {
          result.proposals.push({
            id: wbGenerateId_('proc_prop'),
            date,
            source_agent: WB_OPS_BUILD_V2,
            action_type: 'prepare_purchase_approval',
            title: `Согласовать бюджет закупки SKU ${nm_id}: ${estimated_order_cost} руб.`,
            reason: `Расчётная стоимость заказа: ${estimated_order_cost} руб. (${recommended_order_qty} ед. × ${cost_per_unit} руб.)`,
            priority: 'critical',
            requires_confirmation: true,
            confirmation_id: wbGenerateId_('proc_prop'),
            payload_json: JSON.stringify({ nm_id, estimated_order_cost, recommended_order_qty, cost_per_unit }),
          });
        }

      } catch (skuErr) {
        await wbLog_(db, {
          event_type: 'procurement_sku_error', status: 'error',
          source_agent: WB_OPS_BUILD_V2, subagent: 'procurement',
          error: skuErr.message,
        });
      }
    }

  } catch (e) {
    await wbLog_(db, {
      event_type: 'procurement_agent_error', status: 'error',
      source_agent: WB_OPS_BUILD_V2, subagent: 'procurement',
      error: e.message,
    });
    result.error = e.message;
  }

  return result;
}

// ============================================================
// SECTION 4 — REPORTS CONSISTENCY AGENT
// ============================================================

// -- Individual check functions -------------------------------

async function checkDataCompleteness_(db, date) {
  const details = {};
  let status   = 'passed';
  let severity = 'info';
  let is_blocking = 0;

  const tables = [
    { name: 'wb_sku_snapshot',      blocking: true  },
    { name: 'wb_ads_snapshot',      blocking: false },
    { name: 'wb_stock_snapshot_v2', blocking: false },
    { name: 'wb_finance_snapshot',  blocking: false },
    { name: 'wb_daily_snapshot',    blocking: false },
  ];

  for (const t of tables) {
    try {
      const row = await db.prepare(
        `SELECT COUNT(*) AS cnt FROM ${t.name} WHERE date = ?`
      ).bind(date).first();
      const cnt = row?.cnt ?? 0;
      details[t.name] = cnt;
      if (cnt === 0) {
        if (t.blocking) {
          status      = 'failed';
          severity    = 'error';
          is_blocking = 1;
        } else if (status !== 'failed') {
          status   = 'partial';
          severity = 'warning';
        }
      }
    } catch (e) {
      details[`${t.name}_error`] = e.message;
      if (status !== 'failed') {
        status   = 'partial';
        severity = 'warning';
      }
    }
  }

  return {
    check_type:  WB_CONSISTENCY_CHECK_TYPES.COMPLETENESS,
    status,
    severity,
    details,
    is_blocking,
  };
}

async function checkDataFreshness_(db, date) {
  const details = {};
  let status   = 'passed';
  let severity = 'info';
  let is_blocking = 0;

  const tables = ['wb_sku_snapshot', 'wb_ads_snapshot', 'wb_stock_snapshot_v2'];
  // created_at should be within 24h of (date + 1 day)
  const upperBound = new Date(date);
  upperBound.setDate(upperBound.getDate() + 1);
  const lowerBound = new Date(date);

  for (const tbl of tables) {
    try {
      const row = await db.prepare(
        `SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest
         FROM ${tbl} WHERE date = ?`
      ).bind(date).first();

      if (!row || !row.newest) {
        details[tbl] = 'no_data';
        continue;
      }

      const newest = new Date(row.newest);
      const diffHours = Math.abs((upperBound - newest) / 3600000);
      details[tbl] = { newest: row.newest, diff_hours: wbRound_(diffHours, 1) };

      if (diffHours > 24) {
        if (status !== 'failed') {
          status   = 'stale';
          severity = 'warning';
        }
      }
    } catch (e) {
      details[`${tbl}_error`] = e.message;
    }
  }

  return {
    check_type:  WB_CONSISTENCY_CHECK_TYPES.FRESHNESS,
    status,
    severity,
    details,
    is_blocking,
  };
}

async function checkForDuplicates_(db, date) {
  const details      = {};
  let status         = 'passed';
  let severity       = 'info';
  let is_blocking    = 0;

  const checks = [
    { table: 'wb_sku_snapshot',      group: 'nm_id' },
    { table: 'wb_stock_snapshot_v2', group: 'nm_id' },
    { table: 'wb_finance_snapshot',  group: 'nm_id' },
  ];

  for (const c of checks) {
    try {
      const rows = await db.prepare(
        `SELECT ${c.group}, COUNT(*) AS cnt
         FROM ${c.table}
         WHERE date = ?
         GROUP BY ${c.group}
         HAVING cnt > 1`
      ).bind(date).all();

      const dupes = rows.results || [];
      details[c.table] = dupes.length;
      if (dupes.length > 0) {
        status   = 'inconsistent';
        severity = 'warning';
      }
    } catch (e) {
      details[`${c.table}_error`] = e.message;
    }
  }

  return {
    check_type:  WB_CONSISTENCY_CHECK_TYPES.DUPLICATE,
    status,
    severity,
    details,
    is_blocking,
  };
}

async function checkAnomalousValues_(db, date) {
  const anomalies = [];
  let status      = 'passed';
  let severity    = 'info';
  let is_blocking = 0;

  // Negative orders
  try {
    const r = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM wb_sku_snapshot WHERE date = ? AND orders_count < 0`
    ).bind(date).first();
    if ((r?.cnt ?? 0) > 0) anomalies.push(`Отрицательные заказы: ${r.cnt} строк`);
  } catch {}

  // DRR > 100%
  try {
    const r = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM wb_sku_snapshot WHERE date = ? AND drr > 1`
    ).bind(date).first();
    if ((r?.cnt ?? 0) > 0) anomalies.push(`DRR > 100%: ${r.cnt} SKU`);
  } catch {}

  // Negative stock
  try {
    const r = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM wb_stock_snapshot_v2 WHERE date = ? AND stock_total < 0`
    ).bind(date).first();
    if ((r?.cnt ?? 0) > 0) anomalies.push(`Отрицательный остаток: ${r.cnt} SKU`);
  } catch {}

  // Margin > 100%
  try {
    const r = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM wb_finance_snapshot WHERE date = ? AND margin_pct_after_ads > 1`
    ).bind(date).first();
    if ((r?.cnt ?? 0) > 0) anomalies.push(`Маржа > 100%: ${r.cnt} SKU`);
  } catch {}

  if (anomalies.length > 0) {
    status   = 'warning';
    severity = 'warning';
  }

  return {
    check_type:  WB_CONSISTENCY_CHECK_TYPES.ANOMALY,
    status,
    severity,
    details:     { anomalies },
    is_blocking,
  };
}

function checkSourceHealth_(rawDataFlags) {
  const flags    = rawDataFlags || {};
  const missing  = [];
  if (!flags.sku_ok)     missing.push('sku');
  if (!flags.ads_ok)     missing.push('ads');
  if (!flags.stock_ok)   missing.push('stock');
  if (!flags.finance_ok) missing.push('finance');

  let status      = 'passed';
  let severity    = 'info';
  let is_blocking = 0;

  if (missing.length === 4) {
    status      = 'failed';
    severity    = 'error';
    is_blocking = 1;
  } else if (missing.length > 0) {
    status   = 'partial';
    severity = 'warning';
  }

  return {
    check_type:  WB_CONSISTENCY_CHECK_TYPES.SOURCE_HEALTH,
    status,
    severity,
    details:     { missing_sources: missing, flags },
    is_blocking,
  };
}

// -- Orchestrator ---------------------------------------------

async function runReportsConsistencyAgent_(db, date, rawDataFlags) {
  const result = {
    date,
    overall_status:  WB_DATA_QUALITY.UNKNOWN,
    safe_mode:       0,
    checks_total:    0,
    checks_passed:   0,
    checks_failed:   0,
    checks_warnings: 0,
    blocking_issues: [],
    warnings:        [],
  };

  try {
    // Run all checks
    const checks = [
      await checkDataCompleteness_(db, date),
      await checkDataFreshness_(db, date),
      await checkForDuplicates_(db, date),
      await checkAnomalousValues_(db, date),
      checkSourceHealth_(rawDataFlags),
    ];

    result.checks_total = checks.length;

    // Persist each check
    const now = new Date().toISOString();
    for (const chk of checks) {
      const id = wbGenerateId_('chk');
      try {
        await db.prepare(`
          INSERT INTO wb_report_consistency_check
            (id, date, check_type, entity_type, entity_id,
             status, severity, details_json, is_blocking, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(date, check_type, entity_type, entity_id) DO UPDATE SET
            status       = excluded.status,
            severity     = excluded.severity,
            details_json = excluded.details_json,
            is_blocking  = excluded.is_blocking
        `).bind(
          id, date, chk.check_type,
          'system', 'all',
          chk.status, chk.severity,
          JSON.stringify(chk.details || {}),
          chk.is_blocking ? 1 : 0,
          now
        ).run();
      } catch (e) {
        await wbLog_(db, {
          event_type: 'consistency_check_save_error', status: 'error',
          source_agent: WB_OPS_BUILD_V2, error: e.message,
        });
      }

      // Count
      if (chk.status === 'passed') {
        result.checks_passed++;
      } else if (chk.severity === 'error' || chk.status === 'failed') {
        result.checks_failed++;
        if (chk.is_blocking) result.blocking_issues.push(chk);
      } else if (chk.severity === 'warning') {
        result.checks_warnings++;
        result.warnings.push(chk);
      }
    }

    // Determine overall_status
    if (result.blocking_issues.length > 0) {
      result.overall_status = WB_DATA_QUALITY.FAILED;
    } else if (result.checks_failed > 0) {
      result.overall_status = WB_DATA_QUALITY.INCONSISTENT;
    } else if (result.checks_warnings > 0) {
      result.overall_status = WB_DATA_QUALITY.READY_WITH_WARNINGS;
    } else {
      result.overall_status = WB_DATA_QUALITY.READY;
    }

    // Safe mode
    result.safe_mode = (
      result.overall_status === WB_DATA_QUALITY.FAILED ||
      result.overall_status === WB_DATA_QUALITY.INCONSISTENT
    ) ? 1 : 0;

    // Upsert health summary
    const summaryText = `Всего проверок: ${result.checks_total}. Пройдено: ${result.checks_passed}. Предупреждений: ${result.checks_warnings}. Ошибок: ${result.checks_failed}. Статус: ${result.overall_status}.`;
    const summaryId   = wbGenerateId_('health');
    try {
      await db.prepare(`
        INSERT INTO wb_report_health_summary
          (id, date, overall_status, safe_mode,
           checks_total, checks_passed, checks_warnings, checks_failed,
           blocking_issues_json, warnings_json, summary_text, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(date) DO UPDATE SET
          overall_status       = excluded.overall_status,
          safe_mode            = excluded.safe_mode,
          checks_total         = excluded.checks_total,
          checks_passed        = excluded.checks_passed,
          checks_warnings      = excluded.checks_warnings,
          checks_failed        = excluded.checks_failed,
          blocking_issues_json = excluded.blocking_issues_json,
          warnings_json        = excluded.warnings_json,
          summary_text         = excluded.summary_text,
          updated_at           = excluded.updated_at
      `).bind(
        summaryId, date, result.overall_status, result.safe_mode,
        result.checks_total, result.checks_passed, result.checks_warnings, result.checks_failed,
        JSON.stringify(result.blocking_issues),
        JSON.stringify(result.warnings),
        summaryText, now, now
      ).run();
    } catch (e) {
      await wbLog_(db, {
        event_type: 'health_summary_save_error', status: 'error',
        source_agent: WB_OPS_BUILD_V2, error: e.message,
      });
    }

  } catch (e) {
    await wbLog_(db, {
      event_type: 'consistency_agent_error', status: 'error',
      source_agent: WB_OPS_BUILD_V2, error: e.message,
    });
    result.error = e.message;
  }

  return result;
}

// ============================================================
// SECTION 5 — EXTENDED ORCHESTRATOR
// ============================================================

async function runWbOperationsChiefV2_(env, date, userId) {
  const db   = env.DB;
  const runDate = date || wbYesterday_();

  const report = {
    build:          WB_OPS_BUILD_V2,
    date:           runDate,
    user_id:        userId || null,
    started_at:     new Date().toISOString(),
    consistency:    null,
    safe_mode:      0,
    stage1:         null,
    stock_v2:       null,
    procurement:    null,
    all_proposals:  [],
    errors:         [],
  };

  try {
    // 1. Ensure Stage 2 schema
    await ensureWbStage2Schema_(db);

    // 2. Load raw data
    const [skuData, adsData, stockData, financeData] = await Promise.all([
      loadWbSkuData_(env, runDate).catch(e => ({ skus: [],    source_status: 'missing', error: e.message })),
      loadWbAdsData_(env, runDate).catch(e => ({ ads: [],     source_status: 'missing', error: e.message })),
      loadWbStockData_(env, runDate).catch(e => ({ stocks: [], source_status: 'missing', error: e.message })),
      loadWbFinanceData_(env, db, runDate).catch(e => ({ finance: [], source_status: 'missing', error: e.message })),
    ]);

    // 3. Raw data flags
    const rawDataFlags = {
      sku_ok:     (skuData.source_status     === 'ready' || skuData.source_status     === 'partial'),
      ads_ok:     (adsData.source_status     === 'ready' || adsData.source_status     === 'partial'),
      stock_ok:   (stockData.source_status   === 'ready' || stockData.source_status   === 'partial'),
      finance_ok: (financeData.source_status === 'ready' || financeData.source_status === 'partial'),
    };

    // 4. Consistency check first
    const consistency = await runReportsConsistencyAgent_(db, runDate, rawDataFlags);
    report.consistency = consistency;
    report.safe_mode   = consistency.safe_mode;

    if (consistency.safe_mode === 1) {
      await wbLog_(db, {
        event_type: 'safe_mode_activated', status: 'warning',
        source_agent: WB_OPS_BUILD_V2,
        payload: { date: runDate, overall_status: consistency.overall_status },
      });
    }

    // 5. Run Stage 1 orchestrator (best-effort — don't abort if it fails)
    try {
      const stage1Result = await runWbOperationsChief_(env, runDate, userId);
      report.stage1 = stage1Result;
    } catch (e) {
      report.errors.push({ stage: 'stage1', error: e.message });
      await wbLog_(db, {
        event_type: 'stage1_chief_error', status: 'error',
        source_agent: WB_OPS_BUILD_V2, error: e.message,
      });
    }

    // 6. Run Stock Fulfillment Agent
    const stockV2Result = await runStockFulfillmentAgent_(db, runDate, stockData);
    report.stock_v2 = stockV2Result;
    if (stockV2Result.proposals?.length) report.all_proposals.push(...stockV2Result.proposals);

    // 7. Run Procurement Agent
    const procResult = await runProcurementAgent_(db, runDate, stockV2Result);
    report.procurement = procResult;
    if (procResult.proposals?.length) report.all_proposals.push(...procResult.proposals);

    // 8. Persist all proposals
    const propNow = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    for (const prop of report.all_proposals) {
      try {
        await db.prepare(`
          INSERT OR IGNORE INTO wb_agent_proposals
            (id, date, source_agent, action_type, title, reason,
             priority, requires_confirmation, status, confirmation_id,
             payload_json, created_at, updated_at, expires_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          prop.id || wbGenerateId_('prop'),
          prop.date || runDate,
          prop.source_agent || WB_OPS_BUILD_V2,
          prop.action_type,
          prop.title,
          prop.reason || null,
          prop.priority || 'medium',
          1,
          'waiting_confirmation',
          prop.confirmation_id || wbGenerateId_('conf'),
          prop.payload_json || null,
          propNow, propNow, expiresAt
        ).run();
      } catch (e) {
        await wbLog_(db, {
          event_type: 'proposal_save_error', status: 'error',
          source_agent: WB_OPS_BUILD_V2, error: e.message,
        });
      }
    }

    report.finished_at = new Date().toISOString();

    await wbLog_(db, {
      event_type: 'v2_chief_completed', status: 'success',
      source_agent: WB_OPS_BUILD_V2, user_id: userId,
      payload: {
        date: runDate, safe_mode: report.safe_mode,
        proposals_count: report.all_proposals.length,
        stock_critical: stockV2Result.critical_count,
        procurement_urgent: procResult.urgent_count,
      },
    });

  } catch (e) {
    report.errors.push({ stage: 'chief_v2', error: e.message });
    report.finished_at = new Date().toISOString();
    await wbLog_(db, {
      event_type: 'v2_chief_error', status: 'error',
      source_agent: WB_OPS_BUILD_V2, error: e.message,
    });
  }

  return report;
}

// ============================================================
// SECTION 6 — EXTENDED TELEGRAM HANDLER
// ============================================================

/**
 * Escape string for MarkdownV2 Telegram format.
 */
function wbEscapeMd_(text) {
  if (!text && text !== 0) return '';
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, c => `\\${c}`);
}

/**
 * Split a long string into chunks of max chunkSize chars.
 */
function wbChunkText_(text, chunkSize = 3800) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    start += chunkSize;
  }
  return chunks;
}

/**
 * Send a Telegram message (MarkdownV2).
 */
async function wbSendTgMessage_(token, chatId, text) {
  const url  = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'MarkdownV2', disable_web_page_preview: true });
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return resp.ok;
}

/**
 * Send long message in chunks.
 */
async function wbSendTgChunked_(token, chatId, text) {
  const chunks = wbChunkText_(text, 3800);
  for (const chunk of chunks) {
    try {
      await wbSendTgMessage_(token, chatId, chunk);
    } catch {}
  }
}

async function routeWbTelegramCommandV2_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();
  const db   = env.DB;
  const tok  = env.TELEGRAM_BOT_TOKEN;

  // /wb_procurement
  if (text === '/wb_procurement') {
    try {
      const date = wbYesterday_();
      const rows = await db.prepare(
        `SELECT * FROM wb_procurement_snapshot WHERE date = ? ORDER BY procurement_status ASC`
      ).bind(date).all();
      const items = rows.results || [];

      if (items.length === 0) {
        await wbSendTgMessage_(tok, chatId, wbEscapeMd_(`Данные по закупкам за ${wbFormatDate_(date)} отсутствуют.`));
        return true;
      }

      let out = `*Закупки WB — ${wbEscapeMd_(wbFormatDate_(date))}*\n\n`;
      for (const it of items) {
        const risks = wbSafeJson_(it.procurement_risks_json, []);
        out += `*SKU ${wbEscapeMd_(String(it.nm_id))}* ${wbEscapeMd_(it.sku_title || '')} — `;
        out += `*${wbEscapeMd_(it.procurement_status)}*\n`;
        out += `  Остаток: ${wbEscapeMd_(String(it.days_of_stock))} дн\\.\n`;
        out += `  Дата заказа: ${wbEscapeMd_(it.latest_order_date || 'не рассч\\.')}\n`;
        out += `  Рекоменд\\. кол\\-во: ${wbEscapeMd_(String(it.recommended_order_qty))} ед\\.\n`;
        if (it.supplier_name) out += `  Поставщик: ${wbEscapeMd_(it.supplier_name)}\n`;
        if (risks.length > 0) {
          out += `  ⚠ ${risks.map(r => wbEscapeMd_(r)).join('; ')}\n`;
        }
        out += '\n';
      }
      await wbSendTgChunked_(tok, chatId, out);
    } catch (e) {
      await wbSendTgMessage_(tok, chatId, wbEscapeMd_(`Ошибка при загрузке закупок: ${e.message}`));
    }
    return true;
  }

  // /wb_stock_v2
  if (text === '/wb_stock_v2') {
    try {
      const date = wbYesterday_();
      const rows = await db.prepare(
        `SELECT * FROM wb_stock_snapshot_v2 WHERE date = ? ORDER BY days_of_stock ASC`
      ).bind(date).all();
      const items = rows.results || [];

      if (items.length === 0) {
        await wbSendTgMessage_(tok, chatId, wbEscapeMd_(`Расширенные данные по остаткам за ${wbFormatDate_(date)} отсутствуют.`));
        return true;
      }

      let out = `*Остатки WB v2 — ${wbEscapeMd_(wbFormatDate_(date))}*\n\n`;
      for (const it of items) {
        const risks = wbSafeJson_(it.stock_risks_json, []);
        out += `*SKU ${wbEscapeMd_(String(it.nm_id))}* ${wbEscapeMd_(it.sku_title || '')} — `;
        out += `*${wbEscapeMd_(it.stock_status)}*\n`;
        out += `  На складе: ${wbEscapeMd_(String(it.stock_total))} ед\\., ${wbEscapeMd_(String(it.days_of_stock))} дн\\.\n`;
        if (it.stock_in_transit) {
          out += `  В пути: ${wbEscapeMd_(String(it.stock_in_transit))} ед\\.\n`;
        }
        out += `  Ср\\. продажи: 7д\\=${wbEscapeMd_(String(wbRound_(it.avg_daily_orders_7d, 1)))}/день, 30д\\=${wbEscapeMd_(String(wbRound_(it.avg_daily_orders_30d, 1)))}/день\n`;
        if (it.recommended_supply_qty > 0) {
          out += `  Рекоменд\\. поставка: ${wbEscapeMd_(String(it.recommended_supply_qty))} ед\\.\n`;
        }
        if (risks.length > 0) {
          out += `  ⚠ ${risks.map(r => wbEscapeMd_(r)).join('; ')}\n`;
        }
        out += '\n';
      }
      await wbSendTgChunked_(tok, chatId, out);
    } catch (e) {
      await wbSendTgMessage_(tok, chatId, wbEscapeMd_(`Ошибка при загрузке остатков: ${e.message}`));
    }
    return true;
  }

  // /wb_report_health
  if (text === '/wb_report_health') {
    try {
      const date = wbYesterday_();
      const summary = await db.prepare(
        `SELECT * FROM wb_report_health_summary WHERE date = ?`
      ).bind(date).first();

      if (!summary) {
        await wbSendTgMessage_(tok, chatId, wbEscapeMd_(`Отчёт о качестве данных за ${wbFormatDate_(date)} ещё не сформирован.`));
        return true;
      }

      const blocking  = wbSafeJson_(summary.blocking_issues_json, []);
      const warnings  = wbSafeJson_(summary.warnings_json, []);
      let out = `*Качество данных WB — ${wbEscapeMd_(wbFormatDate_(date))}*\n\n`;
      out += `Статус: *${wbEscapeMd_(summary.overall_status)}*`;
      if (summary.safe_mode) out += ` \\(⚠ SAFE MODE\\)`;
      out += `\n`;
      out += `Проверок всего: ${wbEscapeMd_(String(summary.checks_total))}\n`;
      out += `✅ Пройдено: ${wbEscapeMd_(String(summary.checks_passed))}\n`;
      out += `⚠ Предупреждений: ${wbEscapeMd_(String(summary.checks_warnings))}\n`;
      out += `❌ Ошибок: ${wbEscapeMd_(String(summary.checks_failed))}\n\n`;
      if (blocking.length > 0) {
        out += `*Блокирующие проблемы:*\n`;
        for (const b of blocking) {
          out += `  \\- ${wbEscapeMd_(b.check_type)}: ${wbEscapeMd_(b.status)}\n`;
        }
        out += '\n';
      }
      if (warnings.length > 0) {
        out += `*Предупреждения:*\n`;
        for (const w of warnings) {
          out += `  \\- ${wbEscapeMd_(w.check_type)}: ${wbEscapeMd_(w.status)}\n`;
        }
        out += '\n';
      }
      out += wbEscapeMd_(summary.summary_text || '');
      await wbSendTgChunked_(tok, chatId, out);
    } catch (e) {
      await wbSendTgMessage_(tok, chatId, wbEscapeMd_(`Ошибка при загрузке отчёта: ${e.message}`));
    }
    return true;
  }

  // /wb_supply <nm_id>
  if (text.startsWith('/wb_supply')) {
    const parts = text.split(/\s+/);
    const nm_id = parts[1] ? Number(parts[1]) : null;

    if (!nm_id) {
      await wbSendTgMessage_(tok, chatId, wbEscapeMd_('Использование: /wb_supply <nm_id>'));
      return true;
    }

    try {
      const date = wbYesterday_();
      const stock = await db.prepare(
        `SELECT * FROM wb_stock_snapshot_v2 WHERE date = ? AND nm_id = ?`
      ).bind(date, nm_id).first();

      const proc = await db.prepare(
        `SELECT * FROM wb_procurement_snapshot WHERE date = ? AND nm_id = ?`
      ).bind(date, nm_id).first();

      if (!stock && !proc) {
        await wbSendTgMessage_(tok, chatId, wbEscapeMd_(`Данные по SKU ${nm_id} за ${wbFormatDate_(date)} не найдены.`));
        return true;
      }

      let out = `*Рекомендация по поставке SKU ${wbEscapeMd_(String(nm_id))}*\n`;
      if (stock?.sku_title) out += `_${wbEscapeMd_(stock.sku_title)}_\n`;
      out += `Дата: ${wbEscapeMd_(wbFormatDate_(date))}\n\n`;

      if (stock) {
        const risks = wbSafeJson_(stock.stock_risks_json, []);
        out += `*Остатки:*\n`;
        out += `  Статус: ${wbEscapeMd_(stock.stock_status)}\n`;
        out += `  На складе: ${wbEscapeMd_(String(stock.stock_total))} ед\\.\n`;
        out += `  В пути: ${wbEscapeMd_(String(stock.stock_in_transit || 0))} ед\\.\n`;
        out += `  Дней остатка: ${wbEscapeMd_(String(stock.days_of_stock))}\n`;
        out += `  Рекоменд\\. поставка: *${wbEscapeMd_(String(stock.recommended_supply_qty))} ед\\.*\n`;
        if (risks.length > 0) {
          out += `  Риски: ${risks.map(r => wbEscapeMd_(r)).join('; ')}\n`;
        }
        out += '\n';
      }

      if (proc) {
        const risks = wbSafeJson_(proc.procurement_risks_json, []);
        out += `*Закупка:*\n`;
        out += `  Статус: ${wbEscapeMd_(proc.procurement_status)}\n`;
        out += `  Крайняя дата заказа: *${wbEscapeMd_(proc.latest_order_date || 'не рассч\\.') }*\n`;
        out += `  Рекоменд\\. заказ: ${wbEscapeMd_(String(proc.recommended_order_qty))} ед\\.\n`;
        if (proc.estimated_order_cost) {
          out += `  Ориент\\. сумма: ${wbEscapeMd_(String(proc.estimated_order_cost))} руб\\.\n`;
        }
        if (proc.supplier_name) {
          out += `  Поставщик: ${wbEscapeMd_(proc.supplier_name)}\n`;
        }
        if (risks.length > 0) {
          out += `  Риски: ${risks.map(r => wbEscapeMd_(r)).join('; ')}\n`;
        }
      }

      await wbSendTgChunked_(tok, chatId, out);
    } catch (e) {
      await wbSendTgMessage_(tok, chatId, wbEscapeMd_(`Ошибка: ${e.message}`));
    }
    return true;
  }

  // Not handled — fall through to Stage 1 handler
  return false;
}

// ============================================================
// SECTION 7 — EXTENDED API ROUTER
// ============================================================

async function handleWbStage2Routes_(env, request) {
  const db  = env.DB;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  const jsonResp = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  // GET /agent/wb/stock/v2
  if (method === 'GET' && path === '/agent/wb/stock/v2') {
    const date = url.searchParams.get('date') || wbYesterday_();
    try {
      const rows = await db.prepare(
        `SELECT * FROM wb_stock_snapshot_v2 WHERE date = ? ORDER BY days_of_stock ASC`
      ).bind(date).all();
      return jsonResp({ date, records: rows.results || [] });
    } catch (e) {
      return jsonResp({ error: e.message }, 500);
    }
  }

  // GET /agent/wb/procurement
  if (method === 'GET' && path === '/agent/wb/procurement') {
    const date = url.searchParams.get('date') || wbYesterday_();
    try {
      const rows = await db.prepare(
        `SELECT * FROM wb_procurement_snapshot WHERE date = ? ORDER BY procurement_status ASC`
      ).bind(date).all();
      return jsonResp({ date, records: rows.results || [] });
    } catch (e) {
      return jsonResp({ error: e.message }, 500);
    }
  }

  // GET /agent/wb/report/health
  if (method === 'GET' && path === '/agent/wb/report/health') {
    const date = url.searchParams.get('date') || wbYesterday_();
    try {
      const summary = await db.prepare(
        `SELECT * FROM wb_report_health_summary WHERE date = ?`
      ).bind(date).first();
      const checks = await db.prepare(
        `SELECT * FROM wb_report_consistency_check WHERE date = ? ORDER BY severity DESC`
      ).bind(date).all();
      return jsonResp({
        date,
        summary: summary || null,
        checks:  checks.results || [],
      });
    } catch (e) {
      return jsonResp({ error: e.message }, 500);
    }
  }

  // GET /agent/wb/suppliers
  if (method === 'GET' && path === '/agent/wb/suppliers') {
    try {
      const rows = await db.prepare(
        `SELECT * FROM supplier_directory WHERE is_active = 1 ORDER BY supplier_name ASC`
      ).all();
      return jsonResp({ suppliers: rows.results || [] });
    } catch (e) {
      return jsonResp({ error: e.message }, 500);
    }
  }

  // POST /agent/wb/suppliers
  if (method === 'POST' && path === '/agent/wb/suppliers') {
    try {
      let body = {};
      try { body = await request.json(); } catch {}

      if (!body.supplier_name) {
        return jsonResp({ error: 'supplier_name is required' }, 400);
      }

      const id  = body.id || wbGenerateId_('sup');
      const now = new Date().toISOString();

      await db.prepare(`
        INSERT INTO supplier_directory
          (id, supplier_name, contact_person, contact_email, contact_phone,
           default_production_days, default_delivery_days,
           min_order_qty, min_order_amount, currency,
           payment_terms, notes, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          supplier_name            = excluded.supplier_name,
          contact_person           = excluded.contact_person,
          contact_email            = excluded.contact_email,
          contact_phone            = excluded.contact_phone,
          default_production_days  = excluded.default_production_days,
          default_delivery_days    = excluded.default_delivery_days,
          min_order_qty            = excluded.min_order_qty,
          min_order_amount         = excluded.min_order_amount,
          currency                 = excluded.currency,
          payment_terms            = excluded.payment_terms,
          notes                    = excluded.notes,
          is_active                = excluded.is_active,
          updated_at               = excluded.updated_at
      `).bind(
        id,
        body.supplier_name,
        body.contact_person         ?? null,
        body.contact_email          ?? null,
        body.contact_phone          ?? null,
        Number(body.default_production_days) || WB_PROCUREMENT_RULES.default_production_days,
        Number(body.default_delivery_days)   || WB_PROCUREMENT_RULES.default_delivery_days,
        Number(body.min_order_qty)           || 1,
        wbRound_(Number(body.min_order_amount) || 0, 2),
        body.currency      || 'RUB',
        body.payment_terms ?? null,
        body.notes         ?? null,
        body.is_active != null ? (body.is_active ? 1 : 0) : 1,
        now, now
      ).run();

      return jsonResp({ ok: true, id });
    } catch (e) {
      return jsonResp({ error: e.message }, 500);
    }
  }

  // POST /agent/wb/report/run/v2
  if (method === 'POST' && path === '/agent/wb/report/run/v2') {
    try {
      let body = {};
      try { body = await request.json(); } catch {}

      const date   = body.date    || wbYesterday_();
      const userId = body.user_id || null;

      await ensureWbStage2Schema_(db);
      const report = await runWbOperationsChiefV2_(env, date, userId);
      return jsonResp({ ok: true, report });
    } catch (e) {
      return jsonResp({ error: e.message }, 500);
    }
  }

  // Path not matched — return null so caller can fall through to Stage 1 router
  return null;
}
// ============================================================
// WB Operations Stage 2 — PATCH v1
// Build: ai_helpers_stage2_wb_operations_patch_v1
// Patches: wb_operations_stage2_v1.gs  (do NOT rewrite that file)
//
// WHAT THIS PATCH ADDS:
//
//  SECTION 1 — Schema migration (ALTER TABLE / new table)
//    ensureWbStage2SchemaPatch_(db)
//      • wb_stock_snapshot_v2          +6 columns
//      • wb_procurement_snapshot       +5 columns
//      • wb_report_consistency_check_v2 (new full table)
//      • wb_report_health_summary      +3 columns
//
//  SECTION 2 — Consistency check helpers (missing from v1)
//    runReconciliationChecks_(db, date)
//    runDateChecks_(db, date)
//    buildConsistencyProposals_(db, date, healthSummary)
//    classifyOverallReportStatus_(checks)
//    buildReportHealthSummary_(checks)
//
//  SECTION 3 — Stock: named recommendation/proposal builders
//    buildStockRecommendations_(stockResult)
//    buildSupplyProposals_(db, date, stockResult)
//
//  SECTION 4 — Procurement: missing named helpers
//    checkPurchasePriceRisk_(purchase_price, cost_data, procurement_rules)
//    buildProcurementRecommendations_(procResult)
//    buildProcurementProposals_(db, date, procResult)
//
//  SECTION 5 — Enhanced V2 orchestrator
//    runWbOperationsChiefV2Enhanced_(env, date, userId)
//
//  SECTION 6 — Enhanced Telegram handler
//    handleWbReportHealthEnhanced_(env, chatId, date)
// ============================================================

const WB_OPS_PATCH_BUILD = 'ai_helpers_stage2_wb_operations_patch_v1';

// ============================================================
// SECTION 1 — SCHEMA MIGRATION
// ============================================================

/**
 * Adds missing columns to existing Stage-2 tables and creates
 * wb_report_consistency_check_v2 with the full column set.
 *
 * D1 does not support `ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
 * so every ALTER is wrapped in its own try/catch; "duplicate column
 * name" errors are silently ignored.
 */
async function ensureWbStage2SchemaPatch_(db) {
  // ── wb_stock_snapshot_v2 extra columns ─────────────────────
  const stockAlters = [
    `ALTER TABLE wb_stock_snapshot_v2 ADD COLUMN vendor_code TEXT`,
    `ALTER TABLE wb_stock_snapshot_v2 ADD COLUMN avg_daily_orders_14d REAL DEFAULT 0`,
    `ALTER TABLE wb_stock_snapshot_v2 ADD COLUMN target_days_of_stock INTEGER DEFAULT 30`,
    `ALTER TABLE wb_stock_snapshot_v2 ADD COLUMN safety_days INTEGER DEFAULT 5`,
    `ALTER TABLE wb_stock_snapshot_v2 ADD COLUMN risk_level TEXT DEFAULT 'unknown'`,
    `ALTER TABLE wb_stock_snapshot_v2 ADD COLUMN reason TEXT`,
    `ALTER TABLE wb_stock_snapshot_v2 ADD COLUMN missing_fields_json TEXT DEFAULT '[]'`,
  ];

  // ── wb_procurement_snapshot extra columns ──────────────────
  const procAlters = [
    `ALTER TABLE wb_procurement_snapshot ADD COLUMN vendor_code TEXT`,
    `ALTER TABLE wb_procurement_snapshot ADD COLUMN reserve_qty INTEGER DEFAULT 0`,
    `ALTER TABLE wb_procurement_snapshot ADD COLUMN stock_available_for_supply INTEGER DEFAULT 0`,
    `ALTER TABLE wb_procurement_snapshot ADD COLUMN stock_already_ordered INTEGER DEFAULT 0`,
    `ALTER TABLE wb_procurement_snapshot ADD COLUMN fulfillment_preparation_days INTEGER DEFAULT 3`,
  ];

  // ── wb_report_health_summary extra columns ─────────────────
  const healthAlters = [
    `ALTER TABLE wb_report_health_summary ADD COLUMN ready_score REAL DEFAULT 0`,
    `ALTER TABLE wb_report_health_summary ADD COLUMN missing_sources_json TEXT DEFAULT '[]'`,
    `ALTER TABLE wb_report_health_summary ADD COLUMN recommended_actions_json TEXT DEFAULT '[]'`,
  ];

  const allAlters = [...stockAlters, ...procAlters, ...healthAlters];

  for (const ddl of allAlters) {
    try {
      await db.prepare(ddl).run();
    } catch (e) {
      // Silently ignore "duplicate column name" — everything else re-throw to log
      if (e.message && !e.message.toLowerCase().includes('duplicate column')) {
        await wbLog_(db, {
          event_type: 'schema_patch_alter_error',
          status: 'warning',
          source_agent: WB_OPS_PATCH_BUILD,
          error: e.message,
          payload: { ddl },
        });
      }
    }
  }

  // ── wb_report_consistency_check_v2 (full replacement table) ─
  const createChecksV2 = `
    CREATE TABLE IF NOT EXISTS wb_report_consistency_check_v2 (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT,
      date                 TEXT NOT NULL,
      check_type           TEXT NOT NULL,
      status               TEXT DEFAULT 'unknown',
      severity             TEXT DEFAULT 'info',
      message              TEXT,
      affected_entity_type TEXT,
      affected_entity_id   TEXT,
      affected_sku_json    TEXT DEFAULT '[]',
      source_name          TEXT,
      is_blocking          INTEGER DEFAULT 0,
      details_json         TEXT DEFAULT '{}',
      created_at           TEXT DEFAULT (datetime('now')),
      updated_at           TEXT DEFAULT (datetime('now')),
      UNIQUE(date, check_type, affected_entity_type, affected_entity_id)
    )
  `;

  const indexChecksV2 = `
    CREATE INDEX IF NOT EXISTS idx_wb_consistency_v2_date
      ON wb_report_consistency_check_v2(date, check_type)
  `;

  for (const ddl of [createChecksV2, indexChecksV2]) {
    try {
      await db.prepare(ddl).run();
    } catch (e) {
      if (e.message && !e.message.includes('already exists')) {
        await wbLog_(db, {
          event_type: 'schema_patch_create_error',
          status: 'error',
          source_agent: WB_OPS_PATCH_BUILD,
          error: e.message,
        });
      }
    }
  }
}

// ============================================================
// SECTION 2 — CONSISTENCY CHECK HELPERS
// ============================================================

/**
 * Cross-check totals between aggregate and detail snapshots.
 * Returns array of check-result objects.
 */
async function runReconciliationChecks_(db, date) {
  const results = [];

  // Helper: save a single check result object
  function makeCheck(status, severity, message, source_name, is_blocking, affected_entity_type, affected_entity_id) {
    return {
      check_type:           'reconciliation',
      status,
      severity,
      message,
      affected_entity_type: affected_entity_type || 'system',
      affected_entity_id:   affected_entity_id   || 'all',
      source_name:          source_name           || null,
      is_blocking:          is_blocking           ? 1 : 0,
    };
  }

  // 1. wb_daily_snapshot.total_orders vs SUM(wb_sku_snapshot.orders_count)
  try {
    const daily = await db.prepare(
      `SELECT total_orders FROM wb_daily_snapshot WHERE date = ? LIMIT 1`
    ).bind(date).first();

    const skuSum = await db.prepare(
      `SELECT SUM(orders_count) AS s FROM wb_sku_snapshot WHERE date = ?`
    ).bind(date).first();

    if (daily && skuSum && daily.total_orders != null && skuSum.s != null) {
      const expected = Number(daily.total_orders);
      const actual   = Number(skuSum.s);
      const diff     = expected > 0 ? Math.abs(expected - actual) / expected : 0;
      if (diff > 0.05) {
        results.push(makeCheck(
          'failed', 'error',
          `Расхождение total_orders: дневной снапшот=${expected}, сумма SKU=${actual} (${wbRound_(diff * 100, 1)}%)`,
          'wb_daily_snapshot', 1, 'orders_total', 'daily'
        ));
      } else {
        results.push(makeCheck(
          'ok', 'info',
          `total_orders сходится: ${expected} vs ${actual}`,
          'wb_daily_snapshot', 0, 'orders_total', 'daily'
        ));
      }
    }
  } catch (e) {
    results.push(makeCheck('failed', 'warning', `Ошибка при проверке total_orders: ${e.message}`, 'wb_daily_snapshot', 0));
  }

  // 2. wb_daily_snapshot.total_ad_spend vs SUM(wb_ads_snapshot.ad_spend)
  try {
    const daily = await db.prepare(
      `SELECT total_ad_spend FROM wb_daily_snapshot WHERE date = ? LIMIT 1`
    ).bind(date).first();

    const adsSum = await db.prepare(
      `SELECT SUM(ad_spend) AS s FROM wb_ads_snapshot WHERE date = ?`
    ).bind(date).first();

    if (daily && adsSum && daily.total_ad_spend != null && adsSum.s != null) {
      const expected = Number(daily.total_ad_spend);
      const actual   = Number(adsSum.s);
      const diff     = expected > 0 ? Math.abs(expected - actual) / expected : 0;
      if (diff > 0.05) {
        results.push(makeCheck(
          'failed', 'error',
          `Расхождение total_ad_spend: дневной снапшот=${expected}, сумма ads=${actual} (${wbRound_(diff * 100, 1)}%)`,
          'wb_ads_snapshot', 0, 'ad_spend_total', 'daily'
        ));
      } else {
        results.push(makeCheck(
          'ok', 'info',
          `total_ad_spend сходится: ${expected} vs ${actual}`,
          'wb_ads_snapshot', 0, 'ad_spend_total', 'daily'
        ));
      }
    }
  } catch (e) {
    results.push(makeCheck('failed', 'warning', `Ошибка при проверке total_ad_spend: ${e.message}`, 'wb_ads_snapshot', 0));
  }

  // 3. Every nm_id in wb_sku_snapshot with orders_count > 0 must have wb_finance_snapshot row
  try {
    const skuWithOrders = await db.prepare(
      `SELECT nm_id FROM wb_sku_snapshot WHERE date = ? AND orders_count > 0`
    ).bind(date).all();

    const nmIds = (skuWithOrders.results || []).map(r => r.nm_id);
    const missing = [];

    for (const nm_id of nmIds) {
      try {
        const fin = await db.prepare(
          `SELECT id FROM wb_finance_snapshot WHERE date = ? AND nm_id = ? LIMIT 1`
        ).bind(date, nm_id).first();
        if (!fin) missing.push(nm_id);
      } catch {}
    }

    if (missing.length > 0) {
      results.push(makeCheck(
        'failed', 'error',
        `${missing.length} SKU с заказами не имеют строки в wb_finance_snapshot`,
        'wb_finance_snapshot', 0, 'finance_coverage', 'skus_with_orders'
      ));
    } else if (nmIds.length > 0) {
      results.push(makeCheck(
        'ok', 'info',
        `Все ${nmIds.length} SKU с заказами имеют финансовую строку`,
        'wb_finance_snapshot', 0, 'finance_coverage', 'skus_with_orders'
      ));
    }
  } catch (e) {
    results.push(makeCheck('failed', 'warning', `Ошибка при проверке finance coverage: ${e.message}`, 'wb_finance_snapshot', 0));
  }

  // 4. Every nm_id in wb_ads_snapshot must exist in wb_sku_snapshot
  try {
    const adsNmIds = await db.prepare(
      `SELECT DISTINCT nm_id FROM wb_ads_snapshot WHERE date = ?`
    ).bind(date).all();

    const orphaned = [];
    for (const row of (adsNmIds.results || [])) {
      try {
        const sku = await db.prepare(
          `SELECT id FROM wb_sku_snapshot WHERE date = ? AND nm_id = ? LIMIT 1`
        ).bind(date, row.nm_id).first();
        if (!sku) orphaned.push(row.nm_id);
      } catch {}
    }

    if (orphaned.length > 0) {
      results.push(makeCheck(
        'failed', 'warning',
        `${orphaned.length} nm_id из wb_ads_snapshot не найдены в wb_sku_snapshot`,
        'wb_ads_snapshot', 0, 'ads_sku_mapping', 'orphaned_ads'
      ));
    } else {
      results.push(makeCheck(
        'ok', 'info',
        'Все nm_id из рекламного снапшота присутствуют в SKU снапшоте',
        'wb_ads_snapshot', 0, 'ads_sku_mapping', 'all'
      ));
    }
  } catch (e) {
    results.push(makeCheck('failed', 'warning', `Ошибка при проверке ads-SKU маппинга: ${e.message}`, 'wb_ads_snapshot', 0));
  }

  return results;
}

/**
 * Verify date integrity across snapshot tables.
 * Returns array of check-result objects.
 */
async function runDateChecks_(db, date) {
  const results = [];
  const now = new Date().toISOString();

  function makeCheck(status, severity, message, source_name, is_blocking) {
    return {
      check_type:           'date_integrity',
      status,
      severity,
      message,
      affected_entity_type: 'system',
      affected_entity_id:   'date_check',
      source_name:          source_name || null,
      is_blocking:          is_blocking ? 1 : 0,
    };
  }

  // 1. All snapshot rows for date have date field == requested date
  const snapshotTables = ['wb_sku_snapshot', 'wb_ads_snapshot', 'wb_stock_snapshot_v2', 'wb_finance_snapshot'];
  for (const tbl of snapshotTables) {
    try {
      const r = await db.prepare(
        `SELECT COUNT(*) AS cnt FROM ${tbl} WHERE date != ? AND date IS NOT NULL AND rowid IN (SELECT rowid FROM ${tbl} WHERE date = ?)`
      ).bind(date, date).first();
      // Simpler version: check rows that claim to be for this date but have wrong date value
      const mismatch = await db.prepare(
        `SELECT COUNT(*) AS cnt FROM ${tbl} WHERE date IS NOT NULL AND date != ?`
      ).bind(date).first();
      // We check for rows that simply exist in this table but with a different date — not a fatal issue per se
      // Instead, verify that all rows inserted for `date` actually carry the right date value
      const wrongDate = await db.prepare(
        `SELECT COUNT(*) AS cnt FROM ${tbl} WHERE created_at >= ? AND date != ?`
      ).bind(date, date).first();
      if ((wrongDate?.cnt ?? 0) > 0) {
        results.push(makeCheck(
          'failed', 'warning',
          `В таблице ${tbl} найдены строки с несоответствием поля date`,
          tbl, 0
        ));
      } else {
        results.push(makeCheck('ok', 'info', `Поле date корректно в ${tbl}`, tbl, 0));
      }
    } catch (e) {
      results.push(makeCheck('failed', 'warning', `Ошибка проверки date в ${tbl}: ${e.message}`, tbl, 0));
    }
  }

  // 2. No rows have created_at far in the future (clock skew > 1 hour)
  const futureThreshold = new Date(Date.now() + 3600 * 1000).toISOString();
  for (const tbl of snapshotTables) {
    try {
      const r = await db.prepare(
        `SELECT COUNT(*) AS cnt FROM ${tbl} WHERE created_at > ?`
      ).bind(futureThreshold).first();
      if ((r?.cnt ?? 0) > 0) {
        results.push(makeCheck(
          'failed', 'warning',
          `Обнаружен сдвиг часов: ${r.cnt} строк в ${tbl} имеют created_at в будущем`,
          tbl, 0
        ));
      }
    } catch {}
  }

  // 3. wb_agent_report has a row for this date
  try {
    const agentRow = await db.prepare(
      `SELECT id FROM wb_agent_report WHERE date = ? LIMIT 1`
    ).bind(date).first();
    if (!agentRow) {
      results.push(makeCheck(
        'failed', 'warning',
        `wb_agent_report не содержит строки для даты ${date}`,
        'wb_agent_report', 0
      ));
    } else {
      results.push(makeCheck('ok', 'info', `wb_agent_report: строка для ${date} найдена`, 'wb_agent_report', 0));
    }
  } catch (e) {
    results.push(makeCheck('failed', 'warning', `Ошибка проверки wb_agent_report: ${e.message}`, 'wb_agent_report', 0));
  }

  return results;
}

/**
 * Pure function — classify overall report status from an array of check results.
 */
function classifyOverallReportStatus_(checks) {
  if (!checks || checks.length === 0) return 'unknown';

  if (checks.some(c => c.is_blocking === 1 && c.status === 'failed')) return 'failed';
  if (checks.some(c => c.severity === 'error')) return 'inconsistent';

  const allPassed = checks.every(c => c.status === 'ok' || c.status === 'passed');
  const hasWarnings = checks.some(c => c.severity === 'warning');

  if (allPassed && hasWarnings) return 'ready_with_warnings';
  if (allPassed) return 'ready';

  return 'ready_with_warnings';
}

/**
 * Pure function — build a health summary object from check results array.
 */
function buildReportHealthSummary_(checks) {
  if (!checks || checks.length === 0) {
    return {
      total:           0,
      passed:          0,
      warnings:        0,
      failed:          0,
      ready_score:     0,
      blocking_issues: [],
      missing_sources: [],
    };
  }

  const total    = checks.length;
  const passed   = checks.filter(c => c.status === 'ok' || c.status === 'passed').length;
  const warnings = checks.filter(c => c.severity === 'warning').length;
  const failed   = checks.filter(c => c.status === 'failed').length;
  const ready_score = total > 0 ? wbRound_(passed / total, 4) : 0;

  const blocking_issues = checks.filter(c => c.is_blocking === 1);

  const missing_sources = checks
    .filter(c => c.check_type === 'source_health' && c.status === 'failed' && c.source_name)
    .map(c => c.source_name);

  return { total, passed, warnings, failed, ready_score, blocking_issues, missing_sources };
}

/**
 * Build proposals based on health summary and save them to wb_agent_proposals.
 * Returns array of saved proposals.
 */
async function buildConsistencyProposals_(db, date, healthSummary) {
  const proposals = [];
  if (!healthSummary) return proposals;

  const now       = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  // Helper: build and persist a proposal
  async function saveProposal(action_type, title, reason, priority) {
    const confirmation_id = wbGenerateId_('cons_prop');
    const prop = {
      id:                   wbGenerateId_('cons_prop'),
      date,
      source_agent:         WB_OPS_PATCH_BUILD,
      action_type,
      title,
      reason,
      priority,
      requires_confirmation: true,
      confirmation_id,
      payload_json: JSON.stringify({ date, health_summary: healthSummary }),
    };

    try {
      await db.prepare(`
        INSERT INTO wb_agent_proposals
          (id, date, source_agent, action_type, title, reason,
           priority, requires_confirmation, status, confirmation_id,
           payload_json, created_at, updated_at, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        prop.id, prop.date, prop.source_agent,
        prop.action_type, prop.title, prop.reason,
        prop.priority, 1,
        'waiting_confirmation',
        prop.confirmation_id, prop.payload_json,
        now, now, expiresAt
      ).run();
      proposals.push(prop);
    } catch (e) {
      await wbLog_(db, {
        event_type: 'consistency_proposal_save_error',
        status: 'error',
        source_agent: WB_OPS_PATCH_BUILD,
        error: e.message,
      });
    }
  }

  // Missing cost data
  if ((healthSummary.missing_sources || []).includes('finance')) {
    await saveProposal(
      'fix_missing_cost',
      'Восстановить данные о стоимости для финансового снапшота',
      'Источник finance отсутствует в данных за ' + date,
      'high'
    );
  }

  // Ads not mapped
  if ((healthSummary.missing_sources || []).includes('ads')) {
    await saveProposal(
      'check_ads_source',
      'Проверить источник рекламных данных WB',
      'Рекламный источник недоступен за ' + date,
      'medium'
    );
  }

  // Parser error suspected (failed checks without blocking = possible parse issue)
  const nonBlockingFailed = (healthSummary.failed || 0) - (healthSummary.blocking_issues || []).length;
  if (nonBlockingFailed > 0 && healthSummary.ready_score < 0.7) {
    await saveProposal(
      'check_parser_error',
      'Проверить парсер источников данных на наличие ошибок',
      `Зафиксировано ${nonBlockingFailed} неблокирующих ошибок, ready_score=${healthSummary.ready_score}`,
      'medium'
    );
  }

  // Overall failed → rerun
  if (classifyOverallReportStatus_(healthSummary.blocking_issues || []) === 'failed' ||
      healthSummary.ready_score < 0.5) {
    await saveProposal(
      'rerun_report',
      'Перезапустить формирование отчёта за ' + date,
      'Качество данных ниже порога (ready_score < 0.5) или статус failed',
      'high'
    );
  }

  return proposals;
}

// Persist check results to wb_report_consistency_check_v2
async function _saveConsistencyChecksV2_(db, date, checks, userId) {
  const now = new Date().toISOString();
  for (const chk of checks) {
    const id = wbGenerateId_('chkv2');
    try {
      await db.prepare(`
        INSERT INTO wb_report_consistency_check_v2
          (id, user_id, date, check_type, status, severity, message,
           affected_entity_type, affected_entity_id, affected_sku_json,
           source_name, is_blocking, details_json, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(date, check_type, affected_entity_type, affected_entity_id) DO UPDATE SET
          status               = excluded.status,
          severity             = excluded.severity,
          message              = excluded.message,
          affected_sku_json    = excluded.affected_sku_json,
          source_name          = excluded.source_name,
          is_blocking          = excluded.is_blocking,
          details_json         = excluded.details_json,
          updated_at           = excluded.updated_at
      `).bind(
        id,
        userId || null,
        date,
        chk.check_type,
        chk.status,
        chk.severity,
        chk.message || null,
        chk.affected_entity_type || 'system',
        chk.affected_entity_id   || 'all',
        chk.affected_sku_json    || '[]',
        chk.source_name          || null,
        chk.is_blocking          ? 1 : 0,
        chk.details_json         || '{}',
        now, now
      ).run();
    } catch (e) {
      await wbLog_(db, {
        event_type: 'save_check_v2_error',
        status: 'error',
        source_agent: WB_OPS_PATCH_BUILD,
        error: e.message,
      });
    }
  }
}

// ============================================================
// SECTION 3 — STOCK: RECOMMENDATION & PROPOSAL BUILDERS
// ============================================================

/**
 * Build human-readable stock recommendations from stock agent result.
 * Returns array of { nm_id, sku_title, recommendation, priority }.
 */
function buildStockRecommendations_(stockResult) {
  if (!stockResult || !Array.isArray(stockResult.items)) return [];

  const recs = [];
  for (const item of stockResult.items) {
    const nm_id     = item.nm_id;
    const title     = item.sku_title || String(nm_id);
    const status    = item.stock_status;
    const days      = item.days_of_stock;
    const supplyQty = item.recommended_supply_qty;

    let recommendation = '';
    let priority        = 'medium';

    if (status === 'critical') {
      recommendation = `Срочная поставка: запасов на ${days} дн., рекомендовано ${supplyQty} шт.`;
      priority = 'critical';
    } else if (status === 'low') {
      recommendation = `Плановая поставка: запасов на ${days} дн., рекомендовано ${supplyQty} шт.`;
      priority = 'high';
    } else if (status === 'overstock') {
      recommendation = `Временно остановить поставки: избыток запасов на ${days} дн.`;
      priority = 'low';
    } else if (status === 'watch') {
      recommendation = `Мониторинг: запасов на ${days} дн. Плановая поставка при необходимости.`;
      priority = 'low';
    } else {
      recommendation = `Запасы в норме: ${days} дн.`;
      priority = 'low';
    }

    recs.push({ nm_id, sku_title: title, recommendation, priority });
  }

  return recs;
}

/**
 * Save supply proposals to wb_agent_proposals for critical/low stock items.
 * Returns array of saved proposals.
 */
async function buildSupplyProposals_(db, date, stockResult) {
  const proposals = [];
  if (!stockResult || !Array.isArray(stockResult.items)) return proposals;

  const now       = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  for (const item of stockResult.items) {
    const status = item.stock_status;
    if (status !== 'critical' && status !== 'low') continue;

    const nm_id          = item.nm_id;
    const supplyQty      = item.recommended_supply_qty || 0;
    const days           = item.days_of_stock;

    // Primary supply proposal
    const supplyType     = status === 'critical' ? 'prepare_supply_task' : 'create_fulfillment_tz';
    const supplyPriority = status === 'critical' ? 'critical' : 'high';
    const confirmation_id = wbGenerateId_('sup_prop');

    const prop = {
      id:                   wbGenerateId_('sup_prop'),
      date,
      source_agent:         WB_OPS_PATCH_BUILD,
      action_type:          supplyType,
      title:                `Поставка SKU ${nm_id} (${item.sku_title || 'без названия'}): ${supplyQty} ед.`,
      reason:               `Статус: ${status}, дней остатка: ${days}, рекомендовано: ${supplyQty} шт.`,
      priority:             supplyPriority,
      requires_confirmation: true,
      confirmation_id,
      payload_json: JSON.stringify({ nm_id, stock_status: status, days_of_stock: days, recommended_supply_qty: supplyQty }),
    };

    try {
      await db.prepare(`
        INSERT INTO wb_agent_proposals
          (id, date, source_agent, action_type, title, reason,
           priority, requires_confirmation, status, confirmation_id,
           payload_json, created_at, updated_at, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        prop.id, prop.date, prop.source_agent,
        prop.action_type, prop.title, prop.reason,
        prop.priority, 1,
        'waiting_confirmation',
        prop.confirmation_id, prop.payload_json,
        now, now, expiresAt
      ).run();
      proposals.push(prop);
    } catch (e) {
      await wbLog_(db, {
        event_type: 'supply_proposal_save_error',
        status: 'error',
        source_agent: WB_OPS_PATCH_BUILD,
        error: e.message,
      });
    }
  }

  return proposals;
}

// ============================================================
// SECTION 4 — PROCUREMENT: MISSING NAMED HELPERS
// ============================================================

/**
 * Pure function — assess whether a purchase price exceeds the maximum
 * allowable cost given financial parameters.
 */
function checkPurchasePriceRisk_(purchase_price, cost_data, procurement_rules) {
  if (!cost_data || typeof cost_data !== 'object') {
    return { risk: false, missing_data: true };
  }

  const price_after_commission = Number(cost_data.price_after_commission) || 0;
  const logistics_rub          = Number(cost_data.logistics_rub)          || 0;
  const storage_per_day_rub    = Number(cost_data.storage_per_day_rub)    || 0;
  const tax_pct                = Number(cost_data.tax_pct)                || 0;
  const rules                  = procurement_rules || WB_PROCUREMENT_RULES;
  const target_profit_pct      = Number(rules.target_profit_pct)          || 0;

  if (price_after_commission === 0) {
    return { risk: false, missing_data: true };
  }

  const max_allowed_cost = wbRound_(
    price_after_commission
    - logistics_rub
    - storage_per_day_rub * 30
    - tax_pct * price_after_commission
    - (price_after_commission * target_profit_pct / 100),
    2
  );

  const pp = Number(purchase_price) || 0;

  if (pp > max_allowed_cost) {
    return {
      risk:            true,
      excess_rub:      wbRound_(pp - max_allowed_cost, 2),
      max_allowed_cost,
      purchase_price:  pp,
    };
  }

  return { risk: false, max_allowed_cost, purchase_price: pp };
}

/**
 * Build human-readable procurement recommendations from procurement agent result.
 * Returns array of { nm_id, sku_title, recommendation, priority }.
 */
function buildProcurementRecommendations_(procResult) {
  if (!procResult || !Array.isArray(procResult.items)) return [];

  const recs = [];
  for (const item of procResult.items) {
    const nm_id  = item.nm_id;
    const title  = item.sku_title || String(nm_id);
    const status = item.procurement_status;

    let recommendation = '';
    let priority       = 'medium';

    if (status === 'urgent') {
      const latestDate = item.latest_order_date || 'неизвестна';
      recommendation = `Срочная закупка до ${latestDate}: разместить заказ сегодня.`;
      priority = 'critical';
    } else if (status === 'need_soon') {
      const latestDate = item.latest_order_date || 'неизвестна';
      recommendation = `Плановая закупка: разместить заказ до ${latestDate}.`;
      priority = 'high';
    } else if (status === 'supplier_needed') {
      recommendation = 'Назначить поставщика для данного SKU.';
      priority = 'high';
    } else if (status === 'not_needed') {
      recommendation = 'Закупка не требуется: запасов достаточно.';
      priority = 'low';
    } else {
      recommendation = 'Мониторинг: плановая проверка сроков.';
      priority = 'low';
    }

    // Price risk annotation
    if (item.price_risk) {
      const excess = item.price_risk_excess_rub != null
        ? ` на ${wbRound_(item.price_risk_excess_rub, 2)} руб.`
        : '';
      recommendation += ` Риск по цене: закупочная цена превышает допустимую${excess}.`;
      if (priority === 'low' || priority === 'medium') priority = 'high';
    }

    recs.push({ nm_id, sku_title: title, recommendation, priority });
  }

  return recs;
}

/**
 * Save procurement proposals to wb_agent_proposals.
 * Returns array of saved proposals.
 */
async function buildProcurementProposals_(db, date, procResult) {
  const proposals = [];
  if (!procResult || !Array.isArray(procResult.items)) return proposals;

  const now       = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

  async function saveProp(action_type, title, reason, priority, nm_id, extra_payload) {
    const confirmation_id = wbGenerateId_('proc_prop');
    const prop = {
      id:                   wbGenerateId_('proc_prop'),
      date,
      source_agent:         WB_OPS_PATCH_BUILD,
      action_type,
      title,
      reason,
      priority,
      requires_confirmation: true,
      confirmation_id,
      payload_json: JSON.stringify({ nm_id, date, ...(extra_payload || {}) }),
    };

    try {
      await db.prepare(`
        INSERT INTO wb_agent_proposals
          (id, date, source_agent, action_type, title, reason,
           priority, requires_confirmation, status, confirmation_id,
           payload_json, created_at, updated_at, expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        prop.id, prop.date, prop.source_agent,
        prop.action_type, prop.title, prop.reason,
        prop.priority, 1,
        'waiting_confirmation',
        prop.confirmation_id, prop.payload_json,
        now, now, expiresAt
      ).run();
      proposals.push(prop);
    } catch (e) {
      await wbLog_(db, {
        event_type: 'procurement_proposal_save_error',
        status: 'error',
        source_agent: WB_OPS_PATCH_BUILD,
        error: e.message,
      });
    }
  }

  for (const item of procResult.items) {
    const status  = item.procurement_status;
    const nm_id   = item.nm_id;
    const title   = item.sku_title || String(nm_id);

    if (status === 'urgent' && item.supplier_id) {
      await saveProp(
        'request_supplier_invoice',
        `Запросить счёт у поставщика для SKU ${nm_id} (${title})`,
        `Срочный заказ: крайняя дата ${item.latest_order_date}, дней остатка: ${wbRound_(item.days_of_stock, 0)}`,
        'critical',
        nm_id,
        { supplier_id: item.supplier_id, recommended_order_qty: item.recommended_order_qty, latest_order_date: item.latest_order_date }
      );
    }

    if (status === 'need_soon') {
      await saveProp(
        'create_procurement_task',
        `Создать задачу на закупку SKU ${nm_id} (${title})`,
        `Заказ нужен в течение 7 дней, дедлайн: ${item.latest_order_date}`,
        'high',
        nm_id,
        { latest_order_date: item.latest_order_date, recommended_order_qty: item.recommended_order_qty }
      );
    }

    if (item.price_risk) {
      await saveProp(
        'check_purchase_price',
        `Проверить закупочную цену SKU ${nm_id} (${title})`,
        `Ценовой риск: закупочная цена превышает допустимую`,
        'high',
        nm_id,
        { price_risk: true, price_risk_excess_rub: item.price_risk_excess_rub }
      );
    }
  }

  return proposals;
}

// ============================================================
// SECTION 5 — ENHANCED V2 ORCHESTRATOR
// ============================================================

/**
 * Full enhanced orchestrator: schema patch → consistency → stock → procurement → proposals.
 */
async function runWbOperationsChiefV2Enhanced_(env, date, userId) {
  const db      = env.DB;
  const runDate = date || wbYesterday_();

  const report = {
    build:                  WB_OPS_PATCH_BUILD,
    date:                   runDate,
    user_id:                userId || null,
    started_at:             new Date().toISOString(),
    consistency:            null,
    reconciliation_checks:  [],
    date_checks:            [],
    health_summary:         null,
    overall_status:         'unknown',
    consistency_proposals:  [],
    stock_v2:               null,
    stock_recommendations:  [],
    supply_proposals:       [],
    procurement:            null,
    procurement_recommendations: [],
    procurement_proposals:  [],
    all_proposals:          [],
    errors:                 [],
  };

  try {
    // 1. Schema patch first
    await ensureWbStage2SchemaPatch_(db);

    // 2. Load raw data
    const [skuData, adsData, stockData, financeData] = await Promise.all([
      loadWbSkuData_(env, runDate).catch(e => ({ skus: [], source_status: 'missing', error: e.message })),
      loadWbAdsData_(env, runDate).catch(e => ({ ads: [], source_status: 'missing', error: e.message })),
      loadWbStockData_(env, runDate).catch(e => ({ stocks: [], source_status: 'missing', error: e.message })),
      loadWbFinanceData_(env, db, runDate).catch(e => ({ finance: [], source_status: 'missing', error: e.message })),
    ]);

    const rawDataFlags = {
      sku_ok:     (skuData.source_status     === 'ready' || skuData.source_status     === 'partial'),
      ads_ok:     (adsData.source_status     === 'ready' || adsData.source_status     === 'partial'),
      stock_ok:   (stockData.source_status   === 'ready' || stockData.source_status   === 'partial'),
      finance_ok: (financeData.source_status === 'ready' || financeData.source_status === 'partial'),
    };

    // 3. Run all consistency checks
    let allChecks = [];

    try {
      const baseConsistency = await runReportsConsistencyAgent_(db, runDate, rawDataFlags);
      report.consistency = baseConsistency;
      allChecks = allChecks.concat(baseConsistency.blocking_issues || [], baseConsistency.warnings || []);
    } catch (e) {
      report.errors.push({ stage: 'consistency_base', error: e.message });
    }

    try {
      const reconChecks = await runReconciliationChecks_(db, runDate);
      report.reconciliation_checks = reconChecks;
      allChecks = allChecks.concat(reconChecks);
      await _saveConsistencyChecksV2_(db, runDate, reconChecks, userId);
    } catch (e) {
      report.errors.push({ stage: 'reconciliation', error: e.message });
    }

    try {
      const dateChecks = await runDateChecks_(db, runDate);
      report.date_checks = dateChecks;
      allChecks = allChecks.concat(dateChecks);
      await _saveConsistencyChecksV2_(db, runDate, dateChecks, userId);
    } catch (e) {
      report.errors.push({ stage: 'date_checks', error: e.message });
    }

    // 4. Build full health summary
    const healthSummary     = buildReportHealthSummary_(allChecks);
    report.health_summary   = healthSummary;
    report.overall_status   = classifyOverallReportStatus_(allChecks);

    // Persist updated health summary with new columns
    try {
      const now = new Date().toISOString();
      await db.prepare(`
        UPDATE wb_report_health_summary SET
          ready_score                = ?,
          missing_sources_json       = ?,
          recommended_actions_json   = ?,
          updated_at                 = ?
        WHERE date = ?
      `).bind(
        healthSummary.ready_score,
        JSON.stringify(healthSummary.missing_sources || []),
        '[]',
        now,
        runDate
      ).run();
    } catch (e) {
      report.errors.push({ stage: 'health_summary_update', error: e.message });
    }

    // 5. Build consistency proposals
    try {
      const consistencyProposals = await buildConsistencyProposals_(db, runDate, healthSummary);
      report.consistency_proposals = consistencyProposals;
      report.all_proposals = report.all_proposals.concat(consistencyProposals);
    } catch (e) {
      report.errors.push({ stage: 'consistency_proposals', error: e.message });
    }

    // 6. Run stock agent
    try {
      const stockV2Result          = await runStockFulfillmentAgent_(db, runDate, stockData);
      report.stock_v2              = stockV2Result;
      report.stock_recommendations = buildStockRecommendations_(stockV2Result);
      const supplyProps            = await buildSupplyProposals_(db, runDate, stockV2Result);
      report.supply_proposals      = supplyProps;
      report.all_proposals         = report.all_proposals.concat(supplyProps);
      if (stockV2Result.proposals?.length) {
        report.all_proposals = report.all_proposals.concat(stockV2Result.proposals);
      }
    } catch (e) {
      report.errors.push({ stage: 'stock_v2', error: e.message });
    }

    // 7. Run procurement agent
    try {
      const procResult                  = await runProcurementAgent_(db, runDate, report.stock_v2 || {});
      report.procurement                = procResult;
      report.procurement_recommendations = buildProcurementRecommendations_(procResult);
      const procProposals               = await buildProcurementProposals_(db, runDate, procResult);
      report.procurement_proposals      = procProposals;
      report.all_proposals              = report.all_proposals.concat(procProposals);
      if (procResult.proposals?.length) {
        report.all_proposals = report.all_proposals.concat(procResult.proposals);
      }
    } catch (e) {
      report.errors.push({ stage: 'procurement', error: e.message });
    }

    report.finished_at = new Date().toISOString();

    await wbLog_(db, {
      event_type:   'v2_enhanced_chief_completed',
      status:       'success',
      source_agent: WB_OPS_PATCH_BUILD,
      user_id:      userId,
      payload: {
        date:               runDate,
        overall_status:     report.overall_status,
        ready_score:        healthSummary.ready_score,
        proposals_count:    report.all_proposals.length,
        reconciliation_cnt: report.reconciliation_checks.length,
        date_checks_cnt:    report.date_checks.length,
      },
    });

  } catch (e) {
    report.errors.push({ stage: 'chief_enhanced', error: e.message });
    report.finished_at = new Date().toISOString();
    await wbLog_(db, {
      event_type:   'v2_enhanced_chief_error',
      status:       'error',
      source_agent: WB_OPS_PATCH_BUILD,
      error:        e.message,
    });
  }

  return report;
}

// ============================================================
// SECTION 6 — ENHANCED TELEGRAM: /wb_report_health
// ============================================================

/**
 * Enhanced /wb_report_health handler.
 * Shows overall_status, ready_score %, blocking issues, warnings,
 * and inline buttons [Создать задачи] / [Перезапустить].
 */
async function handleWbReportHealthEnhanced_(env, chatId, date) {
  const db  = env.DB;
  const tok = env.TELEGRAM_BOT_TOKEN;

  const targetDate = date || wbYesterday_();

  try {
    // Load health summary
    const summary = await db.prepare(
      `SELECT * FROM wb_report_health_summary WHERE date = ?`
    ).bind(targetDate).first();

    if (!summary) {
      await wbSendTgMessage_(tok, chatId,
        wbEscapeMd_(`Отчёт о качестве данных за ${wbFormatDate_(targetDate)} ещё не сформирован. Запустите /wb_run_v2.`)
      );
      return;
    }

    // Load checks from v2 table
    let checks = [];
    try {
      const chkRows = await db.prepare(
        `SELECT * FROM wb_report_consistency_check_v2 WHERE date = ? ORDER BY severity DESC, is_blocking DESC`
      ).bind(targetDate).all();
      checks = chkRows.results || [];
    } catch {
      // Fall back to v1 table
      try {
        const chkRows = await db.prepare(
          `SELECT * FROM wb_report_consistency_check WHERE date = ? ORDER BY severity DESC`
        ).bind(targetDate).all();
        checks = chkRows.results || [];
      } catch {}
    }

    // Compute ready_score — prefer DB value, fall back to calculation
    const readyScore = summary.ready_score != null
      ? Number(summary.ready_score)
      : (summary.checks_total > 0 ? summary.checks_passed / summary.checks_total : 0);

    const readyScorePct = wbRound_(readyScore * 100, 1);

    // Emoji for status
    const statusEmoji = {
      ready:               '✅',
      ready_with_warnings: '⚠',
      inconsistent:        '❌',
      failed:              '🚫',
      partial:             '⚠',
      unknown:             '❓',
    }[summary.overall_status] || '❓';

    // Format header
    let out = `*Качество данных WB — ${wbEscapeMd_(wbFormatDate_(targetDate))}*\n\n`;
    out += `${statusEmoji} Статус: *${wbEscapeMd_(summary.overall_status)}*`;
    if (summary.safe_mode) out += ` \\(⚠ SAFE MODE\\)`;
    out += `\n`;
    out += `Готовность: *${wbEscapeMd_(String(readyScorePct))}%*\n`;
    out += `Проверок: ${wbEscapeMd_(String(summary.checks_total))} | `;
    out += `✅ ${wbEscapeMd_(String(summary.checks_passed))} | `;
    out += `⚠ ${wbEscapeMd_(String(summary.checks_warnings))} | `;
    out += `❌ ${wbEscapeMd_(String(summary.checks_failed))}\n\n`;

    // Blocking issues
    const blockingChecks = checks.filter(c => c.is_blocking === 1 || c.is_blocking === true);
    if (blockingChecks.length > 0) {
      out += `*🚫 Блокирующие проблемы \\(${wbEscapeMd_(String(blockingChecks.length))}\\):*\n`;
      for (const b of blockingChecks) {
        const msg = b.message || b.check_type;
        out += `  \\• ${wbEscapeMd_(msg)}\n`;
      }
      out += '\n';
    }

    // Warnings
    const warnChecks = checks.filter(c => c.severity === 'warning' && !c.is_blocking);
    if (warnChecks.length > 0) {
      out += `*⚠ Предупреждения \\(${wbEscapeMd_(String(warnChecks.length))}\\):*\n`;
      for (const w of warnChecks.slice(0, 5)) {
        const msg = w.message || w.check_type;
        out += `  \\• ${wbEscapeMd_(msg)}\n`;
      }
      if (warnChecks.length > 5) {
        out += `  _\\.\\.\\. и ещё ${wbEscapeMd_(String(warnChecks.length - 5))} предупреждений_\n`;
      }
      out += '\n';
    }

    // Missing sources
    const missingSrcJson = summary.missing_sources_json;
    let missingSources = [];
    try { missingSources = JSON.parse(missingSrcJson || '[]'); } catch {}
    if (missingSources.length > 0) {
      out += `*Отсутствующие источники:* ${wbEscapeMd_(missingSources.join(', '))}\n\n`;
    }

    // Summary text if present
    if (summary.summary_text) {
      out += `_${wbEscapeMd_(summary.summary_text)}_\n`;
    }

    // Inline keyboard
    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: 'Создать задачи', callback_data: `wb_health_fix_${targetDate}` },
          { text: 'Перезапустить', callback_data: `wb_health_rerun_${targetDate}` },
        ],
      ],
    };

    // Send with inline keyboard
    const url  = `https://api.telegram.org/bot${tok}/sendMessage`;
    const chunks = wbChunkText_(out, 3800);

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const body = {
        chat_id:                  chatId,
        text:                     chunks[i],
        parse_mode:               'MarkdownV2',
        disable_web_page_preview: true,
      };
      if (isLast) body.reply_markup = inlineKeyboard;

      try {
        await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
      } catch {}
    }

  } catch (e) {
    try {
      await wbSendTgMessage_(tok, chatId,
        wbEscapeMd_(`Ошибка при загрузке отчёта о качестве: ${e.message}`)
      );
    } catch {}
    await wbLog_(db, {
      event_type:   'health_enhanced_handler_error',
      status:       'error',
      source_agent: WB_OPS_PATCH_BUILD,
      error:        e.message,
    });
  }
}
// ============================================================
// CS Operations Chief — Stage 1 (v1)
// Build: ai_helpers_stage1_cs_operations_chief_v1
//
// AI-шеф клиент-сервиса (Customer Service Chief)
// Completely separate block from WB Operations.
//
// ── Tables ───────────────────────────────────────────────────
//   cs_inbox_item          — all customer touchpoints
//   cs_draft_response      — AI-generated draft responses
//   cs_product_issue       — product issue log from reviews/returns
//   cs_knowledge_item      — response knowledge base / templates
//   cs_feedback_insight    — aggregated learning from reviews/returns
//
// ── Agents ───────────────────────────────────────────────────
//   runReviewResponseAgent_       — draft replies to WB reviews
//   runQaAgent_                   — draft answers to WB questions
//   runReturnReasonAgent_         — classify and aggregate return reasons
//   runToneAnalysisAgent_         — QA-check approved draft tone
//   runProductIssueClassifierAgent_ — escalate recurring product issues
//   runProductFeedbackAgent_      — SKU-level sentiment insights
//   runCsOperationsChief_         — main orchestrator
//
// ── API Endpoints ────────────────────────────────────────────
//   GET  /agent/cs/health
//   POST /agent/cs/report/run
//   GET  /agent/cs/inbox
//   GET  /agent/cs/drafts
//   POST /agent/cs/drafts/:id/approve
//   POST /agent/cs/drafts/:id/reject
//   GET  /agent/cs/issues
//   GET  /agent/cs/insights
//   GET  /agent/cs/knowledge
//   POST /agent/cs/knowledge
//   GET  /agent/cs/log
//
// ── Telegram Commands ────────────────────────────────────────
//   /cs_today     — сводка за вчера
//   /cs_reviews   — новые отзывы с черновиками
//   /cs_questions — неотвеченные вопросы
//   /cs_returns   — возвраты за 7 дней
//   /cs_appeals   — открытые жалобы high/critical
//   /cs_issues    — все открытые проблемы с товарами
//   /cs_templates — шаблоны из knowledge base
//   /cs_run       — запустить CS Chief сейчас
//
// ── Telegram Callback Prefixes ───────────────────────────────
//   cs_approve_*      — одобрить черновик ответа
//   cs_reject_*       — отклонить, переделать
//   cs_escalate_*     — передать человеку
//   cs_create_task_*  — создать задачу по проблеме с товаром
//
// Dependencies (from wb_operations_stage1_v1.gs):
//   wbYesterday_(), wbFormatDate_(), wbRound_(),
//   wbGenerateId_(), wbLog_()
//
// Rules:
//   - AI drafts only — no auto-publish to WB API ever
//   - All unsafe actions: requires_confirmation + confirmation_id
//   - Gemini first → Groq fallback → static fallback text
//   - All DB errors caught, logged, never thrown to caller
//   - Timestamps: new Date().toISOString()
// ============================================================

const CS_BUILD = 'ai_helpers_stage1_cs_operations_chief_v1';
const CS_CHIEF = 'cs_operations_chief';

// ── CS Status Constants ───────────────────────────────────────
const CS_INBOX_STATUS = {
  NEW:         'new',
  DRAFT_READY: 'draft_ready',
  APPROVED:    'approved',
  SENT:        'sent',
  SKIPPED:     'skipped',
  ESCALATED:   'escalated',
};

const CS_DRAFT_STATUS = {
  PENDING:  'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SENT:     'sent',
  REVISED:  'revised',
};

const CS_ISSUE_STATUS = {
  OPEN:        'open',
  IN_PROGRESS: 'in_progress',
  RESOLVED:    'resolved',
  WONT_FIX:    'wont_fix',
};

const CS_SEVERITY = {
  LOW:      'low',
  NORMAL:   'normal',
  HIGH:     'high',
  CRITICAL: 'critical',
};

const CS_ISSUE_TYPES = ['defect', 'sizing', 'description_mismatch', 'packaging', 'delivery', 'other'];

// ============================================================
// SECTION 1 — Schema
// ============================================================

async function ensureCsSchema_(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS cs_inbox_item (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      source TEXT NOT NULL,
      source_item_id TEXT,
      nm_id INTEGER,
      sku_title TEXT,
      customer_text TEXT NOT NULL,
      customer_rating INTEGER,
      item_date TEXT,
      status TEXT DEFAULT 'new',
      assigned_to TEXT,
      priority TEXT DEFAULT 'normal',
      tags_json TEXT DEFAULT '[]',
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS cs_draft_response (
      id TEXT PRIMARY KEY,
      inbox_item_id TEXT NOT NULL REFERENCES cs_inbox_item(id),
      user_id TEXT,
      draft_text TEXT NOT NULL,
      draft_version INTEGER DEFAULT 1,
      tone TEXT DEFAULT 'professional',
      language TEXT DEFAULT 'ru',
      ai_model_used TEXT,
      ai_confidence REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      rejection_reason TEXT,
      confirmation_id TEXT UNIQUE,
      approved_by TEXT,
      approved_at TEXT,
      sent_at TEXT,
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS cs_product_issue (
      id TEXT PRIMARY KEY,
      nm_id INTEGER NOT NULL,
      sku_title TEXT,
      user_id TEXT,
      issue_type TEXT NOT NULL,
      issue_description TEXT,
      severity TEXT DEFAULT 'normal',
      source_inbox_ids_json TEXT DEFAULT '[]',
      occurrence_count INTEGER DEFAULT 1,
      first_seen_date TEXT,
      last_seen_date TEXT,
      status TEXT DEFAULT 'open',
      resolution_notes TEXT,
      confirmation_id TEXT UNIQUE,
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(nm_id, issue_type, severity)
    )`,
    `CREATE TABLE IF NOT EXISTS cs_knowledge_item (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      category TEXT NOT NULL,
      trigger_keywords_json TEXT DEFAULT '[]',
      template_text TEXT NOT NULL,
      tone TEXT DEFAULT 'professional',
      language TEXT DEFAULT 'ru',
      usage_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      is_active INTEGER DEFAULT 1,
      tags_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS cs_feedback_insight (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      nm_id INTEGER,
      sku_title TEXT,
      insight_type TEXT NOT NULL,
      insight_text TEXT NOT NULL,
      data_points_count INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0,
      actionable INTEGER DEFAULT 0,
      suggested_action TEXT,
      status TEXT DEFAULT 'new',
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date, nm_id, insight_type)
    )`,
  ];

  for (const sql of statements) {
    try {
      await db.prepare(sql).run();
    } catch (e) {
      // Table already exists or other non-fatal schema error — continue
    }
  }
}

// ============================================================
// SECTION 2 — Data Loading Stubs
// ============================================================

// Stub: returns [] until WB Reviews API is integrated
// Real: GET https://feedbacks-api.wildberries.ru/api/v1/feedbacks
async function loadWbReviews_(env, date) {
  return { data: [], source_status: 'missing' };
}

// Stub: returns [] until WB Questions API is integrated
// Real: GET https://feedbacks-api.wildberries.ru/api/v1/questions
async function loadWbQuestions_(env, date) {
  return { data: [], source_status: 'missing' };
}

// Stub: returns [] until WB Returns API is integrated
// Real: GET https://marketplace-api.wildberries.ru/api/v3/returns
async function loadWbReturns_(env, date) {
  return { data: [], source_status: 'missing' };
}

// ============================================================
// SECTION 3 — CS Utility Functions
// ============================================================

function csSafeText_(text, maxLen) {
  if (!text) return '';
  const s = String(text);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

function csDetectLanguage_(text) {
  if (!text) return 'ru';
  const total = text.length;
  if (total === 0) return 'ru';
  const cyrillicCount = (text.match(/[Ѐ-ӿ]/g) || []).length;
  return cyrillicCount / total > 0.5 ? 'ru' : 'en';
}

function csEscapeMd_(text) {
  if (!text) return '';
  // Escape Telegram MarkdownV2 special characters
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, '\\$&');
}

function csBuildConfirmationId_(itemId, action) {
  return 'cs_' + action + '_' + itemId + '_' + Date.now().toString(36);
}

async function csSendTelegramMessage_(token, chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 3800) {
    chunks.push(text.slice(i, i + 3800));
  }
  let lastOk = true;
  for (const chunk of chunks) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'MarkdownV2',
        }),
      });
      const data = await res.json();
      if (!data.ok) lastOk = false;
    } catch (e) {
      lastOk = false;
    }
  }
  return { ok: lastOk };
}

// ============================================================
// AI Call Helper — Gemini first, Groq fallback
// ============================================================

async function csCallAi_(env, prompt, expectJson = false) {
  // Try Gemini
  if (env.GEMINI_API_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
          }),
        }
      );
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) return { text, model: 'gemini-1.5-flash-latest', ok: true };
    } catch (_) { /* fall through */ }
  }

  // Groq fallback
  if (env.GROQ_API_KEY) {
    try {
      const base = env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4,
          max_tokens: 1024,
        }),
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '';
      if (text) return { text, model: 'llama3-8b-8192', ok: true };
    } catch (_) { /* fall through */ }
  }

  return { text: '', model: 'none', ok: false };
}

function csParseAiJson_(text, fallback) {
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (_) {
    return fallback;
  }
}

// ============================================================
// SECTION 4 — Review Response Agent
// ============================================================

async function runReviewResponseAgent_(env, db, date) {
  const result = {
    date,
    reviews_loaded: 0,
    drafts_created: 0,
    negative_count: 0,
    positive_count: 0,
    error_count: 0,
  };

  try {
    const { data: reviews, source_status } = await loadWbReviews_(env, date);
    result.reviews_loaded = reviews.length;

    if (source_status === 'missing' || reviews.length === 0) {
      return result;
    }

    for (const review of reviews) {
      try {
        // Upsert cs_inbox_item
        const itemId = wbGenerateId_('csi');
        const now = new Date().toISOString();
        const existingItem = review.source_item_id
          ? await db.prepare(
              `SELECT id FROM cs_inbox_item WHERE source='wb_review' AND source_item_id=?`
            ).bind(review.source_item_id).first()
          : null;

        let inboxItemId = existingItem?.id || itemId;

        if (!existingItem) {
          await db.prepare(`
            INSERT INTO cs_inbox_item
              (id, user_id, source, source_item_id, nm_id, sku_title, customer_text,
               customer_rating, item_date, status, priority, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,'new','normal',?,?)
          `).bind(
            itemId,
            review.user_id || null,
            'wb_review',
            review.source_item_id || null,
            review.nm_id || null,
            review.sku_title || '',
            review.customer_text || '',
            review.rating || null,
            review.date || date,
            now, now
          ).run();
          inboxItemId = itemId;
        }

        const rating = review.rating || review.customer_rating || 0;
        const isNegative = rating > 0 && rating <= 3;
        if (isNegative) result.negative_count++; else result.positive_count++;

        // Check if draft already exists
        const existingDraft = await db.prepare(
          `SELECT id FROM cs_draft_response WHERE inbox_item_id=? AND status='pending'`
        ).bind(inboxItemId).first();
        if (existingDraft) continue;

        // Generate AI draft
        const prompt = `Ты специалист по работе с клиентами WB-магазина.
Артикул: ${csSafeText_(review.sku_title || 'Товар', 100)}
Рейтинг: ${rating}/5
Отзыв: ${csSafeText_(review.customer_text || '', 800)}

Напиши профессиональный ответ на отзыв (до 1000 символов).
Требования:
- Поблагодари за отзыв
- Если негативный: извинись, предложи решение
- Если позитивный: поблагодари, пригласи снова
- Тон: дружелюбный, профессиональный
- Не используй клише типа "Ваше мнение важно для нас"
- Отвечай на конкретные замечания клиента

Ответь только текстом ответа, без пояснений.`;

        const aiResult = await csCallAi_(env, prompt);
        const draftText = aiResult.ok && aiResult.text
          ? csSafeText_(aiResult.text.trim(), 1000)
          : (isNegative
            ? 'Добрый день! Приносим извинения за доставленные неудобства. Пожалуйста, свяжитесь с нами для решения вопроса.'
            : 'Спасибо за ваш отзыв! Рады, что товар вам понравился. Будем рады видеть вас снова!');

        const draftId = wbGenerateId_('csd');
        const confirmId = csBuildConfirmationId_(inboxItemId, 'review_reply');
        const nowDraft = new Date().toISOString();

        await db.prepare(`
          INSERT INTO cs_draft_response
            (id, inbox_item_id, draft_text, draft_version, tone, language,
             ai_model_used, ai_confidence, status, confirmation_id, created_at, updated_at)
          VALUES (?,?,?,1,'professional',?,?,0.8,'pending',?,?,?)
        `).bind(
          draftId,
          inboxItemId,
          draftText,
          csDetectLanguage_(review.customer_text || ''),
          aiResult.model || 'none',
          confirmId,
          nowDraft, nowDraft
        ).run();

        // Mark inbox item as draft_ready
        await db.prepare(
          `UPDATE cs_inbox_item SET status='draft_ready', updated_at=? WHERE id=?`
        ).bind(nowDraft, inboxItemId).run();

        result.drafts_created++;
      } catch (e) {
        result.error_count++;
        await wbLog_(db, {
          entity_type: 'cs', entity_id: 'review_agent',
          action: 'draft_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    result.error_count++;
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'review_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 5 — Q&A Agent
// ============================================================

async function runQaAgent_(env, db, date) {
  const result = {
    date,
    questions_loaded: 0,
    drafts_created: 0,
    template_used_count: 0,
    ai_generated_count: 0,
  };

  try {
    const { data: questions, source_status } = await loadWbQuestions_(env, date);
    result.questions_loaded = questions.length;

    if (source_status === 'missing' || questions.length === 0) {
      return result;
    }

    for (const question of questions) {
      try {
        // Upsert inbox item
        const itemId = wbGenerateId_('csi');
        const now = new Date().toISOString();
        const existingItem = question.source_item_id
          ? await db.prepare(
              `SELECT id FROM cs_inbox_item WHERE source='wb_question' AND source_item_id=?`
            ).bind(question.source_item_id).first()
          : null;

        let inboxItemId = existingItem?.id || itemId;

        if (!existingItem) {
          await db.prepare(`
            INSERT INTO cs_inbox_item
              (id, user_id, source, source_item_id, nm_id, sku_title, customer_text,
               item_date, status, priority, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,'new','normal',?,?)
          `).bind(
            itemId,
            question.user_id || null,
            'wb_question',
            question.source_item_id || null,
            question.nm_id || null,
            question.sku_title || '',
            question.customer_text || '',
            question.date || date,
            now, now
          ).run();
          inboxItemId = itemId;
        }

        // Check for existing pending draft
        const existingDraft = await db.prepare(
          `SELECT id FROM cs_draft_response WHERE inbox_item_id=? AND status='pending'`
        ).bind(inboxItemId).first();
        if (existingDraft) continue;

        // Search knowledge base for matching templates
        const customerText = (question.customer_text || '').toLowerCase();
        const knowledgeItems = await db.prepare(
          `SELECT * FROM cs_knowledge_item WHERE is_active=1 ORDER BY usage_count DESC LIMIT 50`
        ).all();

        let templateBase = null;
        for (const ki of (knowledgeItems.results || [])) {
          let keywords = [];
          try { keywords = JSON.parse(ki.trigger_keywords_json || '[]'); } catch (_) {}
          const matched = keywords.some(kw => customerText.includes(String(kw).toLowerCase()));
          if (matched) { templateBase = ki; break; }
        }

        let draftText = '';
        let modelUsed = 'none';
        let usedTemplate = false;

        if (templateBase) {
          // Use template as base, optionally refine
          draftText = templateBase.template_text;
          modelUsed = 'template';
          usedTemplate = true;
          result.template_used_count++;

          // Update usage count
          await db.prepare(
            `UPDATE cs_knowledge_item SET usage_count=usage_count+1, last_used_at=? WHERE id=?`
          ).bind(new Date().toISOString(), templateBase.id).run();
        } else {
          // Generate with AI
          const prompt = `Вопрос покупателя о товаре "${csSafeText_(question.sku_title || 'Товар', 100)}": ${csSafeText_(question.customer_text || '', 600)}

Напиши точный и полезный ответ (до 500 символов).
- Отвечай конкретно на вопрос
- Если не знаешь точного ответа — скажи "Уточните у продавца"
- Не выдумывай характеристики товара
- Тон: дружелюбный, информативный

Только текст ответа.`;

          const aiResult = await csCallAi_(env, prompt);
          draftText = aiResult.ok && aiResult.text
            ? csSafeText_(aiResult.text.trim(), 500)
            : 'Добрый день! Пожалуйста, уточните этот вопрос у продавца через чат.';
          modelUsed = aiResult.model || 'none';
          result.ai_generated_count++;
        }

        const draftId = wbGenerateId_('csd');
        const confirmId = csBuildConfirmationId_(inboxItemId, 'qa_reply');
        const nowDraft = new Date().toISOString();

        await db.prepare(`
          INSERT INTO cs_draft_response
            (id, inbox_item_id, draft_text, draft_version, tone, language,
             ai_model_used, ai_confidence, status, confirmation_id, created_at, updated_at)
          VALUES (?,?,?,1,'friendly',?,?,?,  'pending',?,?,?)
        `).bind(
          draftId, inboxItemId, draftText,
          csDetectLanguage_(question.customer_text || ''),
          modelUsed,
          usedTemplate ? 1.0 : 0.75,
          confirmId, nowDraft, nowDraft
        ).run();

        await db.prepare(
          `UPDATE cs_inbox_item SET status='draft_ready', updated_at=? WHERE id=?`
        ).bind(nowDraft, inboxItemId).run();

        result.drafts_created++;
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: 'qa_agent',
          action: 'draft_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'qa_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 6 — Return Reason Agent
// ============================================================

async function runReturnReasonAgent_(env, db, date) {
  const result = {
    date,
    returns_loaded: 0,
    issues_logged: 0,
    new_issues: 0,
    escalated_issues: 0,
  };

  try {
    const { data: returns, source_status } = await loadWbReturns_(env, date);
    result.returns_loaded = returns.length;

    if (source_status === 'missing' || returns.length === 0) {
      return result;
    }

    for (const ret of returns) {
      try {
        const itemId = wbGenerateId_('csi');
        const now = new Date().toISOString();
        const existingItem = ret.source_item_id
          ? await db.prepare(
              `SELECT id FROM cs_inbox_item WHERE source='wb_return' AND source_item_id=?`
            ).bind(ret.source_item_id).first()
          : null;

        let inboxItemId = existingItem?.id || itemId;

        if (!existingItem) {
          await db.prepare(`
            INSERT INTO cs_inbox_item
              (id, user_id, source, source_item_id, nm_id, sku_title, customer_text,
               item_date, status, priority, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,'new','normal',?,?)
          `).bind(
            itemId,
            ret.user_id || null,
            'wb_return',
            ret.source_item_id || null,
            ret.nm_id || null,
            ret.sku_title || '',
            ret.customer_text || ret.reason || '',
            ret.date || date,
            now, now
          ).run();
          inboxItemId = itemId;
        }

        // Classify return reason with AI
        const classifyPrompt = `Причина возврата от покупателя: ${csSafeText_(ret.customer_text || ret.reason || '', 500)}
Артикул: ${csSafeText_(ret.sku_title || 'Товар', 100)}

Классифицируй причину возврата. Выбери одну из:
defect, sizing, description_mismatch, packaging, delivery, other

Ответь JSON: {"issue_type": "...", "severity": "low|normal|high|critical", "description": "..."}`;

        const aiResult = await csCallAi_(env, classifyPrompt, true);
        const classification = csParseAiJson_(aiResult.text, {
          issue_type: 'other',
          severity: 'normal',
          description: ret.customer_text || 'Не указано',
        });

        const issueType = CS_ISSUE_TYPES.includes(classification.issue_type)
          ? classification.issue_type : 'other';
        const severity = ['low', 'normal', 'high', 'critical'].includes(classification.severity)
          ? classification.severity : 'normal';

        const nmId = ret.nm_id || 0;

        // Aggregate: upsert cs_product_issue
        const existing = await db.prepare(
          `SELECT id, occurrence_count, source_inbox_ids_json FROM cs_product_issue
           WHERE nm_id=? AND issue_type=? AND severity=?`
        ).bind(nmId, issueType, severity).first();

        if (existing) {
          let ids = [];
          try { ids = JSON.parse(existing.source_inbox_ids_json || '[]'); } catch (_) {}
          if (!ids.includes(inboxItemId)) ids.push(inboxItemId);

          const newCount = (existing.occurrence_count || 0) + 1;
          const newSeverity = newCount >= 5 ? 'high' : severity;
          const escalated = newSeverity === 'high' && severity !== 'high';
          if (escalated) result.escalated_issues++;

          await db.prepare(`
            UPDATE cs_product_issue
            SET occurrence_count=?, severity=?, source_inbox_ids_json=?,
                last_seen_date=?, updated_at=?
            WHERE id=?
          `).bind(
            newCount, newSeverity, JSON.stringify(ids),
            date, new Date().toISOString(),
            existing.id
          ).run();

          result.issues_logged++;
        } else {
          const issueId = wbGenerateId_('csp');
          const confirmId = csBuildConfirmationId_(issueId, 'product_issue');
          const nowIssue = new Date().toISOString();

          await db.prepare(`
            INSERT INTO cs_product_issue
              (id, nm_id, sku_title, issue_type, issue_description, severity,
               source_inbox_ids_json, occurrence_count, first_seen_date, last_seen_date,
               status, confirmation_id, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,1,?,?,'open',?,?,?)
          `).bind(
            issueId, nmId, ret.sku_title || '',
            issueType, classification.description || '',
            severity,
            JSON.stringify([inboxItemId]),
            date, date,
            confirmId, nowIssue, nowIssue
          ).run();

          result.new_issues++;
          result.issues_logged++;
        }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: 'return_agent',
          action: 'classify_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'return_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 7 — Tone & Loyalty Agent
// ============================================================

async function runToneAnalysisAgent_(env, db, date) {
  const result = {
    date,
    drafts_analyzed: 0,
    passed_count: 0,
    needs_revision_count: 0,
    avg_score: 0,
  };

  try {
    const drafts = await db.prepare(
      `SELECT * FROM cs_draft_response WHERE status='approved' AND DATE(created_at)=?`
    ).bind(date).all();

    const draftList = drafts.results || [];
    result.drafts_analyzed = draftList.length;

    if (draftList.length === 0) return result;

    let totalScore = 0;

    for (const draft of draftList) {
      try {
        const tonePrompt = `Проверь тон ответа на соответствие фирменному стилю:
Ответ: ${csSafeText_(draft.draft_text || '', 800)}

Оцени по шкале 1-10:
- professionalism (профессионализм)
- friendliness (дружелюбие)
- empathy (эмпатия)
- clarity (ясность)

Ответь JSON: {"professionalism": N, "friendliness": N, "empathy": N, "clarity": N, "overall": N, "suggestion": "..."}`;

        const aiResult = await csCallAi_(env, tonePrompt, true);
        const scores = csParseAiJson_(aiResult.text, {
          professionalism: 7, friendliness: 7, empathy: 7, clarity: 7,
          overall: 7, suggestion: '',
        });

        const overall = typeof scores.overall === 'number' ? scores.overall : 7;
        totalScore += overall;

        // Save scores to payload_json
        let existingPayload = {};
        try { existingPayload = JSON.parse(draft.payload_json || '{}'); } catch (_) {}
        const updatedPayload = { ...existingPayload, tone_scores: scores };

        const now = new Date().toISOString();

        if (overall < 6) {
          // Send back to pending
          await db.prepare(
            `UPDATE cs_draft_response SET status='pending', payload_json=?, updated_at=? WHERE id=?`
          ).bind(JSON.stringify(updatedPayload), now, draft.id).run();

          result.needs_revision_count++;

          await wbLog_(db, {
            entity_type: 'cs', entity_id: draft.id,
            action: 'tone_revision_needed', status: 'warning',
            details_json: JSON.stringify({ overall, suggestion: scores.suggestion || '' }),
          });
        } else {
          await db.prepare(
            `UPDATE cs_draft_response SET payload_json=?, updated_at=? WHERE id=?`
          ).bind(JSON.stringify(updatedPayload), now, draft.id).run();

          result.passed_count++;
        }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: draft.id,
          action: 'tone_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }

    result.avg_score = draftList.length > 0
      ? wbRound_(totalScore / draftList.length, 1)
      : 0;
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'tone_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 8 — Product Issue Classifier Agent
// ============================================================

async function runProductIssueClassifierAgent_(env, db, date) {
  const result = {
    date,
    issues_analyzed: 0,
    escalated_count: 0,
    proposals_created: 0,
    insights_created: 0,
  };

  try {
    const issues = await db.prepare(
      `SELECT * FROM cs_product_issue WHERE status='open' AND occurrence_count >= 3`
    ).all();

    const issueList = issues.results || [];
    result.issues_analyzed = issueList.length;

    for (const issue of issueList) {
      try {
        const shouldEscalate =
          issue.occurrence_count >= 5 || issue.severity === 'critical';

        if (shouldEscalate) {
          result.escalated_count++;

          // Create proposal
          const proposalPayload = {
            proposal_type: 'create_product_task',
            title: `Проблема с товаром: ${issue.issue_type} — ${issue.sku_title || 'nm_id:' + issue.nm_id}`,
            issue_id: issue.id,
            nm_id: issue.nm_id,
            occurrence_count: issue.occurrence_count,
            severity: issue.severity,
            requires_confirmation: true,
          };

          let existingPayload = {};
          try { existingPayload = JSON.parse(issue.payload_json || '{}'); } catch (_) {}
          const updatedPayload = {
            ...existingPayload,
            proposal: proposalPayload,
          };

          const now = new Date().toISOString();
          await db.prepare(
            `UPDATE cs_product_issue SET payload_json=?, updated_at=? WHERE id=?`
          ).bind(JSON.stringify(updatedPayload), now, issue.id).run();

          result.proposals_created++;

          await wbLog_(db, {
            entity_type: 'cs', entity_id: issue.id,
            action: 'issue_escalated', status: 'warning',
            details_json: JSON.stringify(proposalPayload),
          });
        }

        // Generate insight
        const summaryPrompt = `В ${issue.occurrence_count} возвратах за последние дни покупатели указывают на ${issue.issue_type} товара ${issue.sku_title || 'nm_id:' + issue.nm_id}.
Описание: ${csSafeText_(issue.issue_description || '', 300)}

Напиши краткий инсайт (1-2 предложения) и предложи действие.
Ответ JSON: {"insight": "...", "suggested_action": "...", "actionable": true|false}`;

        const aiResult = await csCallAi_(env, summaryPrompt, true);
        const insightData = csParseAiJson_(aiResult.text, {
          insight: `В ${issue.occurrence_count} случаях зафиксирована проблема: ${issue.issue_type}`,
          suggested_action: 'Проверить товар и скорректировать описание или качество',
          actionable: true,
        });

        const insightId = wbGenerateId_('csfi');
        const insightNow = new Date().toISOString();

        try {
          await db.prepare(`
            INSERT OR REPLACE INTO cs_feedback_insight
              (id, date, nm_id, sku_title, insight_type, insight_text,
               data_points_count, confidence, actionable, suggested_action,
               status, payload_json, created_at)
            VALUES (?,?,?,?,'common_complaint',?,?,0.8,?,?,'new','{}',?)
          `).bind(
            insightId, date, issue.nm_id || null, issue.sku_title || '',
            insightData.insight || '',
            issue.occurrence_count,
            insightData.actionable ? 1 : 0,
            insightData.suggested_action || '',
            insightNow
          ).run();

          result.insights_created++;
        } catch (_) { /* UNIQUE constraint — insight already exists for this date/nm_id/type */ }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: issue.id,
          action: 'classifier_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'issue_classifier',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 9 — Product Feedback Agent
// ============================================================

async function runProductFeedbackAgent_(env, db, date) {
  const result = {
    date,
    skus_analyzed: 0,
    insights_created: 0,
    actionable_count: 0,
  };

  try {
    // Aggregate reviews for the date by nm_id
    const reviewsRaw = await db.prepare(
      `SELECT nm_id, sku_title, customer_text, customer_rating
       FROM cs_inbox_item
       WHERE source='wb_review' AND DATE(created_at)=?`
    ).bind(date).all();

    const reviewsList = reviewsRaw.results || [];

    // Group by nm_id
    const byNmId = {};
    for (const r of reviewsList) {
      const key = String(r.nm_id || '0');
      if (!byNmId[key]) byNmId[key] = { nm_id: r.nm_id, sku_title: r.sku_title, reviews: [] };
      byNmId[key].reviews.push(r);
    }

    for (const [, skuData] of Object.entries(byNmId)) {
      if (skuData.reviews.length < 3) continue;

      result.skus_analyzed++;

      try {
        const ratings = skuData.reviews
          .map(r => r.customer_rating || 0)
          .filter(v => v > 0);
        const avgRating = ratings.length > 0
          ? wbRound_(ratings.reduce((a, b) => a + b, 0) / ratings.length, 1)
          : 0;

        const reviewsTextList = skuData.reviews
          .map((r, i) => `${i + 1}. [${r.customer_rating || '?'}/5] ${csSafeText_(r.customer_text || '', 200)}`)
          .join('\n');

        const feedbackPrompt = `Отзывы по товару "${csSafeText_(skuData.sku_title || 'Товар', 100)}" за ${date}:
${csSafeText_(reviewsTextList, 1500)}

Выдели 2-3 главных темы из отзывов: что хвалят, что критикуют.
Ответь JSON: {"praise": ["..."], "complaints": ["..."], "actionable": true|false, "suggested_action": "..."}`;

        const aiResult = await csCallAi_(env, feedbackPrompt, true);
        const feedbackData = csParseAiJson_(aiResult.text, {
          praise: [],
          complaints: [],
          actionable: false,
          suggested_action: '',
        });

        // Rating drop insight
        if (avgRating > 0 && avgRating < 3.5) {
          const dropInsightId = wbGenerateId_('csfi');
          const insightText = `Средний рейтинг товара ${skuData.sku_title || skuData.nm_id} упал до ${avgRating} по ${skuData.reviews.length} отзывам за ${date}.`;
          const nowIns = new Date().toISOString();

          try {
            await db.prepare(`
              INSERT OR REPLACE INTO cs_feedback_insight
                (id, date, nm_id, sku_title, insight_type, insight_text,
                 data_points_count, confidence, actionable, suggested_action,
                 status, payload_json, created_at)
              VALUES (?,?,?,?,'rating_drop',?,?,0.9,1,?,'new','{}',?)
            `).bind(
              dropInsightId, date,
              skuData.nm_id || null, skuData.sku_title || '',
              insightText,
              skuData.reviews.length,
              feedbackData.suggested_action || 'Проверить качество товара и ответить на негативные отзывы',
              nowIns
            ).run();

            result.insights_created++;
            result.actionable_count++;
          } catch (_) { /* UNIQUE constraint */ }
        }

        // Sentiment insight
        const hasPraise = feedbackData.praise && feedbackData.praise.length > 0;
        const hasComplaints = feedbackData.complaints && feedbackData.complaints.length > 0;

        if (hasPraise || hasComplaints) {
          const insightType = hasComplaints ? 'common_complaint' : 'praise_topic';
          const insightText = hasComplaints
            ? `Жалобы по товару ${skuData.sku_title || skuData.nm_id}: ${feedbackData.complaints.join(', ')}.`
            : `Хвалят товар ${skuData.sku_title || skuData.nm_id}: ${feedbackData.praise.join(', ')}.`;

          const sentInsightId = wbGenerateId_('csfi');
          const nowSent = new Date().toISOString();

          try {
            await db.prepare(`
              INSERT OR REPLACE INTO cs_feedback_insight
                (id, date, nm_id, sku_title, insight_type, insight_text,
                 data_points_count, confidence, actionable, suggested_action,
                 status, payload_json, created_at)
              VALUES (?,?,?,?,?,?,?,0.8,?,?,'new',?,?)
            `).bind(
              sentInsightId, date,
              skuData.nm_id || null, skuData.sku_title || '',
              insightType,
              insightText,
              skuData.reviews.length,
              feedbackData.actionable ? 1 : 0,
              feedbackData.suggested_action || '',
              JSON.stringify({ praise: feedbackData.praise, complaints: feedbackData.complaints }),
              nowSent
            ).run();

            result.insights_created++;
            if (feedbackData.actionable) result.actionable_count++;
          } catch (_) { /* UNIQUE constraint */ }
        }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: String(skuData.nm_id || 'unknown'),
          action: 'feedback_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'feedback_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 10 — CS Chief Orchestrator
// ============================================================

async function runCsOperationsChief_(env, date, userId) {
  const db = env.DB;
  const reportDate = date || wbYesterday_();
  const now = new Date().toISOString();

  await ensureCsSchema_(db);

  // Phase 1: run data-loading agents in parallel
  const [reviewResult, qaResult, returnResult] = await Promise.all([
    runReviewResponseAgent_(env, db, reportDate),
    runQaAgent_(env, db, reportDate),
    runReturnReasonAgent_(env, db, reportDate),
  ]);

  // Phase 2: sequential agents that depend on Phase 1
  const toneResult = await runToneAnalysisAgent_(env, db, reportDate);
  const classifierResult = await runProductIssueClassifierAgent_(env, db, reportDate);
  const feedbackResult = await runProductFeedbackAgent_(env, db, reportDate);

  // Collect proposals
  const proposals = await db.prepare(
    `SELECT id, nm_id, sku_title, payload_json FROM cs_product_issue
     WHERE status='open' AND occurrence_count >= 5`
  ).all();

  const proposalList = (proposals.results || []).filter(p => {
    try {
      const pl = JSON.parse(p.payload_json || '{}');
      return pl.proposal && pl.proposal.requires_confirmation;
    } catch (_) { return false; }
  });

  // Generate AI summary
  const summaryPrompt = `Сводка клиент-сервиса за ${reportDate}:
- Отзывов: ${reviewResult.reviews_loaded}, черновиков готово: ${reviewResult.drafts_created}
- Вопросов: ${qaResult.questions_loaded}, черновиков готово: ${qaResult.drafts_created}
- Возвратов: ${returnResult.returns_loaded}, проблем выявлено: ${returnResult.issues_logged}
- Проблем с товарами (>3 случаев): ${classifierResult.issues_analyzed}

Напиши краткий дайджест (3-5 предложений) для руководителя.`;

  const summaryAi = await csCallAi_(env, summaryPrompt);
  const summaryText = summaryAi.ok && summaryAi.text
    ? summaryAi.text.trim()
    : `За ${reportDate}: обработано ${reviewResult.reviews_loaded} отзывов, ${qaResult.questions_loaded} вопросов, ${returnResult.returns_loaded} возвратов. Черновиков ответов: ${reviewResult.drafts_created + qaResult.drafts_created}. Проблем с товарами выявлено: ${classifierResult.issues_analyzed}.`;

  const report = {
    date: reportDate,
    generated_at: now,
    build: CS_BUILD,
    summary: summaryText,
    review_agent: reviewResult,
    qa_agent: qaResult,
    return_agent: returnResult,
    tone_agent: toneResult,
    issue_classifier: classifierResult,
    feedback_agent: feedbackResult,
    proposals: proposalList.map(p => {
      let pl = {};
      try { pl = JSON.parse(p.payload_json || '{}'); } catch (_) {}
      return pl.proposal || {};
    }),
    totals: {
      reviews_loaded: reviewResult.reviews_loaded,
      questions_loaded: qaResult.questions_loaded,
      returns_loaded: returnResult.returns_loaded,
      drafts_created: reviewResult.drafts_created + qaResult.drafts_created,
      issues_found: classifierResult.issues_analyzed,
      insights_created: feedbackResult.insights_created,
    },
  };

  await wbLog_(db, {
    entity_type: 'cs', entity_id: CS_CHIEF,
    action: 'chief_run_complete', status: 'ok',
    details_json: JSON.stringify({ date: reportDate, totals: report.totals }),
  });

  return report;
}

// ============================================================
// SECTION 11 — CS Telegram Handler
// ============================================================

async function routeCsTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!text.startsWith('/cs_')) return false;

  const command = text.split(' ')[0].toLowerCase();

  try {
    await ensureCsSchema_(db);

    if (command === '/cs_today') {
      const date = wbYesterday_();
      const report = await runCsOperationsChief_(env, date, userId);
      const safeSummary = csEscapeMd_(report.summary);
      const safeDate = csEscapeMd_(wbFormatDate_(date));
      const t = report.totals;
      const msgText =
        `*Сводка клиент\\-сервиса за ${safeDate}*\n\n` +
        `${safeSummary}\n\n` +
        `📥 Отзывов: ${t.reviews_loaded}\n` +
        `❓ Вопросов: ${t.questions_loaded}\n` +
        `↩️ Возвратов: ${t.returns_loaded}\n` +
        `✍️ Черновиков: ${t.drafts_created}\n` +
        `⚠️ Проблем с товарами: ${t.issues_found}`;
      await csSendTelegramMessage_(token, chatId, msgText);
      return true;
    }

    if (command === '/cs_reviews') {
      const rows = await db.prepare(
        `SELECT i.id, i.sku_title, i.customer_text, i.customer_rating,
                d.id as draft_id, d.draft_text, d.status as draft_status
         FROM cs_inbox_item i
         LEFT JOIN cs_draft_response d ON d.inbox_item_id=i.id AND d.status='pending'
         WHERE i.source='wb_review' AND i.status IN ('new','draft_ready')
         ORDER BY i.created_at DESC LIMIT 10`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Новых отзывов нет.'));
        return true;
      }

      for (const item of items) {
        const title = csEscapeMd_(item.sku_title || 'Товар');
        const rating = item.customer_rating ? `${item.customer_rating}/5` : '—';
        const reviewText = csEscapeMd_(csSafeText_(item.customer_text || '', 300));
        const draftText = item.draft_text
          ? csEscapeMd_(csSafeText_(item.draft_text, 400))
          : csEscapeMd_('Черновик не готов');

        let msgBody =
          `*Отзыв* — ${title} \\(${csEscapeMd_(rating)}\\)\n` +
          `_${reviewText}_\n\n` +
          `*Черновик ответа:*\n${draftText}`;

        if (item.draft_id) {
          msgBody += `\n\n` +
            `✅ /cs\\_approve\\_${item.draft_id}\n` +
            `🔄 /cs\\_reject\\_${item.draft_id}\n` +
            `👤 /cs\\_escalate\\_${item.draft_id}`;
        }

        await csSendTelegramMessage_(token, chatId, msgBody);
      }
      return true;
    }

    if (command === '/cs_questions') {
      const rows = await db.prepare(
        `SELECT i.id, i.sku_title, i.customer_text,
                d.id as draft_id, d.draft_text
         FROM cs_inbox_item i
         LEFT JOIN cs_draft_response d ON d.inbox_item_id=i.id AND d.status='pending'
         WHERE i.source='wb_question' AND i.status IN ('new','draft_ready')
         ORDER BY i.created_at DESC LIMIT 10`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Неотвеченных вопросов нет.'));
        return true;
      }

      for (const item of items) {
        const title = csEscapeMd_(item.sku_title || 'Товар');
        const qText = csEscapeMd_(csSafeText_(item.customer_text || '', 300));
        const draftText = item.draft_text
          ? csEscapeMd_(csSafeText_(item.draft_text, 400))
          : csEscapeMd_('Черновик не готов');

        let msgBody =
          `*Вопрос* — ${title}\n_${qText}_\n\n` +
          `*Черновик ответа:*\n${draftText}`;

        if (item.draft_id) {
          msgBody += `\n\n` +
            `✅ /cs\\_approve\\_${item.draft_id}\n` +
            `🔄 /cs\\_reject\\_${item.draft_id}\n` +
            `👤 /cs\\_escalate\\_${item.draft_id}`;
        }

        await csSendTelegramMessage_(token, chatId, msgBody);
      }
      return true;
    }

    if (command === '/cs_returns') {
      const rows = await db.prepare(
        `SELECT id, sku_title, customer_text, item_date, priority
         FROM cs_inbox_item
         WHERE source='wb_return'
           AND DATE(created_at) >= DATE('now','-7 days')
         ORDER BY created_at DESC LIMIT 20`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Возвратов за последние 7 дней нет.'));
        return true;
      }

      let out = `*Возвраты за последние 7 дней* \\(${items.length}\\)\n\n`;
      for (const item of items) {
        const date = csEscapeMd_(item.item_date || '—');
        const sku = csEscapeMd_(item.sku_title || 'Товар');
        const reason = csEscapeMd_(csSafeText_(item.customer_text || '', 150));
        out += `• ${date} — ${sku}: _${reason}_\n`;
      }
      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/cs_appeals') {
      const rows = await db.prepare(
        `SELECT id, nm_id, sku_title, issue_type, severity, occurrence_count, status
         FROM cs_product_issue
         WHERE status='open' AND severity IN ('high','critical')
         ORDER BY severity DESC, occurrence_count DESC LIMIT 20`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Открытых жалоб высокого приоритета нет.'));
        return true;
      }

      let out = `*Открытые жалобы \\(high/critical\\)* \\(${items.length}\\)\n\n`;
      for (const item of items) {
        const sev = csEscapeMd_(item.severity || '—');
        const sku = csEscapeMd_(item.sku_title || `nm_id:${item.nm_id}`);
        const type = csEscapeMd_(item.issue_type || '—');
        out += `⚠️ *${sev}* — ${sku} — ${type} \\(${item.occurrence_count} раз\\)\n`;
        out += `   /cs\\_create\\_task\\_${item.id}\n`;
      }
      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/cs_issues') {
      const rows = await db.prepare(
        `SELECT id, nm_id, sku_title, issue_type, severity, occurrence_count, status, first_seen_date
         FROM cs_product_issue
         WHERE status IN ('open','in_progress')
         ORDER BY occurrence_count DESC, severity DESC LIMIT 20`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Открытых проблем с товарами нет.'));
        return true;
      }

      let out = `*Все открытые проблемы с товарами* \\(${items.length}\\)\n\n`;
      for (const item of items) {
        const sev = csEscapeMd_(item.severity || '—');
        const sku = csEscapeMd_(item.sku_title || `nm:${item.nm_id}`);
        const type = csEscapeMd_(item.issue_type || '—');
        const status = csEscapeMd_(item.status || '—');
        out += `• ${sku} — ${type} \\[${sev}\\] — ${item.occurrence_count}x — ${status}\n`;
      }
      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/cs_templates') {
      const rows = await db.prepare(
        `SELECT id, category, template_text, tone, usage_count, is_active
         FROM cs_knowledge_item
         WHERE is_active=1
         ORDER BY usage_count DESC LIMIT 15`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('База шаблонов пуста.'));
        return true;
      }

      let out = `*Шаблоны ответов* \\(${items.length}\\)\n\n`;
      for (const item of items) {
        const cat = csEscapeMd_(item.category || '—');
        const tone = csEscapeMd_(item.tone || '—');
        const preview = csEscapeMd_(csSafeText_(item.template_text || '', 100));
        out += `*${cat}* \\(${tone}\\) — использован ${item.usage_count}x\n_${preview}_\n\n`;
      }
      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/cs_run') {
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Запускаю CS Chief... Это займёт несколько секунд.'));
      const date = wbYesterday_();
      const report = await runCsOperationsChief_(env, date, userId);
      const safeSummary = csEscapeMd_(report.summary);
      const t = report.totals;
      const doneMsg =
        `*CS Chief завершён* \\(${csEscapeMd_(wbFormatDate_(date))}\\)\n\n` +
        `${safeSummary}\n\n` +
        `📥 Отзывов: ${t.reviews_loaded}\n` +
        `❓ Вопросов: ${t.questions_loaded}\n` +
        `↩️ Возвратов: ${t.returns_loaded}\n` +
        `✍️ Черновиков создано: ${t.drafts_created}\n` +
        `⚠️ Проблем с товарами: ${t.issues_found}\n` +
        `💡 Инсайтов: ${t.insights_created}`;
      await csSendTelegramMessage_(token, chatId, doneMsg);
      return true;
    }

    // Handle inline-style deep-link commands (from button callbacks sent as messages)
    if (command.startsWith('/cs_approve_')) {
      const draftId = text.replace('/cs_approve_', '');
      await handleCsApproveDraft_(db, draftId, userId);
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Ответ одобрен.'));
      return true;
    }

    if (command.startsWith('/cs_reject_')) {
      const draftId = text.replace('/cs_reject_', '');
      await handleCsRejectDraft_(db, draftId, null, userId);
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Черновик отклонён, будет переработан.'));
      return true;
    }

    if (command.startsWith('/cs_escalate_')) {
      const draftId = text.replace('/cs_escalate_', '');
      await handleCsEscalateDraft_(db, draftId, userId);
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Обращение передано специалисту.'));
      return true;
    }

    if (command.startsWith('/cs_create_task_')) {
      const issueId = text.replace('/cs_create_task_', '');
      await handleCsCreateTask_(db, issueId, userId);
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Задача по проблеме с товаром создана.'));
      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'telegram_handler',
      action: 'command_error', status: 'error',
      details_json: JSON.stringify({ command, error: String(e) }),
    });
    try {
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Произошла ошибка при выполнении команды.'));
    } catch (_) {}
  }

  return false;
}

// ============================================================
// SECTION 12 — CS Callback Handler (shared action helpers)
// ============================================================

async function handleCsApproveDraft_(db, draftId, userId) {
  const draft = await db.prepare(`SELECT * FROM cs_draft_response WHERE id=?`).bind(draftId).first();
  if (!draft) return { ok: false, error: 'draft_not_found' };
  if (draft.status === 'approved' || draft.status === 'sent') {
    return { ok: true, idempotent: true };
  }

  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE cs_draft_response SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?`
  ).bind(userId || null, now, now, draftId).run();

  await db.prepare(
    `UPDATE cs_inbox_item SET status='approved', updated_at=? WHERE id=?`
  ).bind(now, draft.inbox_item_id).run();

  await wbLog_(db, {
    entity_type: 'cs', entity_id: draftId,
    action: 'draft_approved', status: 'ok',
    details_json: JSON.stringify({ approved_by: userId }),
  });

  return { ok: true };
}

async function handleCsRejectDraft_(db, draftId, reason, userId) {
  const draft = await db.prepare(`SELECT * FROM cs_draft_response WHERE id=?`).bind(draftId).first();
  if (!draft) return { ok: false, error: 'draft_not_found' };
  if (draft.status === 'rejected') return { ok: true, idempotent: true };

  const now = new Date().toISOString();
  const newVersion = (draft.draft_version || 1) + 1;

  await db.prepare(
    `UPDATE cs_draft_response
     SET status='rejected', rejection_reason=?, draft_version=?, updated_at=?
     WHERE id=?`
  ).bind(reason || null, newVersion, now, draftId).run();

  await wbLog_(db, {
    entity_type: 'cs', entity_id: draftId,
    action: 'draft_rejected', status: 'ok',
    details_json: JSON.stringify({ reason, rejected_by: userId }),
  });

  return { ok: true };
}

async function handleCsEscalateDraft_(db, draftId, userId) {
  const draft = await db.prepare(`SELECT * FROM cs_draft_response WHERE id=?`).bind(draftId).first();
  if (!draft) return { ok: false, error: 'draft_not_found' };

  const now = new Date().toISOString();

  await db.prepare(
    `UPDATE cs_inbox_item SET status='escalated', updated_at=? WHERE id=?`
  ).bind(now, draft.inbox_item_id).run();

  await wbLog_(db, {
    entity_type: 'cs', entity_id: draftId,
    action: 'draft_escalated', status: 'ok',
    details_json: JSON.stringify({ escalated_by: userId }),
  });

  return { ok: true };
}

async function handleCsCreateTask_(db, issueId, userId) {
  const issue = await db.prepare(`SELECT * FROM cs_product_issue WHERE id=?`).bind(issueId).first();
  if (!issue) return { ok: false, error: 'issue_not_found' };
  if (issue.status === 'in_progress' || issue.status === 'resolved') {
    return { ok: true, idempotent: true };
  }

  const now = new Date().toISOString();

  await db.prepare(
    `UPDATE cs_product_issue SET status='in_progress', updated_at=? WHERE id=?`
  ).bind(now, issueId).run();

  await wbLog_(db, {
    entity_type: 'cs', entity_id: issueId,
    action: 'product_task_created', status: 'ok',
    details_json: JSON.stringify({ created_by: userId }),
  });

  return { ok: true };
}

async function routeCsCallbackQuery_(env, callbackQuery) {
  const db = env.DB;
  const data = callbackQuery.data || '';
  const userId = String(callbackQuery.from?.id || '');
  const chatId = callbackQuery.message?.chat?.id;
  const token = env.TELEGRAM_BOT_TOKEN;

  try {
    await ensureCsSchema_(db);

    if (data.startsWith('cs_approve_')) {
      const draftId = data.replace('cs_approve_', '');
      const result = await handleCsApproveDraft_(db, draftId, userId);
      if (token && chatId) {
        const txt = result.idempotent
          ? csEscapeMd_('Ответ уже был одобрен ранее.')
          : csEscapeMd_('Ответ одобрен.');
        await csSendTelegramMessage_(token, chatId, txt);
      }
      return true;
    }

    if (data.startsWith('cs_reject_')) {
      const draftId = data.replace('cs_reject_', '');
      const result = await handleCsRejectDraft_(db, draftId, null, userId);
      if (token && chatId) {
        const txt = result.idempotent
          ? csEscapeMd_('Черновик уже был отклонён.')
          : csEscapeMd_('Черновик отклонён, будет переработан.');
        await csSendTelegramMessage_(token, chatId, txt);
      }
      return true;
    }

    if (data.startsWith('cs_escalate_')) {
      const draftId = data.replace('cs_escalate_', '');
      const result = await handleCsEscalateDraft_(db, draftId, userId);
      if (token && chatId) {
        const txt = result.ok
          ? csEscapeMd_('Обращение передано специалисту.')
          : csEscapeMd_('Ошибка при эскалации.');
        await csSendTelegramMessage_(token, chatId, txt);
      }
      return true;
    }

    if (data.startsWith('cs_create_task_')) {
      const issueId = data.replace('cs_create_task_', '');
      const result = await handleCsCreateTask_(db, issueId, userId);
      if (token && chatId) {
        const txt = result.idempotent
          ? csEscapeMd_('Задача уже была создана.')
          : (result.ok
            ? csEscapeMd_('Задача по проблеме с товаром создана.')
            : csEscapeMd_('Ошибка при создании задачи.'));
        await csSendTelegramMessage_(token, chatId, txt);
      }
      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'callback_handler',
      action: 'callback_error', status: 'error',
      details_json: JSON.stringify({ data, error: String(e) }),
    });
  }

  return false;
}

// ============================================================
// SECTION 13 — CS API Router
// ============================================================

async function handleCsAgentRoutes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;

  if (!path.startsWith('/agent/cs/')) return null;

  const jsonResponse = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    await ensureCsSchema_(db);

    // GET /agent/cs/health
    if (method === 'GET' && path === '/agent/cs/health') {
      const tables = ['cs_inbox_item', 'cs_draft_response', 'cs_product_issue',
                      'cs_knowledge_item', 'cs_feedback_insight'];
      const counts = {};
      for (const tbl of tables) {
        try {
          const row = await db.prepare(`SELECT COUNT(*) as n FROM ${tbl}`).first();
          counts[tbl] = row?.n || 0;
        } catch (_) {
          counts[tbl] = -1;
        }
      }
      return jsonResponse({ ok: true, build: CS_BUILD, table_counts: counts });
    }

    // POST /agent/cs/report/run
    if (method === 'POST' && path === '/agent/cs/report/run') {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const date = body.date || wbYesterday_();
      const userId = body.user_id || null;
      const report = await runCsOperationsChief_(env, date, userId);
      return jsonResponse({ ok: true, report });
    }

    // GET /agent/cs/inbox
    if (method === 'GET' && path === '/agent/cs/inbox') {
      const status = url.searchParams.get('status') || null;
      const source = url.searchParams.get('source') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_inbox_item WHERE 1=1`;
      const binds = [];
      if (status) { sql += ` AND status=?`; binds.push(status); }
      if (source) { sql += ` AND source=?`; binds.push(source); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, items: rows.results || [], count: (rows.results || []).length });
    }

    // GET /agent/cs/drafts
    if (method === 'GET' && path === '/agent/cs/drafts') {
      const status = url.searchParams.get('status') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_draft_response WHERE 1=1`;
      const binds = [];
      if (status) { sql += ` AND status=?`; binds.push(status); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, drafts: rows.results || [], count: (rows.results || []).length });
    }

    // POST /agent/cs/drafts/:id/approve
    const approveMatch = path.match(/^\/agent\/cs\/drafts\/([^/]+)\/approve$/);
    if (method === 'POST' && approveMatch) {
      const draftId = approveMatch[1];
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const result = await handleCsApproveDraft_(db, draftId, body.user_id || null);
      return jsonResponse(result, result.ok ? 200 : 404);
    }

    // POST /agent/cs/drafts/:id/reject
    const rejectMatch = path.match(/^\/agent\/cs\/drafts\/([^/]+)\/reject$/);
    if (method === 'POST' && rejectMatch) {
      const draftId = rejectMatch[1];
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const result = await handleCsRejectDraft_(db, draftId, body.reason || null, body.user_id || null);
      return jsonResponse(result, result.ok ? 200 : 404);
    }

    // GET /agent/cs/issues
    if (method === 'GET' && path === '/agent/cs/issues') {
      const status = url.searchParams.get('status') || null;
      const severity = url.searchParams.get('severity') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_product_issue WHERE 1=1`;
      const binds = [];
      if (status) { sql += ` AND status=?`; binds.push(status); }
      if (severity) { sql += ` AND severity=?`; binds.push(severity); }
      sql += ` ORDER BY occurrence_count DESC, created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, issues: rows.results || [], count: (rows.results || []).length });
    }

    // GET /agent/cs/insights
    if (method === 'GET' && path === '/agent/cs/insights') {
      const date = url.searchParams.get('date') || null;
      const nmId = url.searchParams.get('nm_id') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_feedback_insight WHERE 1=1`;
      const binds = [];
      if (date) { sql += ` AND date=?`; binds.push(date); }
      if (nmId) { sql += ` AND nm_id=?`; binds.push(nmId); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, insights: rows.results || [], count: (rows.results || []).length });
    }

    // GET /agent/cs/knowledge
    if (method === 'GET' && path === '/agent/cs/knowledge') {
      const category = url.searchParams.get('category') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_knowledge_item WHERE is_active=1`;
      const binds = [];
      if (category) { sql += ` AND category=?`; binds.push(category); }
      sql += ` ORDER BY usage_count DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, items: rows.results || [], count: (rows.results || []).length });
    }

    // POST /agent/cs/knowledge
    if (method === 'POST' && path === '/agent/cs/knowledge') {
      let body = {};
      try { body = await request.json(); } catch (_) {}

      if (!body.category || !body.template_text) {
        return jsonResponse({ ok: false, error: 'category and template_text are required' }, 400);
      }

      const id = wbGenerateId_('csk');
      const now = new Date().toISOString();

      await db.prepare(`
        INSERT INTO cs_knowledge_item
          (id, user_id, category, trigger_keywords_json, template_text,
           tone, language, is_active, tags_json, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,1,?,?,?)
      `).bind(
        id,
        body.user_id || null,
        body.category,
        JSON.stringify(body.trigger_keywords || []),
        body.template_text,
        body.tone || 'professional',
        body.language || 'ru',
        JSON.stringify(body.tags || []),
        now, now
      ).run();

      return jsonResponse({ ok: true, id });
    }

    // GET /agent/cs/log
    if (method === 'GET' && path === '/agent/cs/log') {
      const entityId = url.searchParams.get('entity_id') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM wb_action_log WHERE entity_type='cs'`;
      const binds = [];
      if (entityId) { sql += ` AND entity_id=?`; binds.push(entityId); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      let rows = { results: [] };
      try { rows = await db.prepare(sql).bind(...binds).all(); } catch (_) {}
      return jsonResponse({ ok: true, log: rows.results || [], count: (rows.results || []).length });
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'api_router',
      action: 'route_error', status: 'error',
      details_json: JSON.stringify({ path, method, error: String(e) }),
    });
    return jsonResponse({ ok: false, error: String(e) }, 500);
  }

  return null;
}
// ============================================================
// CS Operations Chief — Stage 2 (v1)
// Build: ai_helpers_stage2_cs_operations_v1
// Extends: cs_operations_stage1_v1.gs (do NOT modify Stage 1)
//
// ── New Tables ───────────────────────────────────────────────
//   cs_appeal_item         — WB review appeal drafts and submissions
//   cs_knowledge_gap       — detected KB gaps with frequency tracking
//
// ── Schema Patches (ALTER TABLE) ────────────────────────────
//   cs_inbox_item:    + marketplace, vendor_code, item_type,
//                       customer_name, sentiment, topic,
//                       requires_human_review
//   cs_draft_response: + source_agent, tone_status, risk_status
//
// ── New Agents ───────────────────────────────────────────────
//   runComplaintAppealAgent_    — classify/draft WB review appeals
//   runKnowledgeBaseAgent_      — detect KB gaps, suggest templates
//   runToneLoyaltyAgentV2_      — enhanced tone + risk phrase guard
//   runCsOperationsChiefV2_     — V2 orchestrator (all 6 agents)
//
// ── New Telegram Commands ────────────────────────────────────
//   /cs_appeals   — overrides Stage 1: shows appeal drafts with buttons
//   /cs_knowledge — knowledge gaps + stale items
//
// ── New Callbacks ────────────────────────────────────────────
//   cs_submit_appeal_*    — submit appeal (idempotent)
//   cs_cancel_appeal_*    — cancel appeal
//   cs_create_kb_*        — generate KB template from gap
//
// ── New API Endpoints ────────────────────────────────────────
//   GET  /agent/cs/appeals
//   POST /agent/cs/appeals/:id/submit
//   GET  /agent/cs/knowledge/gaps
//   POST /agent/cs/knowledge/gaps/:id/create-template
//   POST /agent/cs/report/run/v2
//
// Dependencies (Stage 1, always loaded first):
//   csCallAi_(), csEscapeMd_(), csSendTelegramMessage_(),
//   csBuildConfirmationId_(), csSafeText_(), csDetectLanguage_()
//   wbGenerateId_(), wbLog_(), wbYesterday_(), wbFormatDate_(),
//   wbRound_(), runReviewResponseAgent_(), runQaAgent_(),
//   runReturnReasonAgent_(), runProductIssueClassifierAgent_(),
//   runProductFeedbackAgent_(), routeCsCallbackQuery_()
// ============================================================

const CS_BUILD_V2 = 'ai_helpers_stage2_cs_operations_v1';

// ============================================================
// SECTION 1 — Schema Patch
// ============================================================

async function ensureCsStage2Schema_(db) {
  // New table: cs_appeal_item
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS cs_appeal_item (
      id TEXT PRIMARY KEY,
      inbox_item_id TEXT NOT NULL,
      nm_id INTEGER,
      sku_title TEXT,
      user_id TEXT,
      appeal_reason TEXT NOT NULL,
      appeal_possible INTEGER DEFAULT 0,
      evidence_json TEXT DEFAULT '[]',
      draft_appeal TEXT,
      risk_level TEXT DEFAULT 'low',
      status TEXT DEFAULT 'draft',
      confirmation_id TEXT UNIQUE,
      submitted_at TEXT,
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`).run();
  } catch (_) { /* already exists */ }

  // New table: cs_knowledge_gap
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS cs_knowledge_gap (
      id TEXT PRIMARY KEY,
      nm_id INTEGER,
      sku_title TEXT,
      topic TEXT NOT NULL,
      question_pattern TEXT,
      frequency_count INTEGER DEFAULT 1,
      source_items_json TEXT DEFAULT '[]',
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(nm_id, topic)
    )`).run();
  } catch (_) { /* already exists */ }

  // Patch cs_inbox_item — each column in its own try/catch
  const inboxPatches = [
    `ALTER TABLE cs_inbox_item ADD COLUMN marketplace TEXT DEFAULT 'wb'`,
    `ALTER TABLE cs_inbox_item ADD COLUMN vendor_code TEXT`,
    `ALTER TABLE cs_inbox_item ADD COLUMN item_type TEXT`,
    `ALTER TABLE cs_inbox_item ADD COLUMN customer_name TEXT`,
    `ALTER TABLE cs_inbox_item ADD COLUMN sentiment TEXT DEFAULT 'neutral'`,
    `ALTER TABLE cs_inbox_item ADD COLUMN topic TEXT`,
    `ALTER TABLE cs_inbox_item ADD COLUMN requires_human_review INTEGER DEFAULT 0`,
  ];

  for (const sql of inboxPatches) {
    try { await db.prepare(sql).run(); } catch (_) { /* duplicate column — ignore */ }
  }

  // Patch cs_draft_response — each column in its own try/catch
  const draftPatches = [
    `ALTER TABLE cs_draft_response ADD COLUMN source_agent TEXT`,
    `ALTER TABLE cs_draft_response ADD COLUMN tone_status TEXT DEFAULT 'pending'`,
    `ALTER TABLE cs_draft_response ADD COLUMN risk_status TEXT DEFAULT 'ok'`,
  ];

  for (const sql of draftPatches) {
    try { await db.prepare(sql).run(); } catch (_) { /* duplicate column — ignore */ }
  }
}

// ============================================================
// SECTION 2 — Complaint / Appeal Agent
// ============================================================

const CS_APPEAL_REASON = {
  NOT_ABOUT_PRODUCT:  'review_not_about_product',
  FALSE_CLAIM:        'false_claim_possible',
  NO_PRODUCT_USAGE:   'no_product_usage',
  COMPETITOR_ATTACK:  'competitor_attack_suspicion',
  OFFENSIVE_CONTENT:  'offensive_content',
  DELIVERY_ISSUE:     'delivery_or_pickup_issue',
  MARKETPLACE_RULE:   'marketplace_rule_violation',
  UNKNOWN:            'unknown',
};

function classifyAppealReason_(customerText, rating) {
  const text = (customerText || '').toLowerCase();

  // Not about product
  if (/не\s*мой\s*заказ|перепутали|не\s*получал|не\s*приходил|чужой\s*заказ/.test(text)) {
    return CS_APPEAL_REASON.NOT_ABOUT_PRODUCT;
  }

  // Offensive content (obscene language patterns)
  if (/[хx][уy][йяеё]|[бb][лl][яaя]|[пp][иi][зz][дd]|[еe][бb][аa][лl]|[гg][аa][вv][нн]/.test(text)) {
    return CS_APPEAL_REASON.OFFENSIVE_CONTENT;
  }

  // Competitor attack — mention of rival brands
  if (/\b(lamoda|ozon|озон|яндекс\s*маркет|yandex\s*market|aliexpress|ali\s*express|amazon|амазон)\b/.test(text)) {
    return CS_APPEAL_REASON.COMPETITOR_ATTACK;
  }

  // Delivery / courier issue without product mention
  if (/курьер|доставщик|пункт\s*выдачи|пвз|не\s*привез|не\s*привёз|привезли\s*не\s*то/.test(text) &&
      !/товар|изделие|продукт|вещь|качество/.test(text)) {
    return CS_APPEAL_REASON.DELIVERY_ISSUE;
  }

  // False claim: rating 1 but very short or generic text
  if (rating === 1 && (text.length < 20 || /^(плохо|ужасно|отвратительно|не\s*понравилось?)$/.test(text.trim()))) {
    return CS_APPEAL_REASON.FALSE_CLAIM;
  }

  // No product-specific usage info with low rating
  if (rating <= 2 && !/использовал|применял|надевал|носил|пользовался|работает|работал|проверил/.test(text)) {
    return CS_APPEAL_REASON.NO_PRODUCT_USAGE;
  }

  return CS_APPEAL_REASON.UNKNOWN;
}

function estimateAppealPotential_(appealReason, rating, textLength) {
  const potentialMap = {
    [CS_APPEAL_REASON.NOT_ABOUT_PRODUCT]:  0.8,
    [CS_APPEAL_REASON.COMPETITOR_ATTACK]:  0.7,
    [CS_APPEAL_REASON.OFFENSIVE_CONTENT]:  0.9,
    [CS_APPEAL_REASON.FALSE_CLAIM]:        0.5,
    [CS_APPEAL_REASON.DELIVERY_ISSUE]:     0.4,
    [CS_APPEAL_REASON.NO_PRODUCT_USAGE]:   0.3,
    [CS_APPEAL_REASON.MARKETPLACE_RULE]:   0.6,
    [CS_APPEAL_REASON.UNKNOWN]:            0.1,
  };

  const potential = potentialMap[appealReason] ?? 0.1;
  return { potential, worth_appeal: potential > 0.3 };
}

function buildAppealEvidence_(inboxItem) {
  const evidence = [];
  const rating = inboxItem.customer_rating || 0;
  const text = inboxItem.customer_text || '';
  const textLen = text.length;

  if (rating === 1) {
    evidence.push('Рейтинг 1/5 — минимальная оценка');
  } else if (rating <= 2) {
    evidence.push(`Рейтинг ${rating}/5 без развёрнутого описания проблемы`);
  }

  if (textLen < 20) {
    evidence.push('Текст отзыва слишком короткий для обоснованной критики');
  }

  if (!/товар|изделие|продукт|размер|качество|материал|цвет|функц/.test(text.toLowerCase())) {
    evidence.push('Текст не содержит упоминания конкретного товара или его характеристик');
  }

  if (/не\s*мой\s*заказ|перепутали|не\s*получал/.test(text.toLowerCase())) {
    evidence.push('Покупатель явно указывает, что это не его заказ');
  }

  if (/курьер|доставщик|пвз|пункт\s*выдачи/.test(text.toLowerCase())) {
    evidence.push('Претензии адресованы службе доставки, а не товару');
  }

  if (/[хx][уy][йяеё]|[бb][лl][яaя]/.test(text.toLowerCase())) {
    evidence.push('Отзыв содержит нецензурные выражения, нарушающие правила WB');
  }

  if (evidence.length === 0) {
    evidence.push(`Отзыв на ${rating}/5 звёзд`);
  }

  return evidence;
}

async function generateAppealDraft_(env, inboxItem, appealReason, evidence) {
  const prompt = `Ты помогаешь составить апелляцию на отзыв WB.
Товар: ${csSafeText_(inboxItem.sku_title || 'Товар', 100)}
Рейтинг отзыва: ${inboxItem.customer_rating || '—'}/5
Текст отзыва: ${csSafeText_(inboxItem.customer_text || '', 400)}
Причина апелляции: ${appealReason}
Доказательства: ${evidence.join('; ')}

Составь вежливую апелляцию к WB (до 500 символов).
Требования:
- Не обвиняй покупателя
- Ссылайся на правила WB
- Укажи конкретные несоответствия
- Без агрессии и ультиматумов

Только текст апелляции.`;

  const aiResult = await csCallAi_(env, prompt);
  if (aiResult.ok && aiResult.text) {
    return csSafeText_(aiResult.text.trim(), 500);
  }

  // Static fallback
  return `Уважаемая служба поддержки Wildberries! Просим рассмотреть данный отзыв на предмет соответствия правилам платформы. Основание: ${appealReason}. ${evidence[0] || ''}. Просим снять отзыв как не соответствующий правилам WB.`;
}

async function createAppealProposal_(db, inboxItem, appealItem) {
  const now = new Date().toISOString();

  // Create wb_agent_proposals record
  try {
    const proposalId = wbGenerateId_('csap');
    await db.prepare(`INSERT OR IGNORE INTO wb_agent_proposals
      (id, proposal_type, entity_type, entity_id, title, requires_confirmation,
       confirmation_id, status, payload_json, created_at, updated_at)
      VALUES (?,?,?,?,?,1,?,?,?,?,?)`).bind(
      proposalId,
      'create_appeal',
      'cs_appeal_item',
      appealItem.id,
      `Апелляция: ${csSafeText_(inboxItem.sku_title || 'Товар', 60)}`,
      appealItem.confirmation_id,
      'pending',
      JSON.stringify({ inbox_item_id: inboxItem.id, nm_id: inboxItem.nm_id }),
      now, now
    ).run();
  } catch (_) {
    // wb_agent_proposals may not exist yet — store proposal in appeal payload instead
    await db.prepare(
      `UPDATE cs_appeal_item SET payload_json=?, updated_at=? WHERE id=?`
    ).bind(
      JSON.stringify({ proposal_type: 'create_appeal', requires_confirmation: true }),
      now,
      appealItem.id
    ).run();
  }
}

async function runComplaintAppealAgent_(env, db, date) {
  const result = {
    date,
    reviews_analyzed: 0,
    appeals_worth: 0,
    appeal_drafts_created: 0,
    skipped_count: 0,
  };

  try {
    const rows = await db.prepare(
      `SELECT * FROM cs_inbox_item
       WHERE source='wb_review'
         AND customer_rating <= 2
         AND status NOT IN ('archived','escalated')
         AND DATE(item_date)=?`
    ).bind(date).all();

    const items = rows.results || [];
    result.reviews_analyzed = items.length;

    for (const item of items) {
      try {
        // Check if appeal already exists
        const existing = await db.prepare(
          `SELECT id FROM cs_appeal_item WHERE inbox_item_id=?`
        ).bind(item.id).first();
        if (existing) { result.skipped_count++; continue; }

        const appealReason = classifyAppealReason_(item.customer_text, item.customer_rating);
        const { potential, worth_appeal } = estimateAppealPotential_(
          appealReason, item.customer_rating, (item.customer_text || '').length
        );

        if (!worth_appeal) { result.skipped_count++; continue; }

        result.appeals_worth++;

        const evidence = buildAppealEvidence_(item);
        const draftText = await generateAppealDraft_(env, item, appealReason, evidence);

        const appealId = wbGenerateId_('csa');
        const confirmId = csBuildConfirmationId_(appealId, 'submit_appeal');
        const riskLevel = potential >= 0.7 ? 'low' : potential >= 0.4 ? 'medium' : 'high';
        const now = new Date().toISOString();

        const appealRecord = {
          id: appealId,
          inbox_item_id: item.id,
          nm_id: item.nm_id || null,
          sku_title: item.sku_title || '',
          user_id: item.user_id || null,
          appeal_reason: appealReason,
          appeal_possible: 1,
          evidence_json: JSON.stringify(evidence),
          draft_appeal: draftText,
          risk_level: riskLevel,
          status: 'waiting_confirmation',
          confirmation_id: confirmId,
          created_at: now,
          updated_at: now,
        };

        await db.prepare(`INSERT INTO cs_appeal_item
          (id, inbox_item_id, nm_id, sku_title, user_id, appeal_reason, appeal_possible,
           evidence_json, draft_appeal, risk_level, status, confirmation_id,
           payload_json, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'{}',?,?)`).bind(
          appealRecord.id, appealRecord.inbox_item_id, appealRecord.nm_id,
          appealRecord.sku_title, appealRecord.user_id, appealRecord.appeal_reason,
          appealRecord.appeal_possible, appealRecord.evidence_json, appealRecord.draft_appeal,
          appealRecord.risk_level, appealRecord.status, appealRecord.confirmation_id,
          appealRecord.created_at, appealRecord.updated_at
        ).run();

        await createAppealProposal_(db, item, appealRecord);

        // Tag inbox item as appeal candidate
        await db.prepare(
          `UPDATE cs_inbox_item SET topic='appeal_candidate', updated_at=? WHERE id=?`
        ).bind(now, item.id).run();

        result.appeal_drafts_created++;
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: item.id,
          action: 'appeal_draft_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'appeal_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 3 — Knowledge Base Agent
// ============================================================

const CS_KB_CATEGORIES = {
  GREETING:          'greeting',
  APOLOGY:           'apology',
  SIZING:            'sizing',
  RETURN_POLICY:     'return_policy',
  DELIVERY:          'delivery',
  PACKAGE_CONTENTS:  'package_contents',
  PRODUCT_INFO:      'product_info',
  WARRANTY:          'warranty',
  USAGE_INSTRUCTION: 'usage_instruction',
  TECHNICAL_ISSUE:   'technical_issue',
  CUSTOM:            'custom',
};

async function lookupKnowledgeAnswer_(db, nmId, questionText) {
  const rows = await db.prepare(
    `SELECT * FROM cs_knowledge_item
     WHERE is_active=1 AND (nm_id=? OR nm_id IS NULL)
     ORDER BY usage_count DESC`
  ).bind(nmId || null).all();

  const items = rows.results || [];
  if (items.length === 0) return null;

  const words = (questionText || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  let bestItem = null;
  let bestScore = 0;

  for (const item of items) {
    let keywords = [];
    try { keywords = JSON.parse(item.trigger_keywords_json || '[]'); } catch (_) {}
    const score = keywords.reduce((acc, kw) => {
      return acc + (words.some(w => w.includes(String(kw).toLowerCase())) ? 1 : 0);
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  if (!bestItem || bestScore === 0) return null;

  // Update usage stats
  await updateKnowledgeUsageCount_(db, bestItem.id);
  return bestItem;
}

async function detectKnowledgeGap_(db, nmId, topic, questionText, sourceItemId) {
  const now = new Date().toISOString();

  const existing = await db.prepare(
    `SELECT * FROM cs_knowledge_gap WHERE nm_id=? AND topic=?`
  ).bind(nmId || null, topic).first();

  if (existing) {
    let sourceIds = [];
    try { sourceIds = JSON.parse(existing.source_items_json || '[]'); } catch (_) {}
    if (sourceItemId && !sourceIds.includes(sourceItemId)) {
      sourceIds.push(sourceItemId);
    }

    await db.prepare(
      `UPDATE cs_knowledge_gap
       SET frequency_count=frequency_count+1, source_items_json=?,
           question_pattern=?, updated_at=?
       WHERE id=?`
    ).bind(JSON.stringify(sourceIds), csSafeText_(questionText || '', 300), now, existing.id).run();

    return await db.prepare(`SELECT * FROM cs_knowledge_gap WHERE id=?`).bind(existing.id).first();
  }

  const gapId = wbGenerateId_('cskgp');
  await db.prepare(`INSERT INTO cs_knowledge_gap
    (id, nm_id, sku_title, topic, question_pattern, frequency_count,
     source_items_json, status, created_at, updated_at)
    VALUES (?,?,?,?,?,1,?,?,?,?)`).bind(
    gapId,
    nmId || null,
    null,
    topic,
    csSafeText_(questionText || '', 300),
    sourceItemId ? JSON.stringify([sourceItemId]) : '[]',
    'open',
    now, now
  ).run();

  return await db.prepare(`SELECT * FROM cs_knowledge_gap WHERE id=?`).bind(gapId).first();
}

async function suggestKnowledgeItem_(env, db, gapRecord) {
  if ((gapRecord.frequency_count || 0) < 3) return null;
  if (gapRecord.status !== 'open') return null;

  const prompt = `Создай шаблон ответа для базы знаний.
Товар: ${gapRecord.sku_title || `nm_id: ${gapRecord.nm_id || 'не указан'}`}
Тема: ${gapRecord.topic}
Частые вопросы: ${gapRecord.question_pattern || gapRecord.topic}

Создай универсальный шаблон ответа (до 600 символов).
- Профессиональный тон
- Конкретный и полезный
- Можно использовать как базовый для вариантов

Только текст шаблона.`;

  const aiResult = await csCallAi_(env, prompt);
  const templateText = aiResult.ok && aiResult.text
    ? csSafeText_(aiResult.text.trim(), 600)
    : `Добрый день! По теме "${gapRecord.topic}" наши специалисты готовы помочь. Пожалуйста, уточните детали вашего вопроса.`;

  const itemId = wbGenerateId_('csk');
  const now = new Date().toISOString();

  await db.prepare(`INSERT INTO cs_knowledge_item
    (id, category, trigger_keywords_json, template_text, tone, language,
     usage_count, is_active, tags_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,0,0,'[]',?,?)`).bind(
    itemId,
    CS_KB_CATEGORIES.CUSTOM,
    JSON.stringify([gapRecord.topic]),
    templateText,
    'professional',
    'ru',
    now, now
  ).run();

  await db.prepare(
    `UPDATE cs_knowledge_gap SET status='draft_created', updated_at=? WHERE id=?`
  ).bind(now, gapRecord.id).run();

  return itemId;
}

function detectTopicFromText_(text) {
  const t = (text || '').toLowerCase();
  if (/размер|мерк|таблиц|подойдет\s*ли/.test(t)) return 'sizing';
  if (/вернуть|обмен|возврат/.test(t)) return 'return_policy';
  if (/доставк|когда\s*придёт|когда\s*приедет|трек/.test(t)) return 'delivery';
  if (/состав|комплект|что\s*входит|содержим/.test(t)) return 'package_contents';
  if (/гарантия|гарантийн/.test(t)) return 'warranty';
  if (/как\s*использовать|как\s*применять|инструкц/.test(t)) return 'usage_instruction';
  if (/не\s*работает|сломал|неисправ/.test(t)) return 'technical_issue';
  return 'product_info';
}

function createKnowledgeDraft_(db, opts) {
  const id = wbGenerateId_('csk');
  const now = new Date().toISOString();
  return db.prepare(`INSERT INTO cs_knowledge_item
    (id, user_id, category, trigger_keywords_json, template_text, tone, language,
     usage_count, is_active, tags_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,0,0,'[]',?,?)`).bind(
    id,
    opts.user_id || null,
    opts.category || CS_KB_CATEGORIES.CUSTOM,
    JSON.stringify(Array.isArray(opts.trigger_keywords) ? opts.trigger_keywords : []),
    opts.template_text || '',
    opts.tone || 'professional',
    'ru',
    now, now
  ).run().then(() => id);
}

async function updateKnowledgeUsageCount_(db, itemId) {
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `UPDATE cs_knowledge_item SET usage_count=usage_count+1, last_used_at=? WHERE id=?`
    ).bind(now, itemId).run();
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: itemId,
      action: 'usage_count_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }
}

async function runKnowledgeBaseAgent_(env, db, date) {
  const result = {
    date,
    items_checked: 0,
    gaps_detected: 0,
    suggestions_created: 0,
    stale_items_count: 0,
  };

  try {
    const rows = await db.prepare(
      `SELECT * FROM cs_inbox_item
       WHERE source IN ('wb_review','wb_question')
         AND DATE(created_at)=?`
    ).bind(date).all();

    const items = rows.results || [];
    result.items_checked = items.length;

    for (const item of items) {
      try {
        // Only run KB lookup for questions
        if (item.source === 'wb_question') {
          const match = await lookupKnowledgeAnswer_(db, item.nm_id, item.customer_text);
          if (!match) {
            const topic = detectTopicFromText_(item.customer_text);
            const gap = await detectKnowledgeGap_(db, item.nm_id, topic, item.customer_text, item.id);
            if (gap) result.gaps_detected++;

            if (gap && (gap.frequency_count || 0) >= 3) {
              const newItemId = await suggestKnowledgeItem_(env, db, gap);
              if (newItemId) result.suggestions_created++;
            }
          }
        }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: item.id,
          action: 'kb_item_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }

    // Find stale knowledge items (usage_count=0 for 30+ days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const staleRows = await db.prepare(
      `SELECT * FROM cs_knowledge_item
       WHERE is_active=1
         AND usage_count=0
         AND DATE(created_at) < ?`
    ).bind(thirtyDaysAgo).all();

    const staleItems = staleRows.results || [];
    result.stale_items_count = staleItems.length;

    const now = new Date().toISOString();
    for (const staleItem of staleItems) {
      try {
        let payload = {};
        try { payload = JSON.parse(staleItem.payload_json || '{}'); } catch (_) {}
        payload.stale = true;
        payload.stale_detected_at = now;
        await db.prepare(
          `UPDATE cs_knowledge_item SET payload_json=?, updated_at=? WHERE id=?`
        ).bind(JSON.stringify(payload), now, staleItem.id).run();
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: staleItem.id,
          action: 'stale_flag_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'kb_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 4 — Enhanced Tone & Loyalty Agent V2
// ============================================================

const CS_RISK_PHRASES = [
  { pattern: /брак|дефект|неисправн/i,                               category: 'defect_admission',   severity: 'high' },
  { pattern: /вы\s+неправильно|неверно\s+используете|ваша\s+вина/i,  category: 'customer_blame',     severity: 'high' },
  { pattern: /гарантийн|замен(им|яем)|вернём\s+деньги/i,             category: 'promise_risk',       severity: 'medium' },
  { pattern: /всегда\s+так|никогда\s+такого/i,                       category: 'absolute_claim',     severity: 'medium' },
  { pattern: /не\s+наша\s+ответственность|не\s+наша\s+проблема/i,    category: 'denial',             severity: 'high' },
  { pattern: /обратитесь\s+в\s+суд|юридически/i,                    category: 'legal_threat',       severity: 'critical' },
];

function detectRiskPhrases_(draftText) {
  const text = draftText || '';
  const found = [];
  for (const rule of CS_RISK_PHRASES) {
    const match = text.match(rule.pattern);
    if (match) {
      found.push({ category: rule.category, severity: rule.severity, match: match[0] });
    }
  }
  return found;
}

function classifyToneV2_(draftText, riskPhrases) {
  if (riskPhrases.some(r => r.severity === 'critical')) return 'potential_liability';
  if (riskPhrases.some(r => r.category === 'customer_blame')) return 'too_aggressive';
  if (riskPhrases.some(r => r.category === 'defect_admission')) return 'risky_wording';
  if ((draftText || '').length < 50) return 'too_dry';
  if (riskPhrases.length === 0) return 'approved';
  return 'needs_softening';
}

async function rewriteForLoyalty_(env, draftText, issues) {
  if (!issues || issues.length === 0) {
    return { rewritten_text: draftText, changed: false };
  }

  const issuesSummary = issues.map(i => `${i.category} (${i.severity}): "${i.match}"`).join('; ');

  const prompt = `Улучши тон ответа покупателю.
Оригинал: ${csSafeText_(draftText || '', 800)}
Проблемы: ${issuesSummary}

Перепиши ответ, устранив проблемы:
- Не обвиняй покупателя
- Не признавай брак без диагностики
- Будь теплее и эмпатичнее
- Сохрани суть ответа

Только исправленный текст.`;

  const aiResult = await csCallAi_(env, prompt);
  if (aiResult.ok && aiResult.text) {
    return { rewritten_text: csSafeText_(aiResult.text.trim(), 1000), changed: true };
  }

  return { rewritten_text: draftText, changed: false };
}

function finalGuard_(riskPhrases) {
  if (riskPhrases.some(r => r.severity === 'critical')) {
    return { blocked: true, reason: 'potential_liability' };
  }
  return { blocked: false };
}

async function runToneLoyaltyAgentV2_(env, db, date) {
  const result = {
    date,
    drafts_checked: 0,
    passed: 0,
    blocked: 0,
    rewritten: 0,
    needs_human_review: 0,
  };

  try {
    const rows = await db.prepare(
      `SELECT * FROM cs_draft_response
       WHERE status='pending' AND DATE(created_at)=?`
    ).bind(date).all();

    const drafts = rows.results || [];
    result.drafts_checked = drafts.length;

    for (const draft of drafts) {
      try {
        const riskPhrases = detectRiskPhrases_(draft.draft_text);
        const toneStatus = classifyToneV2_(draft.draft_text, riskPhrases);
        const guard = finalGuard_(riskPhrases);
        const now = new Date().toISOString();

        if (guard.blocked) {
          await db.prepare(
            `UPDATE cs_draft_response
             SET tone_status=?, risk_status=?, status='needs_revision', updated_at=?
             WHERE id=?`
          ).bind('potential_liability', 'blocked', now, draft.id).run();

          result.blocked++;
          result.needs_human_review++;

          await wbLog_(db, {
            entity_type: 'cs', entity_id: draft.id,
            action: 'draft_blocked', status: 'warning',
            details_json: JSON.stringify({ reason: guard.reason, risk_phrases: riskPhrases }),
          });
          continue;
        }

        const hasIssues = toneStatus !== 'approved';

        if (hasIssues) {
          const { rewritten_text, changed } = await rewriteForLoyalty_(env, draft.draft_text, riskPhrases);

          if (changed) {
            const newVersion = (draft.draft_version || 1) + 1;
            await db.prepare(
              `UPDATE cs_draft_response
               SET draft_text=?, draft_version=?, tone_status=?, risk_status='ok',
                   updated_at=?
               WHERE id=?`
            ).bind(rewritten_text, newVersion, toneStatus, now, draft.id).run();
            result.rewritten++;
          } else {
            // AI rewrite failed — flag for human review
            await db.prepare(
              `UPDATE cs_draft_response
               SET tone_status=?, risk_status='flagged', updated_at=?
               WHERE id=?`
            ).bind(toneStatus, now, draft.id).run();
            result.needs_human_review++;
          }
        } else {
          await db.prepare(
            `UPDATE cs_draft_response
             SET tone_status='approved', risk_status='ok', updated_at=?
             WHERE id=?`
          ).bind(now, draft.id).run();
          result.passed++;
        }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: draft.id,
          action: 'tone_v2_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'tone_agent_v2',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 5 — CS Chief V2 Orchestrator
// ============================================================

async function runCsOperationsChiefV2_(env, date, userId) {
  const db = env.DB;
  const reportDate = date || wbYesterday_();
  const now = new Date().toISOString();

  await ensureCsStage2Schema_(db);

  // Phase 1: parallel data-loading agents (same as Stage 1)
  const [reviewResult, qaResult, returnResult] = await Promise.all([
    runReviewResponseAgent_(env, db, reportDate),
    runQaAgent_(env, db, reportDate),
    runReturnReasonAgent_(env, db, reportDate),
  ]);

  // Phase 2: sequential agents
  const toneResult     = await runToneLoyaltyAgentV2_(env, db, reportDate);
  const appealResult   = await runComplaintAppealAgent_(env, db, reportDate);
  const classifierResult = await runProductIssueClassifierAgent_(env, db, reportDate);
  const kbResult       = await runKnowledgeBaseAgent_(env, db, reportDate);
  const feedbackResult = await runProductFeedbackAgent_(env, db, reportDate);

  // Build summary
  const summaryPrompt = `Сводка клиент-сервиса за ${reportDate}:
- Отзывов: ${reviewResult.reviews_loaded}, черновиков: ${reviewResult.drafts_created}
- Вопросов: ${qaResult.questions_loaded}, черновиков: ${qaResult.drafts_created}
- Возвратов: ${returnResult.returns_loaded}, проблем: ${returnResult.issues_logged}
- Апелляций создано: ${appealResult.appeal_drafts_created} из ${appealResult.reviews_analyzed} проверено
- Тон/риски: проверено ${toneResult.drafts_checked}, заблокировано ${toneResult.blocked}, переписано ${toneResult.rewritten}
- KB: пробелов выявлено ${kbResult.gaps_detected}, шаблонов предложено ${kbResult.suggestions_created}
- Проблем с товарами (>3 случаев): ${classifierResult.issues_analyzed}

Напиши краткий дайджест (3-5 предложений) для руководителя.`;

  const summaryAi = await csCallAi_(env, summaryPrompt);
  const summaryText = summaryAi.ok && summaryAi.text
    ? summaryAi.text.trim()
    : `За ${reportDate}: обработано ${reviewResult.reviews_loaded} отзывов, ${qaResult.questions_loaded} вопросов, ` +
      `${returnResult.returns_loaded} возвратов. Черновиков ответов: ${reviewResult.drafts_created + qaResult.drafts_created}. ` +
      `Апелляций подготовлено: ${appealResult.appeal_drafts_created}. ` +
      `Пробелов в KB: ${kbResult.gaps_detected}. Проблем с товарами: ${classifierResult.issues_analyzed}.`;

  const report = {
    date: reportDate,
    generated_at: now,
    build: CS_BUILD_V2,
    summary: summaryText,
    review_agent: reviewResult,
    qa_agent: qaResult,
    return_agent: returnResult,
    tone_agent_v2: toneResult,
    appeal_agent: appealResult,
    issue_classifier: classifierResult,
    kb_agent: kbResult,
    feedback_agent: feedbackResult,
    totals: {
      reviews_loaded: reviewResult.reviews_loaded,
      questions_loaded: qaResult.questions_loaded,
      returns_loaded: returnResult.returns_loaded,
      drafts_created: reviewResult.drafts_created + qaResult.drafts_created,
      drafts_blocked: toneResult.blocked,
      drafts_rewritten: toneResult.rewritten,
      appeals_created: appealResult.appeal_drafts_created,
      kb_gaps: kbResult.gaps_detected,
      kb_suggestions: kbResult.suggestions_created,
      issues_found: classifierResult.issues_analyzed,
      insights_created: feedbackResult.insights_created,
    },
  };

  await wbLog_(db, {
    entity_type: 'cs', entity_id: 'cs_operations_chief_v2',
    action: 'chief_v2_run_complete', status: 'ok',
    details_json: JSON.stringify({ date: reportDate, totals: report.totals }),
  });

  return report;
}

// ============================================================
// SECTION 6 — New Telegram Commands
// ============================================================

async function routeCsTelegramCommandV2_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!text.startsWith('/cs_')) return false;

  const command = text.split(' ')[0].toLowerCase();

  try {
    await ensureCsStage2Schema_(db);

    // /cs_appeals — overrides Stage 1 to show actual appeal drafts with action buttons
    if (command === '/cs_appeals') {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const rows = await db.prepare(
        `SELECT * FROM cs_appeal_item
         WHERE status='waiting_confirmation'
           AND DATE(created_at) >= ?
         ORDER BY created_at DESC LIMIT 20`
      ).bind(sevenDaysAgo).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Нет жалоб для подачи.'));
        return true;
      }

      for (const appeal of items) {
        const sku = csEscapeMd_(appeal.sku_title || `nm_id:${appeal.nm_id || '—'}`);
        const reason = csEscapeMd_(appeal.appeal_reason || '—');
        const draft = csEscapeMd_(csSafeText_(appeal.draft_appeal || '', 300));

        const msgBody =
          `*Апелляция* — ${sku}\n` +
          `Причина: ${reason}\n` +
          `_${draft}_\n\n` +
          `✅ /cs\\_submit\\_appeal\\_${appeal.id}\n` +
          `❌ /cs\\_cancel\\_appeal\\_${appeal.id}`;

        await csSendTelegramMessage_(token, chatId, msgBody);
      }
      return true;
    }

    // /cs_knowledge — gaps + stale items
    if (command === '/cs_knowledge') {
      const gapRows = await db.prepare(
        `SELECT * FROM cs_knowledge_gap
         WHERE frequency_count >= 3 AND status='open'
         ORDER BY frequency_count DESC LIMIT 15`
      ).all();

      const gaps = gapRows.results || [];

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const staleRows = await db.prepare(
        `SELECT * FROM cs_knowledge_item
         WHERE is_active=1 AND usage_count=0 AND DATE(created_at) < ?
         ORDER BY created_at ASC LIMIT 10`
      ).bind(thirtyDaysAgo).all();

      const staleItems = staleRows.results || [];

      if (gaps.length === 0 && staleItems.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Нет пробелов в KB и устаревших шаблонов.'));
        return true;
      }

      if (gaps.length > 0) {
        let out = `*Пробелы в базе знаний* \\(${gaps.length}\\)\n\n`;
        for (const gap of gaps) {
          const topic = csEscapeMd_(gap.topic || '—');
          const freq = gap.frequency_count || 0;
          out += `• ${topic} — встречается ${freq}x\n`;
          out += `  📝 /cs\\_create\\_kb\\_${gap.id}\n`;
        }
        await csSendTelegramMessage_(token, chatId, out);
      }

      if (staleItems.length > 0) {
        let out = `*Неиспользуемые шаблоны \\(30\\+ дней\\)* \\(${staleItems.length}\\)\n\n`;
        for (const item of staleItems) {
          const cat = csEscapeMd_(item.category || '—');
          const preview = csEscapeMd_(csSafeText_(item.template_text || '', 80));
          out += `• *${cat}*: _${preview}_\n`;
        }
        await csSendTelegramMessage_(token, chatId, out);
      }

      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'telegram_v2_handler',
      action: 'command_v2_error', status: 'error',
      details_json: JSON.stringify({ command, error: String(e) }),
    });
    try {
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Произошла ошибка при выполнении команды.'));
    } catch (_) {}
  }

  return false;
}

// ============================================================
// SECTION 7 — New Callbacks
// ============================================================

async function routeCsCallbackQueryV2_(env, callbackQuery) {
  const db = env.DB;
  const data = callbackQuery.data || '';
  const userId = String(callbackQuery.from?.id || '');
  const chatId = callbackQuery.message?.chat?.id;
  const token = env.TELEGRAM_BOT_TOKEN;

  try {
    await ensureCsStage2Schema_(db);

    if (data.startsWith('cs_submit_appeal_')) {
      const appealId = data.replace('cs_submit_appeal_', '');
      const appeal = await db.prepare(`SELECT * FROM cs_appeal_item WHERE id=?`).bind(appealId).first();

      if (!appeal) {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция не найдена.'));
        }
        return true;
      }

      // Idempotency check
      if (appeal.status === 'submitted') {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция уже была подана ранее.'));
        }
        return true;
      }

      if (appeal.status === 'cancelled') {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция была отменена и не может быть подана.'));
        }
        return true;
      }

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE cs_appeal_item SET status='submitted', submitted_at=?, updated_at=? WHERE id=?`
      ).bind(now, now, appealId).run();

      await wbLog_(db, {
        entity_type: 'cs', entity_id: appealId,
        action: 'appeal_submitted', status: 'ok',
        details_json: JSON.stringify({ submitted_by: userId, confirmation_id: appeal.confirmation_id }),
      });

      if (token && chatId) {
        await csSendTelegramMessage_(token, chatId,
          csEscapeMd_('Апелляция будет подана при наличии WB API. Статус: submitted.')
        );
      }
      return true;
    }

    if (data.startsWith('cs_cancel_appeal_')) {
      const appealId = data.replace('cs_cancel_appeal_', '');
      const appeal = await db.prepare(`SELECT * FROM cs_appeal_item WHERE id=?`).bind(appealId).first();

      if (!appeal) {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция не найдена.'));
        }
        return true;
      }

      // Idempotency check
      if (appeal.status === 'cancelled') {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция уже была отменена.'));
        }
        return true;
      }

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE cs_appeal_item SET status='cancelled', updated_at=? WHERE id=?`
      ).bind(now, appealId).run();

      await wbLog_(db, {
        entity_type: 'cs', entity_id: appealId,
        action: 'appeal_cancelled', status: 'ok',
        details_json: JSON.stringify({ cancelled_by: userId }),
      });

      if (token && chatId) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция отменена.'));
      }
      return true;
    }

    if (data.startsWith('cs_create_kb_')) {
      const gapId = data.replace('cs_create_kb_', '');
      const gap = await db.prepare(`SELECT * FROM cs_knowledge_gap WHERE id=?`).bind(gapId).first();

      if (!gap) {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Пробел в KB не найден.'));
        }
        return true;
      }

      if (gap.status === 'draft_created' || gap.status === 'published') {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Шаблон для этого пробела уже создан.'));
        }
        return true;
      }

      const newItemId = await suggestKnowledgeItem_(env, db, { ...gap, frequency_count: 3 });

      await wbLog_(db, {
        entity_type: 'cs', entity_id: gapId,
        action: 'kb_template_created', status: 'ok',
        details_json: JSON.stringify({ created_by: userId, item_id: newItemId }),
      });

      if (token && chatId) {
        await csSendTelegramMessage_(token, chatId,
          csEscapeMd_('Шаблон создан как черновик, требует проверки перед активацией.')
        );
      }
      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'callback_v2_handler',
      action: 'callback_v2_error', status: 'error',
      details_json: JSON.stringify({ data, error: String(e) }),
    });
  }

  return false;
}

// ============================================================
// SECTION 8 — Extended CS API Routes
// ============================================================

async function handleCsStage2Routes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;

  const jsonResponse = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    await ensureCsStage2Schema_(db);

    // GET /agent/cs/appeals?status=&limit=50
    if (method === 'GET' && path === '/agent/cs/appeals') {
      const status = url.searchParams.get('status') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_appeal_item WHERE 1=1`;
      const binds = [];
      if (status) { sql += ` AND status=?`; binds.push(status); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, appeals: rows.results || [], count: (rows.results || []).length });
    }

    // POST /agent/cs/appeals/:id/submit
    const appealSubmitMatch = path.match(/^\/agent\/cs\/appeals\/([^/]+)\/submit$/);
    if (method === 'POST' && appealSubmitMatch) {
      const appealId = appealSubmitMatch[1];
      const appeal = await db.prepare(`SELECT * FROM cs_appeal_item WHERE id=?`).bind(appealId).first();

      if (!appeal) return jsonResponse({ ok: false, error: 'appeal_not_found' }, 404);
      if (appeal.status === 'submitted') return jsonResponse({ ok: true, idempotent: true });
      if (appeal.status === 'cancelled') {
        return jsonResponse({ ok: false, error: 'appeal_cancelled' }, 409);
      }

      let body = {};
      try { body = await request.json(); } catch (_) {}

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE cs_appeal_item SET status='submitted', submitted_at=?, updated_at=? WHERE id=?`
      ).bind(now, now, appealId).run();

      await wbLog_(db, {
        entity_type: 'cs', entity_id: appealId,
        action: 'appeal_submitted_api', status: 'ok',
        details_json: JSON.stringify({ submitted_by: body.user_id || null }),
      });

      return jsonResponse({ ok: true, appeal_id: appealId, status: 'submitted' });
    }

    // GET /agent/cs/knowledge/gaps?nm_id=&limit=50
    if (method === 'GET' && path === '/agent/cs/knowledge/gaps') {
      const nmId = url.searchParams.get('nm_id') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_knowledge_gap WHERE 1=1`;
      const binds = [];
      if (nmId) { sql += ` AND nm_id=?`; binds.push(nmId); }
      sql += ` ORDER BY frequency_count DESC, created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, gaps: rows.results || [], count: (rows.results || []).length });
    }

    // POST /agent/cs/knowledge/gaps/:id/create-template
    const gapTemplateMatch = path.match(/^\/agent\/cs\/knowledge\/gaps\/([^/]+)\/create-template$/);
    if (method === 'POST' && gapTemplateMatch) {
      const gapId = gapTemplateMatch[1];
      const gap = await db.prepare(`SELECT * FROM cs_knowledge_gap WHERE id=?`).bind(gapId).first();

      if (!gap) return jsonResponse({ ok: false, error: 'gap_not_found' }, 404);
      if (gap.status === 'draft_created' || gap.status === 'published') {
        return jsonResponse({ ok: true, idempotent: true, status: gap.status });
      }

      const newItemId = await suggestKnowledgeItem_(env, db, { ...gap, frequency_count: 3 });

      await wbLog_(db, {
        entity_type: 'cs', entity_id: gapId,
        action: 'kb_template_created_api', status: 'ok',
        details_json: JSON.stringify({ item_id: newItemId }),
      });

      return jsonResponse({ ok: true, gap_id: gapId, knowledge_item_id: newItemId });
    }

    // POST /agent/cs/report/run/v2
    if (method === 'POST' && path === '/agent/cs/report/run/v2') {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const date = body.date || wbYesterday_();
      const userId = body.user_id || null;
      const report = await runCsOperationsChiefV2_(env, date, userId);
      return jsonResponse({ ok: true, report });
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'api_router_v2',
      action: 'route_v2_error', status: 'error',
      details_json: JSON.stringify({ path, method, error: String(e) }),
    });
    return jsonResponse({ ok: false, error: String(e) }, 500);
  }

  return null;
}
// ============================================================
// Approval Flow — Unified Proposal Management (v1)
// Build: ai_helpers_approval_flow_v1
//
// Handles ALL pending proposals from WB Operations and CS blocks.
//
// ── New Tables ───────────────────────────────────────────────
//   approval_digest_log  — one row per day per chat_id digest
//
// ── Read Tables (no schema ownership) ───────────────────────
//   wb_agent_proposals             — WB proposals (stock, ads, etc.)
//   cs_draft_response              — CS draft responses
//   cs_inbox_item                  — looked up for CS draft context
//   wb_agent_alerts                — WB alerts (read-only)
//   wb_report_consistency_check_v2 — for wb_health_fix_ callback
//   wb_action_log                  — written for confirmed proposals
//
// ── Functions ────────────────────────────────────────────────
//   ensureApprovalFlowSchema_(db)
//   getAllPendingProposals_(db, userId)
//   getExpiredProposals_(db)
//   markProposalsExpired_(db)
//   formatWbProposalForTelegram_(proposal)
//   formatCsDraftForTelegram_(draft, inboxItem)
//   buildProposalInlineButton_(proposal)
//   buildDraftInlineButton_(draft)
//   sendApprovalDigest_(env, chatId, userId)
//   scheduleDigestIfNeeded_(env, chatId, userId)
//   routeApprovalTelegramCommand_(env, msg, chatId, userId)
//   routeApprovalCallbackQuery_(env, callbackQuery)
//   handleApprovalFlowRoutes_(env, request)
//   tryNotifyPlanner_(env, proposal)
//
// Dependencies (globally available):
//   wbGenerateId_(prefix), wbLog_(db, opts), wbYesterday_(),
//   wbFormatDate_(iso), wbRound_(val, dec),
//   csEscapeMd_(text), csSendTelegramMessage_(token, chatId, text)
//
// Rules:
//   - All DB calls: try/catch, errors to wbLog_
//   - All callbacks: idempotent — check status before acting
//   - MarkdownV2 text escaped with csEscapeMd_
//   - Telegram messages split at 3800 chars
//   - No console.log — only wbLog_
//   - Confirmed proposals logged to wb_action_log
//   - Timestamps: new Date().toISOString()
//   - IDs: wbGenerateId_(prefix)
// ============================================================

const APPROVAL_FLOW_BUILD = 'ai_helpers_approval_flow_v1';

// ============================================================
// SECTION 1 — Schema
// ============================================================

async function ensureApprovalFlowSchema_(db) {
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS approval_digest_log (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        chat_id TEXT,
        date TEXT NOT NULL,
        wb_proposals_sent INTEGER DEFAULT 0,
        cs_drafts_sent INTEGER DEFAULT 0,
        total_sent INTEGER DEFAULT 0,
        sent_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(date, chat_id)
      )
    `).run();
  } catch (e) {
    await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'schema_error', message: e.message });
  }
}

// ============================================================
// SECTION 2 — Proposal Aggregator
// ============================================================

async function getAllPendingProposals_(db, userId) {
  let wb_proposals = [];
  let cs_drafts = [];

  try {
    const wbRes = await db.prepare(`
      SELECT * FROM wb_agent_proposals
      WHERE status = 'pending'
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY
        CASE priority
          WHEN 'critical' THEN 0
          WHEN 'high'     THEN 1
          WHEN 'medium'   THEN 2
          WHEN 'low'      THEN 3
          ELSE 4
        END ASC,
        created_at ASC
      LIMIT 50
    `).all();
    wb_proposals = wbRes.results || [];
  } catch (e) {
    await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'get_wb_proposals_error', message: e.message });
  }

  try {
    const csRes = await db.prepare(`
      SELECT * FROM cs_draft_response
      WHERE status = 'pending'
      LIMIT 50
    `).all();
    cs_drafts = csRes.results || [];
  } catch (e) {
    await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'get_cs_drafts_error', message: e.message });
  }

  return {
    wb_proposals,
    cs_drafts,
    total: wb_proposals.length + cs_drafts.length,
  };
}

async function getExpiredProposals_(db) {
  try {
    const res = await db.prepare(`
      SELECT * FROM wb_agent_proposals
      WHERE status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at < datetime('now')
    `).all();
    return res.results || [];
  } catch (e) {
    await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'get_expired_error', message: e.message });
    return [];
  }
}

async function markProposalsExpired_(db) {
  try {
    const res = await db.prepare(`
      UPDATE wb_agent_proposals
      SET status = 'expired', updated_at = datetime('now')
      WHERE status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at < datetime('now')
    `).run();
    const count = res.meta?.changes ?? 0;
    if (count > 0) {
      await wbLog_(db, { level: 'info', source: APPROVAL_FLOW_BUILD, event: 'proposals_expired', message: `Marked ${count} proposals as expired` });
    }
    return count;
  } catch (e) {
    await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'mark_expired_error', message: e.message });
    return 0;
  }
}

// ============================================================
// SECTION 3 — Proposal Formatter
// ============================================================

function formatWbProposalForTelegram_(proposal) {
  const icons = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' };
  const icon = icons[proposal.priority] || '⚪';
  const title = csEscapeMd_(proposal.title || 'Без названия');
  const rawDesc = (proposal.description || '').slice(0, 120);
  const desc = csEscapeMd_(rawDesc);
  const actionType = csEscapeMd_(proposal.action_type || '—');
  const date = csEscapeMd_(wbFormatDate_(proposal.created_at ? proposal.created_at.slice(0, 10) : ''));
  return `${icon} *${title}*\n_${desc}_\nТип: ${actionType} \\| Дата: ${date}`;
}

function formatCsDraftForTelegram_(draft, inboxItem) {
  const rawText = (draft.draft_text || draft.response_text || '').slice(0, 200);
  const draftText = csEscapeMd_(rawText);
  const source = csEscapeMd_((inboxItem && inboxItem.source) || 'unknown');
  return `✍️ *Черновик ответа*\n_${draftText}_\nИсточник: ${source}`;
}

function buildProposalInlineButton_(proposal) {
  return [
    { text: '✅ Подтвердить', callback_data: 'approve_wb_' + proposal.id },
    { text: '❌ Отклонить',   callback_data: 'reject_wb_'  + proposal.id },
  ];
}

function buildDraftInlineButton_(draft) {
  return [
    { text: '✅ Одобрить',    callback_data: 'cs_approve_' + draft.id },
    { text: '✏️ Переделать', callback_data: 'cs_reject_'  + draft.id },
  ];
}

// ============================================================
// SECTION 4 — Daily Digest Sender
// ============================================================

async function sendApprovalDigest_(env, chatId, userId) {
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;

  await markProposalsExpired_(db);

  const { wb_proposals, cs_drafts, total } = await getAllPendingProposals_(db, userId);
  const today = new Date().toISOString().slice(0, 10);

  if (total === 0) {
    await csSendTelegramMessage_(token, chatId, '✅ Нет ожидающих подтверждений');
    return { sent: 0, wb_count: 0, cs_count: 0 };
  }

  const header = `📋 *Ожидают подтверждения* — ${csEscapeMd_(today)}\n\nWB: ${wb_proposals.length} \\| CS: ${cs_drafts.length}`;
  await csSendTelegramMessage_(token, chatId, header);

  const wbSlice = wb_proposals.slice(0, 10);
  for (const proposal of wbSlice) {
    const text = formatWbProposalForTelegram_(proposal);
    const buttons = buildProposalInlineButton_(proposal);
    await _sendWithInlineKeyboard_(env, chatId, text, [buttons]);
  }

  const csSlice = cs_drafts.slice(0, 10);
  for (const draft of csSlice) {
    let inboxItem = null;
    if (draft.inbox_item_id) {
      try {
        const r = await db.prepare(`SELECT * FROM cs_inbox_item WHERE id = ? LIMIT 1`).bind(draft.inbox_item_id).first();
        inboxItem = r || null;
      } catch (_) { /* ignore */ }
    }
    const text = formatCsDraftForTelegram_(draft, inboxItem);
    const buttons = buildDraftInlineButton_(draft);
    await _sendWithInlineKeyboard_(env, chatId, text, [buttons]);
  }

  if (total > 20) {
    const overflow = total - 20;
    await csSendTelegramMessage_(token, chatId, `\\.\\.\\.и ещё ${overflow} ожидают\\. Используй /pending для полного списка\\.`);
  }

  // Upsert digest log
  try {
    const logId = wbGenerateId_('digest');
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO approval_digest_log (id, user_id, chat_id, date, wb_proposals_sent, cs_drafts_sent, total_sent, sent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, chat_id) DO UPDATE SET
        wb_proposals_sent = excluded.wb_proposals_sent,
        cs_drafts_sent    = excluded.cs_drafts_sent,
        total_sent        = excluded.total_sent,
        sent_at           = excluded.sent_at
    `).bind(logId, userId || null, chatId, today, wbSlice.length, csSlice.length, wbSlice.length + csSlice.length, now).run();
  } catch (e) {
    await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'digest_log_error', message: e.message });
  }

  return { sent: wbSlice.length + csSlice.length, wb_count: wbSlice.length, cs_count: csSlice.length };
}

async function scheduleDigestIfNeeded_(env, chatId, userId) {
  const db = env.DB;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const row = await db.prepare(`
      SELECT sent_at FROM approval_digest_log
      WHERE date = ? AND chat_id = ? AND sent_at IS NOT NULL
      LIMIT 1
    `).bind(today, chatId).first();
    if (row) return { already_sent: true };
  } catch (e) {
    await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'schedule_check_error', message: e.message });
  }
  return await sendApprovalDigest_(env, chatId, userId);
}

// ============================================================
// SECTION 5 — Telegram Commands
// ============================================================

async function routeApprovalTelegramCommand_(env, msg, chatId, userId) {
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const text = (msg.text || '').trim().split(' ')[0].toLowerCase();

  // /pending
  if (text === '/pending') {
    await markProposalsExpired_(db);
    const { wb_proposals, cs_drafts, total } = await getAllPendingProposals_(db, userId);

    if (total === 0) {
      await csSendTelegramMessage_(token, chatId, '✅ Всё подтверждено\\. Нет ожидающих действий\\.');
      return true;
    }

    const wbSlice = wb_proposals.slice(0, 5);
    for (const p of wbSlice) {
      const t = formatWbProposalForTelegram_(p);
      await _sendWithInlineKeyboard_(env, chatId, t, [buildProposalInlineButton_(p)]);
    }

    const csSlice = cs_drafts.slice(0, 5);
    for (const d of csSlice) {
      let inboxItem = null;
      if (d.inbox_item_id) {
        try {
          inboxItem = await db.prepare(`SELECT * FROM cs_inbox_item WHERE id = ? LIMIT 1`).bind(d.inbox_item_id).first();
        } catch (_) { /* ignore */ }
      }
      const t = formatCsDraftForTelegram_(d, inboxItem);
      await _sendWithInlineKeyboard_(env, chatId, t, [buildDraftInlineButton_(d)]);
    }

    const shown = wbSlice.length + csSlice.length;
    if (total > shown) {
      const more = total - shown;
      await csSendTelegramMessage_(token, chatId, csEscapeMd_(`Ещё ${more} ожидают подтверждения.`));
    }
    return true;
  }

  // /digest
  if (text === '/digest') {
    const result = await sendApprovalDigest_(env, chatId, userId);
    await csSendTelegramMessage_(token, chatId, csEscapeMd_(`Дайджест отправлен. Показано: ${result.sent} (WB: ${result.wb_count}, CS: ${result.cs_count})`));
    return true;
  }

  // /expired
  if (text === '/expired') {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const res = await db.prepare(`
        SELECT * FROM wb_agent_proposals
        WHERE status = 'expired' AND updated_at >= ?
        ORDER BY updated_at DESC
        LIMIT 10
      `).bind(sevenDaysAgo).all();
      const rows = res.results || [];

      if (rows.length === 0) {
        await csSendTelegramMessage_(token, chatId, '✅ Истекших предложений за последние 7 дней нет\\.');
        return true;
      }

      let out = `*Истекших предложений за последние 7 дней: ${rows.length}*\n\n`;
      for (const p of rows) {
        const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[p.priority] || '⚪';
        out += `${icon} ${csEscapeMd_(p.title || '—')} \\(${csEscapeMd_(p.action_type || '—')}\\)\n`;
      }
      await csSendTelegramMessage_(token, chatId, out.trim());
    } catch (e) {
      await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'cmd_expired_error', message: e.message });
      await csSendTelegramMessage_(token, chatId, '❌ Ошибка при получении истекших предложений\\.');
    }
    return true;
  }

  // /approve_all_low
  if (text === '/approve_all_low') {
    try {
      const pending = await db.prepare(`
        SELECT * FROM wb_agent_proposals
        WHERE status = 'pending' AND priority = 'low'
      `).all();
      const rows = pending.results || [];

      if (rows.length === 0) {
        await csSendTelegramMessage_(token, chatId, '✅ Нет низкоприоритетных предложений для подтверждения\\.');
        return true;
      }

      const now = new Date().toISOString();
      for (const p of rows) {
        try {
          await db.prepare(`
            UPDATE wb_agent_proposals
            SET status = 'confirmed', updated_at = ?
            WHERE id = ? AND status = 'pending'
          `).bind(now, p.id).run();
          await _logToActionLog_(db, p, 'proposal_confirmed', userId, 'auto_approve_all_low');
        } catch (e2) {
          await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'approve_low_item_error', message: e2.message, proposal_id: p.id });
        }
      }

      await csSendTelegramMessage_(token, chatId, csEscapeMd_(`Автоматически подтверждено ${rows.length} низкоприоритетных предложений`));
    } catch (e) {
      await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'approve_all_low_error', message: e.message });
      await csSendTelegramMessage_(token, chatId, '❌ Ошибка при авто\\-подтверждении\\.');
    }
    return true;
  }

  return false;
}

// ============================================================
// SECTION 6 — Unified Callback Handler
// ============================================================

async function routeApprovalCallbackQuery_(env, callbackQuery) {
  const db = env.DB;
  const data = callbackQuery.data || '';
  const callbackId = callbackQuery.id;
  const chatId = callbackQuery.message?.chat?.id?.toString();
  const userId = callbackQuery.from?.id?.toString();

  // ── approve_wb_{proposalId} ────────────────────────────────
  if (data.startsWith('approve_wb_')) {
    const proposalId = data.slice('approve_wb_'.length);
    let proposal = null;
    try {
      proposal = await db.prepare(`SELECT * FROM wb_agent_proposals WHERE id = ? LIMIT 1`).bind(proposalId).first();
    } catch (e) {
      await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'approve_wb_load_error', message: e.message });
    }

    if (!proposal) {
      await _answerCallback_(env, callbackId, 'Не найдено');
      return true;
    }
    if (proposal.status !== 'pending') {
      await _answerCallback_(env, callbackId, 'Уже обработано');
      return true;
    }

    const now = new Date().toISOString();
    try {
      await db.prepare(`
        UPDATE wb_agent_proposals SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'pending'
      `).bind(now, proposalId).run();
    } catch (e) {
      await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'approve_wb_update_error', message: e.message });
      await _answerCallback_(env, callbackId, '❌ Ошибка при подтверждении');
      return true;
    }

    await _logToActionLog_(db, proposal, 'proposal_confirmed', userId, 'callback_approve');
    await tryNotifyPlanner_(env, proposal);
    await _answerCallback_(env, callbackId, '✅ Подтверждено');

    if (chatId) {
      await csSendTelegramMessage_(env.TELEGRAM_BOT_TOKEN, chatId, `✅ Предложение *${csEscapeMd_(proposal.title || proposalId)}* подтверждено\\.`);
    }
    return true;
  }

  // ── reject_wb_{proposalId} ────────────────────────────────
  if (data.startsWith('reject_wb_')) {
    const proposalId = data.slice('reject_wb_'.length);
    let proposal = null;
    try {
      proposal = await db.prepare(`SELECT * FROM wb_agent_proposals WHERE id = ? LIMIT 1`).bind(proposalId).first();
    } catch (e) {
      await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'reject_wb_load_error', message: e.message });
    }

    if (!proposal) {
      await _answerCallback_(env, callbackId, 'Не найдено');
      return true;
    }
    if (proposal.status !== 'pending') {
      await _answerCallback_(env, callbackId, 'Уже обработано');
      return true;
    }

    try {
      const now = new Date().toISOString();
      await db.prepare(`
        UPDATE wb_agent_proposals SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'
      `).bind(now, proposalId).run();
      await _logToActionLog_(db, proposal, 'proposal_cancelled', userId, 'callback_reject');
    } catch (e) {
      await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'reject_wb_update_error', message: e.message });
    }

    await _answerCallback_(env, callbackId, '❌ Отклонено');
    return true;
  }

  // ── wb_health_fix_{date} ─────────────────────────────────
  if (data.startsWith('wb_health_fix_')) {
    const date = data.slice('wb_health_fix_'.length);
    let created = 0;
    try {
      const res = await db.prepare(`
        SELECT * FROM wb_report_consistency_check_v2
        WHERE date = ? AND severity IN ('error', 'critical')
      `).bind(date).all();
      const checks = res.results || [];

      const now = new Date().toISOString();
      for (const check of checks) {
        const actionType = check.check_type === 'source_health' ? 'check_parser_error' : 'fix_missing_cost';
        const proposalId = wbGenerateId_('fix');
        const confirmId = `fix_${check.id}_${date}`;
        try {
          await db.prepare(`
            INSERT OR IGNORE INTO wb_agent_proposals
              (id, confirmation_id, user_id, title, description, action_type, priority, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'high', 'pending', ?, ?)
          `).bind(
            proposalId,
            confirmId,
            userId || null,
            `Исправить: ${check.check_type} (${date})`,
            check.details_json || '',
            actionType,
            now,
            now
          ).run();
          created++;
        } catch (_) { /* duplicate — skip */ }
      }
    } catch (e) {
      await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'health_fix_error', message: e.message });
    }
    await _answerCallback_(env, callbackId, `Задачи созданы: ${created}`);
    return true;
  }

  // ── wb_health_rerun_{date} ───────────────────────────────
  if (data.startsWith('wb_health_rerun_')) {
    const date = data.slice('wb_health_rerun_'.length);
    try {
      const logId = wbGenerateId_('rerun');
      const now = new Date().toISOString();
      await db.prepare(`
        INSERT INTO wb_action_log (id, user_id, event_type, payload_json, created_at)
        VALUES (?, ?, 'rerun_requested', ?, ?)
      `).bind(logId, userId || null, JSON.stringify({ date }), now).run();
    } catch (e) {
      await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'rerun_log_error', message: e.message });
    }
    await _answerCallback_(env, callbackId, 'Перезапуск запланирован. Запустите /wb_run для немедленного перезапуска.');
    return true;
  }

  return false;
}

// ============================================================
// SECTION 7 — API Routes
// ============================================================

async function handleApprovalFlowRoutes_(env, request) {
  const db = env.DB;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // GET /agent/proposals/pending
  if (method === 'GET' && path === '/agent/proposals/pending') {
    const userId = url.searchParams.get('user_id') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const data = await getAllPendingProposals_(db, userId);
    // Honour explicit limit param (already limited to 50 in query, but cap further if requested)
    data.wb_proposals = data.wb_proposals.slice(0, limit);
    data.cs_drafts = data.cs_drafts.slice(0, limit);
    data.total = data.wb_proposals.length + data.cs_drafts.length;
    return _jsonResponse_(data);
  }

  // GET /agent/proposals/expired
  if (method === 'GET' && path === '/agent/proposals/expired') {
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    try {
      const res = await db.prepare(`
        SELECT * FROM wb_agent_proposals
        WHERE status = 'expired'
        ORDER BY updated_at DESC
        LIMIT ?
      `).bind(limit).all();
      return _jsonResponse_({ expired: res.results || [] });
    } catch (e) {
      return _jsonResponse_({ error: e.message }, 500);
    }
  }

  // POST /agent/proposals/digest
  if (method === 'POST' && path === '/agent/proposals/digest') {
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const chatId = body.chat_id;
    const userId = body.user_id;
    if (!chatId) return _jsonResponse_({ error: 'chat_id required' }, 400);
    const result = await sendApprovalDigest_(env, chatId, userId);
    return _jsonResponse_(result);
  }

  // POST /agent/proposals/cleanup
  if (method === 'POST' && path === '/agent/proposals/cleanup') {
    const count = await markProposalsExpired_(db);
    return _jsonResponse_({ expired_count: count });
  }

  // GET /agent/proposals/stats
  if (method === 'GET' && path === '/agent/proposals/stats') {
    try {
      const wbStats = await _queryStatusCounts_(db, 'wb_agent_proposals', ['pending', 'confirmed', 'expired', 'cancelled']);
      const csStats = await _queryStatusCounts_(db, 'cs_draft_response', ['pending', 'approved', 'rejected', 'sent']);
      return _jsonResponse_({
        wb: wbStats,
        cs_drafts: csStats,
        total_pending: (wbStats.pending || 0) + (csStats.pending || 0),
      });
    } catch (e) {
      return _jsonResponse_({ error: e.message }, 500);
    }
  }

  return null;
}

// ============================================================
// SECTION 8 — Planner Integration Helper
// ============================================================

async function tryNotifyPlanner_(env, proposal) {
  if (!env.INTERNAL_API_BASE) return { skipped: true };
  try {
    const resp = await fetch(`${env.INTERNAL_API_BASE}/agent/tasks/create-confirmed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: proposal.user_id,
        confirmation_id: proposal.confirmation_id,
        payload: {
          title:       proposal.title,
          action_type: proposal.action_type,
          nm_id:       proposal.nm_id,
        },
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      return { ok: false, error: errText };
    }
    const json = await resp.json().catch(() => ({}));
    return { ok: true, task_id: json.task_id || json.id || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================
// Internal Helpers (private, prefixed __)
// ============================================================

async function _sendWithInlineKeyboard_(env, chatId, text, keyboard) {
  const token = env.TELEGRAM_BOT_TOKEN;
  try {
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard },
    };
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      await wbLog_(env.DB, { level: 'warn', source: APPROVAL_FLOW_BUILD, event: 'send_keyboard_error', message: err });
    }
  } catch (e) {
    await wbLog_(env.DB, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'send_keyboard_exception', message: e.message });
  }
}

async function _answerCallback_(env, callbackQueryId, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (_) { /* best-effort */ }
}

async function _logToActionLog_(db, proposal, eventType, userId, source) {
  try {
    const logId = wbGenerateId_('alog');
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO wb_action_log (id, user_id, event_type, source, proposal_id, confirmation_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      logId,
      userId || proposal.user_id || null,
      eventType,
      source || APPROVAL_FLOW_BUILD,
      proposal.id,
      proposal.confirmation_id || null,
      JSON.stringify({ title: proposal.title, action_type: proposal.action_type, priority: proposal.priority }),
      now
    ).run();
  } catch (e) {
    await wbLog_(db, { level: 'error', source: APPROVAL_FLOW_BUILD, event: 'action_log_error', message: e.message });
  }
}

async function _queryStatusCounts_(db, table, statuses) {
  const result = {};
  for (const s of statuses) {
    try {
      const row = await db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE status = ?`).bind(s).first();
      result[s] = row ? row.cnt : 0;
    } catch (_) {
      result[s] = 0;
    }
  }
  return result;
}

function _jsonResponse_(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
// ============================================================
// QA / Health-Check Runner — v1
// Build: ai_helpers_qa_runner_v1
//
// Automated sanity checks across all system modules.
// Safe to run at any time — all checks are read-only except
// the final wbLog_ call that records the QA run.
//
// ── Checks performed ─────────────────────────────────────────
//
// SECTION 1 — Table existence (52 tables, 1 optional)
//   agent_incoming_messages, agent_proposals, agent_settings,
//   agent_audit_log,
//   wb_daily_snapshot, wb_sku_snapshot, wb_ads_snapshot,
//   wb_finance_snapshot, wb_stock_snapshot,
//   wb_agent_report, wb_agent_alerts, wb_agent_proposals,
//   wb_action_log, wb_cost_data,
//   wb_stock_snapshot_v2, wb_procurement_snapshot,
//   supplier_directory,
//   wb_report_consistency_check, wb_report_health_summary,
//   wb_report_consistency_check_v2,
//   cs_inbox_item, cs_draft_response, cs_product_issue,
//   cs_knowledge_item, cs_feedback_insight,
//   cs_appeal_item, cs_knowledge_gap,
//   approval_digest_log,
//   handoff_event,
//   scheduler_run_log, scheduler_config,
//   design_handoff_item, design_card_snapshot, design_content_plan,
//   rop_kpi_snapshot, rop_target, rop_insight,
//   fulfillment_fbs_snapshot, fulfillment_tz_item, fulfillment_schedule,
//   procurement_order, procurement_handoff_item, procurement_price_history,
//   wb_sync_log,
//   wb_pricing_proposal, wb_pricing_history,
//   bot_users,
//   alert_config, alert_log,
//   wb_analytics_run,
//   hub_records (optional)
//
// SECTION 2 — Schema column presence (17 tables, 46 columns)
//   wb_agent_proposals: confirmation_id, status,
//     requires_confirmation, priority
//   wb_agent_alerts: idempotency_key, alert_type, date
//   cs_draft_response: confirmation_id, status, inbox_item_id
//   cs_inbox_item: source, customer_text, status
//   wb_stock_snapshot_v2: days_of_stock,
//     recommended_supply_qty, stock_status
//   wb_procurement_snapshot: procurement_status,
//     latest_order_date
//   wb_report_health_summary: overall_status, safe_mode
//   handoff_event: confirmation_id, status,
//     requires_confirmation, to_chief
//   fulfillment_tz_item: confirmation_id,
//     requires_confirmation, status
//   fulfillment_fbs_snapshot: urgency,
//     days_of_stock_wb, source_status
//   rop_target: confirmation_id,
//     requires_confirmation, metric
//   design_content_plan: confirmation_id,
//     requires_confirmation, status
//   procurement_order: confirmation_id,
//     requires_confirmation, status
//   wb_pricing_proposal: confirmation_id,
//     requires_confirmation, status
//   wb_sync_log: status, sync_type
//   alert_log: idempotency_key, alert_type
//   bot_users: chat_id, user_id
//
// SECTION 3 — Data integrity (5 checks)
//   1. No orphaned cs_draft_response rows
//   2. No duplicate pending wb_agent_proposals
//   3. Duplicate pending cs drafts per inbox item (warning)
//   4. No duplicate wb_agent_alerts idempotency keys
//   5. No requires_confirmation=0 in pending proposals
//
// SECTION 4 — Calculation smoke tests (15 pure-function tests)
//   calculateDaysOfStock_, calculateSafetyStock_,
//   calculateRecommendedSupplyQty_, classifyStockStatus_v2_,
//   wbRound_, wbPct_, classifyOverallReportStatus_
//
// SECTION 5 — Environment variables (required / recommended /
//   optional)
//
// ── Trigger ───────────────────────────────────────────────────
//   API:      GET /agent/qa/check  (and sub-routes)
//   Telegram: /qa_check  /qa_tables  /qa_calc
//
// Dependencies (from wb_operations_stage1_v1.gs):
//   wbLog_(), wbGenerateId_(), wbRound_(), wbPct_()
// ============================================================

const QA_BUILD = 'ai_helpers_qa_runner_v1';

// ── Required tables ────────────────────────────────────────────
const QA_REQUIRED_TABLES = [
  // §1 Agent Extension
  'agent_incoming_messages',
  'agent_proposals',
  'agent_settings',
  'agent_audit_log',
  // §2 WB Operations Stage 1
  'wb_daily_snapshot',
  'wb_sku_snapshot',
  'wb_ads_snapshot',
  'wb_finance_snapshot',
  'wb_stock_snapshot',
  'wb_agent_report',
  'wb_agent_alerts',
  'wb_agent_proposals',
  'wb_action_log',
  'wb_cost_data',
  // §3 WB Operations Stage 2 + Patch
  'wb_stock_snapshot_v2',
  'wb_procurement_snapshot',
  'supplier_directory',
  'wb_report_consistency_check',
  'wb_report_health_summary',
  'wb_report_consistency_check_v2',
  // §4 CS Operations Stage 1
  'cs_inbox_item',
  'cs_draft_response',
  'cs_product_issue',
  'cs_knowledge_item',
  'cs_feedback_insight',
  // §5 CS Operations Stage 2
  'cs_appeal_item',
  'cs_knowledge_gap',
  // §6 Approval Flow
  'approval_digest_log',
  // §7 Handoff Events
  'handoff_event',
  // §8 Scheduler
  'scheduler_run_log',
  'scheduler_config',
  // §9 Design Chief
  'design_handoff_item',
  'design_card_snapshot',
  'design_content_plan',
  // §10 ROP Chief
  'rop_kpi_snapshot',
  'rop_target',
  'rop_insight',
  // §11 Fulfillment Chief
  'fulfillment_fbs_snapshot',
  'fulfillment_tz_item',
  'fulfillment_schedule',
  // §12 Procurement Chief
  'procurement_order',
  'procurement_handoff_item',
  'procurement_price_history',
  // §13 WB Sync
  'wb_sync_log',
  // §14 WB Pricing
  'wb_pricing_proposal',
  'wb_pricing_history',
  // §15 Bot Setup
  'bot_users',
  // §16 Alerts
  'alert_config',
  'alert_log',
  // §17 Analytics
  'wb_analytics_run',
  // §18 Returns Analysis
  'wb_returns_log',
  'wb_returns_summary',
];

const QA_OPTIONAL_TABLES = [
  'hub_records',
];

// ── Required columns per table ─────────────────────────────────
const QA_SCHEMA_CHECKS = [
  // WB core
  { table: 'wb_agent_proposals',      columns: ['confirmation_id', 'status', 'requires_confirmation', 'priority'] },
  { table: 'wb_agent_alerts',         columns: ['idempotency_key', 'alert_type', 'date'] },
  // CS core
  { table: 'cs_draft_response',       columns: ['confirmation_id', 'status', 'inbox_item_id'] },
  { table: 'cs_inbox_item',           columns: ['source', 'customer_text', 'status'] },
  // WB Stage 2
  { table: 'wb_stock_snapshot_v2',    columns: ['days_of_stock', 'recommended_supply_qty', 'stock_status'] },
  { table: 'wb_procurement_snapshot', columns: ['procurement_status', 'latest_order_date'] },
  { table: 'wb_report_health_summary',columns: ['overall_status', 'safe_mode'] },
  // Handoff Events — critical safety columns
  { table: 'handoff_event',           columns: ['confirmation_id', 'status', 'requires_confirmation', 'to_chief'] },
  // Fulfillment Chief — safety-critical (all tz items must have confirmation)
  { table: 'fulfillment_tz_item',     columns: ['confirmation_id', 'requires_confirmation', 'status'] },
  { table: 'fulfillment_fbs_snapshot',columns: ['urgency', 'days_of_stock_wb', 'source_status'] },
  // ROP Chief
  { table: 'rop_target',              columns: ['confirmation_id', 'requires_confirmation', 'metric'] },
  // Design Chief
  { table: 'design_content_plan',     columns: ['confirmation_id', 'requires_confirmation', 'status'] },
  // Procurement Chief — safety-critical
  { table: 'procurement_order',       columns: ['confirmation_id', 'requires_confirmation', 'status'] },
  // WB Pricing — all proposals must be confirmable
  { table: 'wb_pricing_proposal',     columns: ['confirmation_id', 'requires_confirmation', 'status'] },
  // WB Sync — sync outcome tracking
  { table: 'wb_sync_log',             columns: ['status', 'sync_type'] },
  // Alerts — dedup key is safety-critical (prevents spam)
  { table: 'alert_log',               columns: ['idempotency_key', 'alert_type'] },
  // Bot users — registration required for notifications
  { table: 'bot_users',               columns: ['chat_id', 'user_id'] },
];

// ============================================================
// SECTION 1 — TABLE EXISTENCE
// ============================================================

/**
 * Check whether a single table exists in SQLite's master catalog.
 * Returns { table, exists }
 */
async function checkTableExists_(db, tableName) {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name=?`
    ).bind(tableName).first();
    return { table: tableName, exists: (row && row.cnt > 0) };
  } catch (e) {
    return { table: tableName, exists: false, error: e.message };
  }
}

/**
 * Run table existence checks for all required (and optional) tables.
 * Returns {
 *   checks: Array<{ table, exists, optional? }>,
 *   missing_tables: string[],
 *   optional_missing: string[],
 *   passed: bool
 * }
 */
async function runTableExistenceChecks_(db) {
  const checks = [];
  const missing_tables = [];
  const optional_missing = [];

  for (const tableName of QA_REQUIRED_TABLES) {
    const result = await checkTableExists_(db, tableName);
    checks.push(result);
    if (!result.exists) missing_tables.push(tableName);
  }

  for (const tableName of QA_OPTIONAL_TABLES) {
    const result = await checkTableExists_(db, tableName);
    checks.push({ ...result, optional: true });
    if (!result.exists) optional_missing.push(tableName);
  }

  return {
    checks,
    missing_tables,
    optional_missing,
    passed: missing_tables.length === 0,
  };
}

// ============================================================
// SECTION 2 — SCHEMA COLUMN CHECKS
// ============================================================

/**
 * Check whether a column exists in a table using PRAGMA table_info.
 * Returns { table, column, exists }
 */
async function checkColumnExists_(db, tableName, columnName) {
  try {
    const { results = [] } = await db.prepare(
      `PRAGMA table_info(${tableName})`
    ).all();
    const exists = results.some(row => row.name === columnName);
    return { table: tableName, column: columnName, exists };
  } catch (e) {
    return { table: tableName, column: columnName, exists: false, error: e.message };
  }
}

/**
 * Run schema checks for all critical columns.
 * Returns {
 *   checks: Array<{ table, column, exists }>,
 *   failed: Array<{ table, column }>,
 *   passed: bool
 * }
 */
async function runSchemaChecks_(db) {
  const checks = [];
  const failed = [];

  for (const { table, columns } of QA_SCHEMA_CHECKS) {
    for (const column of columns) {
      const result = await checkColumnExists_(db, table, column);
      checks.push(result);
      if (!result.exists) failed.push({ table, column });
    }
  }

  return {
    checks,
    failed,
    passed: failed.length === 0,
  };
}

// ============================================================
// SECTION 3 — DATA INTEGRITY CHECKS
// ============================================================

/**
 * Run data integrity checks against the live database.
 * Returns {
 *   checks: Array<{ name, passed, warning?, detail? }>,
 *   warnings: string[],
 *   failed: string[],
 *   passed: bool
 * }
 */
async function runDataIntegrityChecks_(db) {
  const checks = [];
  const warnings = [];
  const failed = [];

  // 1. No orphaned cs_draft_response
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM cs_draft_response
       WHERE inbox_item_id NOT IN (SELECT id FROM cs_inbox_item)`
    ).first();
    const cnt = row ? row.cnt : 0;
    const passed = cnt === 0;
    checks.push({ name: 'no_orphaned_cs_draft_response', passed, detail: `orphaned rows: ${cnt}` });
    if (!passed) failed.push(`no_orphaned_cs_draft_response (${cnt} rows)`);
  } catch (e) {
    checks.push({ name: 'no_orphaned_cs_draft_response', passed: false, error: e.message });
    failed.push(`no_orphaned_cs_draft_response (error: ${e.message})`);
  }

  // 2. No duplicate active proposals (same confirmation_id in pending)
  try {
    const { results = [] } = await db.prepare(
      `SELECT confirmation_id, COUNT(*) AS c
       FROM wb_agent_proposals
       WHERE status='pending'
       GROUP BY confirmation_id
       HAVING c > 1`
    ).all();
    const passed = results.length === 0;
    checks.push({
      name: 'no_duplicate_pending_proposals',
      passed,
      detail: passed ? 'ok' : `${results.length} confirmation_id(s) with duplicates`,
    });
    if (!passed) failed.push(`no_duplicate_pending_proposals (${results.length} duplicates)`);
  } catch (e) {
    checks.push({ name: 'no_duplicate_pending_proposals', passed: false, error: e.message });
    failed.push(`no_duplicate_pending_proposals (error: ${e.message})`);
  }

  // 3. Duplicate pending cs drafts per inbox item (warning only)
  try {
    const { results = [] } = await db.prepare(
      `SELECT inbox_item_id, COUNT(*) AS c
       FROM cs_draft_response
       WHERE status='pending'
       GROUP BY inbox_item_id
       HAVING c > 1`
    ).all();
    const clean = results.length === 0;
    checks.push({
      name: 'cs_draft_no_duplicate_pending_per_inbox',
      passed: true,
      warning: !clean,
      detail: clean ? 'ok' : `${results.length} inbox_item(s) with multiple pending drafts`,
    });
    if (!clean) warnings.push(`cs_draft_no_duplicate_pending_per_inbox (${results.length} inbox items)`);
  } catch (e) {
    checks.push({
      name: 'cs_draft_no_duplicate_pending_per_inbox',
      passed: true,
      warning: true,
      error: e.message,
    });
    warnings.push(`cs_draft_no_duplicate_pending_per_inbox (error: ${e.message})`);
  }

  // 4. No duplicate wb_agent_alerts idempotency keys
  try {
    const { results = [] } = await db.prepare(
      `SELECT idempotency_key, COUNT(*) AS c
       FROM wb_agent_alerts
       GROUP BY idempotency_key
       HAVING c > 1`
    ).all();
    const passed = results.length === 0;
    checks.push({
      name: 'wb_agent_alerts_idempotency_unique',
      passed,
      detail: passed ? 'ok' : `${results.length} key(s) duplicated`,
    });
    if (!passed) failed.push(`wb_agent_alerts_idempotency_unique (${results.length} keys)`);
  } catch (e) {
    checks.push({ name: 'wb_agent_alerts_idempotency_unique', passed: false, error: e.message });
    failed.push(`wb_agent_alerts_idempotency_unique (error: ${e.message})`);
  }

  // 5. No requires_confirmation=0 in pending proposals
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS cnt
       FROM wb_agent_proposals
       WHERE requires_confirmation=0 AND status='pending'`
    ).first();
    const cnt = row ? row.cnt : 0;
    const passed = cnt === 0;
    checks.push({
      name: 'no_unconfirmable_proposals_in_pending',
      passed,
      detail: `rows violating invariant: ${cnt}`,
    });
    if (!passed) failed.push(`no_unconfirmable_proposals_in_pending (${cnt} rows)`);
  } catch (e) {
    checks.push({ name: 'no_unconfirmable_proposals_in_pending', passed: false, error: e.message });
    failed.push(`no_unconfirmable_proposals_in_pending (error: ${e.message})`);
  }

  return {
    checks,
    warnings,
    failed,
    passed: failed.length === 0,
  };
}

// ============================================================
// SECTION 4 — CALCULATION SMOKE TESTS
// ============================================================

/**
 * Run pure-function calculation tests (no DB required).
 * Each test: { name, passed, expected, actual, error? }
 */
function runCalculationTests_() {
  const tests = [];

  function addTest(name, fn, expected) {
    try {
      const actual = fn();
      tests.push({ name, passed: actual === expected, expected, actual });
    } catch (e) {
      tests.push({ name, passed: false, expected, actual: null, error: e.message });
    }
  }

  function safeCall(fnName, ...args) {
    if (typeof globalThis[fnName] !== 'function') {
      throw new Error('function_not_found');
    }
    return globalThis[fnName](...args);
  }

  // calculateDaysOfStock_
  addTest(
    'calculateDaysOfStock_(100, 10) = 10',
    () => safeCall('calculateDaysOfStock_', 100, 10),
    10
  );
  addTest(
    'calculateDaysOfStock_(100, 0) = 999',
    () => safeCall('calculateDaysOfStock_', 100, 0),
    999
  );
  addTest(
    'calculateDaysOfStock_(0, 0) = 0',
    () => safeCall('calculateDaysOfStock_', 0, 0),
    0
  );

  // calculateSafetyStock_
  addTest(
    'calculateSafetyStock_(10, 5) = 50',
    () => safeCall('calculateSafetyStock_', 10, 5),
    50
  );

  // calculateRecommendedSupplyQty_
  // stock=50, avg=10, target=30, safety=5, transit=0 → ceil(10*35 - 50 - 0) = 300
  addTest(
    'calculateRecommendedSupplyQty_(50, 10, 30, 5, 0) = 300',
    () => safeCall('calculateRecommendedSupplyQty_', 50, 10, 30, 5, 0),
    300
  );
  // stock=500, avg=10, target=30, safety=5, transit=100 → max(0, 10*35-500-100) = max(0,-250) = 0
  addTest(
    'calculateRecommendedSupplyQty_(500, 10, 30, 5, 100) = 0',
    () => safeCall('calculateRecommendedSupplyQty_', 500, 10, 30, 5, 100),
    0
  );

  // classifyStockStatus_v2_
  const rules = { critical_days: 5, low_days: 10, watch_days: 20, target_days: 30, max_days: 60 };

  addTest(
    'classifyStockStatus_v2_(3, 100, rules) = critical',
    () => safeCall('classifyStockStatus_v2_', 3, 100, rules),
    'critical'
  );
  addTest(
    'classifyStockStatus_v2_(25, 100, rules) = ok',
    () => safeCall('classifyStockStatus_v2_', 25, 100, rules),
    'ok'
  );
  addTest(
    'classifyStockStatus_v2_(70, 100, { max_days: 60 }) = overstock',
    () => safeCall('classifyStockStatus_v2_', 70, 100, { max_days: 60 }),
    'overstock'
  );
  addTest(
    'classifyStockStatus_v2_(0, 0, { critical_days: 5 }) = critical',
    () => safeCall('classifyStockStatus_v2_', 0, 0, { critical_days: 5 }),
    'critical'
  );

  // wbRound_
  addTest(
    'wbRound_(1.005, 2) = 1.01',
    () => safeCall('wbRound_', 1.005, 2),
    1.01
  );

  // wbPct_
  addTest(
    'wbPct_(25, 100) = 0.25',
    () => safeCall('wbPct_', 25, 100),
    0.25
  );

  // classifyOverallReportStatus_
  addTest(
    'classifyOverallReportStatus_([]) = unknown',
    () => safeCall('classifyOverallReportStatus_', []),
    'unknown'
  );
  addTest(
    'classifyOverallReportStatus_([{ is_blocking: 1, status: "failed" }]) = failed',
    () => safeCall('classifyOverallReportStatus_', [{ is_blocking: 1, status: 'failed' }]),
    'failed'
  );
  addTest(
    'classifyOverallReportStatus_([{ severity: "warning", status: "warning", is_blocking: 0 }]) = ready_with_warnings',
    () => safeCall('classifyOverallReportStatus_', [{ severity: 'warning', status: 'warning', is_blocking: 0 }]),
    'ready_with_warnings'
  );

  const passed_count = tests.filter(t => t.passed).length;
  const failed_count = tests.length - passed_count;

  return {
    tests,
    passed_count,
    failed_count,
    all_passed: failed_count === 0,
  };
}

// ============================================================
// SECTION 5 — ENVIRONMENT CHECK
// ============================================================

const QA_ENV_REQUIRED    = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'DB'];
const QA_ENV_RECOMMENDED = ['GEMINI_API_KEY', 'GROQ_API_KEY'];
const QA_ENV_OPTIONAL    = [
  'INTERNAL_API_BASE',
  'WB_API_TOKEN',
  'GROQ_API_BASE',
  'GROQ_MODEL',
  'GEMINI_CLASSIFICATION_MODEL',
];

/**
 * Check which environment variables are configured.
 * Never returns actual values — only booleans.
 */
function checkEnvironment_(env) {
  const required    = {};
  const recommended = {};
  const optional    = {};
  const missing_required    = [];
  const missing_recommended = [];

  for (const key of QA_ENV_REQUIRED) {
    const isSet = Boolean(env && env[key]);
    required[key] = isSet;
    if (!isSet) missing_required.push(key);
  }

  for (const key of QA_ENV_RECOMMENDED) {
    const isSet = Boolean(env && env[key]);
    recommended[key] = isSet;
    if (!isSet) missing_recommended.push(key);
  }

  for (const key of QA_ENV_OPTIONAL) {
    optional[key] = Boolean(env && env[key]);
  }

  return {
    required,
    recommended,
    optional,
    missing_required,
    missing_recommended,
    ready: missing_required.length === 0,
  };
}

// ============================================================
// SECTION 6 — FULL QA RUNNER
// ============================================================

/**
 * Run all QA checks end-to-end.
 * Logs result to wb_action_log (event_type='qa_run').
 */
async function runFullQaCheck_(env) {
  const timestamp = new Date().toISOString();
  const db = env && env.DB;

  // 1. Environment
  let environment;
  try {
    environment = checkEnvironment_(env);
  } catch (e) {
    environment = { ready: false, error: e.message };
  }

  // 2. Tables
  let tables = { checks: [], missing_tables: [], optional_missing: [], passed: false };
  if (db) {
    try {
      tables = await runTableExistenceChecks_(db);
    } catch (e) {
      tables = { checks: [], missing_tables: [], optional_missing: [], passed: false, error: e.message };
    }
  } else {
    tables = { checks: [], missing_tables: ['DB not available'], optional_missing: [], passed: false };
  }

  // 3. Schema
  let schema = { checks: [], failed: [], passed: false };
  if (db) {
    try {
      schema = await runSchemaChecks_(db);
    } catch (e) {
      schema = { checks: [], failed: [], passed: false, error: e.message };
    }
  }

  // 4. Integrity
  let integrity = { checks: [], warnings: [], failed: [], passed: false };
  if (db) {
    try {
      integrity = await runDataIntegrityChecks_(db);
    } catch (e) {
      integrity = { checks: [], warnings: [], failed: [], passed: false, error: e.message };
    }
  }

  // 5. Calculations
  let calculations;
  try {
    calculations = runCalculationTests_();
  } catch (e) {
    calculations = { tests: [], passed_count: 0, failed_count: 0, all_passed: false, error: e.message };
  }

  // 6. Compile summary
  const envOk       = environment.ready;
  const tablesOk    = tables.passed;
  const schemaOk    = schema.passed;
  const integrityOk = integrity.passed;
  const calcsOk     = calculations.all_passed;

  const hasHardFail = !envOk || !tablesOk || !integrityOk;
  const hasWarnings = (integrity.warnings && integrity.warnings.length > 0)
    || !schemaOk
    || !calcsOk;

  let overall_status;
  if (hasHardFail) {
    overall_status = 'failed';
  } else if (hasWarnings) {
    overall_status = 'warnings';
  } else {
    overall_status = 'ok';
  }

  const totalTableChecks  = tables.checks.length;
  const passedTableChecks = tables.checks.filter(c => c.exists).length;
  const totalSchemaChecks  = schema.checks.length;
  const passedSchemaChecks = schema.checks.filter(c => c.exists).length;
  const totalIntegrityChecks  = integrity.checks.length;
  const passedIntegrityChecks = integrity.checks.filter(c => c.passed).length;
  const integrityWarnings = integrity.checks.filter(c => c.warning).length;

  const total_checks = totalTableChecks + totalSchemaChecks + totalIntegrityChecks + calculations.tests.length;
  const total_passed = passedTableChecks + passedSchemaChecks + passedIntegrityChecks + calculations.passed_count;
  const total_warnings = integrityWarnings;
  const total_failed = total_checks - total_passed - total_warnings;

  const result = {
    build:          QA_BUILD,
    timestamp,
    overall_status,
    environment,
    tables,
    schema,
    integrity,
    calculations,
    summary: {
      total_checks,
      passed:   total_passed,
      warnings: total_warnings,
      failed:   Math.max(0, total_failed),
    },
  };

  // Log to audit trail
  if (db) {
    try {
      await wbLog_(db, {
        source_agent: QA_BUILD,
        event_type:   'qa_run',
        status:       overall_status === 'ok' ? 'success' : overall_status === 'warnings' ? 'warning' : 'error',
        payload: {
          overall_status,
          summary: result.summary,
          missing_tables:    tables.missing_tables,
          optional_missing:  tables.optional_missing,
          schema_failed:     schema.failed,
          integrity_failed:  integrity.failed,
          integrity_warnings:integrity.warnings,
          calc_failed:       calculations.failed_count,
          missing_env:       environment.missing_required,
        },
      });
    } catch (_) {
      // Log failure must not affect the QA result
    }
  }

  return result;
}

// ============================================================
// SECTION 7 — TELEGRAM COMMANDS
// ============================================================

/**
 * Escape special MarkdownV2 characters for Telegram.
 */
function qaEscapeMd_(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Format full QA result for Telegram.
 */
function formatQaResultForTelegram_(result) {
  const {
    overall_status,
    environment,
    tables,
    schema,
    integrity,
    calculations,
    summary,
  } = result;

  const statusEmoji = overall_status === 'ok'       ? '✅ OK'
    : overall_status === 'warnings' ? '⚠️ warnings'
    : '❌ failed';

  const reqKeys = Object.keys(environment.required || {});
  const reqSet  = reqKeys.filter(k => environment.required[k]).length;

  const tableTotal   = tables.checks.length;
  const tablePresent = tables.checks.filter(c => c.exists).length;
  const tableLine    = tables.optional_missing.length > 0
    ? `${qaEscapeMd_(tablePresent)}/${qaEscapeMd_(tableTotal)} \\(${qaEscapeMd_(tables.optional_missing.join(', '))} — опциональна, отсутствует\\)`
    : `${qaEscapeMd_(tablePresent)}/${qaEscapeMd_(tableTotal)}`;

  const schemaTotal  = schema.checks.length;
  const schemaOk     = schema.checks.filter(c => c.exists).length;

  const integrityLine = integrity.failed.length === 0 && integrity.warnings.length === 0
    ? 'OK'
    : integrity.failed.length > 0 ? `❌ ${qaEscapeMd_(integrity.failed.length)} ошибок` : `⚠️ ${qaEscapeMd_(integrity.warnings.length)} предупреждений`;

  const calcLine = `${qaEscapeMd_(calculations.passed_count)}/${qaEscapeMd_(calculations.tests.length)} тестов`;

  let text = `🧪 *QA Проверка системы*\n\n`;
  text += `Статус: ${qaEscapeMd_(statusEmoji)}\n\n`;
  text += `Окружение: ${qaEscapeMd_(reqSet)}/${qaEscapeMd_(reqKeys.length)} обязательных переменных\n`;
  text += `Таблицы: ${tableLine}\n`;
  text += `Схема: ${qaEscapeMd_(schemaOk)}/${qaEscapeMd_(schemaTotal)} колонок\n`;
  text += `Целостность: ${qaEscapeMd_(integrityLine)}\n`;
  text += `Расчёты: ${calcLine}\n`;

  // Details section
  const details = [];

  if ((environment.missing_required || []).length > 0) {
    details.push(`Отсутствующие env: ${environment.missing_required.join(', ')}`);
  }
  if (tables.missing_tables.length > 0) {
    details.push(`Отсутствующие таблицы: ${tables.missing_tables.join(', ')}`);
  }
  if (schema.failed.length > 0) {
    for (const f of schema.failed) {
      details.push(`Колонка не найдена: ${f.table}.${f.column}`);
    }
  }
  if (integrity.failed.length > 0) {
    for (const f of integrity.failed) {
      details.push(`Нарушение целостности: ${f}`);
    }
  }
  if (integrity.warnings.length > 0) {
    for (const w of integrity.warnings) {
      details.push(`Предупреждение: ${w}`);
    }
  }
  const failedCalcs = calculations.tests.filter(t => !t.passed);
  for (const t of failedCalcs) {
    const err = t.error ? `error: ${t.error}` : `ожидалось ${t.expected}, получено ${t.actual}`;
    details.push(`Тест провален: ${t.name} — ${err}`);
  }

  if (details.length > 0) {
    text += `\nДетали:\n`;
    for (const d of details) {
      text += `— ${qaEscapeMd_(d)}\n`;
    }
  }

  return text;
}

/**
 * Format table existence check for Telegram.
 */
function formatQaTablesForTelegram_(tables) {
  const present  = tables.checks.filter(c => c.exists && !c.optional);
  const missing  = tables.missing_tables;
  const optMiss  = tables.optional_missing;

  let text = `📋 *QA: Таблицы*\n\n`;
  text += `Обязательных: ${qaEscapeMd_(present.length)}/${qaEscapeMd_(QA_REQUIRED_TABLES.length)}\n`;

  if (missing.length > 0) {
    text += `\n❌ Отсутствуют:\n`;
    for (const t of missing) {
      text += `— ${qaEscapeMd_(t)}\n`;
    }
  } else {
    text += `\n✅ Все обязательные таблицы присутствуют\n`;
  }

  if (optMiss.length > 0) {
    text += `\n⚪ Опциональные, отсутствуют:\n`;
    for (const t of optMiss) {
      text += `— ${qaEscapeMd_(t)}\n`;
    }
  }

  return text;
}

/**
 * Format calculation tests for Telegram.
 */
function formatQaCalcForTelegram_(calculations) {
  let text = `🔢 *QA: Расчёты*\n\n`;
  text += `Пройдено: ${qaEscapeMd_(calculations.passed_count)}/${qaEscapeMd_(calculations.tests.length)}\n`;

  const failed = calculations.tests.filter(t => !t.passed);
  if (failed.length === 0) {
    text += `\n✅ Все тесты прошли\n`;
  } else {
    text += `\n❌ Провалено:\n`;
    for (const t of failed) {
      const detail = t.error
        ? `error: ${qaEscapeMd_(t.error)}`
        : `ожидалось ${qaEscapeMd_(String(t.expected))}, получено ${qaEscapeMd_(String(t.actual))}`;
      text += `— ${qaEscapeMd_(t.name)}\n  ${detail}\n`;
    }
  }

  return text;
}

/**
 * Send a Telegram message (reuse bot token from env).
 */
async function sendQaTelegramMessage_(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return false;
  const MAX = 3800;
  const chunks = [];
  let rem = text;
  while (rem.length > MAX) {
    let split = rem.lastIndexOf('\n', MAX);
    if (split < 0) split = MAX;
    chunks.push(rem.slice(0, split));
    rem = rem.slice(split).trimStart();
  }
  if (rem.length) chunks.push(rem);

  for (const chunk of chunks) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'MarkdownV2' }),
        }
      );
      if (!res.ok) {
        // Non-fatal — the response already left the worker
      }
    } catch (_) {
      // Fetch errors are non-fatal for QA output
    }
  }
  return true;
}

/**
 * Route QA-related Telegram commands.
 * Returns true if handled, false otherwise.
 */
async function routeQaTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();
  const command = text.split(/\s+/)[0].toLowerCase();

  // /qa and /qa_full are aliases for /qa_check
  if (command === '/qa' || command === '/qa_full' || command === '/qa_check') {
    try {
      const result    = await runFullQaCheck_(env);
      const formatted = formatQaResultForTelegram_(result);
      await sendQaTelegramMessage_(env, chatId, formatted);
    } catch (e) {
      await sendQaTelegramMessage_(
        env, chatId,
        `❌ QA завершился с ошибкой: ${qaEscapeMd_(e.message)}`
      );
    }
    return true;
  }

  if (command === '/qa_tables') {
    try {
      const db     = env.DB;
      const tables = db ? await runTableExistenceChecks_(db)
        : { checks: [], missing_tables: ['DB not available'], optional_missing: [], passed: false };
      const formatted = formatQaTablesForTelegram_(tables);
      await sendQaTelegramMessage_(env, chatId, formatted);
    } catch (e) {
      await sendQaTelegramMessage_(
        env, chatId,
        `❌ QA tables: ${qaEscapeMd_(e.message)}`
      );
    }
    return true;
  }

  if (command === '/qa_calc') {
    try {
      const calculations = runCalculationTests_();
      const formatted    = formatQaCalcForTelegram_(calculations);
      await sendQaTelegramMessage_(env, chatId, formatted);
    } catch (e) {
      await sendQaTelegramMessage_(
        env, chatId,
        `❌ QA calc: ${qaEscapeMd_(e.message)}`
      );
    }
    return true;
  }

  return false;
}

// ============================================================
// SECTION 8 — API ROUTES
// ============================================================

/**
 * Handle QA API routes.
 * Returns a Response object if matched, null otherwise.
 */
async function handleQaRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;

  if (request.method !== 'GET') return null;

  if (pathname === '/agent/qa/check') {
    try {
      const result = await runFullQaCheck_(env);
      return qaJsonResponse_(result);
    } catch (e) {
      return qaJsonResponse_({ error: e.message, build: QA_BUILD }, 500);
    }
  }

  if (pathname === '/agent/qa/tables') {
    try {
      const db = env.DB;
      if (!db) return qaJsonResponse_({ error: 'DB not available' }, 503);
      const result = await runTableExistenceChecks_(db);
      return qaJsonResponse_(result);
    } catch (e) {
      return qaJsonResponse_({ error: e.message }, 500);
    }
  }

  if (pathname === '/agent/qa/schema') {
    try {
      const db = env.DB;
      if (!db) return qaJsonResponse_({ error: 'DB not available' }, 503);
      const result = await runSchemaChecks_(db);
      return qaJsonResponse_(result);
    } catch (e) {
      return qaJsonResponse_({ error: e.message }, 500);
    }
  }

  if (pathname === '/agent/qa/integrity') {
    try {
      const db = env.DB;
      if (!db) return qaJsonResponse_({ error: 'DB not available' }, 503);
      const result = await runDataIntegrityChecks_(db);
      return qaJsonResponse_(result);
    } catch (e) {
      return qaJsonResponse_({ error: e.message }, 500);
    }
  }

  if (pathname === '/agent/qa/calculations') {
    try {
      const result = runCalculationTests_();
      return qaJsonResponse_(result);
    } catch (e) {
      return qaJsonResponse_({ error: e.message }, 500);
    }
  }

  if (pathname === '/agent/qa/environment') {
    try {
      const result = checkEnvironment_(env);
      return qaJsonResponse_(result);
    } catch (e) {
      return qaJsonResponse_({ error: e.message }, 500);
    }
  }

  return null;
}

/**
 * Internal helper — build a JSON response with CORS headers.
 */
function qaJsonResponse_(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
// ============================================================
// Handoff Events — межшефная коммуникация
// Build: ai_helpers_handoff_events_v1
//
// Структурированная передача событий между AI-шефами.
// Когда один шеф выявляет проблему для другого — создаёт handoff.
// Никаких автоматических действий — только информирование и proposals.
//
// ── Новые таблицы ────────────────────────────────────────────
// handoff_event — события между шефами
//
// ── Новые Telegram-команды ───────────────────────────────────
// /handoffs         — все pending handoffs
// /handoffs_wb      — только для wb_operations_chief
// /handoffs_cs      — только для cs_operations_chief
//
// ── Новые API ────────────────────────────────────────────────
// GET  /agent/handoffs
// GET  /agent/handoffs/stats
// POST /agent/handoffs
// POST /agent/handoffs/:id/acknowledge
// POST /agent/handoffs/:id/resolve
// POST /agent/handoffs/:id/dismiss
// POST /agent/handoffs/expire
// ============================================================

const HANDOFF_CHIEFS = {
  WB_OPERATIONS: 'wb_operations_chief',
  CS_OPERATIONS: 'cs_operations_chief',
  DESIGN:        'design_chief',
  ROP:           'rop_chief',
  PROCUREMENT:   'procurement_chief',
  FULFILLMENT:   'fulfillment_chief',
  PLANNER:       'planner',
  INBOX_HUB:     'inbox_hub',
};

const HANDOFF_PRIORITY = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low',
};

const HANDOFF_STATUS = {
  PENDING:      'pending',
  ACKNOWLEDGED: 'acknowledged',
  IN_PROGRESS:  'in_progress',
  DONE:         'done',
  DISMISSED:    'dismissed',
  EXPIRED:      'expired',
};

const HANDOFF_TYPE = {
  RATING_DROP:           'rating_drop',
  RETURN_SPIKE:          'return_spike',
  PRODUCT_QUALITY_RISK:  'product_quality_risk',
  CARD_CONTENT_GAP:      'card_content_gap',
  INSTRUCTION_UNCLEAR:   'instruction_unclear',
  EXPECTATION_MISMATCH:  'expectation_mismatch',
  CRITICAL_COMPLAINT:    'critical_complaint',
  HIGH_RETURN_RATE:      'high_return_rate',
  STOCK_CRITICAL:        'stock_critical',
  STOCK_LOW:             'stock_low',
  SUPPLY_NEEDED:         'supply_needed',
  SKU_RISK:              'sku_risk',
  FINANCE_CRITICAL:      'finance_critical',
  ADS_BUDGET_RISK:       'ads_budget_risk',
  FULFILLMENT_TZ_NEEDED: 'fulfillment_tz_needed',
  PRICE_DROP_NOTIFY:     'price_drop_notify',
  TASK_NEEDED:           'task_needed',
  INSIGHT_CAPTURED:      'insight_captured',
};

const HANDOFF_PRIORITY_WEIGHT = {
  critical: 4, high: 3, medium: 2, low: 1,
};

// ── Section 1: Schema ─────────────────────────────────────────

async function ensureHandoffSchema_(db) {
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS handoff_event (
        id TEXT PRIMARY KEY,
        from_chief TEXT NOT NULL,
        to_chief TEXT NOT NULL,
        handoff_type TEXT NOT NULL,
        priority TEXT DEFAULT 'medium',
        status TEXT DEFAULT 'pending',
        nm_id INTEGER,
        sku_title TEXT,
        entity_type TEXT,
        entity_id TEXT,
        title TEXT NOT NULL,
        summary TEXT,
        evidence_json TEXT DEFAULT '[]',
        recommended_action TEXT,
        payload_json TEXT DEFAULT '{}',
        requires_confirmation INTEGER DEFAULT 0,
        confirmation_id TEXT UNIQUE,
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        resolved_at TEXT,
        expires_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `).run();
  } catch (_) {}

  for (const sql of [
    `CREATE INDEX IF NOT EXISTS idx_handoff_to_chief ON handoff_event(to_chief, status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_handoff_from_chief ON handoff_event(from_chief, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_handoff_nm_id ON handoff_event(nm_id, status)`,
  ]) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
}

// ── Section 2: Core CRUD ──────────────────────────────────────

async function createHandoffEvent_(db, opts) {
  const {
    from_chief, to_chief, handoff_type,
    priority = HANDOFF_PRIORITY.MEDIUM,
    nm_id = null, sku_title = null,
    entity_type = null, entity_id = null,
    title, summary = null,
    evidence = [], recommended_action = null,
    payload = {}, requires_confirmation = 0,
    ttl_hours = null,
  } = opts;

  const id = wbGenerateId_('hof');
  const confirmation_id = requires_confirmation ? wbGenerateId_('hof_conf') : null;
  const expires_at = ttl_hours
    ? new Date(Date.now() + ttl_hours * 3600000).toISOString()
    : null;

  try {
    await db.prepare(`
      INSERT INTO handoff_event
        (id, from_chief, to_chief, handoff_type, priority, status,
         nm_id, sku_title, entity_type, entity_id, title, summary,
         evidence_json, recommended_action, payload_json,
         requires_confirmation, confirmation_id, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(confirmation_id) DO NOTHING
    `).bind(
      id, from_chief, to_chief, handoff_type, priority, HANDOFF_STATUS.PENDING,
      nm_id, sku_title, entity_type, entity_id, title, summary,
      JSON.stringify(evidence), recommended_action, JSON.stringify(payload),
      requires_confirmation ? 1 : 0, confirmation_id, expires_at
    ).run();

    await wbLog_(db, {
      event_type: 'handoff_created',
      entity_type: 'handoff',
      entity_id: id,
      details_json: JSON.stringify({ from_chief, to_chief, handoff_type, priority }),
    });

    return { id, confirmation_id };
  } catch (e) {
    await wbLog_(db, { event_type: 'handoff_create_error', entity_type: 'handoff', details_json: JSON.stringify({ error: String(e) }) });
    return { id: null, error: String(e) };
  }
}

async function getHandoffEvents_(db, toChief, status, limit) {
  let sql = `SELECT * FROM handoff_event WHERE 1=1`;
  const params = [];

  if (toChief) { sql += ` AND to_chief=?`; params.push(toChief); }
  if (status)  { sql += ` AND status=?`;   params.push(status); }

  sql += ` AND (expires_at IS NULL OR expires_at > datetime('now'))`;
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit || 50);

  try {
    const res = await db.prepare(sql).bind(...params).all();
    const rows = res.results || [];
    // Sort by priority weight desc
    rows.sort((a, b) => (HANDOFF_PRIORITY_WEIGHT[b.priority] || 0) - (HANDOFF_PRIORITY_WEIGHT[a.priority] || 0));
    return rows;
  } catch (_) { return []; }
}

async function acknowledgeHandoff_(db, handoffId, acknowledgedBy) {
  try {
    const existing = await db.prepare(`SELECT status FROM handoff_event WHERE id=?`).bind(handoffId).first();
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status === HANDOFF_STATUS.DONE || existing.status === HANDOFF_STATUS.DISMISSED) {
      return { ok: false, error: 'already_final' };
    }
    await db.prepare(`
      UPDATE handoff_event SET status='acknowledged', acknowledged_at=datetime('now'),
        acknowledged_by=?, updated_at=datetime('now') WHERE id=?
    `).bind(acknowledgedBy || 'user', handoffId).run();
    await wbLog_(db, { event_type: 'handoff_acknowledged', entity_type: 'handoff', entity_id: handoffId });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function resolveHandoff_(db, handoffId) {
  try {
    await db.prepare(`
      UPDATE handoff_event SET status='done', resolved_at=datetime('now'),
        updated_at=datetime('now') WHERE id=?
    `).bind(handoffId).run();
    await wbLog_(db, { event_type: 'handoff_resolved', entity_type: 'handoff', entity_id: handoffId });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function dismissHandoff_(db, handoffId, reason) {
  try {
    const existing = await db.prepare(`SELECT payload_json FROM handoff_event WHERE id=?`).bind(handoffId).first();
    let payload = {};
    try { payload = JSON.parse(existing?.payload_json || '{}'); } catch (_) {}
    payload.dismiss_reason = reason || 'dismissed by user';

    await db.prepare(`
      UPDATE handoff_event SET status='dismissed', payload_json=?,
        updated_at=datetime('now') WHERE id=?
    `).bind(JSON.stringify(payload), handoffId).run();
    await wbLog_(db, { event_type: 'handoff_dismissed', entity_type: 'handoff', entity_id: handoffId });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function expireOldHandoffs_(db) {
  try {
    const res = await db.prepare(`
      UPDATE handoff_event SET status='expired', updated_at=datetime('now')
      WHERE status IN ('pending','acknowledged')
        AND expires_at IS NOT NULL AND expires_at < datetime('now')
    `).run();
    return { expired_count: res.changes || 0 };
  } catch (_) { return { expired_count: 0 }; }
}

// ── Section 3: Pre-built handoff creators ────────────────────

async function createStockCriticalHandoff_(db, snap) {
  return createHandoffEvent_(db, {
    from_chief: HANDOFF_CHIEFS.WB_OPERATIONS,
    to_chief:   HANDOFF_CHIEFS.PROCUREMENT,
    handoff_type: HANDOFF_TYPE.STOCK_CRITICAL,
    priority: HANDOFF_PRIORITY.CRITICAL,
    nm_id: snap.nm_id, sku_title: snap.sku_title,
    title: `Критичный остаток: ${snap.sku_title || snap.nm_id} — ${wbRound_(snap.days_of_stock, 1)} дней`,
    summary: 'Остаток опустился ниже критического порога',
    evidence: [
      `Остаток: ${snap.stock_total} шт.`,
      `Скорость: ${wbRound_(snap.avg_daily_orders_7d || 0, 1)} шт./день`,
      `Рекомендовано: ${snap.recommended_supply_qty} шт.`,
    ],
    recommended_action: 'Срочно инициировать закупку',
    ttl_hours: 48,
  });
}

async function createStockLowHandoff_(db, snap) {
  return createHandoffEvent_(db, {
    from_chief: HANDOFF_CHIEFS.WB_OPERATIONS,
    to_chief:   HANDOFF_CHIEFS.PROCUREMENT,
    handoff_type: HANDOFF_TYPE.STOCK_LOW,
    priority: HANDOFF_PRIORITY.HIGH,
    nm_id: snap.nm_id, sku_title: snap.sku_title,
    title: `Низкий остаток: ${snap.sku_title || snap.nm_id} — ${wbRound_(snap.days_of_stock, 1)} дней`,
    evidence: [`Остаток: ${snap.stock_total} шт.`, `Рекомендовано: ${snap.recommended_supply_qty} шт.`],
    recommended_action: 'Запланировать закупку',
    ttl_hours: 72,
  });
}

async function createRatingDropHandoff_(db, insight) {
  return createHandoffEvent_(db, {
    from_chief: HANDOFF_CHIEFS.CS_OPERATIONS,
    to_chief:   HANDOFF_CHIEFS.WB_OPERATIONS,
    handoff_type: HANDOFF_TYPE.RATING_DROP,
    priority: HANDOFF_PRIORITY.HIGH,
    nm_id: insight.nm_id, sku_title: insight.sku_title,
    title: `Падение рейтинга: ${insight.sku_title || insight.nm_id}`,
    summary: insight.insight_text,
    evidence: [insight.insight_text],
    recommended_action: 'Проверить причины, обновить карточку, улучшить упаковку',
    ttl_hours: 72,
  });
}

async function createCardContentGapHandoff_(db, issue) {
  return createHandoffEvent_(db, {
    from_chief: HANDOFF_CHIEFS.CS_OPERATIONS,
    to_chief:   HANDOFF_CHIEFS.DESIGN,
    handoff_type: HANDOFF_TYPE.CARD_CONTENT_GAP,
    priority: HANDOFF_PRIORITY.MEDIUM,
    nm_id: issue.nm_id, sku_title: issue.sku_title,
    title: `Пробел в карточке: ${issue.issue_type} — ${issue.sku_title || issue.nm_id}`,
    summary: issue.issue_description,
    evidence: [`${issue.occurrence_count} обращений покупателей`, `Тип: ${issue.issue_type}`],
    recommended_action: 'Обновить карточку, добавить инструкционный слайд',
    ttl_hours: 168,
  });
}

async function createProductQualityRiskHandoff_(db, issue) {
  return createHandoffEvent_(db, {
    from_chief: HANDOFF_CHIEFS.CS_OPERATIONS,
    to_chief:   HANDOFF_CHIEFS.WB_OPERATIONS,
    handoff_type: HANDOFF_TYPE.PRODUCT_QUALITY_RISK,
    priority: HANDOFF_PRIORITY.HIGH,
    nm_id: issue.nm_id, sku_title: issue.sku_title,
    title: `Риск качества: ${issue.sku_title || issue.nm_id}`,
    summary: `${issue.occurrence_count} обращений по причине: ${issue.issue_type}`,
    evidence: [`${issue.occurrence_count} случаев`, `Серьёзность: ${issue.severity}`],
    recommended_action: 'Проверить партию товара, связаться с поставщиком',
    ttl_hours: 48,
  });
}

async function createSkuRiskHandoff_(db, snap) {
  const priority = ['risk', 'exit'].includes(snap.sku_status)
    ? HANDOFF_PRIORITY.HIGH : HANDOFF_PRIORITY.MEDIUM;
  return createHandoffEvent_(db, {
    from_chief: HANDOFF_CHIEFS.WB_OPERATIONS,
    to_chief:   HANDOFF_CHIEFS.ROP,
    handoff_type: HANDOFF_TYPE.SKU_RISK,
    priority,
    nm_id: snap.nm_id, sku_title: snap.sku_title,
    title: `Риск SKU: ${snap.sku_title || snap.nm_id} — статус ${snap.sku_status}`,
    evidence: [
      `Статус: ${snap.sku_status}`,
      snap.drr ? `DRR: ${wbRound_(snap.drr * 100, 1)}%` : null,
      snap.profit_after_ads !== undefined ? `Прибыль: ${wbRound_(snap.profit_after_ads, 0)} руб.` : null,
    ].filter(Boolean),
    recommended_action: 'Управленческое решение по артикулу',
    ttl_hours: 48,
  });
}

async function createFulfillmentTzHandoff_(db, proposal) {
  return createHandoffEvent_(db, {
    from_chief: HANDOFF_CHIEFS.WB_OPERATIONS,
    to_chief:   HANDOFF_CHIEFS.FULFILLMENT,
    handoff_type: HANDOFF_TYPE.FULFILLMENT_TZ_NEEDED,
    priority: HANDOFF_PRIORITY.HIGH,
    title: `ТЗ на поставку: ${proposal.title || 'Поставка товара'}`,
    summary: proposal.description,
    evidence: [`Proposal ID: ${proposal.id}`],
    recommended_action: 'Подготовить ТЗ на фулфилмент',
    requires_confirmation: 1,
    ttl_hours: 72,
  });
}

// ── Section 4: Bridge functions ───────────────────────────────

async function processWbOpsHandoffs_(db, wbReport) {
  let count = 0;
  if (!wbReport) return { handoffs_created: 0 };

  // Critical stock
  const stockResult = wbReport.stock_agent || wbReport.stock_fulfillment_agent;
  if (stockResult?.critical_stock_items) {
    for (const snap of stockResult.critical_stock_items) {
      const r = await createStockCriticalHandoff_(db, snap);
      if (r.id) count++;
    }
  }
  if (stockResult?.low_stock_items) {
    for (const snap of stockResult.low_stock_items.slice(0, 5)) {
      const r = await createStockLowHandoff_(db, snap);
      if (r.id) count++;
    }
  }

  // SKU risks
  const skuResult = wbReport.sku_monitor;
  if (skuResult?.risk_skus) {
    for (const snap of skuResult.risk_skus.slice(0, 10)) {
      const r = await createSkuRiskHandoff_(db, snap);
      if (r.id) count++;
    }
  }

  // Fulfillment proposals
  const proposals = wbReport.proposals || [];
  for (const p of proposals.filter(p => p.action_type === 'create_fulfillment_tz')) {
    const r = await createFulfillmentTzHandoff_(db, p);
    if (r.id) count++;
  }

  await wbLog_(db, { event_type: 'wb_ops_handoffs_processed', entity_type: 'handoff', details_json: JSON.stringify({ count }) });
  return { handoffs_created: count };
}

async function processCsHandoffs_(db, csReport) {
  let count = 0;
  if (!csReport) return { handoffs_created: 0 };

  // Rating drop insights
  try {
    const insights = await db.prepare(
      `SELECT * FROM cs_feedback_insight WHERE insight_type='rating_drop' AND status='new' AND date(created_at)=?`
    ).bind(wbYesterday_()).all();
    for (const ins of (insights.results || [])) {
      const r = await createRatingDropHandoff_(db, ins);
      if (r.id) count++;
    }
  } catch (_) {}

  // Product quality risks
  try {
    const issues = await db.prepare(
      `SELECT * FROM cs_product_issue WHERE occurrence_count >= 5 AND status='open'`
    ).all();
    for (const iss of (issues.results || []).slice(0, 10)) {
      if (['defect', 'packaging'].includes(iss.issue_type)) {
        const r = await createProductQualityRiskHandoff_(db, iss);
        if (r.id) count++;
      } else if (['description_mismatch', 'sizing'].includes(iss.issue_type)) {
        const r = await createCardContentGapHandoff_(db, iss);
        if (r.id) count++;
      }
    }
  } catch (_) {}

  await wbLog_(db, { event_type: 'cs_handoffs_processed', entity_type: 'handoff', details_json: JSON.stringify({ count }) });
  return { handoffs_created: count };
}

// ── Section 5: Telegram ───────────────────────────────────────

function handoffPriorityIcon_(priority) {
  return { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[priority] || '⚪';
}

async function sendHandoffList_(token, chatId, events, title) {
  if (!events.length) {
    await csSendTelegramMessage_(token, chatId, csEscapeMd_(title) + '\n\nНет pending событий\\.');
    return;
  }

  // Group by to_chief
  const byChief = {};
  for (const e of events) {
    if (!byChief[e.to_chief]) byChief[e.to_chief] = [];
    byChief[e.to_chief].push(e);
  }

  const chiefLabels = {
    wb_operations_chief: 'WB Operations',
    cs_operations_chief: 'Клиент-сервис',
    design_chief:        'Дизайн',
    rop_chief:           'РОП',
    procurement_chief:   'Закупки',
    fulfillment_chief:   'Фулфилмент',
    planner:             'Планнер',
    inbox_hub:           'Inbox Hub',
  };

  const lines = [`*${csEscapeMd_(title)}*\n`];
  for (const [chief, items] of Object.entries(byChief)) {
    lines.push(`→ *${csEscapeMd_(chiefLabels[chief] || chief)}* \\(${items.length}\\):`);
    for (const e of items.slice(0, 5)) {
      const icon = handoffPriorityIcon_(e.priority);
      lines.push(`${icon} ${csEscapeMd_(e.title)}`);
    }
    if (items.length > 5) lines.push(`_...ещё ${items.length - 5}_`);
    lines.push('');
  }

  // Send text
  await csSendTelegramMessage_(token, chatId, lines.join('\n'));

  // Send buttons for critical/high
  for (const e of events.filter(e => ['critical', 'high'].includes(e.priority)).slice(0, 5)) {
    const text = `${handoffPriorityIcon_(e.priority)} ${csEscapeMd_(e.title)}`;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: [[
            { text: '✅ Принять', callback_data: `hof_ack_${e.id}` },
            { text: '❌ Отклонить', callback_data: `hof_dismiss_${e.id}` },
          ]] },
        }),
      });
    } catch (_) {}
  }
}

async function routeHandoffTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();
  const token = env.TELEGRAM_BOT_TOKEN;
  const db = env.DB;

  if (!text.startsWith('/handoff')) return false;

  try {
    await ensureHandoffSchema_(db);
    await expireOldHandoffs_(db);

    if (text === '/handoffs') {
      const events = await getHandoffEvents_(db, null, HANDOFF_STATUS.PENDING, 50);
      await sendHandoffList_(token, chatId, events, 'Handoff-события');
      return true;
    }

    if (text === '/handoffs_wb') {
      const events = await getHandoffEvents_(db, HANDOFF_CHIEFS.WB_OPERATIONS, HANDOFF_STATUS.PENDING, 20);
      await sendHandoffList_(token, chatId, events, 'Handoffs → WB Operations');
      return true;
    }

    if (text === '/handoffs_cs') {
      const events = await getHandoffEvents_(db, HANDOFF_CHIEFS.CS_OPERATIONS, HANDOFF_STATUS.PENDING, 20);
      await sendHandoffList_(token, chatId, events, 'Handoffs → Клиент-сервис');
      return true;
    }
  } catch (e) {
    await csSendTelegramMessage_(token, chatId, `Ошибка: ${csEscapeMd_(String(e).slice(0, 200))}`);
    return true;
  }

  return false;
}

// ── Section 6: Callbacks ──────────────────────────────────────

async function routeHandoffCallbackQuery_(env, callbackQuery) {
  const data = callbackQuery?.data || '';
  if (!data.startsWith('hof_')) return false;

  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const userId = callbackQuery?.from?.id;

  const answerCallback = async (text) => {
    try {
      await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQuery.id, text: text || '', show_alert: false }),
      });
    } catch (_) {}
  };

  try {
    if (data.startsWith('hof_ack_')) {
      const id = data.replace('hof_ack_', '');
      const r = await acknowledgeHandoff_(db, id, String(userId || ''));
      await answerCallback(r.ok ? '✅ Принято в работу' : (r.error === 'already_final' ? 'Уже завершено' : 'Не найдено'));
      return true;
    }

    if (data.startsWith('hof_dismiss_')) {
      const id = data.replace('hof_dismiss_', '');
      await dismissHandoff_(db, id, 'dismissed via telegram button');
      await answerCallback('❌ Отклонено');
      return true;
    }

    if (data.startsWith('hof_done_')) {
      const id = data.replace('hof_done_', '');
      await resolveHandoff_(db, id);
      await answerCallback('✅ Выполнено');
      return true;
    }
  } catch (e) {
    await answerCallback('Ошибка');
  }

  return false;
}

// ── Section 7: API ────────────────────────────────────────────

async function handleHandoffRoutes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.DB;

  if (!path.startsWith('/agent/handoffs')) return null;

  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    await ensureHandoffSchema_(db);

    if (path === '/agent/handoffs' && request.method === 'GET') {
      const toChief = url.searchParams.get('to_chief') || null;
      const status  = url.searchParams.get('status') || null;
      const limit   = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const events  = await getHandoffEvents_(db, toChief, status, limit);
      return json({ ok: true, events, count: events.length });
    }

    if (path === '/agent/handoffs/stats' && request.method === 'GET') {
      const chiefs = Object.values(HANDOFF_CHIEFS);
      const statuses = Object.values(HANDOFF_STATUS);
      const stats = {};
      for (const chief of chiefs) {
        stats[chief] = {};
        for (const st of statuses) {
          try {
            const r = await db.prepare(
              `SELECT COUNT(*) as c FROM handoff_event WHERE to_chief=? AND status=?`
            ).bind(chief, st).first();
            stats[chief][st] = r?.c || 0;
          } catch (_) { stats[chief][st] = 0; }
        }
      }
      return json({ ok: true, stats });
    }

    if (path === '/agent/handoffs' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!body.from_chief || !body.to_chief || !body.handoff_type || !body.title) {
        return json({ ok: false, error: 'from_chief, to_chief, handoff_type, title required' }, 400);
      }
      const result = await createHandoffEvent_(db, body);
      return json({ ok: !!result.id, ...result });
    }

    const ackMatch = path.match(/^\/agent\/handoffs\/([^/]+)\/acknowledge$/);
    if (ackMatch && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const r = await acknowledgeHandoff_(db, ackMatch[1], body.user_id || 'api');
      return json(r);
    }

    const resolveMatch = path.match(/^\/agent\/handoffs\/([^/]+)\/resolve$/);
    if (resolveMatch && request.method === 'POST') {
      const r = await resolveHandoff_(db, resolveMatch[1]);
      return json(r);
    }

    const dismissMatch = path.match(/^\/agent\/handoffs\/([^/]+)\/dismiss$/);
    if (dismissMatch && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const r = await dismissHandoff_(db, dismissMatch[1], body.reason);
      return json(r);
    }

    if (path === '/agent/handoffs/expire' && request.method === 'POST') {
      const r = await expireOldHandoffs_(db);
      return json({ ok: true, ...r });
    }
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }

  return null;
}
/**
 * scheduler_v1.gs
 * ================
 * Cloudflare Worker scheduled() handler orchestrator.
 * Powers all automated daily/periodic agent triggers.
 *
 * Build: ai_helpers_scheduler_v1
 *
 * Add to wrangler.toml:
 * [triggers]
 * crons = [
 *   "0 3 * * *",   # proposal_cleanup
 *   "0 4 * * *",   # qa_daily
 *   "0 5 * * *",   # wb_daily_report
 *   "0 7 * * *",   # cs_daily_report
 *   "0 * * * *",   # proposals_check
 *   "0 6 * * 1",   # weekly_insights
 * ]
 */

// ---------------------------------------------------------------------------
// SECTION 1: Schedule configuration
// ---------------------------------------------------------------------------

const SCHEDULES = {
  // Daily WB Operations Chief at 05:00 UTC
  WB_DAILY_REPORT:      '0 5 * * *',
  // Daily Fulfillment Chief at 06:00 UTC (after WB, before CS)
  FULFILLMENT_DAILY:    '0 6 * * *',
  // Daily CS Chief at 07:00 UTC
  CS_DAILY_REPORT:      '0 7 * * *',
  // Daily ROP Chief at 08:00 UTC
  ROP_DAILY_REPORT:     '0 8 * * *',
  // Daily Design Chief at 09:00 UTC
  DESIGN_DAILY_REPORT:   '0 9 * * *',
  // Daily Procurement Chief at 10:00 UTC
  PROCUREMENT_DAILY:     '0 10 * * *',
  // Hourly pending proposals check (sends digest if >=5 pending)
  PROPOSALS_CHECK:      '0 * * * *',
  // Weekly insights on Monday 06:00 UTC — NOTE: conflicts with FULFILLMENT_DAILY on Monday
  // so weekly_insights runs at 06:30 on Mondays (use separate cron)
  WEEKLY_INSIGHTS:      '30 6 * * 1',
  // Daily QA check at 04:00 UTC (before reports run)
  QA_DAILY:             '0 4 * * *',
  // Proposal expiry cleanup at 03:00 UTC
  PROPOSAL_CLEANUP:     '0 3 * * *',
  // WB data sync at 04:30 UTC — after QA (04:00), before WB chief (05:00)
  WB_DATA_SYNC:         '30 4 * * *',
  // WB Pricing Advisor at 11:00 UTC — after all chiefs have processed data
  WB_PRICING_DAILY:     '0 11 * * *',
  // Alerts check at 05:30 UTC — after wb_data_sync and wb_daily_report
  ALERTS_CHECK:         '30 5 * * *',
};

// Map job names to their handler functions (populated below after function definitions)
const JOB_REGISTRY = {};

// ---------------------------------------------------------------------------
// SECTION 2: Schema bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensures scheduler tables exist in D1.
 * Safe to call on every cold start.
 */
async function ensureSchedulerSchema_(db) {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_run_log (
        id          TEXT PRIMARY KEY,
        job_name    TEXT NOT NULL,
        cron_expr   TEXT,
        status      TEXT DEFAULT 'running',
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        result_json TEXT DEFAULT '{}',
        error       TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_config (
        id                TEXT PRIMARY KEY,
        job_name          TEXT NOT NULL UNIQUE,
        enabled           INTEGER DEFAULT 1,
        notify_chat_id    TEXT,
        notify_on_error   INTEGER DEFAULT 1,
        notify_on_success INTEGER DEFAULT 0,
        last_run_at       TEXT,
        last_status       TEXT,
        created_at        TEXT DEFAULT (datetime('now')),
        updated_at        TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    // Schema errors are non-fatal at startup; individual jobs will fail gracefully
    try {
      await wbLog_(db, {
        event_type: 'scheduler_schema_error',
        details_json: JSON.stringify({ error: String(e) }),
      });
    } catch (_) { /* swallow */ }
  }
}

// ---------------------------------------------------------------------------
// SECTION 3: Telegram notification helper
// ---------------------------------------------------------------------------

/**
 * Sends a Telegram notification from the scheduler.
 * Failures are swallowed — notifications never break a job.
 */
async function sendSchedulerTelegramNotification_(env, chatId, jobName, status, details) {
  try {
    const text = `🤖 Планировщик: ${jobName}\nСтатус: ${status}\n${details}`;
    if (typeof csSendTelegramMessage_ === 'function') {
      await csSendTelegramMessage_(env.TELEGRAM_BOT_TOKEN, chatId, text);
    }
  } catch (_) { /* notification failures must not propagate */ }
}

// ---------------------------------------------------------------------------
// SECTION 3 (cont.): Job runner helper
// ---------------------------------------------------------------------------

/**
 * Wraps any async job function with:
 * - Run-log insertion (status='running')
 * - Success/failure UPDATE
 * - Optional Telegram notifications per scheduler_config
 * - scheduler_config last_run_at / last_status update
 *
 * Returns { ok, status, duration_ms, result }
 */
async function runScheduledJob_(env, jobName, cronExpr, jobFn) {
  const db = env.DB;
  const id = wbGenerateId_('sched');
  const startedAt = new Date().toISOString();
  let durationMs = 0;
  let status = 'failed';
  let result = null;
  let errorText = null;

  // Insert initial running row
  try {
    await db.prepare(
      `INSERT INTO scheduler_run_log (id, job_name, cron_expr, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`
    ).bind(id, jobName, cronExpr ?? null, startedAt).run();
  } catch (e) {
    try {
      await wbLog_(db, {
        event_type: 'scheduler_log_insert_error',
        details_json: JSON.stringify({ job_name: jobName, error: String(e) }),
      });
    } catch (_) { /* swallow */ }
  }

  // Execute the job
  const t0 = Date.now();
  try {
    result = await jobFn();
    durationMs = Date.now() - t0;
    status = 'ok';
  } catch (e) {
    durationMs = Date.now() - t0;
    status = 'failed';
    errorText = String(e);
  }

  const finishedAt = new Date().toISOString();

  // Update run log
  try {
    await db.prepare(
      `UPDATE scheduler_run_log
       SET status = ?, finished_at = ?, duration_ms = ?, result_json = ?, error = ?
       WHERE id = ?`
    ).bind(
      status,
      finishedAt,
      durationMs,
      JSON.stringify(result ?? {}),
      errorText,
      id
    ).run();
  } catch (e) {
    try {
      await wbLog_(db, {
        event_type: 'scheduler_log_update_error',
        details_json: JSON.stringify({ job_name: jobName, error: String(e) }),
      });
    } catch (_) { /* swallow */ }
  }

  // Load scheduler_config for notification settings
  let config = null;
  try {
    const row = await db.prepare(
      `SELECT * FROM scheduler_config WHERE job_name = ?`
    ).bind(jobName).first();
    config = row ?? null;
  } catch (_) { /* config load failure is non-fatal */ }

  // Send Telegram notification if configured
  if (config?.notify_chat_id) {
    const chatId = config.notify_chat_id;
    if (status === 'failed' && config.notify_on_error) {
      await sendSchedulerTelegramNotification_(
        env, chatId, jobName, 'failed',
        `Ошибка: ${errorText ?? 'unknown'}\nДлительность: ${durationMs}ms`
      );
    } else if (status === 'ok' && config.notify_on_success) {
      await sendSchedulerTelegramNotification_(
        env, chatId, jobName, 'ok',
        `Успешно завершено за ${durationMs}ms`
      );
    }
  }

  // Update scheduler_config last_run metadata
  try {
    await db.prepare(
      `UPDATE scheduler_config
       SET last_run_at = ?, last_status = ?, updated_at = ?
       WHERE job_name = ?`
    ).bind(finishedAt, status, finishedAt, jobName).run();
  } catch (_) { /* non-fatal */ }

  return { ok: status === 'ok', status, duration_ms: durationMs, result };
}

// ---------------------------------------------------------------------------
// SECTION 4: Individual job handlers
// ---------------------------------------------------------------------------

/**
 * WB daily operations chief report.
 */
async function runWbDailyReportJob_(env) {
  const db = env.DB;
  const date = wbYesterday_();
  let reportResult = null;

  // Load notify_chat_id for optional Telegram summary
  let notifyChatId = null;
  try {
    const cfg = await db.prepare(
      `SELECT notify_chat_id FROM scheduler_config WHERE job_name = ?`
    ).bind('wb_daily_report').first();
    notifyChatId = cfg?.notify_chat_id ?? null;
  } catch (_) { /* non-fatal */ }

  // Call WB Operations Chief if available
  try {
    if (typeof runWbOperationsChiefV2_ === 'function') {
      reportResult = await runWbOperationsChiefV2_(env, date, 'scheduled');
    }
  } catch (e) {
    await wbLog_(db, {
      event_type: 'wb_daily_report_error',
      details_json: JSON.stringify({ date, error: String(e) }),
    });
    throw e;
  }

  // Send Telegram summary if chat configured and we have a summary
  if (notifyChatId && reportResult?.summary) {
    await sendSchedulerTelegramNotification_(
      env, notifyChatId, 'wb_daily_report', 'ok',
      csEscapeMd_(String(reportResult.summary).slice(0, 500))
    );
  }

  // Run Ads Chief analysis in parallel (non-blocking)
  let adsResult = null;
  try {
    if (typeof runAdsChief_ === 'function') {
      adsResult = await runAdsChief_(env);
      // Surface waste alerts to notify chat if any
      if (notifyChatId && adsResult.wasted?.length > 0 && typeof sendTelegramMessage_ === 'function') {
        const wastedTotal = adsResult.wasted.reduce((s, w) => s + (w.total_spend || 0), 0);
        await sendTelegramMessage_(env, notifyChatId,
          `⚠️ Реклама: ${adsResult.wasted.length} кампаний сливают бюджет (${Math.round(wastedTotal)} ₽ без заказов)\n/ads_waste — детали`,
          {}
        );
      }
    }
  } catch (_) {
    // Ads failure must not block main WB report
  }

  return {
    date: wbFormatDate_(date),
    status: reportResult?.status ?? 'completed',
    summary_preview: String(reportResult?.summary ?? '').slice(0, 200),
    ads_campaigns: adsResult?.campaigns?.length ?? 0,
    ads_wasted: adsResult?.wasted?.length ?? 0,
  };
}

/**
 * CS daily operations chief report.
 */
async function runCsDailyReportJob_(env) {
  const db = env.DB;
  const date = wbYesterday_();
  let reportResult = null;

  // Load notify_chat_id
  let notifyChatId = null;
  try {
    const cfg = await db.prepare(
      `SELECT notify_chat_id FROM scheduler_config WHERE job_name = ?`
    ).bind('cs_daily_report').first();
    notifyChatId = cfg?.notify_chat_id ?? null;
  } catch (_) { /* non-fatal */ }

  // Call CS Operations Chief if available
  try {
    if (typeof runCsOperationsChiefV2_ === 'function') {
      reportResult = await runCsOperationsChiefV2_(env, date, 'scheduled');
    }
  } catch (e) {
    await wbLog_(db, {
      event_type: 'cs_daily_report_error',
      details_json: JSON.stringify({ date, error: String(e) }),
    });
    throw e;
  }

  // Send Telegram summary if chat configured
  if (notifyChatId && reportResult?.summary) {
    await sendSchedulerTelegramNotification_(
      env, notifyChatId, 'cs_daily_report', 'ok',
      csEscapeMd_(String(reportResult.summary).slice(0, 500))
    );
  }

  return {
    date: wbFormatDate_(date),
    status: reportResult?.status ?? 'completed',
    drafts_created: reportResult?.drafts_created ?? 0,
    reviews_loaded: reportResult?.reviews_loaded ?? 0,
  };
}

/**
 * Hourly pending proposals check — sends digest if >=5 pending.
 */
async function runProposalsCheckJob_(env) {
  const db = env.DB;
  let notifyChatId = null;

  try {
    const cfg = await db.prepare(
      `SELECT notify_chat_id FROM scheduler_config WHERE job_name = ?`
    ).bind('proposals_check').first();
    notifyChatId = cfg?.notify_chat_id ?? null;
  } catch (_) { /* non-fatal */ }

  let totalPending = 0;
  let digestSent = false;

  try {
    if (typeof getAllPendingProposals_ === 'function') {
      const proposals = await getAllPendingProposals_(db, null); // null = all users
      totalPending = Array.isArray(proposals) ? proposals.length : 0;

      if (totalPending >= 5 && notifyChatId) {
        if (typeof sendApprovalDigest_ === 'function') {
          await sendApprovalDigest_(env, notifyChatId, null);
          digestSent = true;
        }
      }
    }
  } catch (e) {
    await wbLog_(db, {
      event_type: 'proposals_check_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }

  return { total_pending: totalPending, digest_sent: digestSent };
}

/**
 * Weekly insights review for all enabled users.
 */
async function runWeeklyInsightsJob_(env) {
  const db = env.DB;
  let usersProcessed = 0;
  const errors = [];

  let users = [];
  try {
    const { results } = await db.prepare(
      `SELECT user_id, chat_id FROM agent_settings WHERE agent_enabled = 1 AND chat_id IS NOT NULL`
    ).all();
    users = results ?? [];
  } catch (e) {
    await wbLog_(db, {
      event_type: 'weekly_insights_users_load_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }

  for (const user of users) {
    try {
      if (typeof runWeeklyInsightsReview_ === 'function') {
        await runWeeklyInsightsReview_(env, user.user_id, user.chat_id);
        usersProcessed++;
      }
    } catch (e) {
      errors.push({ user_id: user.user_id, error: String(e) });
      try {
        await wbLog_(db, {
          event_type: 'weekly_insights_user_error',
          details_json: JSON.stringify({ user_id: user.user_id, error: String(e) }),
        });
      } catch (_) { /* swallow */ }
    }
  }

  // Also run WB weekly analytics and send summary to notify chat
  let analyticsResult = null;
  try {
    if (typeof runWbWeeklyAnalytics_ === 'function') {
      analyticsResult = await runWbWeeklyAnalytics_(env);

      // Send Telegram summary to the first configured notify chat
      const cfg = await db.prepare(
        `SELECT notify_chat_id FROM scheduler_config WHERE notify_chat_id IS NOT NULL LIMIT 1`
      ).first().catch(() => null);

      if (cfg?.notify_chat_id && typeof sendTelegramMessage_ === 'function') {
        const text = typeof formatAnalyticsForTelegram_ === 'function'
          ? formatAnalyticsForTelegram_(analyticsResult)
          : `📊 Аналитика недели готова (выручка ${analyticsResult.revenue_cur || 0} ₽)`;
        await sendTelegramMessage_(env, cfg.notify_chat_id, text, { parse_mode: 'Markdown' });
      }
    }
  } catch (_) {
    // Analytics failure must not block the weekly insights run
  }

  return { users_processed: usersProcessed, errors, analytics: analyticsResult ? 'ok' : 'skipped' };
}

/**
 * Daily QA check — alerts on failure.
 */
async function runQaDailyJob_(env) {
  const db = env.DB;
  let qaResult = null;

  try {
    if (typeof runFullQaCheck_ === 'function') {
      qaResult = await runFullQaCheck_(env);
    }
  } catch (e) {
    await wbLog_(db, {
      event_type: 'qa_daily_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }

  // Alert on failure
  if (qaResult?.overall_status === 'failed') {
    let notifyChatId = null;
    try {
      const cfg = await db.prepare(
        `SELECT notify_chat_id FROM scheduler_config WHERE job_name = ?`
      ).bind('qa_daily').first();
      notifyChatId = cfg?.notify_chat_id ?? null;
    } catch (_) { /* non-fatal */ }

    if (notifyChatId) {
      await sendSchedulerTelegramNotification_(
        env, notifyChatId, 'qa_daily', 'failed',
        `QA провалился: ${qaResult?.summary ?? 'см. логи'}`
      );
    }
  }

  return {
    overall_status: qaResult?.overall_status ?? 'unknown',
    checks_passed: qaResult?.checks_passed ?? 0,
    checks_failed: qaResult?.checks_failed ?? 0,
    summary: qaResult?.summary ?? '',
  };
}

/**
 * Proposal expiry cleanup.
 */
async function runProposalCleanupJob_(env) {
  const db = env.DB;
  let expiredCount = 0;

  try {
    if (typeof markProposalsExpired_ === 'function') {
      const result = await markProposalsExpired_(db);
      expiredCount = result?.expired_count ?? (typeof result === 'number' ? result : 0);
    }
  } catch (e) {
    await wbLog_(db, {
      event_type: 'proposal_cleanup_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }

  return { expired_count: expiredCount };
}

async function runFulfillmentDailyJob_(env) {
  try {
    if (typeof runFulfillmentChief_ === 'function') {
      return await runFulfillmentChief_(env);
    }
    return { status: 'skipped', reason: 'runFulfillmentChief_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'fulfillment_daily_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

async function runRopDailyJob_(env) {
  try {
    if (typeof runRopChief_ === 'function') {
      return await runRopChief_(env);
    }
    return { status: 'skipped', reason: 'runRopChief_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'rop_daily_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

async function runDesignDailyJob_(env) {
  try {
    if (typeof runDesignChief_ === 'function') {
      return await runDesignChief_(env);
    }
    return { status: 'skipped', reason: 'runDesignChief_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'design_daily_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

async function runProcurementDailyJob_(env) {
  try {
    if (typeof runProcurementChief_ === 'function') {
      return await runProcurementChief_(env);
    }
    return { status: 'skipped', reason: 'runProcurementChief_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'procurement_daily_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

async function runAlertsCheckJob_(env) {
  try {
    if (typeof runAllAlerts_ === 'function') {
      return await runAllAlerts_(env);
    }
    return { status: 'skipped', reason: 'runAllAlerts_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'alerts_check_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

async function runWbPricingDailyJob_(env) {
  try {
    if (typeof runPricingChief_ === 'function') {
      return await runPricingChief_(env);
    }
    return { status: 'skipped', reason: 'runPricingChief_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'wb_pricing_daily_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

async function runWbDataSyncCronJob_(env) {
  try {
    if (typeof runWbSyncJob_ === 'function') {
      return await runWbSyncJob_(env);
    }
    return { status: 'skipped', reason: 'runWbSyncJob_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'wb_data_sync_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

// Populate job registry after all handlers are defined
Object.assign(JOB_REGISTRY, {
  wb_daily_report:     (env) => runWbDailyReportJob_(env),
  fulfillment_daily:   (env) => runFulfillmentDailyJob_(env),
  cs_daily_report:     (env) => runCsDailyReportJob_(env),
  rop_daily_report:    (env) => runRopDailyJob_(env),
  design_daily_report: (env) => runDesignDailyJob_(env),
  procurement_daily:   (env) => runProcurementDailyJob_(env),
  proposals_check:     (env) => runProposalsCheckJob_(env),
  weekly_insights:     (env) => runWeeklyInsightsJob_(env),
  qa_daily:            (env) => runQaDailyJob_(env),
  proposal_cleanup:    (env) => runProposalCleanupJob_(env),
  wb_data_sync:        (env) => runWbDataSyncCronJob_(env),
  wb_pricing_daily:    (env) => runWbPricingDailyJob_(env),
  alerts_check:        (env) => runAlertsCheckJob_(env),
});

// Map SCHEDULES cron strings to their canonical job names
const CRON_TO_JOB = {
  [SCHEDULES.WB_DAILY_REPORT]:     'wb_daily_report',
  [SCHEDULES.FULFILLMENT_DAILY]:   'fulfillment_daily',
  [SCHEDULES.CS_DAILY_REPORT]:     'cs_daily_report',
  [SCHEDULES.ROP_DAILY_REPORT]:    'rop_daily_report',
  [SCHEDULES.DESIGN_DAILY_REPORT]: 'design_daily_report',
  [SCHEDULES.PROCUREMENT_DAILY]:   'procurement_daily',
  [SCHEDULES.PROPOSALS_CHECK]:     'proposals_check',
  [SCHEDULES.WEEKLY_INSIGHTS]:     'weekly_insights',
  [SCHEDULES.QA_DAILY]:            'qa_daily',
  [SCHEDULES.PROPOSAL_CLEANUP]:    'proposal_cleanup',
  [SCHEDULES.WB_DATA_SYNC]:        'wb_data_sync',
  [SCHEDULES.WB_PRICING_DAILY]:    'wb_pricing_daily',
  [SCHEDULES.ALERTS_CHECK]:        'alerts_check',
};

// ---------------------------------------------------------------------------
// SECTION 5: Main scheduled() dispatcher
// ---------------------------------------------------------------------------

/**
 * Entry point called from worker.js scheduled() handler.
 *
 * Usage in worker.js:
 *   export default {
 *     async scheduled(event, env, ctx) {
 *       await handleScheduledEvent_(event, env, ctx);
 *     }
 *   };
 */
async function handleScheduledEvent_(event, env, ctx) {
  await ensureSchedulerSchema_(env.DB);

  switch (event.cron) {
    case SCHEDULES.QA_DAILY:
      ctx.waitUntil(
        runScheduledJob_(env, 'qa_daily', event.cron, () => runQaDailyJob_(env))
      );
      break;

    case SCHEDULES.PROPOSAL_CLEANUP:
      ctx.waitUntil(
        runScheduledJob_(env, 'proposal_cleanup', event.cron, () => runProposalCleanupJob_(env))
      );
      break;

    case SCHEDULES.WB_DAILY_REPORT:
      ctx.waitUntil(
        runScheduledJob_(env, 'wb_daily_report', event.cron, () => runWbDailyReportJob_(env))
      );
      break;

    case SCHEDULES.FULFILLMENT_DAILY:
      ctx.waitUntil(
        runScheduledJob_(env, 'fulfillment_daily', event.cron, () => runFulfillmentDailyJob_(env))
      );
      break;

    case SCHEDULES.CS_DAILY_REPORT:
      ctx.waitUntil(
        runScheduledJob_(env, 'cs_daily_report', event.cron, () => runCsDailyReportJob_(env))
      );
      break;

    case SCHEDULES.ROP_DAILY_REPORT:
      ctx.waitUntil(
        runScheduledJob_(env, 'rop_daily_report', event.cron, () => runRopDailyJob_(env))
      );
      break;

    case SCHEDULES.DESIGN_DAILY_REPORT:
      ctx.waitUntil(
        runScheduledJob_(env, 'design_daily_report', event.cron, () => runDesignDailyJob_(env))
      );
      break;

    case SCHEDULES.PROCUREMENT_DAILY:
      ctx.waitUntil(
        runScheduledJob_(env, 'procurement_daily', event.cron, () => runProcurementDailyJob_(env))
      );
      break;

    case SCHEDULES.PROPOSALS_CHECK:
      ctx.waitUntil(
        runScheduledJob_(env, 'proposals_check', event.cron, () => runProposalsCheckJob_(env))
      );
      break;

    case SCHEDULES.WEEKLY_INSIGHTS:
      ctx.waitUntil(
        runScheduledJob_(env, 'weekly_insights', event.cron, () => runWeeklyInsightsJob_(env))
      );
      break;

    case SCHEDULES.WB_DATA_SYNC:
      ctx.waitUntil(
        runScheduledJob_(env, 'wb_data_sync', event.cron, () => runWbDataSyncCronJob_(env))
      );
      break;

    case SCHEDULES.WB_PRICING_DAILY:
      ctx.waitUntil(
        runScheduledJob_(env, 'wb_pricing_daily', event.cron, () => runWbPricingDailyJob_(env))
      );
      break;

    case SCHEDULES.ALERTS_CHECK:
      ctx.waitUntil(
        runScheduledJob_(env, 'alerts_check', event.cron, () => runAlertsCheckJob_(env))
      );
      break;

    default:
      // Unknown cron — log and continue without throwing
      try {
        await wbLog_(env.DB, {
          event_type: 'scheduler_unknown_cron',
          details_json: JSON.stringify({ cron: event.cron }),
        });
      } catch (_) { /* swallow */ }
  }
}

// ---------------------------------------------------------------------------
// SECTION 6: Telegram command router
// ---------------------------------------------------------------------------

/**
 * Handles scheduler-related Telegram commands.
 * Returns true if command was handled, false otherwise.
 */
async function routeSchedulerTelegramCommand_(env, msg, chatId, userId) {
  const db = env.DB;
  const text = (msg?.text ?? '').trim();

  // /scheduler_status — show all job statuses
  if (text === '/scheduler_status') {
    let reply = '🤖 Планировщик\n\n';
    try {
      const { results } = await db.prepare(
        `SELECT job_name, last_run_at, last_status, enabled
         FROM scheduler_config ORDER BY job_name`
      ).all();

      if (!results?.length) {
        reply += 'Нет данных о заданиях.';
      } else {
        for (const row of results) {
          const icon = row.last_status === 'ok' ? '✅' :
                       row.last_status === 'failed' ? '❌' :
                       row.last_status === 'partial' ? '⚠️' : '❓';
          const when = row.last_run_at
            ? new Date(row.last_run_at).toLocaleString('ru-RU', { timeZone: 'UTC' })
            : 'никогда';
          const disabled = row.enabled ? '' : ' [выкл]';
          reply += `${row.job_name}: ${icon} ${row.last_status ?? '?'} (${when})${disabled}\n`;
        }
      }
    } catch (e) {
      reply += `Ошибка загрузки статуса: ${String(e)}`;
    }

    try {
      if (typeof csSendTelegramMessage_ === 'function') {
        await csSendTelegramMessage_(env.TELEGRAM_BOT_TOKEN, chatId, reply);
      }
    } catch (_) { /* swallow */ }
    return true;
  }

  // /scheduler_run <job_name> — manual trigger (admin-only if ADMIN_TELEGRAM_ID set)
  if (text.startsWith('/scheduler_run')) {
    const parts = text.split(/\s+/);
    const jobName = parts[1] ?? '';

    // Admin check
    if (env.ADMIN_TELEGRAM_ID && String(userId) !== String(env.ADMIN_TELEGRAM_ID)) {
      try {
        if (typeof csSendTelegramMessage_ === 'function') {
          await csSendTelegramMessage_(env.TELEGRAM_BOT_TOKEN, chatId, '⛔ Доступ запрещён.');
        }
      } catch (_) { /* swallow */ }
      return true;
    }

    if (!jobName || !JOB_REGISTRY[jobName]) {
      const knownJobs = Object.keys(JOB_REGISTRY).join(', ');
      try {
        if (typeof csSendTelegramMessage_ === 'function') {
          await csSendTelegramMessage_(
            env.TELEGRAM_BOT_TOKEN, chatId,
            `❓ Неизвестное задание: "${jobName}"\nДоступные: ${knownJobs}`
          );
        }
      } catch (_) { /* swallow */ }
      return true;
    }

    // Run immediately
    let runResult;
    try {
      runResult = await runScheduledJob_(env, jobName, 'manual', () => JOB_REGISTRY[jobName](env));
    } catch (e) {
      runResult = { ok: false, status: 'failed', error: String(e) };
    }

    const icon = runResult.ok ? '✅' : '❌';
    const replyText = `${icon} Задание ${jobName}\nСтатус: ${runResult.status}\nДлительность: ${runResult.duration_ms ?? '?'}ms\n${JSON.stringify(runResult.result ?? {}, null, 2).slice(0, 300)}`;
    try {
      if (typeof csSendTelegramMessage_ === 'function') {
        await csSendTelegramMessage_(env.TELEGRAM_BOT_TOKEN, chatId, replyText);
      }
    } catch (_) { /* swallow */ }
    return true;
  }

  // /scheduler_logs — last 10 runs
  if (text === '/scheduler_logs') {
    let reply = '📋 Последние запуски планировщика\n\n';
    try {
      const { results } = await db.prepare(
        `SELECT job_name, status, started_at, duration_ms, error
         FROM scheduler_run_log ORDER BY started_at DESC LIMIT 10`
      ).all();

      if (!results?.length) {
        reply += 'Нет записей.';
      } else {
        for (const row of results) {
          const icon = row.status === 'ok' ? '✅' : row.status === 'failed' ? '❌' : '⚠️';
          const when = new Date(row.started_at).toLocaleString('ru-RU', { timeZone: 'UTC' });
          const duration = row.duration_ms != null ? ` ${row.duration_ms}ms` : '';
          const err = row.error ? ` — ${String(row.error).slice(0, 60)}` : '';
          reply += `${icon} ${row.job_name} (${when})${duration}${err}\n`;
        }
      }
    } catch (e) {
      reply += `Ошибка: ${String(e)}`;
    }

    try {
      if (typeof csSendTelegramMessage_ === 'function') {
        await csSendTelegramMessage_(env.TELEGRAM_BOT_TOKEN, chatId, reply);
      }
    } catch (_) { /* swallow */ }
    return true;
  }

  return false; // command not handled
}

// ---------------------------------------------------------------------------
// SECTION 7: API routes
// ---------------------------------------------------------------------------

/**
 * Handles /agent/scheduler/* HTTP routes.
 * Returns a Response, or null if the path is not matched.
 */
async function handleSchedulerRoutes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.DB;

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  // GET /agent/scheduler/status
  if (request.method === 'GET' && path === '/agent/scheduler/status') {
    try {
      const { results } = await db.prepare(
        `SELECT * FROM scheduler_config ORDER BY job_name`
      ).all();
      return json({ ok: true, jobs: results ?? [] });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  // GET /agent/scheduler/logs?job_name=&limit=20
  if (request.method === 'GET' && path === '/agent/scheduler/logs') {
    try {
      const jobNameFilter = url.searchParams.get('job_name') ?? null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);

      let stmt;
      if (jobNameFilter) {
        stmt = db.prepare(
          `SELECT * FROM scheduler_run_log WHERE job_name = ? ORDER BY started_at DESC LIMIT ?`
        ).bind(jobNameFilter, limit);
      } else {
        stmt = db.prepare(
          `SELECT * FROM scheduler_run_log ORDER BY started_at DESC LIMIT ?`
        ).bind(limit);
      }

      const { results } = await stmt.all();
      return json({ ok: true, logs: results ?? [] });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  // POST /agent/scheduler/run
  if (request.method === 'POST' && path === '/agent/scheduler/run') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const jobName = body?.job_name ?? '';
    if (!jobName || !JOB_REGISTRY[jobName]) {
      return json({ ok: false, error: `Unknown job_name: "${jobName}"`, known: Object.keys(JOB_REGISTRY) }, 400);
    }

    let runResult;
    try {
      runResult = await runScheduledJob_(env, jobName, 'api_manual', () => JOB_REGISTRY[jobName](env));
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }

    return json({ ok: runResult.ok, ...runResult });
  }

  // POST /agent/scheduler/config
  if (request.method === 'POST' && path === '/agent/scheduler/config') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const { job_name, enabled, notify_chat_id, notify_on_error, notify_on_success } = body ?? {};
    if (!job_name) {
      return json({ ok: false, error: 'job_name is required' }, 400);
    }

    try {
      const now = new Date().toISOString();
      const id = wbGenerateId_('scfg');

      await db.prepare(`
        INSERT INTO scheduler_config
          (id, job_name, enabled, notify_chat_id, notify_on_error, notify_on_success, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_name) DO UPDATE SET
          enabled           = excluded.enabled,
          notify_chat_id    = excluded.notify_chat_id,
          notify_on_error   = excluded.notify_on_error,
          notify_on_success = excluded.notify_on_success,
          updated_at        = excluded.updated_at
      `).bind(
        id,
        job_name,
        enabled != null ? (enabled ? 1 : 0) : 1,
        notify_chat_id ?? null,
        notify_on_error != null ? (notify_on_error ? 1 : 0) : 1,
        notify_on_success != null ? (notify_on_success ? 1 : 0) : 0,
        now,
        now
      ).run();

      const updated = await db.prepare(
        `SELECT * FROM scheduler_config WHERE job_name = ?`
      ).bind(job_name).first();

      return json({ ok: true, config: updated });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  return null; // route not matched
}
// ============================================================
// Design Chief — AI модуль управления дизайном карточек (v1)
// Build: ai_helpers_design_chief_v1
//
// Получает handoff-события от других шефов:
//   card_content_gap  ← WB Operations Chief
//   rating_drop       ← CS Operations Chief
//
// ── Таблицы ─────────────────────────────────────────────────
//   design_handoff_item   — задачи дизайна из handoff-событий
//   design_card_snapshot  — снэпшоты карточек товаров (0-100)
//   design_content_plan   — планы контента, ожидающие подтверждения
//
// ── Субагенты ───────────────────────────────────────────────
//   runCardContentAnalyzerAgent_  — оценка карточки 0-100
//   runSeoAnalyzerAgent_          — анализ SEO-пробелов
//   runContentGapFinderAgent_     — приоритизация SKU по handoffs
//
// ── Telegram-команды ────────────────────────────────────────
//   /design | /design_report — запустить шефа, показать сводку
//   /design_handoffs          — pending задачи дизайна
//   /design_plan              — контент-план (ожидают подтверждения)
//
// ── Callbacks ───────────────────────────────────────────────
//   design_confirm_<id>  — подтвердить пункт контент-плана
//   design_skip_<id>     — отклонить пункт контент-плана
//
// ── API-маршруты ────────────────────────────────────────────
//   GET  /agent/design/handoffs
//   GET  /agent/design/plan
//   POST /agent/design/report/run
//   GET  /agent/design/card/:nm_id
//
// Правила безопасности:
//   - НИКОГДА не публиковать изменения карточек автоматически
//   - НИКОГДА не отправлять ТЗ дизайнерам без подтверждения человека
//   - Все рискованные действия: requires_confirmation: true
//   - Все предложения имеют confirmation_id
//   - НИКОГДА не считать «нет данных» нулём
//   - Всегда выводить source_status: 'missing' если данных нет
//
// Зависимости (всегда загружаются до):
//   wbGenerateId_(), wbLog_(), wbYesterday_(), wbFormatDate_(),
//   wbRound_(), csCallAi_(), csEscapeMd_(), csSendTelegramMessage_(),
//   csSafeText_(), ensureHandoffSchema_(), getHandoffEvents_(),
//   acknowledgeHandoff_(), HANDOFF_CHIEFS, HANDOFF_STATUS, HANDOFF_TYPE
// ============================================================

const DESIGN_BUILD = 'ai_helpers_design_chief_v1';

// ============================================================
// SECTION 1 — Schema
// ============================================================

async function ensureDesignSchema_(db) {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS design_handoff_item (
      id TEXT PRIMARY KEY,
      handoff_event_id TEXT,
      nm_id INTEGER,
      vendor_code TEXT,
      sku_title TEXT,
      issue_type TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'pending',
      evidence_json TEXT DEFAULT '[]',
      proposed_changes_json TEXT DEFAULT '{}',
      confirmation_id TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      confirmed_at TEXT,
      confirmed_by TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`).run();
  } catch (_) {}

  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS design_card_snapshot (
      id TEXT PRIMARY KEY,
      snapshot_date TEXT NOT NULL,
      nm_id INTEGER NOT NULL,
      vendor_code TEXT,
      sku_title TEXT,
      title_length INTEGER DEFAULT 0,
      description_length INTEGER DEFAULT 0,
      photos_count INTEGER DEFAULT 0,
      characteristics_count INTEGER DEFAULT 0,
      has_video INTEGER DEFAULT 0,
      title_keywords_json TEXT DEFAULT '[]',
      issues_found_json TEXT DEFAULT '[]',
      overall_score INTEGER DEFAULT 0,
      source_status TEXT DEFAULT 'missing',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(snapshot_date, nm_id)
    )`).run();
  } catch (_) {}

  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS design_content_plan (
      id TEXT PRIMARY KEY,
      plan_date TEXT NOT NULL,
      nm_id INTEGER NOT NULL,
      vendor_code TEXT,
      sku_title TEXT,
      priority TEXT DEFAULT 'medium',
      issue_type TEXT,
      current_state_json TEXT DEFAULT '{}',
      proposed_action TEXT,
      ai_draft TEXT,
      status TEXT DEFAULT 'pending',
      confirmation_id TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      confirmed_at TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`).run();
  } catch (_) {}

  for (const sql of [
    `CREATE INDEX IF NOT EXISTS idx_design_handoff_status ON design_handoff_item(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_design_handoff_nm ON design_handoff_item(nm_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_design_snapshot_date ON design_card_snapshot(snapshot_date, nm_id)`,
    `CREATE INDEX IF NOT EXISTS idx_design_plan_status ON design_content_plan(status, plan_date DESC)`,
  ]) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
}

// ============================================================
// SECTION 2 — AI Helper
// ============================================================

async function callDesignAi_(env, prompt, maxTokens) {
  const max = maxTokens || 512;

  // Try Gemini
  if (env.GEMINI_API_KEY) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: max, temperature: 0.4 },
          }),
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { ok: true, text: text.trim(), source: 'gemini' };
      }
    } catch (_) {}
  }

  // Fallback: Groq
  if (env.GROQ_API_KEY) {
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: max,
          temperature: 0.4,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return { ok: true, text: text.trim(), source: 'groq' };
      }
    } catch (_) {}
  }

  // Static fallback
  return { ok: false, text: null, source: 'static' };
}

// ============================================================
// SECTION 3 — Handoff Processing
// ============================================================

async function processDesignHandoffs_(db) {
  let processed = 0;
  let skipped = 0;

  try {
    const rows = await db.prepare(
      `SELECT * FROM handoff_event
       WHERE to_chief='design_chief' AND status='pending'
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY created_at ASC LIMIT 50`
    ).all();

    const events = rows.results || [];

    for (const evt of events) {
      try {
        const existing = await db.prepare(
          `SELECT id FROM design_handoff_item WHERE handoff_event_id=?`
        ).bind(evt.id).first();

        if (existing) { skipped++; continue; }

        const issueType = designIssueTypeFromHandoff_(evt.handoff_type, evt.payload_json);
        const itemId = designGenerateId_('dhoi');
        const confirmId = designBuildConfirmationId_(evt.nm_id || 'noid', issueType);
        const now = new Date().toISOString();

        let evidence = [];
        try { evidence = JSON.parse(evt.evidence_json || '[]'); } catch (_) {}

        await db.prepare(`INSERT OR IGNORE INTO design_handoff_item
          (id, handoff_event_id, nm_id, vendor_code, sku_title, issue_type,
           priority, status, evidence_json, proposed_changes_json,
           confirmation_id, requires_confirmation, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).bind(
          itemId, evt.id,
          evt.nm_id || null,
          evt.vendor_code || null,
          evt.sku_title || null,
          issueType,
          evt.priority || 'medium',
          'pending',
          JSON.stringify(evidence),
          '{}',
          confirmId,
          now, now
        ).run();

        await db.prepare(
          `UPDATE handoff_event SET status='acknowledged', acknowledged_at=datetime('now'),
           acknowledged_by='design_chief', updated_at=datetime('now') WHERE id=?`
        ).bind(evt.id).run();

        processed++;
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'design', entity_id: evt.id,
          action: 'process_handoff_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'process_handoffs',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return { processed, skipped };
}

function designIssueTypeFromHandoff_(handoffType, payloadJson) {
  if (handoffType === 'card_content_gap') return 'card_content_gap';
  if (handoffType === 'rating_drop') return 'rating_content';
  if (handoffType === 'seo_gap') return 'seo_gap';

  let payload = {};
  try { payload = JSON.parse(payloadJson || '{}'); } catch (_) {}

  if (payload.issue_type === 'photo_gap') return 'photo_gap';
  if (payload.issue_type === 'seo_gap') return 'seo_gap';

  return 'card_content_gap';
}

function designGenerateId_(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

function designBuildConfirmationId_(nmId, action) {
  const ts = Date.now().toString(36);
  return `design_${action}_${nmId}_${ts}`;
}

// ============================================================
// SECTION 4 — Card Content Analyzer Agent
// ============================================================

const DESIGN_CARD_SCORE_WEIGHTS = {
  title_length:            20,
  description_length:      20,
  photos_count:            25,
  characteristics_count:   20,
  has_video:               15,
};

function scoreCard_(card) {
  let score = 0;
  const issues = [];

  // Title (min 40 chars for good score)
  const titleLen = card.title_length || 0;
  if (titleLen >= 80) {
    score += DESIGN_CARD_SCORE_WEIGHTS.title_length;
  } else if (titleLen >= 40) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.title_length * 0.6);
    issues.push('Заголовок короткий — менее 80 символов');
  } else if (titleLen > 0) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.title_length * 0.2);
    issues.push('Заголовок очень короткий — менее 40 символов');
  } else {
    issues.push('Заголовок отсутствует');
  }

  // Description (min 200 chars)
  const descLen = card.description_length || 0;
  if (descLen >= 500) {
    score += DESIGN_CARD_SCORE_WEIGHTS.description_length;
  } else if (descLen >= 200) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.description_length * 0.6);
    issues.push('Описание короткое — менее 500 символов');
  } else if (descLen > 0) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.description_length * 0.2);
    issues.push('Описание очень короткое — менее 200 символов');
  } else {
    issues.push('Описание отсутствует');
  }

  // Photos (min 5 recommended, 8 ideal)
  const photos = card.photos_count || 0;
  if (photos >= 8) {
    score += DESIGN_CARD_SCORE_WEIGHTS.photos_count;
  } else if (photos >= 5) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.photos_count * 0.7);
    issues.push('Менее 8 фотографий');
  } else if (photos >= 2) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.photos_count * 0.3);
    issues.push(`Мало фотографий — только ${photos}`);
  } else if (photos === 1) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.photos_count * 0.1);
    issues.push('Только одна фотография');
  } else {
    issues.push('Фотографии отсутствуют');
  }

  // Characteristics (min 5)
  const chars = card.characteristics_count || 0;
  if (chars >= 10) {
    score += DESIGN_CARD_SCORE_WEIGHTS.characteristics_count;
  } else if (chars >= 5) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.characteristics_count * 0.6);
    issues.push('Менее 10 характеристик');
  } else if (chars > 0) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.characteristics_count * 0.2);
    issues.push(`Мало характеристик — только ${chars}`);
  } else {
    issues.push('Характеристики не заполнены');
  }

  // Video
  if (card.has_video) {
    score += DESIGN_CARD_SCORE_WEIGHTS.has_video;
  } else {
    issues.push('Нет видео');
  }

  return { score: Math.min(100, Math.max(0, score)), issues };
}

async function runCardContentAnalyzerAgent_(env, db, date) {
  const result = {
    date,
    items_analyzed: 0,
    snapshots_saved: 0,
    avg_score: null,
    low_score_count: 0,
    source_status: 'missing',
  };

  try {
    const rows = await db.prepare(
      `SELECT DISTINCT nm_id, vendor_code, sku_title, priority, evidence_json
       FROM design_handoff_item
       WHERE status IN ('pending','in_progress')
       ORDER BY created_at ASC LIMIT 100`
    ).all();

    const items = rows.results || [];
    if (items.length === 0) {
      result.source_status = 'missing';
      return result;
    }

    result.source_status = 'ok';
    let totalScore = 0;
    let scored = 0;

    for (const item of items) {
      try {
        let evidence = [];
        try { evidence = JSON.parse(item.evidence_json || '[]'); } catch (_) {}

        // Build card data from evidence (since no direct WB card API here)
        const cardData = extractCardDataFromEvidence_(evidence, item);

        const { score, issues } = scoreCard_(cardData);

        const snapshotId = designGenerateId_('dcs');
        const now = new Date().toISOString();

        await db.prepare(`INSERT OR REPLACE INTO design_card_snapshot
          (id, snapshot_date, nm_id, vendor_code, sku_title,
           title_length, description_length, photos_count,
           characteristics_count, has_video,
           title_keywords_json, issues_found_json, overall_score, source_status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          snapshotId, date,
          item.nm_id || 0,
          item.vendor_code || null,
          item.sku_title || null,
          cardData.title_length,
          cardData.description_length,
          cardData.photos_count,
          cardData.characteristics_count,
          cardData.has_video ? 1 : 0,
          JSON.stringify(cardData.title_keywords || []),
          JSON.stringify(issues),
          score,
          'ok',
          now
        ).run();

        result.snapshots_saved++;
        totalScore += score;
        scored++;
        if (score < 50) result.low_score_count++;

        result.items_analyzed++;
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'design', entity_id: String(item.nm_id || 'unknown'),
          action: 'card_analyzer_item_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }

    result.avg_score = scored > 0 ? Math.round(totalScore / scored) : null;
  } catch (e) {
    result.source_status = 'error';
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'card_analyzer',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

function extractCardDataFromEvidence_(evidence, item) {
  const card = {
    title_length: 0,
    description_length: 0,
    photos_count: 0,
    characteristics_count: 0,
    has_video: false,
    title_keywords: [],
  };

  for (const ev of evidence) {
    const s = String(ev || '').toLowerCase();
    const numMatch = s.match(/(\d+)/);
    const num = numMatch ? parseInt(numMatch[1], 10) : 0;

    if (/фото|фотограф|photo/.test(s) && num > 0) card.photos_count = num;
    if (/характеристик/.test(s) && num > 0) card.characteristics_count = num;
    if (/описание.*символ|символ.*описани/.test(s) && num > 0) card.description_length = num;
    if (/заголовок.*символ|title.*char/.test(s) && num > 0) card.title_length = num;
    if (/видео|video/.test(s)) card.has_video = true;
  }

  // Use sku_title length as fallback for title_length
  if (card.title_length === 0 && item.sku_title) {
    card.title_length = item.sku_title.length;
  }

  return card;
}

// ============================================================
// SECTION 5 — SEO Analyzer Agent
// ============================================================

const DESIGN_SEO_KEYWORDS_BY_CATEGORY = {
  одежда:       ['размер', 'материал', 'состав', 'уход', 'модель', 'коллекция', 'фасон'],
  обувь:        ['размер', 'подошва', 'материал', 'сезон', 'полнота', 'высота каблука'],
  электроника:  ['мощность', 'гарантия', 'совместимость', 'интерфейс', 'память', 'разрешение'],
  косметика:    ['состав', 'объём', 'тип кожи', 'применение', 'эффект', 'срок годности'],
  детские:      ['возраст', 'материал', 'безопасность', 'размер', 'сертификат'],
  дом:          ['материал', 'размер', 'уход', 'стиль', 'цвет', 'комплектация'],
  спорт:        ['размер', 'материал', 'нагрузка', 'сезон', 'вес', 'тип спорта'],
  default:      ['качество', 'материал', 'размер', 'цвет', 'применение', 'характеристики'],
};

function detectProductCategory_(skuTitle) {
  const t = (skuTitle || '').toLowerCase();
  if (/платье|брюки|футболк|пальто|куртк|рубашк|костюм|юбк|джинс/.test(t)) return 'одежда';
  if (/туфли|сапог|кроссовк|ботинк|сандал|мокасин|кед/.test(t)) return 'обувь';
  if (/телефон|ноутбук|планшет|наушник|колонк|камер|принтер/.test(t)) return 'электроника';
  if (/крем|сыворотк|шампунь|маска|помад|тушь|духи|парфюм/.test(t)) return 'косметика';
  if (/детск|игрушк|коляск|пеленк|бодик|подгузн/.test(t)) return 'детские';
  if (/диван|стол|стул|шкаф|кровать|подушк|одеяло|полотенц/.test(t)) return 'дом';
  if (/гантел|велосипед|коврик|тренажер|перчатк спорт|мяч/.test(t)) return 'спорт';
  return 'default';
}

function analyzeSeoGaps_(skuTitle, description, titleKeywords) {
  const category = detectProductCategory_(skuTitle);
  const expected = DESIGN_SEO_KEYWORDS_BY_CATEGORY[category] || DESIGN_SEO_KEYWORDS_BY_CATEGORY.default;

  const combined = [
    ...(skuTitle || '').toLowerCase().split(/\s+/),
    ...(description || '').toLowerCase().split(/\s+/),
    ...(titleKeywords || []).map(k => String(k).toLowerCase()),
  ].join(' ');

  const missing = expected.filter(kw => !combined.includes(kw));
  const present = expected.filter(kw => combined.includes(kw));

  const coverageRate = expected.length > 0 ? present.length / expected.length : 0;

  return { category, missing, present, coverageRate };
}

async function runSeoAnalyzerAgent_(env, db, date) {
  const result = {
    date,
    items_analyzed: 0,
    gaps: [],
    avg_coverage_rate: null,
    source_status: 'missing',
  };

  try {
    const rows = await db.prepare(
      `SELECT dhi.nm_id, dhi.vendor_code, dhi.sku_title, dhi.issue_type, dhi.priority,
              dcs.title_keywords_json, dcs.overall_score
       FROM design_handoff_item dhi
       LEFT JOIN design_card_snapshot dcs
         ON dcs.nm_id=dhi.nm_id AND dcs.snapshot_date=?
       WHERE dhi.status IN ('pending','in_progress')
       ORDER BY dhi.created_at ASC LIMIT 100`
    ).bind(date).all();

    const items = rows.results || [];
    if (items.length === 0) {
      result.source_status = 'missing';
      return result;
    }

    result.source_status = 'ok';
    let totalCoverage = 0;
    let analyzed = 0;

    for (const item of items) {
      try {
        let titleKeywords = [];
        try { titleKeywords = JSON.parse(item.title_keywords_json || '[]'); } catch (_) {}

        const { category, missing, present, coverageRate } = analyzeSeoGaps_(
          item.sku_title, '', titleKeywords
        );

        if (missing.length > 0) {
          result.gaps.push({
            nm_id: item.nm_id,
            vendor_code: item.vendor_code,
            sku_title: item.sku_title,
            category,
            missing_keywords: missing,
            present_keywords: present,
            coverage_rate: wbRound_(coverageRate, 2),
            priority: item.priority,
          });
        }

        totalCoverage += coverageRate;
        analyzed++;
        result.items_analyzed++;
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'design', entity_id: String(item.nm_id || 'unknown'),
          action: 'seo_item_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }

    result.avg_coverage_rate = analyzed > 0 ? wbRound_(totalCoverage / analyzed, 2) : null;
  } catch (e) {
    result.source_status = 'error';
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'seo_analyzer',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 6 — Content Gap Finder Agent
// ============================================================

const DESIGN_PRIORITY_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 };

async function runContentGapFinderAgent_(env, db, date) {
  const result = {
    date,
    priority_items: [],
    total_pending: 0,
    source_status: 'missing',
  };

  try {
    const rows = await db.prepare(
      `SELECT dhi.nm_id, dhi.vendor_code, dhi.sku_title,
              dhi.priority, dhi.issue_type, dhi.status,
              dhi.evidence_json, dhi.created_at,
              COUNT(*) as handoff_count,
              dcs.overall_score
       FROM design_handoff_item dhi
       LEFT JOIN design_card_snapshot dcs
         ON dcs.nm_id=dhi.nm_id AND dcs.snapshot_date=?
       WHERE dhi.status IN ('pending','in_progress')
       GROUP BY dhi.nm_id
       ORDER BY dhi.created_at ASC LIMIT 200`
    ).bind(date).all();

    const groups = rows.results || [];
    if (groups.length === 0) {
      result.source_status = 'missing';
      return result;
    }

    result.source_status = 'ok';
    result.total_pending = groups.length;

    const scored = groups.map(g => {
      const priorityScore = DESIGN_PRIORITY_WEIGHT[g.priority] || 1;
      const scorePenalty = g.overall_score !== null ? (100 - (g.overall_score || 0)) / 100 : 0.5;
      const handoffBonus = Math.min((g.handoff_count || 1) * 0.2, 1.0);
      const totalScore = priorityScore + scorePenalty + handoffBonus;

      return {
        nm_id: g.nm_id,
        vendor_code: g.vendor_code,
        sku_title: g.sku_title,
        priority: g.priority,
        issue_type: g.issue_type,
        handoff_count: g.handoff_count || 1,
        card_score: g.overall_score !== null ? g.overall_score : null,
        card_score_status: g.overall_score !== null ? 'ok' : 'missing',
        sort_score: wbRound_(totalScore, 3),
      };
    });

    scored.sort((a, b) => b.sort_score - a.sort_score);
    result.priority_items = scored;
  } catch (e) {
    result.source_status = 'error';
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'gap_finder',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 7 — Content Plan Generation
// ============================================================

async function generateContentDraft_(env, nmId, issueType, evidence) {
  const evidenceText = Array.isArray(evidence) ? evidence.join('; ') : String(evidence || '');

  const prompt = `Ты AI-помощник по контенту для маркетплейса Wildberries.
Товар: nm_id ${nmId}
Тип проблемы: ${issueType}
Доказательства: ${csSafeText_(evidenceText, 400)}

Составь краткие рекомендации по улучшению карточки товара (до 600 символов):
- Конкретные предложения по заголовку, описанию или фотографиям
- Список ключевых слов для добавления (если нужно)
- Что именно исправить в первую очередь

Только текст рекомендаций.`;

  const aiResult = await callDesignAi_(env, prompt, 512);

  if (aiResult.ok && aiResult.text) {
    return csSafeText_(aiResult.text.trim(), 600);
  }

  const fallbacks = {
    card_content_gap: `Рекомендуется: добавить подробное описание товара (минимум 200 символов), указать все основные характеристики, загрузить не менее 5 фотографий с разных ракурсов.`,
    seo_gap:          `Рекомендуется: добавить в заголовок и описание ключевые слова категории. Проверить и расширить список характеристик для лучшей индексации.`,
    photo_gap:        `Рекомендуется: загрузить дополнительные фотографии (минимум 5-8 штук). Добавить фото на белом фоне, фото деталей и фото в использовании.`,
    rating_content:   `Рекомендуется: проверить соответствие описания реальному товару, добавить инструкцию по использованию, уточнить характеристики согласно отзывам покупателей.`,
  };

  return fallbacks[issueType] || `Рекомендуется улучшить контент карточки товара nm_id ${nmId}: заголовок, описание и фотографии.`;
}

async function buildContentPlan_(db, date, gapResult) {
  const created = [];
  const items = gapResult.priority_items || [];

  const highPriorityItems = items.filter(
    it => ['critical', 'high'].includes(it.priority) || (it.card_score !== null && it.card_score < 50)
  ).slice(0, 20);

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const item of highPriorityItems) {
    try {
      const existing = await db.prepare(
        `SELECT id FROM design_content_plan
         WHERE nm_id=? AND plan_date=? AND status IN ('pending','in_progress')`
      ).bind(item.nm_id, date).first();

      if (existing) continue;

      const planId = designGenerateId_('dcp');
      const confirmId = designBuildConfirmationId_(item.nm_id, 'content_plan');

      const currentState = {
        card_score: item.card_score,
        card_score_status: item.card_score_status,
        handoff_count: item.handoff_count,
        issue_type: item.issue_type,
      };

      const proposedAction = designProposeAction_(item.issue_type, item.card_score);

      await db.prepare(`INSERT OR IGNORE INTO design_content_plan
        (id, plan_date, nm_id, vendor_code, sku_title, priority, issue_type,
         current_state_json, proposed_action, ai_draft, status,
         confirmation_id, requires_confirmation, expires_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).bind(
        planId, date,
        item.nm_id,
        item.vendor_code || null,
        item.sku_title || null,
        item.priority,
        item.issue_type,
        JSON.stringify(currentState),
        proposedAction,
        null,
        'pending',
        confirmId,
        expiresAt,
        now
      ).run();

      created.push({ plan_id: planId, nm_id: item.nm_id, confirmation_id: confirmId });
    } catch (e) {
      await wbLog_(db, {
        entity_type: 'design', entity_id: String(item.nm_id || 'unknown'),
        action: 'build_plan_item_error', status: 'error',
        details_json: JSON.stringify({ error: String(e) }),
      });
    }
  }

  return { plans_created: created.length, items: created };
}

function designProposeAction_(issueType, cardScore) {
  if (issueType === 'photo_gap') return 'Загрузить дополнительные фотографии (минимум 5)';
  if (issueType === 'seo_gap') return 'Добавить ключевые слова категории в заголовок и описание';
  if (issueType === 'rating_content') return 'Привести описание в соответствие с реальными характеристиками товара';
  if (cardScore !== null && cardScore < 30) return 'Комплексное обновление карточки: заголовок, описание, фото, характеристики';
  return 'Дополнить описание и характеристики товара';
}

// ============================================================
// SECTION 8 — Chief Orchestrator
// ============================================================

async function runDesignChief_(env) {
  const db = env.DB;
  const date = wbYesterday_();
  const now = new Date().toISOString();

  await ensureDesignSchema_(db);

  const handoffResult = await processDesignHandoffs_(db);

  const [cardResult, seoResult] = await Promise.all([
    runCardContentAnalyzerAgent_(env, db, date),
    runSeoAnalyzerAgent_(env, db, date),
  ]);

  const gapResult = await runContentGapFinderAgent_(env, db, date);

  // Enrich top priority items with AI drafts
  const topItems = (gapResult.priority_items || []).filter(
    it => ['critical', 'high'].includes(it.priority)
  ).slice(0, 5);

  for (const item of topItems) {
    try {
      let evidence = [];
      try {
        const row = await db.prepare(
          `SELECT evidence_json FROM design_handoff_item WHERE nm_id=? AND status IN ('pending','in_progress') LIMIT 1`
        ).bind(item.nm_id).first();
        if (row) evidence = JSON.parse(row.evidence_json || '[]');
      } catch (_) {}

      const draft = await generateContentDraft_(env, item.nm_id, item.issue_type, evidence);

      await db.prepare(
        `UPDATE design_content_plan SET ai_draft=?, updated_at=? WHERE nm_id=? AND plan_date=? AND ai_draft IS NULL`
      ).bind(draft, now, item.nm_id, date).run();
    } catch (_) {}
  }

  const planResult = await buildContentPlan_(db, date, gapResult);

  const report = {
    date,
    generated_at: now,
    build: DESIGN_BUILD,
    handoffs: handoffResult,
    card_analyzer: cardResult,
    seo_analyzer: seoResult,
    gap_finder: gapResult,
    content_plan: planResult,
    totals: {
      handoffs_processed: handoffResult.processed,
      cards_analyzed: cardResult.items_analyzed,
      low_score_cards: cardResult.low_score_count,
      avg_card_score: cardResult.avg_score,
      seo_gaps_found: seoResult.gaps.length,
      priority_items: (gapResult.priority_items || []).length,
      plans_created: planResult.plans_created,
    },
  };

  await wbLog_(db, {
    entity_type: 'design', entity_id: 'design_chief',
    action: 'chief_run_complete', status: 'ok',
    details_json: JSON.stringify({ date, totals: report.totals }),
  });

  // Send Telegram summary
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await sendDesignTelegramSummary_(env, report);
    } catch (_) {}
  }

  return report;
}

async function sendDesignTelegramSummary_(env, report) {
  const t = report.totals;
  const avgScore = t.avg_card_score !== null
    ? csEscapeMd_(String(t.avg_card_score))
    : csEscapeMd_('нет данных');

  const lines = [
    `*Дизайн-шеф — ${csEscapeMd_(report.date)}*`,
    '',
    `📥 Handoffs обработано: *${t.handoffs_processed}*`,
    `🃏 Карточек проанализировано: *${t.cards_analyzed}*`,
    `📉 Слабых карточек \\(< 50 баллов\\): *${t.low_score_cards}*`,
    `📊 Средний балл карточек: *${avgScore}*`,
    `🔍 SEO\\-пробелов выявлено: *${t.seo_gaps_found}*`,
    `📋 Приоритетных задач: *${t.priority_items}*`,
    `✅ Планов создано \\(ждут подтверждения\\): *${t.plans_created}*`,
    '',
    `_Все изменения карточек требуют подтверждения человека\\._`,
  ];

  await csSendTelegramMessage_(
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_CHAT_ID,
    lines.join('\n')
  );
}

// ============================================================
// SECTION 9 — Telegram Commands
// ============================================================

async function routeDesignTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;

  const command = text.split(' ')[0].toLowerCase();

  if (!['/design', '/design_report', '/design_handoffs', '/design_plan'].includes(command)) {
    return false;
  }

  try {
    await ensureDesignSchema_(db);

    if (command === '/design' || command === '/design_report') {
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Запускаю Design Chief, подождите...'));
      const report = await runDesignChief_(env);
      const t = report.totals;
      const avgScore = t.avg_card_score !== null
        ? String(t.avg_card_score)
        : 'нет данных';

      const out = [
        `*Отчёт Design Chief — ${csEscapeMd_(report.date)}*`,
        '',
        `Handoffs обработано: ${csEscapeMd_(String(t.handoffs_processed))}`,
        `Карточек проанализировано: ${csEscapeMd_(String(t.cards_analyzed))}`,
        `Слабых карточек: ${csEscapeMd_(String(t.low_score_cards))}`,
        `Средний балл: ${csEscapeMd_(avgScore)}`,
        `SEO\\-пробелов: ${csEscapeMd_(String(t.seo_gaps_found))}`,
        `Планов ожидают подтверждения: ${csEscapeMd_(String(t.plans_created))}`,
      ].join('\n');

      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/design_handoffs') {
      const rows = await db.prepare(
        `SELECT * FROM design_handoff_item
         WHERE status='pending'
         ORDER BY created_at DESC LIMIT 20`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Нет pending задач дизайна.'));
        return true;
      }

      let out = `*Pending задачи дизайна \\(${items.length}\\)*\n\n`;
      for (const item of items) {
        const priority = csEscapeMd_(item.priority || 'medium');
        const sku = csEscapeMd_(item.sku_title || `nm_id:${item.nm_id || '—'}`);
        const type = csEscapeMd_(item.issue_type || '—');
        out += `• *${sku}*\n`;
        out += `  Тип: ${type} | Приоритет: ${priority}\n`;
      }

      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/design_plan') {
      const rows = await db.prepare(
        `SELECT * FROM design_content_plan
         WHERE status='pending' AND requires_confirmation=1
         ORDER BY plan_date DESC, created_at DESC LIMIT 15`
      ).all();

      const plans = rows.results || [];
      if (plans.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Нет пунктов контент-плана, ожидающих подтверждения.'));
        return true;
      }

      for (const plan of plans) {
        const sku = csEscapeMd_(plan.sku_title || `nm_id:${plan.nm_id || '—'}`);
        const action = csEscapeMd_(plan.proposed_action || '—');
        const draft = plan.ai_draft
          ? csEscapeMd_(csSafeText_(plan.ai_draft, 250))
          : csEscapeMd_('Черновик не сгенерирован');

        const msgBody =
          `*Контент\\-план*: ${sku}\n` +
          `Действие: _${action}_\n` +
          `Черновик: ${draft}`;

        try {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: msgBody,
              parse_mode: 'MarkdownV2',
              reply_markup: { inline_keyboard: [[
                { text: '✅ Подтвердить', callback_data: `design_confirm_${plan.id}` },
                { text: '⏭ Пропустить', callback_data: `design_skip_${plan.id}` },
              ]] },
            }),
          });
        } catch (_) {}
      }
      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'telegram_handler',
      action: 'command_error', status: 'error',
      details_json: JSON.stringify({ command, error: String(e) }),
    });
    try {
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Произошла ошибка при выполнении команды.'));
    } catch (_) {}
  }

  return false;
}

// ============================================================
// SECTION 10 — Callback Routing
// ============================================================

async function routeDesignCallbackQuery_(env, cq) {
  const data = (cq.data || '');
  if (!data.startsWith('design_')) return false;

  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const userId = String(cq.from?.id || '');
  const chatId = cq.message?.chat?.id;

  const answerCq = async (text) => {
    try {
      await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: cq.id,
          text: text || '',
          show_alert: false,
        }),
      });
    } catch (_) {}
  };

  try {
    await ensureDesignSchema_(db);

    if (data.startsWith('design_confirm_')) {
      const planId = data.replace('design_confirm_', '');
      const plan = await db.prepare(
        `SELECT * FROM design_content_plan WHERE id=?`
      ).bind(planId).first();

      if (!plan) { await answerCq('Пункт плана не найден.'); return true; }
      if (plan.status === 'confirmed') { await answerCq('Уже подтверждено.'); return true; }
      if (plan.status === 'dismissed') { await answerCq('Пункт был пропущен.'); return true; }

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE design_content_plan SET status='confirmed', confirmed_at=?, updated_at=? WHERE id=?`
      ).bind(now, now, planId).run();

      await db.prepare(
        `UPDATE design_handoff_item SET status='in_progress', updated_at=? WHERE nm_id=? AND status='pending'`
      ).bind(now, plan.nm_id).run();

      await wbLog_(db, {
        entity_type: 'design', entity_id: planId,
        action: 'content_plan_confirmed', status: 'ok',
        details_json: JSON.stringify({ confirmed_by: userId, nm_id: plan.nm_id }),
      });

      await answerCq('✅ Подтверждено. Задача передана в работу.');

      if (token && chatId) {
        await csSendTelegramMessage_(token, chatId,
          `*Подтверждено*: ${csEscapeMd_(plan.sku_title || `nm_id:${plan.nm_id}`)}\n_Изменения в карточку вносятся вручную\\._`
        );
      }
      return true;
    }

    if (data.startsWith('design_skip_')) {
      const planId = data.replace('design_skip_', '');
      const plan = await db.prepare(
        `SELECT * FROM design_content_plan WHERE id=?`
      ).bind(planId).first();

      if (!plan) { await answerCq('Пункт плана не найден.'); return true; }
      if (plan.status === 'dismissed') { await answerCq('Уже пропущено.'); return true; }

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE design_content_plan SET status='dismissed', updated_at=? WHERE id=?`
      ).bind(now, planId).run();

      await wbLog_(db, {
        entity_type: 'design', entity_id: planId,
        action: 'content_plan_dismissed', status: 'ok',
        details_json: JSON.stringify({ dismissed_by: userId, nm_id: plan.nm_id }),
      });

      await answerCq('⏭ Пропущено.');
      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'callback_handler',
      action: 'callback_error', status: 'error',
      details_json: JSON.stringify({ data, error: String(e) }),
    });
    await answerCq('Ошибка при обработке.');
  }

  return false;
}

// ============================================================
// SECTION 11 — API Routes
// ============================================================

async function handleDesignRoutes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;

  if (!path.startsWith('/agent/design')) return null;

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    await ensureDesignSchema_(db);

    // GET /agent/design/handoffs
    if (method === 'GET' && path === '/agent/design/handoffs') {
      const status = url.searchParams.get('status') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const nmId = url.searchParams.get('nm_id') || null;

      let sql = `SELECT * FROM design_handoff_item WHERE 1=1`;
      const binds = [];
      if (status) { sql += ` AND status=?`; binds.push(status); }
      if (nmId)   { sql += ` AND nm_id=?`;  binds.push(nmId); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      const items = rows.results || [];
      return json({ ok: true, handoffs: items, count: items.length });
    }

    // GET /agent/design/plan
    if (method === 'GET' && path === '/agent/design/plan') {
      const status = url.searchParams.get('status') || 'pending';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      const rows = await db.prepare(
        `SELECT * FROM design_content_plan WHERE status=?
         ORDER BY plan_date DESC, created_at DESC LIMIT ?`
      ).bind(status, limit).all();

      const items = rows.results || [];
      return json({ ok: true, plans: items, count: items.length });
    }

    // POST /agent/design/report/run
    if (method === 'POST' && path === '/agent/design/report/run') {
      const report = await runDesignChief_(env);
      return json({ ok: true, report });
    }

    // GET /agent/design/card/:nm_id
    const cardMatch = path.match(/^\/agent\/design\/card\/(\d+)$/);
    if (method === 'GET' && cardMatch) {
      const nmId = parseInt(cardMatch[1], 10);
      if (!nmId) return json({ ok: false, error: 'invalid_nm_id' }, 400);

      const snapshot = await db.prepare(
        `SELECT * FROM design_card_snapshot WHERE nm_id=? ORDER BY snapshot_date DESC LIMIT 1`
      ).bind(nmId).first();

      if (!snapshot) {
        return json({
          ok: true,
          nm_id: nmId,
          snapshot: null,
          source_status: 'missing',
        });
      }

      return json({ ok: true, nm_id: nmId, snapshot, source_status: 'ok' });
    }

    // POST /agent/design/plan/:id/confirm
    const confirmMatch = path.match(/^\/agent\/design\/plan\/([^/]+)\/confirm$/);
    if (method === 'POST' && confirmMatch) {
      const planId = confirmMatch[1];
      const plan = await db.prepare(
        `SELECT * FROM design_content_plan WHERE id=?`
      ).bind(planId).first();

      if (!plan) return json({ ok: false, error: 'plan_not_found' }, 404);
      if (plan.status === 'confirmed') return json({ ok: true, idempotent: true });
      if (plan.status === 'dismissed') return json({ ok: false, error: 'plan_dismissed' }, 409);

      let body = {};
      try { body = await request.json(); } catch (_) {}

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE design_content_plan SET status='confirmed', confirmed_at=?, updated_at=? WHERE id=?`
      ).bind(now, now, planId).run();

      await wbLog_(db, {
        entity_type: 'design', entity_id: planId,
        action: 'plan_confirmed_api', status: 'ok',
        details_json: JSON.stringify({ confirmed_by: body.user_id || null }),
      });

      return json({ ok: true, plan_id: planId, status: 'confirmed' });
    }

    // POST /agent/design/plan/:id/dismiss
    const dismissMatch = path.match(/^\/agent\/design\/plan\/([^/]+)\/dismiss$/);
    if (method === 'POST' && dismissMatch) {
      const planId = dismissMatch[1];
      const plan = await db.prepare(
        `SELECT id, status FROM design_content_plan WHERE id=?`
      ).bind(planId).first();

      if (!plan) return json({ ok: false, error: 'plan_not_found' }, 404);
      if (plan.status === 'dismissed') return json({ ok: true, idempotent: true });

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE design_content_plan SET status='dismissed', updated_at=? WHERE id=?`
      ).bind(now, planId).run();

      await wbLog_(db, {
        entity_type: 'design', entity_id: planId,
        action: 'plan_dismissed_api', status: 'ok',
        details_json: JSON.stringify({}),
      });

      return json({ ok: true, plan_id: planId, status: 'dismissed' });
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'api_router',
      action: 'route_error', status: 'error',
      details_json: JSON.stringify({ path, method, error: String(e) }),
    });
    return json({ ok: false, error: String(e) }, 500);
  }

  return null;
}
// ============================================================
// ROP Chief — Head of Sales (v1)
// Build: ai_helpers_rop_chief_v1
//
// AI-шеф отдела продаж (Руководитель Отдела Продаж).
// Отслеживает KPI по SKU и магазину, мониторит конверсии,
// принимает handoff-события от WB Operations и CS Chiefs,
// генерирует управленческие отчёты для Telegram.
//
// ── Новые таблицы ────────────────────────────────────────────
//   rop_kpi_snapshot    — дневные KPI-срезы по артикулам
//   rop_target          — цели по периодам / артикулам
//   rop_insight         — инсайты, риски, алерты
//
// ── Sub-agents ───────────────────────────────────────────────
//   runKpiTrackerAgent_       — считывает wb_sku_snapshot / wb_daily_snapshot
//   runSalesFunnelAgent_      — анализирует конверсию vs. рекламу
//   runTargetMonitorAgent_    — сравнивает KPI с целями
//
// ── Telegram-команды ─────────────────────────────────────────
//   /rop | /rop_report   — запустить Chief, показать отчёт
//   /rop_handoffs        — pending handoffs / инсайты
//   /rop_kpi             — KPI-срез за сегодня
//   /rop_targets         — цели и статусы
//
// ── Callback-префиксы ────────────────────────────────────────
//   rop_confirm_target_<id>  — подтвердить цель
//   rop_skip_insight_<id>    — отклонить инсайт
//
// ── API ──────────────────────────────────────────────────────
//   GET  /agent/rop/handoffs
//   GET  /agent/rop/kpi?date=YYYY-MM-DD
//   GET  /agent/rop/targets
//   POST /agent/rop/report/run
//   POST /agent/rop/targets
//
// Правила безопасности:
//   - НИКОГДА не менять цены автоматически
//   - НИКОГДА не запускать/останавливать рекламу
//   - НИКОГДА не создавать задачи во внешних системах
//   - Все рискованные действия: requires_confirmation = 1
//   - AI только для текста сводки; расчёты — код
//   - "нет данных" ≠ 0 — всегда source_status: 'missing'
//
// Dependencies (globally available):
//   wbGenerateId_(), wbLog_(), wbYesterday_(),
//   wbFormatDate_(), wbRound_(),
//   csEscapeMd_(), csSendTelegramMessage_()
// ============================================================

const ROP_BUILD = 'ai_helpers_rop_chief_v1';
const ROP_CHIEF = 'rop_chief';

const ROP_TREND = {
  GROWING:   'growing',
  STABLE:    'stable',
  DECLINING: 'declining',
  CRITICAL:  'critical',
};

const ROP_TARGET_STATUS = {
  PENDING:   'pending',
  ON_TRACK:  'on_track',
  AT_RISK:   'at_risk',
  MISSED:    'missed',
  ACHIEVED:  'achieved',
};

const ROP_INSIGHT_TYPE = {
  SKU_RISK:        'sku_risk',
  REVENUE_DROP:    'revenue_drop',
  RATING_ALERT:    'rating_alert',
  TOP_PERFORMER:   'top_performer',
  WEEKLY_SUMMARY:  'weekly_summary',
};

const ROP_PRIORITY = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low',
};

// ── Section 1: Schema ─────────────────────────────────────────

async function ensureRopSchema_(db) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS rop_kpi_snapshot (
      id TEXT PRIMARY KEY,
      snapshot_date TEXT NOT NULL,
      nm_id INTEGER NOT NULL,
      vendor_code TEXT,
      sku_title TEXT,
      orders_count INTEGER DEFAULT 0,
      orders_revenue REAL DEFAULT 0,
      returns_count INTEGER DEFAULT 0,
      return_rate REAL DEFAULT 0,
      avg_rating REAL,
      reviews_count INTEGER DEFAULT 0,
      conversion_rate REAL,
      revenue_7d REAL,
      revenue_30d REAL,
      orders_7d INTEGER,
      orders_30d INTEGER,
      trend TEXT DEFAULT 'stable',
      source_status TEXT DEFAULT 'missing',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(snapshot_date, nm_id)
    )`,
    `CREATE TABLE IF NOT EXISTS rop_target (
      id TEXT PRIMARY KEY,
      period TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      nm_id INTEGER,
      vendor_code TEXT,
      metric TEXT NOT NULL,
      target_value REAL NOT NULL,
      current_value REAL,
      deviation_pct REAL,
      status TEXT DEFAULT 'pending',
      confirmation_id TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      confirmed_by TEXT,
      confirmed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS rop_insight (
      id TEXT PRIMARY KEY,
      insight_date TEXT NOT NULL,
      insight_type TEXT NOT NULL,
      nm_id INTEGER,
      vendor_code TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      evidence_json TEXT DEFAULT '[]',
      recommended_action TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'new',
      confirmation_id TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  ];

  for (const sql of tables) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }

  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_rop_kpi_date ON rop_kpi_snapshot(snapshot_date, nm_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rop_target_status ON rop_target(status, period_end)`,
    `CREATE INDEX IF NOT EXISTS idx_rop_insight_date ON rop_insight(insight_date, status)`,
    `CREATE INDEX IF NOT EXISTS idx_rop_insight_nm ON rop_insight(nm_id, status)`,
  ];
  for (const sql of indexes) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
}

// ── Section 2: AI helper ──────────────────────────────────────

async function callRopAi_(env, prompt) {
  // Try Gemini
  if (env.GEMINI_API_KEY) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { text, source: 'gemini' };
      }
    } catch (_) {}
  }

  // Try Groq
  if (env.GROQ_API_KEY) {
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 600,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return { text, source: 'groq' };
      }
    } catch (_) {}
  }

  // Static fallback
  return {
    text: 'AI-анализ недоступен. Данные представлены в табличном формате выше.',
    source: 'fallback',
  };
}

// ── Section 3: KPI Tracker Agent ──────────────────────────────

async function runKpiTrackerAgent_(env, db, date) {
  const snapshots = [];
  let source_status = 'missing';

  let skuRows = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM wb_sku_snapshot WHERE date = ? ORDER BY sales_rub DESC LIMIT 200`
    ).bind(date).all();
    skuRows = res.results || [];
  } catch (_) {}

  if (!skuRows.length) {
    await wbLog_(db, { event_type: 'rop_kpi_no_sku_data', entity_type: 'rop', details_json: JSON.stringify({ date }) });
    return { snapshots: [], source_status: 'missing' };
  }

  source_status = 'partial';

  for (const sku of skuRows) {
    const nmId = parseInt(sku.nm_id, 10);
    if (!nmId) continue;

    // 7d and 30d revenue
    let revenue_7d = null;
    let revenue_30d = null;
    let orders_7d = null;
    let orders_30d = null;

    try {
      const r7 = await db.prepare(
        `SELECT SUM(sales_rub) as rev, SUM(orders_count) as ord FROM wb_sku_snapshot
         WHERE nm_id = ? AND date >= date(?, '-6 days') AND date <= ?`
      ).bind(sku.nm_id, date, date).first();
      revenue_7d = r7?.rev ?? null;
      orders_7d  = r7?.ord ?? null;
    } catch (_) {}

    try {
      const r30 = await db.prepare(
        `SELECT SUM(sales_rub) as rev, SUM(orders_count) as ord FROM wb_sku_snapshot
         WHERE nm_id = ? AND date >= date(?, '-29 days') AND date <= ?`
      ).bind(sku.nm_id, date, date).first();
      revenue_30d = r30?.rev ?? null;
      orders_30d  = r30?.ord ?? null;
    } catch (_) {}

    // Trend classification
    let trend = ROP_TREND.STABLE;
    if (revenue_7d !== null && revenue_30d !== null && revenue_30d > 0) {
      const daily30avg = revenue_30d / 30;
      const daily7avg  = revenue_7d  / 7;
      const ratio      = daily30avg > 0 ? daily7avg / daily30avg : null;
      if (ratio !== null) {
        if (ratio < 0.5)  trend = ROP_TREND.CRITICAL;
        else if (ratio < 0.7) trend = ROP_TREND.DECLINING;
        else if (ratio > 1.2) trend = ROP_TREND.GROWING;
        else                  trend = ROP_TREND.STABLE;
      }
    }

    // Return rate
    const ordersCount  = sku.orders_count || 0;
    const returnsCount = sku.returns_count || 0;
    const return_rate  = ordersCount > 0 ? wbRound_(returnsCount / ordersCount, 4) : 0;

    // Conversion rate (orders / card views) — available only if cr_to_cart present
    const conversion_rate = sku.cr_to_cart ?? null;

    const snap_source = (sku.source_status === 'ready') ? 'ready' : 'partial';

    const id = wbGenerateId_('rkpi');
    const now = new Date().toISOString();

    try {
      await db.prepare(`
        INSERT INTO rop_kpi_snapshot
          (id, snapshot_date, nm_id, vendor_code, sku_title, orders_count, orders_revenue,
           returns_count, return_rate, avg_rating, reviews_count,
           conversion_rate, revenue_7d, revenue_30d, orders_7d, orders_30d,
           trend, source_status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(snapshot_date, nm_id) DO UPDATE SET
          orders_count = excluded.orders_count,
          orders_revenue = excluded.orders_revenue,
          returns_count = excluded.returns_count,
          return_rate = excluded.return_rate,
          avg_rating = excluded.avg_rating,
          reviews_count = excluded.reviews_count,
          conversion_rate = excluded.conversion_rate,
          revenue_7d = excluded.revenue_7d,
          revenue_30d = excluded.revenue_30d,
          orders_7d = excluded.orders_7d,
          orders_30d = excluded.orders_30d,
          trend = excluded.trend,
          source_status = excluded.source_status
      `).bind(
        id, date, nmId, sku.vendor_code || null, sku.title || null,
        ordersCount, sku.sales_rub || 0,
        returnsCount, return_rate,
        null, null,
        conversion_rate, revenue_7d, revenue_30d, orders_7d, orders_30d,
        trend, snap_source, now
      ).run();

      snapshots.push({ nm_id: nmId, vendor_code: sku.vendor_code, sku_title: sku.title, trend, revenue_7d, revenue_30d, source_status: snap_source });
    } catch (e) {
      await wbLog_(db, { event_type: 'rop_kpi_insert_error', entity_type: 'rop', details_json: JSON.stringify({ nm_id: nmId, error: String(e) }) });
    }
  }

  if (snapshots.length === skuRows.length) source_status = 'ready';

  await wbLog_(db, { event_type: 'rop_kpi_tracker_done', entity_type: 'rop', details_json: JSON.stringify({ date, count: snapshots.length, source_status }) });
  return { snapshots, source_status };
}

// ── Section 4: Sales Funnel Agent ─────────────────────────────

async function runSalesFunnelAgent_(env, db, date) {
  const funnel_issues = [];

  let kpiRows = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM rop_kpi_snapshot WHERE snapshot_date = ? AND source_status != 'missing'`
    ).bind(date).all();
    kpiRows = res.results || [];
  } catch (_) {}

  if (!kpiRows.length) return { funnel_issues: [], source_status: 'missing' };

  // Join with ads data
  for (const kpi of kpiRows) {
    let adsRow = null;
    try {
      const r = await db.prepare(
        `SELECT SUM(ad_spend) as spend, AVG(cr) as cr, AVG(drr) as drr
         FROM wb_ads_snapshot WHERE nm_id = ? AND date = ?`
      ).bind(String(kpi.nm_id), date).first();
      adsRow = r || null;
    } catch (_) {}

    if (!adsRow || adsRow.spend === null || adsRow.spend === 0) continue;

    const conversionRate = kpi.conversion_rate;
    const adSpend        = adsRow.spend || 0;
    const drr            = adsRow.drr || 0;

    // High ad spend + low conversion = funnel issue
    const isHighSpend      = adSpend > 5000;
    const isLowConversion  = conversionRate !== null && conversionRate < 0.01;
    const isHighDrr        = drr > 0.35;

    if (isHighSpend && (isLowConversion || isHighDrr)) {
      funnel_issues.push({
        nm_id:        kpi.nm_id,
        vendor_code:  kpi.vendor_code,
        sku_title:    kpi.sku_title,
        ad_spend:     wbRound_(adSpend, 0),
        conversion:   conversionRate !== null ? wbRound_(conversionRate * 100, 2) : null,
        drr_pct:      wbRound_(drr * 100, 1),
        issue:        isLowConversion ? 'low_conversion' : 'high_drr',
        trend:        kpi.trend,
      });
    }
  }

  await wbLog_(db, { event_type: 'rop_funnel_done', entity_type: 'rop', details_json: JSON.stringify({ date, issues: funnel_issues.length }) });
  return { funnel_issues, source_status: 'ready' };
}

// ── Section 5: Target Monitor Agent ──────────────────────────

async function runTargetMonitorAgent_(env, db, date) {
  const alerts = [];

  let targets = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM rop_target WHERE status IN ('pending','on_track','at_risk') ORDER BY created_at DESC`
    ).all();
    targets = res.results || [];
  } catch (_) { return { alerts: [], source_status: 'missing' }; }

  const now = new Date().toISOString().slice(0, 10);

  for (const target of targets) {
    // Find current KPI value
    let currentValue = null;
    try {
      if (target.nm_id) {
        const row = await db.prepare(
          `SELECT * FROM rop_kpi_snapshot WHERE nm_id = ? AND snapshot_date = ?`
        ).bind(target.nm_id, date).first();
        if (row) {
          if (target.metric === 'revenue')     currentValue = row.orders_revenue;
          if (target.metric === 'orders')      currentValue = row.orders_count;
          if (target.metric === 'return_rate') currentValue = row.return_rate;
          if (target.metric === 'rating')      currentValue = row.avg_rating;
        }
      } else {
        // Store-wide: aggregate daily snapshot
        const row = await db.prepare(
          `SELECT * FROM wb_daily_snapshot WHERE date = ?`
        ).bind(date).first();
        if (row) {
          if (target.metric === 'revenue') currentValue = row.total_sales_rub;
          if (target.metric === 'orders')  currentValue = row.total_orders;
        }
      }
    } catch (_) {}

    if (currentValue === null) continue;

    const deviation_pct = target.target_value > 0
      ? wbRound_((currentValue - target.target_value) / target.target_value * 100, 1)
      : null;

    let newStatus = target.status;
    const periodEnded = now > target.period_end;

    if (periodEnded) {
      newStatus = currentValue >= target.target_value ? ROP_TARGET_STATUS.ACHIEVED : ROP_TARGET_STATUS.MISSED;
    } else if (deviation_pct !== null) {
      if (deviation_pct >= 0)        newStatus = ROP_TARGET_STATUS.ON_TRACK;
      else if (deviation_pct > -15)  newStatus = ROP_TARGET_STATUS.ON_TRACK;
      else                           newStatus = ROP_TARGET_STATUS.AT_RISK;
    }

    try {
      await db.prepare(
        `UPDATE rop_target SET current_value=?, deviation_pct=?, status=? WHERE id=?`
      ).bind(currentValue, deviation_pct, newStatus, target.id).run();
    } catch (_) {}

    if ([ROP_TARGET_STATUS.AT_RISK, ROP_TARGET_STATUS.MISSED].includes(newStatus)) {
      alerts.push({
        target_id:    target.id,
        metric:       target.metric,
        nm_id:        target.nm_id || null,
        vendor_code:  target.vendor_code || null,
        target_value: target.target_value,
        current_value: currentValue,
        deviation_pct,
        status:       newStatus,
        period:       target.period,
      });
    }
  }

  await wbLog_(db, { event_type: 'rop_target_monitor_done', entity_type: 'rop', details_json: JSON.stringify({ date, alerts: alerts.length }) });
  return { alerts, source_status: 'ready' };
}

// ── Section 6: Handoff Processing ─────────────────────────────

async function processRopHandoffs_(db) {
  let handoffs = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM handoff_event WHERE to_chief = ? AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY created_at DESC LIMIT 50`
    ).bind(ROP_CHIEF).all();
    handoffs = res.results || [];
  } catch (_) { return { processed: 0 }; }

  let processed = 0;
  const date = new Date().toISOString().slice(0, 10);

  for (const h of handoffs) {
    const insightType = (h.handoff_type === 'rating_drop' || h.handoff_type === 'product_quality_risk')
      ? ROP_INSIGHT_TYPE.RATING_ALERT
      : ROP_INSIGHT_TYPE.SKU_RISK;

    const priority = h.priority === 'critical' ? ROP_PRIORITY.CRITICAL
      : h.priority === 'high' ? ROP_PRIORITY.HIGH
      : ROP_PRIORITY.MEDIUM;

    const insightId = wbGenerateId_('rins');
    const confirmId = `rop_insight_${h.nm_id || 'store'}_${Date.now().toString(36)}`;
    const evidence  = (() => { try { return JSON.parse(h.evidence_json || '[]'); } catch (_) { return []; } })();

    try {
      await db.prepare(`
        INSERT INTO rop_insight
          (id, insight_date, insight_type, nm_id, vendor_code, title, summary,
           evidence_json, recommended_action, priority, status,
           confirmation_id, requires_confirmation, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        insightId, date, insightType,
        h.nm_id || null, h.sku_title || null,
        h.title, h.summary || null,
        JSON.stringify(evidence),
        h.recommended_action || 'Требуется управленческое решение',
        priority, 'new',
        confirmId, 1,
        new Date().toISOString()
      ).run();

      // Mark handoff acknowledged
      await db.prepare(
        `UPDATE handoff_event SET status='acknowledged', acknowledged_at=datetime('now'),
         acknowledged_by=? WHERE id=?`
      ).bind(ROP_CHIEF, h.id).run();

      processed++;
    } catch (e) {
      await wbLog_(db, { event_type: 'rop_handoff_process_error', entity_type: 'rop', details_json: JSON.stringify({ handoff_id: h.id, error: String(e) }) });
    }
  }

  await wbLog_(db, { event_type: 'rop_handoffs_processed', entity_type: 'rop', details_json: JSON.stringify({ processed }) });
  return { processed };
}

// ── Section 7: Proposals ──────────────────────────────────────

async function buildRopProposals_(db, date, insights) {
  const created = [];

  const criticalInsights = insights.filter(i => i.priority === ROP_PRIORITY.CRITICAL || i.priority === ROP_PRIORITY.HIGH);

  for (const ins of criticalInsights.slice(0, 10)) {
    const confirmId = `rop_action_${ins.nm_id || 'store'}_${Date.now().toString(36)}`;
    const id = wbGenerateId_('rprop');

    const action = ins.nm_id
      ? `Проверьте ценообразование и рекламу для SKU ${ins.vendor_code || ins.nm_id}`
      : 'Проверьте общую стратегию продаж';

    try {
      await db.prepare(`
        INSERT INTO rop_insight
          (id, insight_date, insight_type, nm_id, vendor_code, title, summary,
           evidence_json, recommended_action, priority, status,
           confirmation_id, requires_confirmation, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        id, date, ins.insight_type || ROP_INSIGHT_TYPE.SKU_RISK,
        ins.nm_id || null, ins.vendor_code || null,
        `[Предложение] ${ins.title}`,
        ins.summary || null,
        ins.evidence_json || '[]',
        action,
        ins.priority, 'new',
        confirmId, 1,
        new Date().toISOString()
      ).run();
      created.push({ id, confirmation_id: confirmId });
    } catch (_) {}
  }

  return created;
}

// ── Section 8: Report Builder ─────────────────────────────────

async function buildRopWeeklyReport_(db, date, kpiResult, funnelResult, targetResult) {
  const lines = [];
  const esc = csEscapeMd_;

  lines.push(`*РОП — Еженедельный отчёт*`);
  lines.push(`Дата: ${esc(date)}\n`);

  // Top 5 by revenue
  lines.push(`*ТОП\\-5 SKU по выручке:*`);
  let topSkus = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM rop_kpi_snapshot WHERE snapshot_date = ? ORDER BY orders_revenue DESC LIMIT 5`
    ).bind(date).all();
    topSkus = res.results || [];
  } catch (_) {}

  if (topSkus.length) {
    for (const s of topSkus) {
      const trend_icon = { growing: '📈', stable: '➡️', declining: '📉', critical: '🔻' }[s.trend] || '➡️';
      lines.push(`${trend_icon} ${esc(s.sku_title || String(s.nm_id))} — ${esc(wbRound_(s.orders_revenue, 0) + ' ₽')}`);
    }
  } else {
    lines.push(`_Нет данных \\(source\\_status: missing\\)_`);
  }
  lines.push('');

  // Top 3 declining
  const declining = (kpiResult?.snapshots || [])
    .filter(s => s.trend === ROP_TREND.DECLINING || s.trend === ROP_TREND.CRITICAL)
    .slice(0, 3);
  lines.push(`*Снижающиеся SKU \\(${declining.length}\\):*`);
  if (declining.length) {
    for (const s of declining) {
      const label = s.trend === ROP_TREND.CRITICAL ? '🔻 Критично' : '📉 Снижение';
      lines.push(`${label}: ${esc(s.sku_title || String(s.nm_id))}`);
      if (s.revenue_7d !== null && s.revenue_30d !== null) {
        lines.push(`  7д: ${esc(wbRound_(s.revenue_7d, 0) + ' ₽')} | 30д: ${esc(wbRound_(s.revenue_30d, 0) + ' ₽')}`);
      }
    }
  } else {
    lines.push(`_Снижающихся нет_`);
  }
  lines.push('');

  // Funnel issues
  const funnelIssues = funnelResult?.funnel_issues || [];
  lines.push(`*Проблемы воронки \\(${funnelIssues.length}\\):*`);
  if (funnelIssues.length) {
    for (const f of funnelIssues.slice(0, 5)) {
      lines.push(`⚠️ ${esc(f.sku_title || String(f.nm_id))} — расход ${esc(String(f.ad_spend))} ₽, конверсия ${f.conversion !== null ? esc(String(f.conversion) + '%') : esc('н/д')}`);
    }
  } else {
    lines.push(`_Воронка в норме_`);
  }
  lines.push('');

  // Target status
  const targetAlerts = targetResult?.alerts || [];
  lines.push(`*Цели — алерты \\(${targetAlerts.length}\\):*`);
  if (targetAlerts.length) {
    for (const a of targetAlerts) {
      const icon = a.status === ROP_TARGET_STATUS.MISSED ? '❌' : '⚠️';
      const devStr = a.deviation_pct !== null ? ` \\(${esc(String(a.deviation_pct))}%\\)` : '';
      lines.push(`${icon} ${esc(a.metric)}${a.vendor_code ? ' ' + esc(a.vendor_code) : ''}: ${esc(String(a.status))}${devStr}`);
    }
  } else {
    lines.push(`_Все цели в норме_`);
  }
  lines.push('');

  // Pending insights from handoffs
  let pendingInsights = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM rop_insight WHERE status='new' ORDER BY created_at DESC LIMIT 10`
    ).all();
    pendingInsights = res.results || [];
  } catch (_) {}

  lines.push(`*Активные риски \\(${pendingInsights.length}\\):*`);
  if (pendingInsights.length) {
    for (const ins of pendingInsights.slice(0, 5)) {
      const pIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[ins.priority] || '⚪';
      lines.push(`${pIcon} ${esc(ins.title)}`);
      if (ins.recommended_action) lines.push(`  → ${esc(ins.recommended_action)}`);
    }
    if (pendingInsights.length > 5) lines.push(`_...и ещё ${pendingInsights.length - 5}_`);
  } else {
    lines.push(`_Новых рисков нет_`);
  }

  return lines.join('\n');
}

// ── Section 9: Chief Orchestrator ────────────────────────────

async function runRopChief_(env) {
  const db = env.DB;
  const date = new Date().toISOString().slice(0, 10);

  await ensureRopSchema_(db);

  const kpiResult    = await runKpiTrackerAgent_(env, db, date);
  const funnelResult = await runSalesFunnelAgent_(env, db, date);
  const targetResult = await runTargetMonitorAgent_(env, db, date);
  const handoffResult = await processRopHandoffs_(db);

  // Collect new critical insights for proposals
  let newInsights = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM rop_insight WHERE insight_date = ? AND status = 'new'
       AND priority IN ('critical','high')`
    ).bind(date).all();
    newInsights = res.results || [];
  } catch (_) {}

  const proposalsCreated = await buildRopProposals_(db, date, newInsights);

  const reportText = await buildRopWeeklyReport_(db, date, kpiResult, funnelResult, targetResult);

  // AI summary for the insight section
  if (newInsights.length > 0) {
    const insightSummary = newInsights.slice(0, 5).map(i => `- ${i.title}: ${i.recommended_action || ''}`).join('\n');
    const prompt = `Ты РОП (руководитель отдела продаж) маркетплейса Wildberries. Сделай краткий вывод (2–3 предложения) по следующим рискам:\n${insightSummary}\nНе давай рекомендаций по ценам или рекламе — только управленческое резюме.`;
    const aiResult = await callRopAi_(env, prompt);
    if (aiResult.source !== 'fallback') {
      await wbLog_(db, { event_type: 'rop_ai_summary_ok', entity_type: 'rop', details_json: JSON.stringify({ source: aiResult.source }) });
    }
  }

  // Send Telegram report
  const chatId = env.TELEGRAM_CHAT_ID || env.TELEGRAM_ADMIN_CHAT_ID;
  if (chatId && env.TELEGRAM_BOT_TOKEN) {
    await ropSendSplitMessage_(env.TELEGRAM_BOT_TOKEN, chatId, reportText);
  }

  await wbLog_(db, {
    event_type: 'rop_chief_run_done',
    entity_type: 'rop',
    details_json: JSON.stringify({
      date,
      kpi_count: kpiResult.snapshots.length,
      funnel_issues: funnelResult.funnel_issues.length,
      target_alerts: targetResult.alerts.length,
      handoffs_processed: handoffResult.processed,
      proposals_created: proposalsCreated.length,
    }),
  });

  return {
    date,
    kpi: kpiResult,
    funnel: funnelResult,
    targets: targetResult,
    handoffs: handoffResult,
    proposals: proposalsCreated,
    report_length: reportText.length,
  };
}

// ── Section 10: Telegram helpers ─────────────────────────────

async function ropSendSplitMessage_(token, chatId, text) {
  const MAX = 3800;
  if (text.length <= MAX) {
    await csSendTelegramMessage_(token, chatId, text);
    return;
  }
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = remaining.slice(0, MAX);
    const lastNl = cut.lastIndexOf('\n');
    if (lastNl > 0) cut = cut.slice(0, lastNl);
    chunks.push(cut);
    remaining = remaining.slice(cut.length).replace(/^\n/, '');
  }
  for (const chunk of chunks) {
    await csSendTelegramMessage_(token, chatId, chunk);
  }
}

async function ropSendWithButtons_(token, chatId, text, buttons) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: buttons },
      }),
    });
  } catch (_) {}
}

async function ropAnswerCallback_(token, callbackQueryId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || '', show_alert: false }),
    });
  } catch (_) {}
}

// ── Section 11: Telegram Command Router ──────────────────────

async function routeRopTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim().split(' ')[0].toLowerCase();
  const token = env.TELEGRAM_BOT_TOKEN;
  const db = env.DB;
  const esc = csEscapeMd_;

  if (!text.startsWith('/rop')) return false;

  try {
    await ensureRopSchema_(db);

    if (text === '/rop' || text === '/rop_report') {
      await csSendTelegramMessage_(token, chatId, '⏳ Запускаю РОП\\-отчёт\\.\\.\\.');
      const result = await runRopChief_(env);
      await csSendTelegramMessage_(token, chatId, esc(`Отчёт сформирован. KPI: ${result.kpi.snapshots.length} SKU, предложений: ${result.proposals.length}`));
      return true;
    }

    if (text === '/rop_handoffs') {
      let insights = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM rop_insight WHERE status='new' ORDER BY created_at DESC LIMIT 20`
        ).all();
        insights = res.results || [];
      } catch (_) {}

      if (!insights.length) {
        await csSendTelegramMessage_(token, chatId, '✅ Нет новых инсайтов и handoff\\-событий для РОП\\.');
        return true;
      }

      const lines = [`*Pending РОП инсайты \\(${insights.length}\\)*\n`];
      for (const ins of insights) {
        const pIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[ins.priority] || '⚪';
        lines.push(`${pIcon} ${esc(ins.title)}`);
        if (ins.recommended_action) lines.push(`  → _${esc(ins.recommended_action)}_`);
        lines.push('');
      }
      await ropSendSplitMessage_(token, chatId, lines.join('\n'));

      // Buttons for critical/high
      for (const ins of insights.filter(i => ['critical', 'high'].includes(i.priority)).slice(0, 5)) {
        await ropSendWithButtons_(token, chatId, esc(ins.title), [[
          { text: '✅ Принять', callback_data: `rop_confirm_target_${ins.id}` },
          { text: '❌ Пропустить', callback_data: `rop_skip_insight_${ins.id}` },
        ]]);
      }
      return true;
    }

    if (text === '/rop_kpi') {
      const date = new Date().toISOString().slice(0, 10);
      let rows = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM rop_kpi_snapshot WHERE snapshot_date = ? ORDER BY orders_revenue DESC LIMIT 20`
        ).bind(date).all();
        rows = res.results || [];
      } catch (_) {}

      if (!rows.length) {
        await csSendTelegramMessage_(token, chatId, `_KPI за ${esc(date)} не найдены\\. source\\_status: missing_`);
        return true;
      }

      const lines = [`*KPI за ${esc(date)}*\n`];
      for (const r of rows) {
        const tIcon = { growing: '📈', stable: '➡️', declining: '📉', critical: '🔻' }[r.trend] || '➡️';
        lines.push(`${tIcon} *${esc(r.sku_title || String(r.nm_id))}*`);
        lines.push(`  Выручка: ${esc(String(wbRound_(r.orders_revenue || 0, 0)))} ₽ | Заказов: ${esc(String(r.orders_count || 0))}`);
        if (r.return_rate) lines.push(`  Возврат: ${esc(String(wbRound_(r.return_rate * 100, 1)))}%`);
        lines.push('');
      }
      await ropSendSplitMessage_(token, chatId, lines.join('\n'));
      return true;
    }

    if (text === '/rop_targets') {
      let targets = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM rop_target WHERE status NOT IN ('achieved','missed') ORDER BY period_end ASC LIMIT 20`
        ).all();
        targets = res.results || [];
      } catch (_) {}

      if (!targets.length) {
        await csSendTelegramMessage_(token, chatId, '📋 Активных целей нет\\.');
        return true;
      }

      const lines = [`*Активные цели РОП \\(${targets.length}\\)*\n`];
      for (const t of targets) {
        const sIcon = { pending: '⏳', on_track: '✅', at_risk: '⚠️', missed: '❌', achieved: '🏆' }[t.status] || '⏳';
        const skuLabel = t.vendor_code ? ` \\[${esc(t.vendor_code)}\\]` : ' \\[магазин\\]';
        lines.push(`${sIcon} ${esc(t.metric)}${skuLabel} — цель: ${esc(String(t.target_value))}`);
        if (t.current_value !== null) {
          lines.push(`  Текущее: ${esc(String(wbRound_(t.current_value, 1)))} | Откл: ${t.deviation_pct !== null ? esc(String(t.deviation_pct) + '%') : esc('н/д')}`);
        }
        lines.push(`  Период: ${esc(t.period_start)} — ${esc(t.period_end)}`);
        lines.push('');
      }
      await ropSendSplitMessage_(token, chatId, lines.join('\n'));
      return true;
    }

  } catch (e) {
    await wbLog_(db, { event_type: 'rop_tg_command_error', entity_type: 'rop', details_json: JSON.stringify({ text, error: String(e) }) });
    await csSendTelegramMessage_(token, chatId, `❌ Ошибка РОП: ${esc(String(e).slice(0, 200))}`);
    return true;
  }

  return false;
}

// ── Section 12: Callback Router ───────────────────────────────

async function routeRopCallbackQuery_(env, cq) {
  const data = cq?.data || '';
  if (!data.startsWith('rop_')) return false;

  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const userId = String(cq?.from?.id || '');
  const callbackId = cq.id;

  const answer = (text) => ropAnswerCallback_(token, callbackId, text);

  try {
    if (data.startsWith('rop_confirm_target_')) {
      const id = data.replace('rop_confirm_target_', '');
      const row = await db.prepare(`SELECT * FROM rop_insight WHERE id=?`).bind(id).first().catch(() => null);
      if (!row) { await answer('Не найдено'); return true; }
      if (row.status !== 'new') { await answer('Уже обработано'); return true; }

      await db.prepare(
        `UPDATE rop_insight SET status='acknowledged' WHERE id=?`
      ).bind(id).run();
      await wbLog_(db, { event_type: 'rop_insight_confirmed', entity_type: 'rop', details_json: JSON.stringify({ id, user: userId }) });
      await answer('✅ Инсайт принят в работу');
      return true;
    }

    if (data.startsWith('rop_skip_insight_')) {
      const id = data.replace('rop_skip_insight_', '');
      const row = await db.prepare(`SELECT * FROM rop_insight WHERE id=?`).bind(id).first().catch(() => null);
      if (!row) { await answer('Не найдено'); return true; }
      if (row.status !== 'new') { await answer('Уже обработано'); return true; }

      await db.prepare(
        `UPDATE rop_insight SET status='dismissed' WHERE id=?`
      ).bind(id).run();
      await wbLog_(db, { event_type: 'rop_insight_dismissed', entity_type: 'rop', details_json: JSON.stringify({ id, user: userId }) });
      await answer('❌ Инсайт отклонён');
      return true;
    }

    if (data.startsWith('rop_confirm_target_')) {
      const id = data.replace('rop_confirm_target_', '');
      const target = await db.prepare(`SELECT * FROM rop_target WHERE id=?`).bind(id).first().catch(() => null);
      if (!target) { await answer('Не найдено'); return true; }
      if (target.confirmed_at) { await answer('Уже подтверждено'); return true; }

      await db.prepare(
        `UPDATE rop_target SET confirmed_by=?, confirmed_at=datetime('now'), requires_confirmation=0 WHERE id=?`
      ).bind(userId, id).run();
      await wbLog_(db, { event_type: 'rop_target_confirmed', entity_type: 'rop', details_json: JSON.stringify({ id, user: userId }) });
      await answer('✅ Цель подтверждена');
      return true;
    }
  } catch (e) {
    await wbLog_(db, { event_type: 'rop_callback_error', entity_type: 'rop', details_json: JSON.stringify({ data, error: String(e) }) });
    await answer('Ошибка');
  }

  return false;
}

// ── Section 13: API Routes ────────────────────────────────────

async function handleRopRoutes_(env, request) {
  const url  = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;

  if (!path.startsWith('/agent/rop')) return null;

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    await ensureRopSchema_(db);

    // GET /agent/rop/handoffs — pending insights
    if (path === '/agent/rop/handoffs' && method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const status = url.searchParams.get('status') || 'new';
      const res = await db.prepare(
        `SELECT * FROM rop_insight WHERE status=? ORDER BY created_at DESC LIMIT ?`
      ).bind(status, limit).all();
      const insights = res.results || [];
      return json({ ok: true, insights, count: insights.length });
    }

    // GET /agent/rop/kpi?date=YYYY-MM-DD
    if (path === '/agent/rop/kpi' && method === 'GET') {
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const res = await db.prepare(
        `SELECT * FROM rop_kpi_snapshot WHERE snapshot_date=? ORDER BY orders_revenue DESC`
      ).bind(date).all();
      const snapshots = res.results || [];
      return json({ ok: true, date, snapshots, count: snapshots.length });
    }

    // GET /agent/rop/targets
    if (path === '/agent/rop/targets' && method === 'GET') {
      const status = url.searchParams.get('status') || null;
      let q = `SELECT * FROM rop_target WHERE 1=1`;
      const params = [];
      if (status) { q += ` AND status=?`; params.push(status); }
      q += ` ORDER BY period_end ASC LIMIT 100`;
      const res = await db.prepare(q).bind(...params).all();
      const targets = res.results || [];
      return json({ ok: true, targets, count: targets.length });
    }

    // POST /agent/rop/report/run
    if (path === '/agent/rop/report/run' && method === 'POST') {
      const result = await runRopChief_(env);
      return json({ ok: true, ...result });
    }

    // POST /agent/rop/targets — create new target
    if (path === '/agent/rop/targets' && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (_) {}

      const { period, nm_id, vendor_code, metric, target_value, period_start, period_end } = body;
      if (!period || !metric || target_value === undefined || target_value === null) {
        return json({ ok: false, error: 'period, metric, target_value required' }, 400);
      }

      const id = wbGenerateId_('rtar');
      const now = new Date().toISOString().slice(0, 10);
      const pStart = period_start || now;
      const pEnd   = period_end || (period === 'weekly'
        ? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
        : new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
      const confirmId = `rop_target_${nm_id || 'store'}_${Date.now().toString(36)}`;

      await db.prepare(`
        INSERT INTO rop_target
          (id, period, period_start, period_end, nm_id, vendor_code, metric,
           target_value, status, confirmation_id, requires_confirmation, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        id, period, pStart, pEnd,
        nm_id ? parseInt(nm_id, 10) : null,
        vendor_code || null, metric,
        parseFloat(target_value),
        ROP_TARGET_STATUS.PENDING,
        confirmId, 1,
        new Date().toISOString()
      ).run();

      await wbLog_(db, { event_type: 'rop_target_created', entity_type: 'rop', details_json: JSON.stringify({ id, metric, period }) });
      return json({ ok: true, id, confirmation_id: confirmId, requires_confirmation: true });
    }

  } catch (e) {
    await wbLog_(db, { event_type: 'rop_api_error', entity_type: 'rop', details_json: JSON.stringify({ path, method, error: String(e) }) });
    return json({ ok: false, error: String(e) }, 500);
  }

  return null;
}
// ============================================================
// Fulfillment Chief — FBS/FBO Supply Management (v1)
// Build: ai_helpers_fulfillment_chief_v1
//
// Manages WB FBS/FBO stock monitoring, TZ (technical spec) drafting,
// and supply schedule planning. NEVER auto-creates deliveries.
// All proposals require human confirmation before any action.
//
// TABLES:
//   fulfillment_fbs_snapshot   — WB warehouse stock levels per SKU
//   fulfillment_tz_item        — TZ (поставка план) drafts per SKU
//   fulfillment_schedule       — grouped supply batches per warehouse
//
// SUB-AGENTS:
//   runFbsMonitorAgent_        — monitors WB stock, computes urgency
//   runTzGeneratorAgent_       — drafts TZ items for critical/high SKUs
//   runSupplyPlannerAgent_     — groups confirmed TZ into schedule batches
//
// TELEGRAM COMMANDS:
//   /fulfillment               — run chief, show summary
//   /fulfillment_report        — alias for /fulfillment
//   /fulfillment_handoffs      — pending handoffs to fulfillment_chief
//   /fulfillment_tz            — TZ items awaiting confirmation
//   /fulfillment_fbs           — FBS stock (critical + high urgency)
//   /fulfillment_schedule      — confirmed + planned schedules
//
// CALLBACKS:
//   ff_confirm_tz_<id>         — confirm TZ item
//   ff_cancel_tz_<id>          — cancel TZ item
//   ff_confirm_schedule_<id>   — confirm supply schedule
//
// API:
//   GET  /agent/fulfillment/fbs
//   GET  /agent/fulfillment/tz
//   GET  /agent/fulfillment/schedule
//   POST /agent/fulfillment/report/run
//   POST /agent/fulfillment/tz/:id/confirm
//   POST /agent/fulfillment/tz/:id/cancel
//
// SAFETY RULES (absolute — never violate):
//   - NEVER auto-create deliveries/supplies in WB
//   - NEVER auto-send TZ to fulfillment team
//   - NEVER auto-confirm procurement orders
//   - All proposals: requires_confirmation = 1
//   - Missing data → source_status='missing' warning, NOT zero-stock alert
//   - Calculations always deterministic — AI only for summary text
// ============================================================

const FF_CHIEF_BUILD    = 'ai_helpers_fulfillment_chief_v1';
const FF_CHIEF_NAME     = 'fulfillment_chief';

const FF_URGENCY = {
  NONE:     'none',
  LOW:      'low',
  MEDIUM:   'medium',
  HIGH:     'high',
  CRITICAL: 'critical',
};

const FF_TZ_STATUS = {
  DRAFT:     'draft',
  CONFIRMED: 'confirmed',
  SENT:      'sent',
  CANCELLED: 'cancelled',
};

const FF_SCHEDULE_STATUS = {
  PLANNED:   'planned',
  CONFIRMED: 'confirmed',
  SENT:      'sent',
  CANCELLED: 'cancelled',
};

const FF_REPLENISHMENT_TARGET_DAYS = 30;
const FF_URGENCY_THRESHOLDS = {
  critical: 3,
  high:     7,
  medium:   14,
  low:      21,
};

// ============================================================
// SECTION 1 — SCHEMA
// ============================================================

async function ensureFulfillmentSchema_(db) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS fulfillment_fbs_snapshot (
      id TEXT PRIMARY KEY,
      snapshot_date TEXT NOT NULL,
      nm_id INTEGER NOT NULL,
      vendor_code TEXT,
      sku_title TEXT,
      barcode TEXT,
      stock_wb_total INTEGER DEFAULT 0,
      stock_wb_available INTEGER DEFAULT 0,
      stock_wb_in_transit INTEGER DEFAULT 0,
      stock_wb_reserved INTEGER DEFAULT 0,
      stock_seller INTEGER,
      avg_daily_orders_7d REAL DEFAULT 0,
      days_of_stock_wb REAL,
      replenishment_needed INTEGER DEFAULT 0,
      replenishment_qty INTEGER DEFAULT 0,
      urgency TEXT DEFAULT 'none',
      source_status TEXT DEFAULT 'missing',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(snapshot_date, nm_id)
    )`,
    `CREATE TABLE IF NOT EXISTS fulfillment_tz_item (
      id TEXT PRIMARY KEY,
      tz_date TEXT NOT NULL,
      nm_id INTEGER NOT NULL,
      vendor_code TEXT,
      sku_title TEXT,
      barcode TEXT,
      warehouse_target TEXT,
      qty_to_send INTEGER NOT NULL,
      urgency TEXT DEFAULT 'medium',
      rationale TEXT,
      ai_comment TEXT,
      status TEXT DEFAULT 'draft',
      confirmation_id TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      confirmed_at TEXT,
      confirmed_by TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS fulfillment_schedule (
      id TEXT PRIMARY KEY,
      schedule_date TEXT NOT NULL,
      warehouse_name TEXT,
      items_json TEXT DEFAULT '[]',
      total_items INTEGER DEFAULT 0,
      status TEXT DEFAULT 'planned',
      confirmation_id TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      confirmed_at TEXT,
      confirmed_by TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  ];

  for (const sql of tables) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }

  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_fbs_snap_date ON fulfillment_fbs_snapshot(snapshot_date, urgency)`,
    `CREATE INDEX IF NOT EXISTS idx_fbs_snap_nm ON fulfillment_fbs_snapshot(nm_id, snapshot_date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tz_status ON fulfillment_tz_item(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tz_nm ON fulfillment_tz_item(nm_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_schedule_status ON fulfillment_schedule(status, schedule_date)`,
  ];
  for (const sql of indexes) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
}

// ============================================================
// SECTION 2 — HELPERS
// ============================================================

function ffGenerateId_(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix || 'ff'}_${ts}_${rand}`;
}

function ffTzConfirmationId_(nmId) {
  return `ff_tz_${nmId}_${Date.now().toString(36)}`;
}

function ffScheduleConfirmationId_(warehouse) {
  const slug = (warehouse || 'wh').replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase();
  return `ff_sched_${slug}_${Date.now().toString(36)}`;
}

function ffToday_() {
  return new Date().toISOString().slice(0, 10);
}

function ffRound_(val, dec) {
  if (val === null || val === undefined || isNaN(val)) return 0;
  const m = Math.pow(10, dec || 0);
  return Math.round(val * m) / m;
}

function ffCalcUrgency_(daysOfStock, stockAvailable) {
  if (stockAvailable === 0 || daysOfStock < FF_URGENCY_THRESHOLDS.critical) return FF_URGENCY.CRITICAL;
  if (daysOfStock < FF_URGENCY_THRESHOLDS.high)   return FF_URGENCY.HIGH;
  if (daysOfStock < FF_URGENCY_THRESHOLDS.medium)  return FF_URGENCY.MEDIUM;
  if (daysOfStock < FF_URGENCY_THRESHOLDS.low)     return FF_URGENCY.LOW;
  return FF_URGENCY.NONE;
}

function ffCalcReplenishmentQty_(stockAvailable, avgDailyOrders) {
  if (avgDailyOrders <= 0) return 0;
  const target = FF_REPLENISHMENT_TARGET_DAYS * avgDailyOrders;
  return Math.max(0, Math.round(target - stockAvailable));
}

function ffEscapeMd_(text) {
  return String(text || '').replace(/[_*[\]()~>#+=|{}.!\-\\]/g, '\\$&');
}

async function ffSendTelegram_(token, chatId, text) {
  const chunks = [];
  let t = text;
  while (t.length > 3800) {
    const cut = t.lastIndexOf('\n', 3800);
    chunks.push(t.slice(0, cut > 0 ? cut : 3800));
    t = t.slice(cut > 0 ? cut + 1 : 3800);
  }
  if (t.length) chunks.push(t);

  for (const chunk of chunks) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'MarkdownV2' }),
      });
    } catch (_) {}
  }
}

async function ffSendTelegramWithButtons_(token, chatId, text, buttons) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 3800),
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: buttons },
      }),
    });
  } catch (_) {}
}

async function ffAnswerCallback_(token, callbackQueryId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || '', show_alert: false }),
    });
  } catch (_) {}
}

// ============================================================
// SECTION 3 — AI SUMMARY (Gemini → Groq → static fallback)
// ============================================================

async function ffAiSummary_(env, prompt) {
  if (env.GEMINI_API_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text && text.length > 20) return text.trim();
    } catch (_) {}
  }

  if (env.GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400,
        }),
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.length > 20) return text.trim();
    } catch (_) {}
  }

  return null;
}

async function ffAiRationale_(env, snap) {
  const prompt =
    `Ты — менеджер фулфилмента. Напиши краткое обоснование (1–2 предложения) для поставки товара на склад WB.\n` +
    `Товар: ${snap.sku_title || snap.vendor_code || snap.nm_id}\n` +
    `Остаток на WB (доступен): ${snap.stock_wb_available} шт.\n` +
    `Средние заказы в день (7д): ${ffRound_(snap.avg_daily_orders_7d, 1)} шт./день\n` +
    `Дней остатка: ${ffRound_(snap.days_of_stock_wb, 1)}\n` +
    `Рекомендуемое кол-во: ${snap.replenishment_qty} шт.\n` +
    `Срочность: ${snap.urgency}\n` +
    `Ответ только на русском, коротко и конкретно.`;

  const result = await ffAiSummary_(env, prompt);
  return result || `Остаток ${snap.stock_wb_available} шт., хватит на ${ffRound_(snap.days_of_stock_wb, 1)} дней при темпе ${ffRound_(snap.avg_daily_orders_7d, 1)} шт./день.`;
}

// ============================================================
// SECTION 4 — SUB-AGENT: FBS MONITOR
// ============================================================

async function runFbsMonitorAgent_(env, db, date) {
  const snapshotDate = date || ffToday_();
  const snapshots = [];
  let criticalCount = 0;
  let highCount = 0;
  let sourceStatus = 'missing';

  // Read WB stock data: prefer wb_stock_snapshot_v2, fallback to wb_stock_snapshot
  let stockRows = [];
  let stockSource = 'missing';

  try {
    const v2res = await db.prepare(
      `SELECT nm_id, sku_title, stock_total as stock_wb_total,
              (stock_total - stock_in_transit - stock_reserved) as stock_wb_available,
              stock_in_transit as stock_wb_in_transit,
              stock_reserved as stock_wb_reserved,
              avg_daily_orders_7d, source_status
       FROM wb_stock_snapshot_v2
       WHERE date=?`
    ).bind(snapshotDate).all();
    if ((v2res.results || []).length > 0) {
      stockRows = v2res.results;
      stockSource = 'wb_stock_snapshot_v2';
    }
  } catch (_) {}

  if (!stockRows.length) {
    try {
      const v1res = await db.prepare(
        `SELECT nm_id, sku_title, stock_total as stock_wb_total,
                stock_total as stock_wb_available,
                0 as stock_wb_in_transit, 0 as stock_wb_reserved,
                0 as avg_daily_orders_7d, source_status
         FROM wb_stock_snapshot
         WHERE date=?`
      ).bind(snapshotDate).all();
      if ((v1res.results || []).length > 0) {
        stockRows = v1res.results;
        stockSource = 'wb_stock_snapshot';
      }
    } catch (_) {}
  }

  if (!stockRows.length) {
    return {
      snapshots: [],
      critical_count: 0,
      high_count: 0,
      source_status: 'missing',
      warning: 'Нет данных об остатках WB на дату ' + snapshotDate,
    };
  }

  sourceStatus = 'ready';

  // Read avg daily orders from wb_sku_snapshot if available (more accurate)
  const skuOrdersMap = {};
  try {
    const skuRes = await db.prepare(
      `SELECT nm_id, orders_count, vendor_code, title, stock_total
       FROM wb_sku_snapshot WHERE date=?`
    ).bind(snapshotDate).all();
    for (const row of (skuRes.results || [])) {
      skuOrdersMap[String(row.nm_id)] = row;
    }
  } catch (_) {}

  for (const row of stockRows) {
    const nmId = row.nm_id;
    const skuRow = skuOrdersMap[String(nmId)] || {};

    // Use sku_snapshot avg if available, else row's own avg, else 0
    let avgDaily = row.avg_daily_orders_7d || 0;
    if (skuRow.orders_count && avgDaily === 0) {
      avgDaily = skuRow.orders_count / 7;
    }

    const available = Math.max(0, row.stock_wb_available ?? row.stock_wb_total ?? 0);
    const daysOfStock = avgDaily > 0 ? available / avgDaily : (available > 0 ? 999 : 0);
    const urgency = ffCalcUrgency_(daysOfStock, available);
    const replenishmentQty = ffCalcReplenishmentQty_(available, avgDaily);
    const replenishmentNeeded = urgency !== FF_URGENCY.NONE ? 1 : 0;

    const rowSourceStatus = row.source_status === 'missing' ? 'missing' : 'ready';

    const snap = {
      id: ffGenerateId_('fbs'),
      snapshot_date: snapshotDate,
      nm_id: nmId,
      vendor_code: skuRow.vendor_code || null,
      sku_title: row.sku_title || skuRow.title || null,
      barcode: null,
      stock_wb_total: row.stock_wb_total || 0,
      stock_wb_available: available,
      stock_wb_in_transit: row.stock_wb_in_transit || 0,
      stock_wb_reserved: row.stock_wb_reserved || 0,
      stock_seller: null,
      avg_daily_orders_7d: ffRound_(avgDaily, 2),
      days_of_stock_wb: daysOfStock < 999 ? ffRound_(daysOfStock, 2) : null,
      replenishment_needed: replenishmentNeeded,
      replenishment_qty: replenishmentQty,
      urgency,
      source_status: rowSourceStatus,
    };

    try {
      await db.prepare(`
        INSERT INTO fulfillment_fbs_snapshot
          (id, snapshot_date, nm_id, vendor_code, sku_title, barcode,
           stock_wb_total, stock_wb_available, stock_wb_in_transit, stock_wb_reserved,
           stock_seller, avg_daily_orders_7d, days_of_stock_wb,
           replenishment_needed, replenishment_qty, urgency, source_status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(snapshot_date, nm_id) DO UPDATE SET
          stock_wb_total=excluded.stock_wb_total,
          stock_wb_available=excluded.stock_wb_available,
          stock_wb_in_transit=excluded.stock_wb_in_transit,
          stock_wb_reserved=excluded.stock_wb_reserved,
          avg_daily_orders_7d=excluded.avg_daily_orders_7d,
          days_of_stock_wb=excluded.days_of_stock_wb,
          replenishment_needed=excluded.replenishment_needed,
          replenishment_qty=excluded.replenishment_qty,
          urgency=excluded.urgency,
          source_status=excluded.source_status
      `).bind(
        snap.id, snap.snapshot_date, snap.nm_id, snap.vendor_code, snap.sku_title, snap.barcode,
        snap.stock_wb_total, snap.stock_wb_available, snap.stock_wb_in_transit, snap.stock_wb_reserved,
        snap.stock_seller, snap.avg_daily_orders_7d, snap.days_of_stock_wb,
        snap.replenishment_needed, snap.replenishment_qty, snap.urgency, snap.source_status
      ).run();
    } catch (_) {}

    snapshots.push(snap);
    if (urgency === FF_URGENCY.CRITICAL) criticalCount++;
    if (urgency === FF_URGENCY.HIGH) highCount++;
  }

  return {
    snapshots,
    critical_count: criticalCount,
    high_count: highCount,
    source_status: sourceStatus,
    stock_source: stockSource,
    date: snapshotDate,
  };
}

// ============================================================
// SECTION 5 — SUB-AGENT: TZ GENERATOR
// ============================================================

async function runTzGeneratorAgent_(env, db, date, fbsResult) {
  const tzDate = date || ffToday_();
  const tzItems = [];
  let totalQty = 0;

  const urgentSnaps = (fbsResult.snapshots || []).filter(
    s => s.urgency === FF_URGENCY.CRITICAL || s.urgency === FF_URGENCY.HIGH
  );

  if (!urgentSnaps.length) {
    return { tz_items: [], total_qty: 0, message: 'Нет позиций для ТЗ' };
  }

  for (const snap of urgentSnaps) {
    if (!snap.replenishment_qty || snap.replenishment_qty <= 0) continue;

    const confirmationId = ffTzConfirmationId_(snap.nm_id);
    const rationale = await ffAiRationale_(env, snap);
    const warehouseTarget = env.FF_DEFAULT_WAREHOUSE || 'Коледино';

    const item = {
      id: ffGenerateId_('tz'),
      tz_date: tzDate,
      nm_id: snap.nm_id,
      vendor_code: snap.vendor_code || null,
      sku_title: snap.sku_title || null,
      barcode: snap.barcode || null,
      warehouse_target: warehouseTarget,
      qty_to_send: snap.replenishment_qty,
      urgency: snap.urgency,
      rationale,
      ai_comment: null,
      status: FF_TZ_STATUS.DRAFT,
      confirmation_id: confirmationId,
      requires_confirmation: 1,
    };

    try {
      await db.prepare(`
        INSERT INTO fulfillment_tz_item
          (id, tz_date, nm_id, vendor_code, sku_title, barcode,
           warehouse_target, qty_to_send, urgency, rationale,
           status, confirmation_id, requires_confirmation)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        item.id, item.tz_date, item.nm_id, item.vendor_code, item.sku_title, item.barcode,
        item.warehouse_target, item.qty_to_send, item.urgency, item.rationale,
        item.status, item.confirmation_id, item.requires_confirmation
      ).run();

      tzItems.push(item);
      totalQty += item.qty_to_send;
    } catch (_) {}
  }

  return { tz_items: tzItems, total_qty: totalQty, date: tzDate };
}

// ============================================================
// SECTION 6 — SUB-AGENT: SUPPLY PLANNER
// ============================================================

async function runSupplyPlannerAgent_(env, db, date, tzItems) {
  const scheduleDate = date || ffToday_();
  const schedules = [];

  // Only group confirmed TZ items — never auto-process drafts
  let confirmedItems = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM fulfillment_tz_item WHERE status='confirmed' AND sent_at IS NULL`
    ).all();
    confirmedItems = res.results || [];
  } catch (_) {}

  if (!confirmedItems.length) {
    return { schedules: [], message: 'Нет подтверждённых ТЗ для планирования поставки' };
  }

  // Group by warehouse_target
  const byWarehouse = {};
  for (const item of confirmedItems) {
    const wh = item.warehouse_target || 'Не указан';
    if (!byWarehouse[wh]) byWarehouse[wh] = [];
    byWarehouse[wh].push(item);
  }

  for (const [warehouse, items] of Object.entries(byWarehouse)) {
    const itemsForJson = items.map(i => ({
      nm_id: i.nm_id,
      vendor_code: i.vendor_code,
      sku_title: i.sku_title,
      barcode: i.barcode,
      qty: i.qty_to_send,
    }));

    const confirmationId = ffScheduleConfirmationId_(warehouse);
    const schedule = {
      id: ffGenerateId_('sched'),
      schedule_date: scheduleDate,
      warehouse_name: warehouse,
      items_json: JSON.stringify(itemsForJson),
      total_items: items.length,
      status: FF_SCHEDULE_STATUS.PLANNED,
      confirmation_id: confirmationId,
      requires_confirmation: 1,
      notes: `Автоплан по ${items.length} подтверждённым ТЗ. Требует ручного подтверждения.`,
    };

    try {
      await db.prepare(`
        INSERT INTO fulfillment_schedule
          (id, schedule_date, warehouse_name, items_json, total_items,
           status, confirmation_id, requires_confirmation, notes)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        schedule.id, schedule.schedule_date, schedule.warehouse_name,
        schedule.items_json, schedule.total_items,
        schedule.status, schedule.confirmation_id, schedule.requires_confirmation, schedule.notes
      ).run();

      schedules.push(schedule);
    } catch (_) {}
  }

  return { schedules, date: scheduleDate };
}

// ============================================================
// SECTION 7 — HANDOFF PROCESSING
// ============================================================

async function processFulfillmentHandoffs_(db) {
  let processed = 0;
  const warnings = [];

  let pendingHandoffs = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM handoff_event
       WHERE to_chief='fulfillment_chief' AND status='pending'
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY created_at ASC LIMIT 50`
    ).all();
    pendingHandoffs = res.results || [];
  } catch (_) {
    return { processed: 0, warnings: ['handoff_event table unavailable'] };
  }

  for (const hof of pendingHandoffs) {
    if (hof.handoff_type === 'fulfillment_tz_needed') {
      let payload = {};
      try { payload = JSON.parse(hof.payload_json || '{}'); } catch (_) {}

      const nmId = hof.nm_id || payload.nm_id || null;
      if (!nmId) {
        warnings.push(`Handoff ${hof.id}: нет nm_id, пропущен`);
        continue;
      }

      const confirmationId = ffTzConfirmationId_(nmId);
      const tzDate = ffToday_();
      const warehouseTarget = payload.warehouse_target || 'Коледино';
      const qty = payload.qty_to_send || payload.replenishment_qty || 1;

      try {
        await db.prepare(`
          INSERT INTO fulfillment_tz_item
            (id, tz_date, nm_id, vendor_code, sku_title, barcode,
             warehouse_target, qty_to_send, urgency, rationale,
             status, confirmation_id, requires_confirmation)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(confirmation_id) DO NOTHING
        `).bind(
          ffGenerateId_('tz_hof'), tzDate, nmId,
          hof.nm_id ? null : payload.vendor_code || null,
          hof.sku_title || payload.sku_title || null,
          payload.barcode || null,
          warehouseTarget, qty,
          'high',
          hof.title || 'Создано из handoff-события',
          FF_TZ_STATUS.DRAFT, confirmationId, 1
        ).run();
        processed++;
      } catch (_) {}
    }

    if (hof.handoff_type === 'stock_critical') {
      // Log warning — fulfillment chief notes this but doesn't auto-act
      warnings.push(`stock_critical для nm_id=${hof.nm_id}: ${hof.title}`);
    }

    // Mark acknowledged regardless of type
    try {
      await db.prepare(
        `UPDATE handoff_event SET status='acknowledged', acknowledged_at=datetime('now'),
           acknowledged_by='fulfillment_chief', updated_at=datetime('now') WHERE id=?`
      ).bind(hof.id).run();
    } catch (_) {}
  }

  return { processed, warnings, total_pending: pendingHandoffs.length };
}

// ============================================================
// SECTION 8 — TELEGRAM FORMAT
// ============================================================

function ffUrgencyIcon_(urgency) {
  return {
    critical: '🔴',
    high:     '🟠',
    medium:   '🟡',
    low:      '🔵',
    none:     '⚪',
  }[urgency] || '⚪';
}

function ffFormatTzItem_(item) {
  const icon = ffUrgencyIcon_(item.urgency);
  const urgencyLabel = {
    critical: '🔴 КРИТИЧНО',
    high:     '🟠 Высокая',
    medium:   '🟡 Средняя',
    low:      '🔵 Низкая',
  }[item.urgency] || item.urgency;

  const lines = [
    `📦 *ТЗ на поставку \\#${ffEscapeMd_(item.id.slice(-8))}*`,
    `Артикул: ${ffEscapeMd_(item.vendor_code || '—')} \\(nmId: ${item.nm_id}\\)`,
    `Товар: ${ffEscapeMd_(item.sku_title || '—')}`,
    `Склад WB: ${ffEscapeMd_(item.warehouse_target || '—')}`,
    `Кол\\-во: *${item.qty_to_send} ед\\.*`,
    `Срочность: ${ffEscapeMd_(urgencyLabel)}`,
    item.rationale ? `Обоснование: ${ffEscapeMd_(item.rationale)}` : null,
    ``,
    `⚠️ _Требует подтверждения перед отправкой_`,
  ].filter(l => l !== null);

  return lines.join('\n');
}

function ffFormatFbsRow_(snap) {
  const icon = ffUrgencyIcon_(snap.urgency);
  const days = snap.days_of_stock_wb !== null ? ffRound_(snap.days_of_stock_wb, 1) : '—';
  const title = (snap.sku_title || snap.vendor_code || String(snap.nm_id)).slice(0, 30);
  return `${icon} ${ffEscapeMd_(title)}: ${snap.stock_wb_available} шт\\. / ${days} дн\\. → +${snap.replenishment_qty}`;
}

function ffBuildChiefSummary_(date, handoffResult, fbsResult, tzResult, schedResult) {
  const lines = [
    `*📦 Fulfillment Chief — отчёт ${ffEscapeMd_(date)}*`,
    ``,
  ];

  if (fbsResult.warning) {
    lines.push(`⚠️ ${ffEscapeMd_(fbsResult.warning)}`);
    lines.push('');
  } else {
    const total = (fbsResult.snapshots || []).length;
    lines.push(`*FBS Мониторинг:* ${total} SKU проверено`);
    lines.push(`🔴 Критично: ${fbsResult.critical_count || 0} | 🟠 Высокая: ${fbsResult.high_count || 0}`);
    lines.push('');
  }

  if ((tzResult.tz_items || []).length) {
    lines.push(`*ТЗ на поставку:* ${tzResult.tz_items.length} позиций, всего ${tzResult.total_qty || 0} ед\\.`);
    lines.push(`_Все ТЗ ожидают подтверждения_`);
    lines.push('');
  } else {
    lines.push(`*ТЗ:* нет срочных позиций`);
    lines.push('');
  }

  if ((schedResult.schedules || []).length) {
    lines.push(`*Поставки запланированы:* ${schedResult.schedules.length} склад\\(ов\\)`);
    lines.push(`_Ожидают подтверждения перед отправкой_`);
    lines.push('');
  }

  if ((handoffResult.warnings || []).length) {
    lines.push(`*⚠️ Предупреждения:*`);
    for (const w of handoffResult.warnings.slice(0, 3)) {
      lines.push(`• ${ffEscapeMd_(w)}`);
    }
    lines.push('');
  }

  lines.push(`_Данные: ${ffEscapeMd_(fbsResult.stock_source || 'н/д')}_`);
  lines.push(`/fulfillment\\_tz — показать ТЗ`);
  lines.push(`/fulfillment\\_fbs — остатки FBS`);

  return lines.join('\n');
}

// ============================================================
// SECTION 9 — CHIEF ORCHESTRATOR
// ============================================================

async function runFulfillmentChief_(env) {
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID || env.FF_CHAT_ID;
  const date = ffToday_();

  await ensureFulfillmentSchema_(db);

  const handoffResult = await processFulfillmentHandoffs_(db);
  const fbsResult     = await runFbsMonitorAgent_(env, db, date);
  const tzResult      = await runTzGeneratorAgent_(env, db, date, fbsResult);
  const schedResult   = await runSupplyPlannerAgent_(env, db, date, tzResult.tz_items || []);

  // AI summary for the daily text
  let aiSummaryText = null;
  if ((fbsResult.snapshots || []).length > 0) {
    const aiPrompt =
      `Ты — аналитик фулфилмента WB. Напиши короткий (3–4 предложения) итог дня на русском.\n` +
      `Дата: ${date}\n` +
      `SKU проверено: ${fbsResult.snapshots.length}\n` +
      `Критично: ${fbsResult.critical_count}, Высокая срочность: ${fbsResult.high_count}\n` +
      `Создано ТЗ: ${tzResult.tz_items.length}, Общее кол-во: ${tzResult.total_qty}\n` +
      `Не давай конкретных рекомендаций по действиям — только факты.`;
    aiSummaryText = await ffAiSummary_(env, aiPrompt);
  }

  const summaryText = ffBuildChiefSummary_(date, handoffResult, fbsResult, tzResult, schedResult);

  if (token && chatId) {
    await ffSendTelegram_(token, chatId, summaryText);
    if (aiSummaryText) {
      await ffSendTelegram_(token, chatId, ffEscapeMd_(aiSummaryText));
    }

    // Send buttons for critical TZ items
    const criticalTz = (tzResult.tz_items || []).filter(i => i.urgency === FF_URGENCY.CRITICAL);
    for (const item of criticalTz.slice(0, 5)) {
      const itemText = ffFormatTzItem_(item);
      await ffSendTelegramWithButtons_(token, chatId, itemText, [[
        { text: '✅ Подтвердить', callback_data: `ff_confirm_tz_${item.id}` },
        { text: '❌ Отклонить',  callback_data: `ff_cancel_tz_${item.id}` },
      ]]);
    }
  }

  return {
    date,
    handoffs: handoffResult,
    fbs: { critical: fbsResult.critical_count, high: fbsResult.high_count, total: (fbsResult.snapshots || []).length },
    tz: { count: tzResult.tz_items.length, total_qty: tzResult.total_qty },
    schedules: (schedResult.schedules || []).length,
  };
}

// ============================================================
// SECTION 10 — TELEGRAM COMMAND ROUTING
// ============================================================

async function routeFulfillmentTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();
  const token = env.TELEGRAM_BOT_TOKEN;
  const db = env.DB;

  if (!text.startsWith('/fulfillment')) return false;

  try {
    await ensureFulfillmentSchema_(db);

    // /fulfillment or /fulfillment_report
    if (text === '/fulfillment' || text === '/fulfillment_report') {
      const result = await runFulfillmentChief_(env);
      await ffSendTelegram_(token, chatId,
        `✅ Fulfillment Chief выполнен\\. ТЗ создано: ${result.tz?.count || 0}\\.`
      );
      return true;
    }

    // /fulfillment_handoffs
    if (text === '/fulfillment_handoffs') {
      let rows = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM handoff_event WHERE to_chief='fulfillment_chief' AND status='pending'
           ORDER BY created_at DESC LIMIT 20`
        ).all();
        rows = res.results || [];
      } catch (_) {}

      if (!rows.length) {
        await ffSendTelegram_(token, chatId, `*Fulfillment Handoffs*\n\nНет pending событий\\.`);
        return true;
      }

      const lines = [`*📨 Handoffs → Fulfillment* \\(${rows.length}\\):\n`];
      for (const r of rows) {
        const icon = ffUrgencyIcon_(r.priority);
        lines.push(`${icon} ${ffEscapeMd_(r.title)}`);
        lines.push(`  _Тип: ${ffEscapeMd_(r.handoff_type)}, ${ffEscapeMd_(r.created_at?.slice(0, 10) || '—')}_`);
      }
      await ffSendTelegram_(token, chatId, lines.join('\n'));
      return true;
    }

    // /fulfillment_tz
    if (text === '/fulfillment_tz') {
      let rows = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM fulfillment_tz_item WHERE status='draft'
           ORDER BY urgency DESC, created_at DESC LIMIT 20`
        ).all();
        rows = res.results || [];
      } catch (_) {}

      if (!rows.length) {
        await ffSendTelegram_(token, chatId, `*ТЗ на поставку*\n\nНет ТЗ, ожидающих подтверждения\\.`);
        return true;
      }

      await ffSendTelegram_(token, chatId, `*📦 ТЗ на поставку \\(draft\\):* ${rows.length} позиций\n`);
      for (const item of rows.slice(0, 8)) {
        const itemText = ffFormatTzItem_(item);
        await ffSendTelegramWithButtons_(token, chatId, itemText, [[
          { text: '✅ Подтвердить', callback_data: `ff_confirm_tz_${item.id}` },
          { text: '❌ Отклонить',  callback_data: `ff_cancel_tz_${item.id}` },
        ]]);
      }
      return true;
    }

    // /fulfillment_fbs
    if (text === '/fulfillment_fbs') {
      const today = ffToday_();
      let rows = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM fulfillment_fbs_snapshot
           WHERE snapshot_date=? AND urgency IN ('critical','high')
           ORDER BY urgency DESC, days_of_stock_wb ASC LIMIT 30`
        ).bind(today).all();
        rows = res.results || [];
      } catch (_) {}

      if (!rows.length) {
        await ffSendTelegram_(token, chatId,
          `*FBS Остатки \\(${ffEscapeMd_(today)}\\)*\n\nНет критичных или высоких позиций\\.`
        );
        return true;
      }

      const lines = [`*📊 FBS Остатки \\(${ffEscapeMd_(today)}\\)* — критично \\+ высокая:\n`];
      for (const s of rows) {
        lines.push(ffFormatFbsRow_(s));
      }
      lines.push(`\n_Всего позиций: ${rows.length}_`);
      await ffSendTelegram_(token, chatId, lines.join('\n'));
      return true;
    }

    // /fulfillment_schedule
    if (text === '/fulfillment_schedule') {
      let rows = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM fulfillment_schedule
           WHERE status IN ('planned','confirmed')
           ORDER BY schedule_date DESC LIMIT 10`
        ).all();
        rows = res.results || [];
      } catch (_) {}

      if (!rows.length) {
        await ffSendTelegram_(token, chatId, `*График поставок*\n\nНет плановых или подтверждённых поставок\\.`);
        return true;
      }

      const lines = [`*🗓 График поставок \\(planned \\+ confirmed\\):*\n`];
      for (const s of rows) {
        const statusIcon = s.status === 'confirmed' ? '✅' : '🕐';
        lines.push(`${statusIcon} ${ffEscapeMd_(s.schedule_date)} — ${ffEscapeMd_(s.warehouse_name || '—')} \\(${s.total_items} SKU\\)`);
        if (s.status === 'planned') {
          lines.push(`  _Ожидает подтверждения_`);
        }
      }
      await ffSendTelegram_(token, chatId, lines.join('\n'));
      return true;
    }
  } catch (e) {
    await ffSendTelegram_(token, chatId, `Ошибка: ${ffEscapeMd_(String(e).slice(0, 200))}`);
    return true;
  }

  return false;
}

// ============================================================
// SECTION 11 — CALLBACK ROUTING
// ============================================================

async function routeFulfillmentCallbackQuery_(env, cq) {
  const data = cq?.data || '';
  if (!data.startsWith('ff_')) return false;

  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const userId = String(cq?.from?.id || 'unknown');

  const answer = (text) => ffAnswerCallback_(token, cq.id, text);

  try {
    // ff_confirm_tz_<id>
    if (data.startsWith('ff_confirm_tz_')) {
      const id = data.slice('ff_confirm_tz_'.length);
      const item = await db.prepare(`SELECT * FROM fulfillment_tz_item WHERE id=?`).bind(id).first();
      if (!item) { await answer('ТЗ не найдено'); return true; }
      if (item.status !== FF_TZ_STATUS.DRAFT) {
        await answer(item.status === FF_TZ_STATUS.CONFIRMED ? 'Уже подтверждено' : 'Нельзя подтвердить: ' + item.status);
        return true;
      }
      await db.prepare(
        `UPDATE fulfillment_tz_item SET status='confirmed', confirmed_at=datetime('now'), confirmed_by=? WHERE id=?`
      ).bind(userId, id).run();
      await answer('✅ ТЗ подтверждено. Ожидает отправки.');
      return true;
    }

    // ff_cancel_tz_<id>
    if (data.startsWith('ff_cancel_tz_')) {
      const id = data.slice('ff_cancel_tz_'.length);
      const item = await db.prepare(`SELECT status FROM fulfillment_tz_item WHERE id=?`).bind(id).first();
      if (!item) { await answer('ТЗ не найдено'); return true; }
      if (item.status === FF_TZ_STATUS.SENT) { await answer('ТЗ уже отправлено, нельзя отменить'); return true; }
      await db.prepare(
        `UPDATE fulfillment_tz_item SET status='cancelled' WHERE id=?`
      ).bind(id).run();
      await answer('❌ ТЗ отменено');
      return true;
    }

    // ff_confirm_schedule_<id>
    if (data.startsWith('ff_confirm_schedule_')) {
      const id = data.slice('ff_confirm_schedule_'.length);
      const sched = await db.prepare(`SELECT * FROM fulfillment_schedule WHERE id=?`).bind(id).first();
      if (!sched) { await answer('График не найден'); return true; }
      if (sched.status !== FF_SCHEDULE_STATUS.PLANNED) {
        await answer('Статус: ' + sched.status + ' — нельзя подтвердить');
        return true;
      }
      await db.prepare(
        `UPDATE fulfillment_schedule SET status='confirmed', confirmed_at=datetime('now'), confirmed_by=? WHERE id=?`
      ).bind(userId, id).run();
      await answer('✅ График поставки подтверждён. Требует ручной отправки на склад.');
      return true;
    }
  } catch (e) {
    await answer('Ошибка обработки');
  }

  return false;
}

// ============================================================
// SECTION 12 — API ROUTES
// ============================================================

async function handleFulfillmentRoutes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.DB;

  if (!path.startsWith('/agent/fulfillment')) return null;

  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    await ensureFulfillmentSchema_(db);

    // GET /agent/fulfillment/fbs
    if (path === '/agent/fulfillment/fbs' && request.method === 'GET') {
      const date = url.searchParams.get('date') || ffToday_();
      const urgency = url.searchParams.get('urgency') || null;
      let sql = `SELECT * FROM fulfillment_fbs_snapshot WHERE snapshot_date=?`;
      const params = [date];
      if (urgency) { sql += ` AND urgency=?`; params.push(urgency); }
      sql += ` ORDER BY urgency DESC, days_of_stock_wb ASC LIMIT 200`;
      const res = await db.prepare(sql).bind(...params).all();
      const rows = res.results || [];
      return json({ ok: true, date, rows, count: rows.length });
    }

    // GET /agent/fulfillment/tz
    if (path === '/agent/fulfillment/tz' && request.method === 'GET') {
      const status = url.searchParams.get('status') || null;
      let sql = `SELECT * FROM fulfillment_tz_item WHERE 1=1`;
      const params = [];
      if (status) { sql += ` AND status=?`; params.push(status); }
      sql += ` ORDER BY urgency DESC, created_at DESC LIMIT 200`;
      const res = params.length
        ? await db.prepare(sql).bind(...params).all()
        : await db.prepare(sql).all();
      const rows = res.results || [];
      return json({ ok: true, rows, count: rows.length });
    }

    // GET /agent/fulfillment/schedule
    if (path === '/agent/fulfillment/schedule' && request.method === 'GET') {
      const status = url.searchParams.get('status') || null;
      let sql = `SELECT * FROM fulfillment_schedule WHERE 1=1`;
      const params = [];
      if (status) { sql += ` AND status=?`; params.push(status); }
      sql += ` ORDER BY schedule_date DESC LIMIT 100`;
      const res = params.length
        ? await db.prepare(sql).bind(...params).all()
        : await db.prepare(sql).all();
      const rows = res.results || [];
      return json({ ok: true, rows, count: rows.length });
    }

    // POST /agent/fulfillment/report/run
    if (path === '/agent/fulfillment/report/run' && request.method === 'POST') {
      const result = await runFulfillmentChief_(env);
      return json({ ok: true, result });
    }

    // POST /agent/fulfillment/tz/:id/confirm
    const tzConfirmMatch = path.match(/^\/agent\/fulfillment\/tz\/([^/]+)\/confirm$/);
    if (tzConfirmMatch && request.method === 'POST') {
      const id = tzConfirmMatch[1];
      const body = await request.json().catch(() => ({}));
      const item = await db.prepare(`SELECT * FROM fulfillment_tz_item WHERE id=?`).bind(id).first();
      if (!item) return json({ ok: false, error: 'not_found' }, 404);
      if (item.status !== FF_TZ_STATUS.DRAFT) return json({ ok: false, error: 'not_draft', status: item.status }, 409);
      await db.prepare(
        `UPDATE fulfillment_tz_item SET status='confirmed', confirmed_at=datetime('now'), confirmed_by=? WHERE id=?`
      ).bind(body.user_id || 'api', id).run();
      return json({ ok: true, id, status: 'confirmed' });
    }

    // POST /agent/fulfillment/tz/:id/cancel
    const tzCancelMatch = path.match(/^\/agent\/fulfillment\/tz\/([^/]+)\/cancel$/);
    if (tzCancelMatch && request.method === 'POST') {
      const id = tzCancelMatch[1];
      const item = await db.prepare(`SELECT status FROM fulfillment_tz_item WHERE id=?`).bind(id).first();
      if (!item) return json({ ok: false, error: 'not_found' }, 404);
      if (item.status === FF_TZ_STATUS.SENT) return json({ ok: false, error: 'already_sent' }, 409);
      await db.prepare(`UPDATE fulfillment_tz_item SET status='cancelled' WHERE id=?`).bind(id).run();
      return json({ ok: true, id, status: 'cancelled' });
    }
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }

  return null;
}
// ============================================================
// Procurement Chief — AI Закупки (v1)
// Build: ai_helpers_procurement_chief_v1
//
// Manages reorder point monitoring, supplier order planning,
// price risk checking, and procurement handoff processing.
// NEVER auto-sends emails, NEVER auto-confirms orders,
// NEVER creates orders in any external system.
// All proposals: requires_confirmation = 1.
// Missing data → source_status='missing', NEVER count as zero.
//
// TABLES:
//   procurement_order          — order drafts per SKU
//   procurement_handoff_item   — handoff tracking per event
//   procurement_price_history  — supplier price log
//
// SUB-AGENTS:
//   runReorderPointAgent_      — reads snapshots, classifies urgency
//   runSupplierOrderPlannerAgent_ — drafts procurement_order rows
//   runPriceRiskAgent_         — flags orders with price risk
//
// TELEGRAM COMMANDS:
//   /procurement or /procurement_report — run chief, show summary
//   /procurement_handoffs    — pending handoff items
//   /procurement_orders      — draft orders awaiting confirmation
//   /procurement_suppliers   — active suppliers from directory
//
// CALLBACKS:
//   proc_confirm_order_<id>   — confirm order draft
//   proc_cancel_order_<id>    — cancel order draft
//   proc_view_supplier_<id>   — show supplier details (edit message)
//
// API:
//   GET  /agent/procurement/handoffs
//   GET  /agent/procurement/orders?status=draft
//   GET  /agent/procurement/suppliers
//   POST /agent/procurement/report/run
//   POST /agent/procurement/orders/:id/confirm
//   POST /agent/procurement/orders/:id/cancel
//   POST /agent/procurement/prices
// ============================================================

const PROC_CHIEF_BUILD = 'ai_helpers_procurement_chief_v1';
const PROC_CHIEF_NAME  = 'procurement_chief';

const PROC_ORDER_STATUS = {
  DRAFT:     'draft',
  CONFIRMED: 'confirmed',
  SENT:      'sent',
  CANCELLED: 'cancelled',
};

const PROC_URGENCY = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low',
};

const PROC_URGENCY_THRESHOLDS = {
  critical: 3,
  high:     7,
  medium:   14,
};

// ============================================================
// SECTION 1 — SCHEMA
// ============================================================

async function ensureProcurementChiefSchema_(db) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS procurement_order (
      id TEXT PRIMARY KEY,
      order_date TEXT NOT NULL,
      supplier_id TEXT,
      supplier_name TEXT,
      nm_id INTEGER,
      vendor_code TEXT,
      sku_title TEXT,
      qty_requested INTEGER NOT NULL,
      estimated_unit_cost REAL,
      estimated_total_cost REAL,
      currency TEXT DEFAULT 'RUB',
      urgency TEXT DEFAULT 'medium',
      rationale TEXT,
      ai_comment TEXT,
      status TEXT DEFAULT 'draft',
      confirmation_id TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      confirmed_at TEXT,
      confirmed_by TEXT,
      sent_at TEXT,
      source_handoff_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS procurement_handoff_item (
      id TEXT PRIMARY KEY,
      handoff_event_id TEXT NOT NULL,
      nm_id INTEGER,
      vendor_code TEXT,
      sku_title TEXT,
      handoff_type TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'pending',
      order_id TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS procurement_price_history (
      id TEXT PRIMARY KEY,
      nm_id INTEGER NOT NULL,
      vendor_code TEXT,
      supplier_id TEXT,
      supplier_name TEXT,
      price_date TEXT NOT NULL,
      unit_cost REAL NOT NULL,
      currency TEXT DEFAULT 'RUB',
      min_order_qty INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(nm_id, supplier_id, price_date)
    )`,
  ];

  for (const sql of tables) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }

  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_proc_order_status ON procurement_order(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_proc_order_nm ON procurement_order(nm_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_proc_order_urgency ON procurement_order(urgency, status)`,
    `CREATE INDEX IF NOT EXISTS idx_proc_hof_item_event ON procurement_handoff_item(handoff_event_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_proc_hof_item_status ON procurement_handoff_item(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_proc_price_nm ON procurement_price_history(nm_id, price_date DESC)`,
  ];

  for (const sql of indexes) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
}

// ============================================================
// SECTION 2 — HELPERS
// ============================================================

function procGenerateId_() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return 'proc_' + ts + '_' + rand;
}

function procOrderConfirmationId_(nmId) {
  return `proc_order_${nmId}_${Date.now().toString(36)}`;
}

function procPriceHistoryId_() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return 'pph_' + ts + '_' + rand;
}

function procToday_() {
  return new Date().toISOString().slice(0, 10);
}

function procRound_(val, dec) {
  if (val === null || val === undefined || isNaN(val)) return 0;
  const m = Math.pow(10, dec || 0);
  return Math.round(val * m) / m;
}

function procEscapeMd_(text) {
  return String(text || '').replace(/[_*[\]()~>#+=|{}.!\-\\]/g, '\\$&');
}

function procUrgencyIcon_(urgency) {
  return { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[urgency] || '⚪';
}

function procClassifyUrgency_(daysOfStock) {
  if (daysOfStock === null || daysOfStock === undefined) return PROC_URGENCY.MEDIUM;
  if (daysOfStock < PROC_URGENCY_THRESHOLDS.critical) return PROC_URGENCY.CRITICAL;
  if (daysOfStock < PROC_URGENCY_THRESHOLDS.high)     return PROC_URGENCY.HIGH;
  if (daysOfStock < PROC_URGENCY_THRESHOLDS.medium)   return PROC_URGENCY.MEDIUM;
  return PROC_URGENCY.LOW;
}

async function procSendTelegram_(token, chatId, text) {
  let t = text;
  const chunks = [];
  while (t.length > 3800) {
    const cut = t.lastIndexOf('\n', 3800);
    chunks.push(t.slice(0, cut > 0 ? cut : 3800));
    t = t.slice(cut > 0 ? cut + 1 : 3800);
  }
  if (t.length) chunks.push(t);

  for (const chunk of chunks) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'MarkdownV2' }),
      });
    } catch (_) {}
  }
}

async function procSendTelegramWithButtons_(token, chatId, text, buttons) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 3800),
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: buttons },
      }),
    });
  } catch (_) {}
}

async function procEditMessage_(token, chatId, messageId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, 3800),
        parse_mode: 'MarkdownV2',
      }),
    });
  } catch (_) {}
}

async function procAnswerCallback_(token, callbackQueryId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || '', show_alert: false }),
    });
  } catch (_) {}
}

// ============================================================
// SECTION 3 — AI HELPER (Gemini → Groq → static fallback)
// ============================================================

async function callProcurementAi_(env, prompt) {
  if (env.GEMINI_API_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text && text.length > 20) return text.trim();
    } catch (_) {}
  }

  if (env.GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400,
        }),
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text && text.length > 20) return text.trim();
    } catch (_) {}
  }

  return null;
}

async function procAiOrderRationale_(env, item) {
  const prompt =
    `Ты — менеджер по закупкам WB. Напиши краткое обоснование (1–2 предложения) для закупки товара у поставщика.\n` +
    `Товар: ${item.sku_title || item.vendor_code || item.nm_id}\n` +
    `Остаток дней: ${item.days_of_stock !== undefined ? procRound_(item.days_of_stock, 1) : 'н/д'}\n` +
    `Рекомендуемое кол-во: ${item.recommended_order_qty || item.qty_requested} шт.\n` +
    `Срочность: ${item.urgency}\n` +
    `Ответ только на русском, коротко и конкретно.`;
  const result = await callProcurementAi_(env, prompt);
  return result || `Остаток на ${procRound_(item.days_of_stock || 0, 1)} дн., рекомендовано закупить ${item.recommended_order_qty || item.qty_requested} шт.`;
}

async function procAiWeeklySummary_(env, stats) {
  const prompt =
    `Ты — аналитик закупок WB. Напиши краткий итог недели по закупкам (3–4 предложения).\n` +
    `Дата: ${stats.date}\n` +
    `Позиций на контроле: ${stats.total_items}\n` +
    `Критично: ${stats.critical_count}, Высокая: ${stats.high_count}, Средняя: ${stats.medium_count}\n` +
    `Черновиков заказов создано: ${stats.orders_created}\n` +
    `Позиций с ценовым риском: ${stats.risk_flags_count}\n` +
    `Не давай конкретных команд — только факты и краткий вывод.`;
  return await callProcurementAi_(env, prompt);
}

// ============================================================
// SECTION 4 — SUB-AGENT: REORDER POINT MONITOR
// ============================================================

async function runReorderPointAgent_(env, db, date) {
  const snapshotDate = date || procToday_();
  const items = [];
  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let sourceStatus = 'missing';

  // Read wb_procurement_snapshot for items needing order
  let procRows = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM wb_procurement_snapshot
       WHERE (procurement_status = 'order_needed' OR recommended_order_qty > 0)
       ORDER BY days_of_stock ASC LIMIT 200`
    ).all();
    procRows = res.results || [];
  } catch (_) {}

  if (!procRows.length) {
    // Fall back: read all rows for date
    try {
      const res = await db.prepare(
        `SELECT * FROM wb_procurement_snapshot WHERE date = ? ORDER BY days_of_stock ASC LIMIT 200`
      ).bind(snapshotDate).all();
      procRows = res.results || [];
    } catch (_) {}
  }

  // Also read wb_stock_snapshot_v2 for critical items
  let stockCriticalRows = [];
  try {
    const res = await db.prepare(
      `SELECT nm_id, sku_title, vendor_code, days_of_stock, stock_total,
              avg_daily_orders_7d, recommended_supply_qty, risk_level, source_status
       FROM wb_stock_snapshot_v2
       WHERE date = ? AND risk_level = 'critical'
       ORDER BY days_of_stock ASC LIMIT 100`
    ).bind(snapshotDate).all();
    stockCriticalRows = res.results || [];
  } catch (_) {}

  if (!procRows.length && !stockCriticalRows.length) {
    return {
      items: [],
      critical_count: 0,
      high_count: 0,
      medium_count: 0,
      source_status: 'missing',
      warning: `Нет данных о закупках на дату ${snapshotDate}`,
    };
  }

  sourceStatus = 'ready';

  // Index stock critical rows by nm_id for enrichment
  const stockMap = {};
  for (const row of stockCriticalRows) {
    stockMap[String(row.nm_id)] = row;
  }

  // Process procurement snapshot rows
  const processedNmIds = new Set();
  for (const row of procRows) {
    if (row.source_status === 'missing') continue;

    const nmId = row.nm_id;
    processedNmIds.add(String(nmId));

    const daysOfStock = row.days_of_stock;
    const urgency = procClassifyUrgency_(daysOfStock);

    const item = {
      nm_id: nmId,
      vendor_code: row.vendor_code || null,
      sku_title: row.sku_title || null,
      days_of_stock: daysOfStock,
      stock_total: row.stock_total || 0,
      avg_daily_orders_7d: row.avg_daily_orders_7d || 0,
      recommended_order_qty: row.recommended_order_qty || 0,
      supplier_id: row.supplier_id || null,
      procurement_status: row.procurement_status || null,
      urgency,
      source: 'wb_procurement_snapshot',
    };

    items.push(item);
    if (urgency === PROC_URGENCY.CRITICAL) criticalCount++;
    else if (urgency === PROC_URGENCY.HIGH) highCount++;
    else if (urgency === PROC_URGENCY.MEDIUM) mediumCount++;
  }

  // Add critical stock items not already in procurement snapshot
  for (const row of stockCriticalRows) {
    if (processedNmIds.has(String(row.nm_id))) continue;
    if (row.source_status === 'missing') continue;

    const item = {
      nm_id: row.nm_id,
      vendor_code: row.vendor_code || null,
      sku_title: row.sku_title || null,
      days_of_stock: row.days_of_stock,
      stock_total: row.stock_total || 0,
      avg_daily_orders_7d: row.avg_daily_orders_7d || 0,
      recommended_order_qty: row.recommended_supply_qty || 0,
      supplier_id: null,
      procurement_status: 'order_needed',
      urgency: PROC_URGENCY.CRITICAL,
      source: 'wb_stock_snapshot_v2',
    };

    items.push(item);
    criticalCount++;
  }

  // Sort: critical first, then by days_of_stock asc
  items.sort((a, b) => {
    const w = { critical: 4, high: 3, medium: 2, low: 1 };
    if (w[b.urgency] !== w[a.urgency]) return w[b.urgency] - w[a.urgency];
    return (a.days_of_stock || 999) - (b.days_of_stock || 999);
  });

  return {
    items,
    critical_count: criticalCount,
    high_count: highCount,
    medium_count: mediumCount,
    source_status: sourceStatus,
    date: snapshotDate,
  };
}

// ============================================================
// SECTION 5 — SUB-AGENT: SUPPLIER ORDER PLANNER
// ============================================================

async function runSupplierOrderPlannerAgent_(env, db, date, reorderItems) {
  const orderDate = date || procToday_();
  const ordersCreated = [];
  let totalCostEstimate = 0;

  const urgentItems = (reorderItems.items || []).filter(
    i => i.urgency === PROC_URGENCY.CRITICAL || i.urgency === PROC_URGENCY.HIGH
  );

  if (!urgentItems.length) {
    return { orders_created: [], total_cost_estimate: 0, message: 'Нет позиций для заказа' };
  }

  for (const item of urgentItems) {
    const nmId = item.nm_id;

    // Look up supplier in supplier_directory
    let supplier = null;
    if (item.supplier_id) {
      try {
        supplier = await db.prepare(
          `SELECT * FROM supplier_directory WHERE id = ? LIMIT 1`
        ).bind(item.supplier_id).first();
      } catch (_) {}
    }

    // If no supplier found by id, try by nm_id
    if (!supplier) {
      try {
        supplier = await db.prepare(
          `SELECT * FROM supplier_directory WHERE nm_id = ? AND status = 'active' LIMIT 1`
        ).bind(nmId).first();
      } catch (_) {}
    }

    const minOrderQty = supplier?.min_order_qty || 1;
    const recommendedQty = item.recommended_order_qty || 1;
    const qtyRequested = Math.max(recommendedQty, minOrderQty);

    // Get cost per unit: try wb_cost_data, then wb_procurement_snapshot
    let costPerUnit = null;
    try {
      const costRow = await db.prepare(
        `SELECT cost_per_unit FROM wb_cost_data WHERE nm_id = ? ORDER BY created_at DESC LIMIT 1`
      ).bind(nmId).first();
      if (costRow?.cost_per_unit) costPerUnit = costRow.cost_per_unit;
    } catch (_) {}

    if (!costPerUnit) {
      try {
        const snapRow = await db.prepare(
          `SELECT cost_per_unit FROM wb_procurement_snapshot WHERE nm_id = ? ORDER BY date DESC LIMIT 1`
        ).bind(nmId).first();
        if (snapRow?.cost_per_unit) costPerUnit = snapRow.cost_per_unit;
      } catch (_) {}
    }

    const estimatedTotalCost = (costPerUnit && qtyRequested)
      ? procRound_(costPerUnit * qtyRequested, 2)
      : null;

    const rationale = await procAiOrderRationale_(env, { ...item, qty_requested: qtyRequested });
    const confirmationId = procOrderConfirmationId_(nmId);

    const order = {
      id: procGenerateId_(),
      order_date: orderDate,
      supplier_id: supplier?.id || item.supplier_id || null,
      supplier_name: supplier?.name || supplier?.supplier_name || null,
      nm_id: nmId,
      vendor_code: item.vendor_code || null,
      sku_title: item.sku_title || null,
      qty_requested: qtyRequested,
      estimated_unit_cost: costPerUnit || null,
      estimated_total_cost: estimatedTotalCost,
      currency: 'RUB',
      urgency: item.urgency,
      rationale,
      ai_comment: null,
      status: PROC_ORDER_STATUS.DRAFT,
      confirmation_id: confirmationId,
      requires_confirmation: 1,
      source_handoff_id: null,
    };

    try {
      await db.prepare(`
        INSERT INTO procurement_order
          (id, order_date, supplier_id, supplier_name, nm_id, vendor_code, sku_title,
           qty_requested, estimated_unit_cost, estimated_total_cost, currency, urgency,
           rationale, ai_comment, status, confirmation_id, requires_confirmation, source_handoff_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        order.id, order.order_date, order.supplier_id, order.supplier_name,
        order.nm_id, order.vendor_code, order.sku_title,
        order.qty_requested, order.estimated_unit_cost, order.estimated_total_cost,
        order.currency, order.urgency, order.rationale, order.ai_comment,
        order.status, order.confirmation_id, order.requires_confirmation, order.source_handoff_id
      ).run();

      ordersCreated.push(order);
      if (estimatedTotalCost) totalCostEstimate += estimatedTotalCost;
    } catch (_) {}
  }

  return {
    orders_created: ordersCreated,
    total_cost_estimate: procRound_(totalCostEstimate, 2),
    date: orderDate,
  };
}

// ============================================================
// SECTION 6 — SUB-AGENT: PRICE RISK CHECKER
// ============================================================

async function runPriceRiskAgent_(env, db, date, orders) {
  const riskFlags = [];

  for (const order of (orders.orders_created || [])) {
    const nmId = order.nm_id;
    if (!order.estimated_unit_cost) continue;

    let riskResult = null;

    // Try checkPurchasePriceRisk_ from wb_operations_stage2_patch.gs
    try {
      if (typeof checkPurchasePriceRisk_ === 'function') {
        let costData = null;
        try {
          costData = await db.prepare(
            `SELECT price_after_commission, logistics_rub, storage_per_day_rub, tax_pct
             FROM wb_cost_data WHERE nm_id = ? ORDER BY created_at DESC LIMIT 1`
          ).bind(nmId).first();
        } catch (_) {}

        if (costData) {
          riskResult = checkPurchasePriceRisk_(order.estimated_unit_cost, costData, null);
        }
      }
    } catch (_) {}

    // Fallback: if estimated_unit_cost > historical_cost * 1.3 → flag risky
    if (!riskResult) {
      try {
        const histRow = await db.prepare(
          `SELECT unit_cost FROM procurement_price_history
           WHERE nm_id = ? ORDER BY price_date DESC LIMIT 1`
        ).bind(nmId).first();

        if (histRow?.unit_cost && order.estimated_unit_cost > histRow.unit_cost * 1.3) {
          riskResult = {
            risk: true,
            excess_rub: procRound_(order.estimated_unit_cost - histRow.unit_cost * 1.3, 2),
            max_allowed_cost: procRound_(histRow.unit_cost * 1.3, 2),
            purchase_price: order.estimated_unit_cost,
            reason: 'exceeds_historical_by_30pct',
          };
        }
      } catch (_) {}
    }

    if (riskResult?.risk) {
      riskFlags.push({
        order_id: order.id,
        nm_id: nmId,
        sku_title: order.sku_title,
        estimated_unit_cost: order.estimated_unit_cost,
        max_allowed_cost: riskResult.max_allowed_cost,
        excess_rub: riskResult.excess_rub,
        reason: riskResult.reason || 'price_exceeds_threshold',
      });

      try {
        await db.prepare(
          `UPDATE procurement_order SET ai_comment = ? WHERE id = ?`
        ).bind(
          `Ценовой риск: закупочная цена ${order.estimated_unit_cost} руб. превышает допустимую на ${riskResult.excess_rub || '?'} руб.`,
          order.id
        ).run();
      } catch (_) {}
    }
  }

  return { risk_flags: riskFlags };
}

// ============================================================
// SECTION 7 — HANDOFF PROCESSING
// ============================================================

async function processProcurementHandoffs_(db) {
  let processed = 0;
  const warnings = [];

  let pendingHandoffs = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM handoff_event
       WHERE to_chief = 'procurement_chief' AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY created_at ASC LIMIT 100`
    ).all();
    pendingHandoffs = res.results || [];
  } catch (_) {
    return { processed: 0, warnings: ['handoff_event table unavailable'], total_pending: 0 };
  }

  const handoffTypes = new Set(['supply_needed', 'stock_critical', 'stock_low']);

  for (const hof of pendingHandoffs) {
    if (!handoffTypes.has(hof.handoff_type)) {
      try {
        await db.prepare(
          `UPDATE handoff_event SET status='acknowledged', acknowledged_at=datetime('now'),
             acknowledged_by='procurement_chief', updated_at=datetime('now') WHERE id=?`
        ).bind(hof.id).run();
      } catch (_) {}
      continue;
    }

    let payload = {};
    try { payload = JSON.parse(hof.payload_json || '{}'); } catch (_) {}

    const itemId = procGenerateId_();
    try {
      await db.prepare(`
        INSERT INTO procurement_handoff_item
          (id, handoff_event_id, nm_id, vendor_code, sku_title, handoff_type,
           priority, status, notes)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT DO NOTHING
      `).bind(
        itemId,
        hof.id,
        hof.nm_id || payload.nm_id || null,
        hof.vendor_code || payload.vendor_code || null,
        hof.sku_title || payload.sku_title || null,
        hof.handoff_type,
        hof.priority || 'medium',
        'pending',
        hof.summary || hof.title || null
      ).run();
      processed++;
    } catch (e) {
      warnings.push(`Ошибка при создании handoff_item для ${hof.id}: ${String(e).slice(0, 80)}`);
    }

    try {
      await db.prepare(
        `UPDATE handoff_event SET status='acknowledged', acknowledged_at=datetime('now'),
           acknowledged_by='procurement_chief', updated_at=datetime('now') WHERE id=?`
      ).bind(hof.id).run();
    } catch (_) {}
  }

  return { processed, warnings, total_pending: pendingHandoffs.length };
}

// ============================================================
// SECTION 8 — TELEGRAM FORMATTING
// ============================================================

function procFormatOrderCard_(order) {
  const icon = procUrgencyIcon_(order.urgency);
  const urgencyLabel = {
    critical: '🔴 КРИТИЧНО',
    high:     '🟠 Высокая',
    medium:   '🟡 Средняя',
    low:      '🔵 Низкая',
  }[order.urgency] || order.urgency;

  const lines = [
    `📋 *Заказ \\#${procEscapeMd_(order.id.slice(-8))}*`,
    `Товар: ${procEscapeMd_(order.sku_title || '—')}`,
    `Артикул: ${procEscapeMd_(order.vendor_code || '—')} \\(nm: ${order.nm_id || '—'}\\)`,
    `Поставщик: ${procEscapeMd_(order.supplier_name || 'не указан')}`,
    `Кол\\-во: *${order.qty_requested} шт\\.*`,
    order.estimated_unit_cost
      ? `Цена/шт: ${procEscapeMd_(String(procRound_(order.estimated_unit_cost, 2)))} руб\\.`
      : null,
    order.estimated_total_cost
      ? `Итого: *${procEscapeMd_(String(procRound_(order.estimated_total_cost, 2)))} руб\\.*`
      : null,
    `Срочность: ${procEscapeMd_(urgencyLabel)}`,
    order.rationale ? `Обоснование: _${procEscapeMd_(order.rationale)}_` : null,
    order.ai_comment ? `⚠️ ${procEscapeMd_(order.ai_comment)}` : null,
    ``,
    `⚠️ _Требует подтверждения\\. Автоотправка поставщику запрещена\\._`,
  ].filter(l => l !== null);

  return lines.join('\n');
}

function procBuildChiefSummary_(date, handoffResult, reorderResult, plannerResult, riskResult) {
  const lines = [
    `*🛒 Procurement Chief — ${procEscapeMd_(date)}*`,
    ``,
  ];

  if (reorderResult.source_status === 'missing') {
    lines.push(`⚠️ ${procEscapeMd_(reorderResult.warning || 'Нет данных о закупках')}`);
    lines.push('');
  } else {
    const total = (reorderResult.items || []).length;
    lines.push(`*Мониторинг заказов:* ${total} позиций`);
    lines.push(`🔴 Критично: ${reorderResult.critical_count || 0} | 🟠 Высокая: ${reorderResult.high_count || 0} | 🟡 Средняя: ${reorderResult.medium_count || 0}`);
    lines.push('');
  }

  const ordersCount = (plannerResult.orders_created || []).length;
  if (ordersCount) {
    lines.push(`*Черновики заказов создано:* ${ordersCount}`);
    lines.push(`Ориентировочная сумма: *${procEscapeMd_(String(plannerResult.total_cost_estimate || 0))} руб\\.*`);
    lines.push(`_Все ожидают подтверждения_`);
    lines.push('');
  } else {
    lines.push(`*Заказов:* нет срочных позиций`);
    lines.push('');
  }

  const riskCount = (riskResult.risk_flags || []).length;
  if (riskCount) {
    lines.push(`*⚠️ Ценовые риски:* ${riskCount} позиций`);
    for (const f of (riskResult.risk_flags || []).slice(0, 3)) {
      lines.push(`  • ${procEscapeMd_(f.sku_title || String(f.nm_id))}: \\+${procEscapeMd_(String(f.excess_rub || '?'))} руб\\.`);
    }
    lines.push('');
  }

  if ((handoffResult.warnings || []).length) {
    lines.push(`*Предупреждения:*`);
    for (const w of handoffResult.warnings.slice(0, 3)) {
      lines.push(`• ${procEscapeMd_(w)}`);
    }
    lines.push('');
  }

  lines.push(`/procurement\\_orders — черновики заказов`);
  lines.push(`/procurement\\_handoffs — pending handoffs`);

  return lines.join('\n');
}

// ============================================================
// SECTION 9 — CHIEF ORCHESTRATOR
// ============================================================

async function runProcurementChief_(env) {
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID || env.PROC_CHAT_ID;
  const date = procToday_();

  await ensureProcurementChiefSchema_(db);

  const handoffResult  = await processProcurementHandoffs_(db);
  const reorderResult  = await runReorderPointAgent_(env, db, date);
  const plannerResult  = await runSupplierOrderPlannerAgent_(env, db, date, reorderResult);
  const riskResult     = await runPriceRiskAgent_(env, db, date, plannerResult);

  const summaryText = procBuildChiefSummary_(date, handoffResult, reorderResult, plannerResult, riskResult);

  let aiSummaryText = null;
  if ((reorderResult.items || []).length > 0) {
    aiSummaryText = await procAiWeeklySummary_(env, {
      date,
      total_items:      (reorderResult.items || []).length,
      critical_count:   reorderResult.critical_count || 0,
      high_count:       reorderResult.high_count || 0,
      medium_count:     reorderResult.medium_count || 0,
      orders_created:   (plannerResult.orders_created || []).length,
      risk_flags_count: (riskResult.risk_flags || []).length,
    });
  }

  if (token && chatId) {
    await procSendTelegram_(token, chatId, summaryText);

    if (aiSummaryText) {
      await procSendTelegram_(token, chatId, procEscapeMd_(aiSummaryText));
    }

    // Show confirmation buttons for critical/high orders
    const urgentOrders = (plannerResult.orders_created || []).filter(
      o => o.urgency === PROC_URGENCY.CRITICAL || o.urgency === PROC_URGENCY.HIGH
    );
    for (const order of urgentOrders.slice(0, 5)) {
      const cardText = procFormatOrderCard_(order);
      await procSendTelegramWithButtons_(token, chatId, cardText, [[
        { text: '✅ Подтвердить', callback_data: `proc_confirm_order_${order.id}` },
        { text: '❌ Отменить',   callback_data: `proc_cancel_order_${order.id}` },
      ]]);
    }
  }

  return {
    date,
    handoffs:   handoffResult,
    reorder:    { critical: reorderResult.critical_count, high: reorderResult.high_count, total: (reorderResult.items || []).length },
    orders:     { count: (plannerResult.orders_created || []).length, total_cost: plannerResult.total_cost_estimate },
    risk_flags: (riskResult.risk_flags || []).length,
  };
}

// ============================================================
// SECTION 10 — TELEGRAM COMMAND ROUTING
// ============================================================

async function routeProcurementTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();
  const token = env.TELEGRAM_BOT_TOKEN;
  const db = env.DB;

  if (!text.startsWith('/procurement')) return false;

  try {
    await ensureProcurementChiefSchema_(db);

    if (text === '/procurement' || text === '/procurement_report') {
      const result = await runProcurementChief_(env);
      await procSendTelegram_(token, chatId,
        `✅ Procurement Chief выполнен\\. Заказов создано: ${result.orders?.count || 0}\\.`
      );
      return true;
    }

    if (text === '/procurement_handoffs') {
      let rows = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM procurement_handoff_item WHERE status = 'pending'
           ORDER BY created_at DESC LIMIT 30`
        ).all();
        rows = res.results || [];
      } catch (_) {}

      if (!rows.length) {
        await procSendTelegram_(token, chatId, `*Procurement Handoffs*\n\nНет pending handoff\\-событий\\.`);
        return true;
      }

      const lines = [`*📨 Procurement Handoffs \\(${rows.length}\\):*\n`];
      for (const r of rows) {
        const icon = procUrgencyIcon_(r.priority);
        const typeLabel = { supply_needed: 'поставка', stock_critical: 'крит\\. остаток', stock_low: 'низкий остаток' }[r.handoff_type] || procEscapeMd_(r.handoff_type || '—');
        lines.push(`${icon} nm:${r.nm_id || '—'} — ${procEscapeMd_(r.sku_title || '—')} \\[${typeLabel}\\]`);
        if (r.notes) lines.push(`  _${procEscapeMd_(r.notes.slice(0, 80))}_`);
      }
      await procSendTelegram_(token, chatId, lines.join('\n'));
      return true;
    }

    if (text === '/procurement_orders') {
      let rows = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM procurement_order WHERE status = 'draft'
           ORDER BY urgency DESC, created_at DESC LIMIT 20`
        ).all();
        rows = res.results || [];
      } catch (_) {}

      if (!rows.length) {
        await procSendTelegram_(token, chatId, `*Заказы \\(черновики\\)*\n\nНет заказов, ожидающих подтверждения\\.`);
        return true;
      }

      await procSendTelegram_(token, chatId, `*🛒 Черновики заказов:* ${rows.length} позиций\n`);
      for (const order of rows.slice(0, 8)) {
        const cardText = procFormatOrderCard_(order);
        await procSendTelegramWithButtons_(token, chatId, cardText, [[
          { text: '✅ Подтвердить', callback_data: `proc_confirm_order_${order.id}` },
          { text: '❌ Отменить',   callback_data: `proc_cancel_order_${order.id}` },
        ]]);
      }
      return true;
    }

    if (text === '/procurement_suppliers') {
      let rows = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM supplier_directory WHERE status = 'active' ORDER BY name ASC LIMIT 30`
        ).all();
        rows = res.results || [];
      } catch (_) {
        try {
          const res2 = await db.prepare(
            `SELECT * FROM supplier_directory WHERE active = 1 ORDER BY supplier_name ASC LIMIT 30`
          ).all();
          rows = res2.results || [];
        } catch (_2) {}
      }

      if (!rows.length) {
        await procSendTelegram_(token, chatId, `*Поставщики*\n\nНет активных поставщиков в справочнике\\.`);
        return true;
      }

      const lines = [`*📦 Активные поставщики \\(${rows.length}\\):*\n`];
      for (const s of rows) {
        const name = s.name || s.supplier_name || String(s.id);
        const minQty = s.min_order_qty ? ` | min: ${s.min_order_qty} шт\\.` : '';
        const leadDays = s.lead_days || s.delivery_days;
        const lead = leadDays ? ` | срок: ${leadDays} дн\\.` : '';
        lines.push(`• ${procEscapeMd_(name)}${minQty}${lead}`);
      }
      await procSendTelegram_(token, chatId, lines.join('\n'));
      return true;
    }
  } catch (e) {
    await procSendTelegram_(token, chatId, `Ошибка: ${procEscapeMd_(String(e).slice(0, 200))}`);
    return true;
  }

  return false;
}

// ============================================================
// SECTION 11 — CALLBACK ROUTING
// ============================================================

async function routeProcurementCallbackQuery_(env, cq) {
  const data = cq?.data || '';
  if (!data.startsWith('proc_')) return false;

  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const userId = String(cq?.from?.id || 'unknown');
  const chatId = cq?.message?.chat?.id;
  const messageId = cq?.message?.message_id;

  const answer = (text) => procAnswerCallback_(token, cq.id, text);

  try {
    if (data.startsWith('proc_confirm_order_')) {
      const id = data.slice('proc_confirm_order_'.length);
      const order = await db.prepare(`SELECT * FROM procurement_order WHERE id = ?`).bind(id).first();
      if (!order) { await answer('Заказ не найден'); return true; }
      if (order.status !== PROC_ORDER_STATUS.DRAFT) {
        await answer(order.status === PROC_ORDER_STATUS.CONFIRMED ? 'Уже подтверждён' : 'Статус: ' + order.status);
        return true;
      }
      await db.prepare(
        `UPDATE procurement_order SET status='confirmed', confirmed_at=datetime('now'), confirmed_by=? WHERE id=?`
      ).bind(userId, id).run();
      await answer('✅ Заказ подтверждён. Автоотправка запрещена — отправьте поставщику вручную.');
      return true;
    }

    if (data.startsWith('proc_cancel_order_')) {
      const id = data.slice('proc_cancel_order_'.length);
      const order = await db.prepare(`SELECT status FROM procurement_order WHERE id = ?`).bind(id).first();
      if (!order) { await answer('Заказ не найден'); return true; }
      if (order.status === PROC_ORDER_STATUS.SENT) { await answer('Заказ уже отправлен, нельзя отменить'); return true; }
      await db.prepare(
        `UPDATE procurement_order SET status='cancelled' WHERE id=?`
      ).bind(id).run();
      await answer('❌ Заказ отменён');
      return true;
    }

    if (data.startsWith('proc_view_supplier_')) {
      const supplierId = data.slice('proc_view_supplier_'.length);
      let supplier = null;
      try {
        supplier = await db.prepare(
          `SELECT * FROM supplier_directory WHERE id = ?`
        ).bind(supplierId).first();
      } catch (_) {}

      if (!supplier) { await answer('Поставщик не найден'); return true; }

      const name = supplier.name || supplier.supplier_name || supplierId;
      const lines = [
        `*🏭 Поставщик: ${procEscapeMd_(name)}*`,
        `ID: ${procEscapeMd_(String(supplierId))}`,
        supplier.contact_name ? `Контакт: ${procEscapeMd_(supplier.contact_name)}` : null,
        supplier.email ? `Email: ${procEscapeMd_(supplier.email)}` : null,
        supplier.phone ? `Тел: ${procEscapeMd_(supplier.phone)}` : null,
        supplier.min_order_qty ? `Мин\\. заказ: ${supplier.min_order_qty} шт\\.` : null,
        supplier.lead_days ? `Срок поставки: ${supplier.lead_days} дн\\.` : null,
        supplier.notes ? `_${procEscapeMd_(String(supplier.notes).slice(0, 150))}_` : null,
        ``,
        `⚠️ _Отправка заказов поставщику — только вручную\\._`,
      ].filter(l => l !== null);

      if (chatId && messageId) {
        await procEditMessage_(token, chatId, messageId, lines.join('\n'));
      }
      await answer('');
      return true;
    }
  } catch (e) {
    await answer('Ошибка обработки');
  }

  return false;
}

// ============================================================
// SECTION 12 — API ROUTES
// ============================================================

async function handleProcurementRoutes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.DB;

  if (!path.startsWith('/agent/procurement')) return null;

  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    await ensureProcurementChiefSchema_(db);

    // GET /agent/procurement/handoffs
    if (path === '/agent/procurement/handoffs' && request.method === 'GET') {
      const status = url.searchParams.get('status') || 'pending';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      let sql = `SELECT * FROM procurement_handoff_item`;
      const params = [];
      if (status !== 'all') { sql += ` WHERE status=?`; params.push(status); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);
      const res = await db.prepare(sql).bind(...params).all();
      const rows = res.results || [];
      return json({ ok: true, rows, count: rows.length });
    }

    // GET /agent/procurement/orders?status=draft
    if (path === '/agent/procurement/orders' && request.method === 'GET') {
      const status = url.searchParams.get('status') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
      let sql = `SELECT * FROM procurement_order WHERE 1=1`;
      const params = [];
      if (status) { sql += ` AND status=?`; params.push(status); }
      sql += ` ORDER BY urgency DESC, created_at DESC LIMIT ?`;
      params.push(limit);
      const res = await db.prepare(sql).bind(...params).all();
      const rows = res.results || [];
      return json({ ok: true, rows, count: rows.length });
    }

    // GET /agent/procurement/suppliers
    if (path === '/agent/procurement/suppliers' && request.method === 'GET') {
      let rows = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM supplier_directory WHERE status='active' ORDER BY name ASC LIMIT 200`
        ).all();
        rows = res.results || [];
      } catch (_) {
        try {
          const res2 = await db.prepare(
            `SELECT * FROM supplier_directory WHERE active=1 ORDER BY supplier_name ASC LIMIT 200`
          ).all();
          rows = res2.results || [];
        } catch (_2) {}
      }
      return json({ ok: true, rows, count: rows.length });
    }

    // POST /agent/procurement/report/run
    if (path === '/agent/procurement/report/run' && request.method === 'POST') {
      const result = await runProcurementChief_(env);
      return json({ ok: true, result });
    }

    // POST /agent/procurement/orders/:id/confirm
    const confirmMatch = path.match(/^\/agent\/procurement\/orders\/([^/]+)\/confirm$/);
    if (confirmMatch && request.method === 'POST') {
      const id = confirmMatch[1];
      const body = await request.json().catch(() => ({}));
      const order = await db.prepare(`SELECT * FROM procurement_order WHERE id=?`).bind(id).first();
      if (!order) return json({ ok: false, error: 'not_found' }, 404);
      if (order.status !== PROC_ORDER_STATUS.DRAFT) {
        return json({ ok: false, error: 'not_draft', status: order.status }, 409);
      }
      await db.prepare(
        `UPDATE procurement_order SET status='confirmed', confirmed_at=datetime('now'), confirmed_by=? WHERE id=?`
      ).bind(body.user_id || 'api', id).run();
      return json({ ok: true, id, status: 'confirmed' });
    }

    // POST /agent/procurement/orders/:id/cancel
    const cancelMatch = path.match(/^\/agent\/procurement\/orders\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method === 'POST') {
      const id = cancelMatch[1];
      const order = await db.prepare(`SELECT status FROM procurement_order WHERE id=?`).bind(id).first();
      if (!order) return json({ ok: false, error: 'not_found' }, 404);
      if (order.status === PROC_ORDER_STATUS.SENT) {
        return json({ ok: false, error: 'already_sent' }, 409);
      }
      await db.prepare(`UPDATE procurement_order SET status='cancelled' WHERE id=?`).bind(id).run();
      return json({ ok: true, id, status: 'cancelled' });
    }

    // POST /agent/procurement/prices
    if (path === '/agent/procurement/prices' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!body.nm_id || !body.supplier_id || !body.unit_cost || !body.price_date) {
        return json({ ok: false, error: 'nm_id, supplier_id, unit_cost, price_date required' }, 400);
      }
      if (isNaN(Number(body.unit_cost)) || Number(body.unit_cost) <= 0) {
        return json({ ok: false, error: 'unit_cost must be a positive number' }, 400);
      }

      let supplierName = null;
      try {
        const sup = await db.prepare(`SELECT name, supplier_name FROM supplier_directory WHERE id=?`)
          .bind(body.supplier_id).first();
        supplierName = sup?.name || sup?.supplier_name || null;
      } catch (_) {}

      const id = procPriceHistoryId_();
      try {
        await db.prepare(`
          INSERT INTO procurement_price_history
            (id, nm_id, vendor_code, supplier_id, supplier_name, price_date,
             unit_cost, currency, min_order_qty, notes)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(nm_id, supplier_id, price_date) DO UPDATE SET
            unit_cost=excluded.unit_cost,
            supplier_name=excluded.supplier_name,
            min_order_qty=excluded.min_order_qty,
            notes=excluded.notes
        `).bind(
          id,
          body.nm_id,
          body.vendor_code || null,
          body.supplier_id,
          supplierName,
          body.price_date,
          Number(body.unit_cost),
          body.currency || 'RUB',
          body.min_order_qty || null,
          body.notes || null
        ).run();
        return json({ ok: true, id });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }

  return null;
}
// ============================================================
// wb_sync_v1.gs — WB Data Synchronisation Pipeline
// Build: ai_helpers_wb_sync_v1
//
// Fetches data from Wildberries API and writes to D1 snapshot
// tables so every chief finds fresh data when it wakes up.
// Runs at 04:30 UTC (after QA at 04:00, before WB chief at 05:00).
//
// ── WB API endpoints used ────────────────────────────────────
// GET statistics-api.wildberries.ru/api/v1/supplier/stocks
// GET statistics-api.wildberries.ru/api/v1/supplier/orders
// GET statistics-api.wildberries.ru/api/v1/supplier/nm-report/grouped
// POST content-api.wildberries.ru/content/v2/get/cards/list
// POST discounts-prices-api.wildberries.ru/api/v2/list/goods/filter
//
// ── Tables written ───────────────────────────────────────────
//   wb_stock_snapshot_v2    — stock levels + avg_daily + urgency
//   wb_sku_snapshot         — order / revenue metrics per nm_id
//   design_card_snapshot    — card content quality metrics
//   wb_cost_data            — price / cost data
//   wb_procurement_snapshot — derived: days_of_stock, reorder qty
//   wb_sync_log             — sync run history
//
// ── Safety rules ─────────────────────────────────────────────
//   - Never writes requires_confirmation records
//   - Never modifies proposals or action records
//   - source_status = 'missing' if WB_API_TOKEN absent
//   - source_status = 'api_error' on network failure
//   - ON CONFLICT … DO UPDATE — safe to re-run
// ============================================================

const WB_SYNC_STATS_BASE   = 'https://statistics-api.wildberries.ru';
const WB_SYNC_CONTENT_BASE = 'https://content-api.wildberries.ru';
const WB_SYNC_PRICES_BASE  = 'https://discounts-prices-api.wildberries.ru';
const WB_SYNC_TIMEOUT_MS   = 25000;

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureWbSyncSchema_(env) {
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS wb_sync_log (
        id              TEXT PRIMARY KEY,
        sync_date       TEXT NOT NULL,
        sync_type       TEXT NOT NULL,
        status          TEXT DEFAULT 'running',
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        duration_ms     INTEGER,
        records_written INTEGER DEFAULT 0,
        error           TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
      )
    `).run();
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_wb_sync_log_date
        ON wb_sync_log(sync_date, sync_type)
    `).run();
  } catch (_) {}
}

// ── ID helper ──────────────────────────────────────────────────────────────

function wbSyncGenId_(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function wbSyncGet_(token, url) {
  const res = await fetch(url, {
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(WB_SYNC_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} GET ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function wbSyncPost_(token, url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WB_SYNC_TIMEOUT_MS),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} POST ${url}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ── §1 Stock sync → wb_stock_snapshot_v2 ───────────────────────────────────
//
// WB returns one row per (nm_id, warehouse). Aggregate by nm_id:
//   stock_total      = quantity + inWayToClient + inWayFromClient
//   stock_in_transit = inWayToClient   (on the way to buyer)
//   stock_reserved   = inWayFromClient (returns in transit)
// The "available for new orders" qty is `quantity` — stored in
// stock_total for now; avg_daily step refines days_of_stock.

async function wbSyncStocks_(env, syncDate) {
  if (!env.WB_API_TOKEN) return { records: 0, source_status: 'missing' };
  const token  = env.WB_API_TOKEN;
  // WB stocks endpoint needs dateFrom; use 2 days ago to always get current snapshot
  const d2From = new Date(new Date(syncDate).getTime() - 2 * 86400000)
    .toISOString().slice(0, 10);
  const url = `${WB_SYNC_STATS_BASE}/api/v1/supplier/stocks?dateFrom=${d2From}`;

  let rows;
  try {
    rows = await wbSyncGet_(token, url);
  } catch (e) {
    return { records: 0, source_status: 'api_error', error: e.message };
  }
  if (!Array.isArray(rows)) return { records: 0, source_status: 'empty' };

  // Aggregate by nmId across warehouses
  const byNm = {};
  for (const r of rows) {
    const nmId = r.nmId;
    if (!nmId) continue;
    if (!byNm[nmId]) {
      byNm[nmId] = {
        nm_id:           nmId,
        vendor_code:     r.supplierArticle || '',
        sku_title:       r.subjectName || '',
        stock_total:     0,
        stock_in_transit: 0,
        stock_reserved:  0,
      };
    }
    byNm[nmId].stock_total       += (r.quantity || 0) + (r.inWayToClient || 0) + (r.inWayFromClient || 0);
    byNm[nmId].stock_in_transit  += r.inWayToClient  || 0;
    byNm[nmId].stock_reserved    += r.inWayFromClient || 0;
  }

  let written = 0;
  for (const e of Object.values(byNm)) {
    try {
      await env.DB.prepare(`
        INSERT INTO wb_stock_snapshot_v2
          (id, date, nm_id, vendor_code, sku_title,
           stock_total, stock_in_transit, stock_reserved,
           source_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', datetime('now'))
        ON CONFLICT(date, nm_id) DO UPDATE SET
          vendor_code      = excluded.vendor_code,
          sku_title        = excluded.sku_title,
          stock_total      = excluded.stock_total,
          stock_in_transit = excluded.stock_in_transit,
          stock_reserved   = excluded.stock_reserved,
          source_status    = 'ready',
          updated_at       = datetime('now')
      `).bind(
        wbSyncGenId_('stk'), syncDate, e.nm_id,
        e.vendor_code, e.sku_title,
        e.stock_total, e.stock_in_transit, e.stock_reserved,
      ).run();
      written++;
    } catch (_) {}
  }
  return { records: written, source_status: written > 0 ? 'ready' : 'empty' };
}

// ── §2 Orders 7d → avg_daily_orders_7d + days_of_stock ────────────────────
//
// Fetches the last 7 days of non-cancelled orders, counts per nm_id,
// then updates wb_stock_snapshot_v2 with avg_daily, days_of_stock,
// risk_level, stock_status, and recommended_supply_qty.
// Must run AFTER §1 (needs stock_total already written).

async function wbSyncAvgDaily_(env, syncDate) {
  if (!env.WB_API_TOKEN) return { records: 0, source_status: 'missing' };
  const token  = env.WB_API_TOKEN;
  const d7From = new Date(new Date(syncDate).getTime() - 7 * 86400000)
    .toISOString().slice(0, 10);
  const url = `${WB_SYNC_STATS_BASE}/api/v1/supplier/orders?dateFrom=${d7From}&flag=0`;

  let orders;
  try {
    orders = await wbSyncGet_(token, url);
  } catch (e) {
    return { records: 0, source_status: 'api_error', error: e.message };
  }
  if (!Array.isArray(orders)) return { records: 0, source_status: 'empty' };

  // Sum non-cancelled quantities per nm_id
  const countByNm = {};
  for (const o of orders) {
    if (o.isCancel) continue;
    const nm = o.nmId;
    if (!nm) continue;
    countByNm[nm] = (countByNm[nm] || 0) + (o.quantity || 1);
  }

  let updated = 0;
  for (const [nmIdStr, total7d] of Object.entries(countByNm)) {
    const nmId  = Number(nmIdStr);
    const avg7d = total7d / 7;

    try {
      const row = await env.DB.prepare(
        `SELECT stock_total FROM wb_stock_snapshot_v2 WHERE date = ? AND nm_id = ?`
      ).bind(syncDate, nmId).first();

      const stock       = row ? (row.stock_total || 0) : 0;
      const daysOfStock = avg7d > 0 ? stock / avg7d : null;
      const urgency     = !daysOfStock ? 'none'
        : daysOfStock < 3  ? 'critical'
        : daysOfStock < 7  ? 'high'
        : daysOfStock < 14 ? 'medium'
        : daysOfStock < 21 ? 'low' : 'none';
      const stockStatus = !daysOfStock ? 'unknown'
        : daysOfStock < 7  ? 'critical'
        : daysOfStock < 14 ? 'warning' : 'ok';
      // 30-day target supply: keep 30d of stock
      const repQty = avg7d > 0 ? Math.max(0, Math.round(30 * avg7d - stock)) : 0;

      if (row) {
        await env.DB.prepare(`
          UPDATE wb_stock_snapshot_v2
          SET avg_daily_orders_7d  = ?,
              days_of_stock        = ?,
              risk_level           = ?,
              stock_status         = ?,
              recommended_supply_qty = ?,
              updated_at           = datetime('now')
          WHERE date = ? AND nm_id = ?
        `).bind(avg7d, daysOfStock, urgency, stockStatus, repQty, syncDate, nmId).run();
      } else {
        // Stock row not yet written (no WB stock entry) — insert minimal placeholder
        await env.DB.prepare(`
          INSERT OR IGNORE INTO wb_stock_snapshot_v2
            (id, date, nm_id, avg_daily_orders_7d, days_of_stock,
             risk_level, stock_status, recommended_supply_qty,
             source_status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', datetime('now'))
        `).bind(
          wbSyncGenId_('stk'), syncDate, nmId,
          avg7d, daysOfStock, urgency, stockStatus, repQty,
        ).run();
      }
      updated++;
    } catch (_) {}
  }
  return { records: updated, source_status: updated > 0 ? 'ready' : 'empty' };
}

// ── §3 NM grouped report → wb_sku_snapshot ─────────────────────────────────
//
// 30-day aggregated metrics per nm_id: orders, revenue, returns,
// avg_rating, feedbacksCount, conversion. Used by ROP Chief.

async function wbSyncFetchNmPage_(token, dateFrom, dateTo, page) {
  const url = `${WB_SYNC_STATS_BASE}/api/v1/supplier/nm-report/grouped` +
    `?period.begin=${dateFrom}&period.end=${dateTo}` +
    `&aggregationLevel=nm&page=${page}&limit=100`;
  return wbSyncGet_(token, url);
}

async function wbSyncSkuMetrics_(env, syncDate) {
  if (!env.WB_API_TOKEN) return { records: 0, source_status: 'missing' };
  const token   = env.WB_API_TOKEN;
  const d30From = new Date(new Date(syncDate).getTime() - 30 * 86400000)
    .toISOString().slice(0, 10);

  const allCards = [];
  let page = 1;
  while (page <= 30) {
    try {
      const res   = await wbSyncFetchNmPage_(token, d30From, syncDate, page);
      const cards = res?.data?.cards || [];
      allCards.push(...cards);
      if (!res?.data?.isNextPage || cards.length === 0) break;
      page++;
    } catch (_) { break; }
  }

  let written = 0;
  const now = new Date().toISOString();

  for (const card of allCards) {
    const nmId = card.nmID;
    if (!nmId) continue;

    const ordersCount  = card.ordersCount  || 0;
    const returnsCount = card.returnsCount  || 0;
    const salesRub     = card.buyoutsSumRub || card.ordersSumRub || 0;
    const returnRate   = ordersCount > 0 ? returnsCount / ordersCount : 0;
    const skuStatus    = returnRate > 0.3 ? 'risk_high_returns'
      : (card.avgRating != null && card.avgRating < 4) ? 'risk_low_rating' : 'ok';

    try {
      await env.DB.prepare(`
        INSERT INTO wb_sku_snapshot
          (date, marketplace, nm_id, vendor_code, title,
           orders_count, sales_rub, returns_count,
           sku_status, source_status, updated_at)
        VALUES (?, 'WB', ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
        ON CONFLICT(date, marketplace, nm_id) DO UPDATE SET
          orders_count  = excluded.orders_count,
          sales_rub     = excluded.sales_rub,
          returns_count = excluded.returns_count,
          sku_status    = excluded.sku_status,
          source_status = 'ready',
          updated_at    = excluded.updated_at
      `).bind(
        syncDate, String(nmId),
        card.vendorCode || '', card.imtName || '',
        ordersCount, salesRub, returnsCount,
        skuStatus, now,
      ).run();
      written++;
    } catch (_) {}
  }
  return { records: written, source_status: written > 0 ? 'ready' : 'empty' };
}

// ── §4 Card content → design_card_snapshot ─────────────────────────────────
//
// Paginates through the seller's entire card catalogue. For each card,
// computes a quality score and lists concrete issues.
// Used by Design Chief's card content analyser.

async function wbSyncCardContent_(env, syncDate) {
  if (!env.WB_API_TOKEN) return { records: 0, source_status: 'missing' };
  const token = env.WB_API_TOKEN;
  const url   = `${WB_SYNC_CONTENT_BASE}/content/v2/get/cards/list`;

  let cursor  = null;
  let written = 0;
  let page    = 0;

  while (page < 50) {
    let res;
    try {
      res = await wbSyncPost_(token, url, {
        settings: {
          sort:   { ascending: false },
          filter: { withPhoto: -1 },
          cursor: { limit: 100, ...(cursor || {}) },
        },
      });
    } catch (_) { break; }

    const cards = res?.cards || [];
    if (cards.length === 0) break;

    for (const card of cards) {
      const nmId    = card.nmID;
      if (!nmId) continue;
      const titleLen = (card.title        || '').length;
      const descLen  = (card.description  || '').length;
      const photos   = (card.photos       || []).length;
      const chars    = (card.characteristics || []).length;
      const hasVideo = card.video ? 1 : 0;

      const issues = [];
      if (titleLen < 30)  issues.push({ type: 'short_title',         detail: `${titleLen} chars` });
      if (photos   < 5)   issues.push({ type: 'few_photos',          detail: `${photos} photos` });
      if (!hasVideo)      issues.push({ type: 'no_video' });
      if (descLen  < 100) issues.push({ type: 'short_description',   detail: `${descLen} chars` });
      if (chars    < 3)   issues.push({ type: 'few_characteristics', detail: `${chars} chars` });

      const score = Math.max(0, 100 - issues.length * 15);

      try {
        await env.DB.prepare(`
          INSERT INTO design_card_snapshot
            (id, snapshot_date, nm_id, vendor_code, sku_title,
             title_length, description_length, photos_count,
             characteristics_count, has_video,
             title_keywords_json, issues_found_json, overall_score, source_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'ready')
          ON CONFLICT(snapshot_date, nm_id) DO UPDATE SET
            title_length          = excluded.title_length,
            description_length    = excluded.description_length,
            photos_count          = excluded.photos_count,
            characteristics_count = excluded.characteristics_count,
            has_video             = excluded.has_video,
            issues_found_json     = excluded.issues_found_json,
            overall_score         = excluded.overall_score,
            source_status         = 'ready'
        `).bind(
          wbSyncGenId_('dcs'), syncDate, nmId,
          card.vendorCode || '', card.title || '',
          titleLen, descLen, photos, chars, hasVideo,
          JSON.stringify(issues), score,
        ).run();
        written++;
      } catch (_) {}
    }

    const newCursor = res?.cursor;
    if (!newCursor || cards.length < 100) break;
    cursor = { updatedAt: newCursor.updatedAt, nmID: newCursor.nmID, limit: 100 };
    page++;
  }
  return { records: written, source_status: written > 0 ? 'ready' : 'empty' };
}

// ── §5 Prices → wb_cost_data ───────────────────────────────────────────────
//
// Fetches goods with current prices/discounts. Writes the lowest-size
// discounted price as cost_per_unit — a proxy for the buyer price.
// Supplier cost (COGS) should be set manually or from a separate feed.

async function wbSyncCostData_(env, syncDate) {
  if (!env.WB_API_TOKEN) return { records: 0, source_status: 'missing' };
  const token = env.WB_API_TOKEN;
  const url   = `${WB_SYNC_PRICES_BASE}/api/v2/list/goods/filter`;
  const now   = new Date().toISOString();

  let offset  = 0;
  let written = 0;

  while (offset < 5000) {
    let res;
    try {
      res = await wbSyncPost_(token, url, {
        sort:   { ascending: false },
        filter: {},
        cursor: { limit: 100, offset },
      });
    } catch (_) { break; }

    const goods = res?.data?.listGoods || [];
    if (goods.length === 0) break;

    for (const g of goods) {
      const nmId = g.nmID;
      if (!nmId) continue;
      const sizes = g.sizes || [];
      const price = sizes.length > 0
        ? (sizes[0].discountedPrice || sizes[0].price || 0)
        : 0;

      try {
        await env.DB.prepare(`
          INSERT INTO wb_cost_data (nm_id, effective_date, cost_per_unit, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(nm_id, effective_date) DO UPDATE SET
            cost_per_unit = excluded.cost_per_unit,
            updated_at    = excluded.updated_at
        `).bind(String(nmId), syncDate, price, now).run();
        written++;
      } catch (_) {}
    }

    if (goods.length < 100) break;
    offset += 100;
  }
  return { records: written, source_status: written > 0 ? 'ready' : 'empty' };
}

// ── §6 Procurement snapshot (derived, no API call) ─────────────────────────
//
// Reads wb_stock_snapshot_v2 (written in §1–2) and computes:
//   recommended_order_qty = max(0, 45 * avg_daily - stock_total)
//   procurement_status    = 'order_needed' | 'ok' | 'missing_data'
// Used by Procurement Chief's reorder-point agent.

async function wbSyncProcurementSnapshot_(env, syncDate) {
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, vendor_code, sku_title,
             stock_total, avg_daily_orders_7d,
             days_of_stock, risk_level
      FROM wb_stock_snapshot_v2
      WHERE date = ?
    `).bind(syncDate).all();
  } catch (_) {
    return { records: 0, source_status: 'db_error' };
  }

  const entries = rows?.results || [];
  let written   = 0;

  for (const e of entries) {
    const avg7d       = e.avg_daily_orders_7d || 0;
    const stock       = e.stock_total || 0;
    const days        = e.days_of_stock;
    const recommended = avg7d > 0 ? Math.max(0, Math.round(45 * avg7d - stock)) : 0;
    const procStatus  = days == null ? 'missing_data'
      : days < 14    ? 'order_needed' : 'ok';

    try {
      await env.DB.prepare(`
        INSERT INTO wb_procurement_snapshot
          (id, date, nm_id, sku_title, vendor_code,
           avg_daily_orders_30d, days_of_stock,
           recommended_order_qty, procurement_status, source_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', datetime('now'))
        ON CONFLICT(date, nm_id) DO UPDATE SET
          avg_daily_orders_30d  = excluded.avg_daily_orders_30d,
          days_of_stock         = excluded.days_of_stock,
          recommended_order_qty = excluded.recommended_order_qty,
          procurement_status    = excluded.procurement_status,
          source_status         = 'ready',
          updated_at            = datetime('now')
      `).bind(
        wbSyncGenId_('prsnap'), syncDate, e.nm_id,
        e.sku_title || '', e.vendor_code || '',
        avg7d, days, recommended, procStatus,
      ).run();
      written++;
    } catch (_) {}
  }
  return { records: written, source_status: written > 0 ? 'ready' : 'empty' };
}

// ── §7 Orchestrator ────────────────────────────────────────────────────────

async function runWbDataSync_(env) {
  await ensureWbSyncSchema_(env);

  const syncDate = new Date().toISOString().slice(0, 10);
  const syncId   = wbSyncGenId_('wbsync');
  const startMs  = Date.now();

  try {
    await env.DB.prepare(`
      INSERT INTO wb_sync_log
        (id, sync_date, sync_type, status, started_at)
      VALUES (?, ?, 'full_sync', 'running', datetime('now'))
    `).bind(syncId, syncDate).run();
  } catch (_) {}

  const results    = {};
  const errorParts = [];

  const run = async (key, fn) => {
    try {
      results[key] = await fn();
      if (results[key].error) errorParts.push(`${key}: ${results[key].error}`);
    } catch (e) {
      results[key] = { records: 0, source_status: 'error', error: e.message };
      errorParts.push(`${key}: ${e.message}`);
    }
  };

  // Steps 1–2 are sequential (avg_daily needs stocks written first)
  await run('stocks',      () => wbSyncStocks_(env, syncDate));
  await run('avg_daily',   () => wbSyncAvgDaily_(env, syncDate));

  // Steps 3–5 can run in parallel (independent API sources)
  // Step 7: returns data runs in parallel alongside steps 3–5
  await Promise.all([
    run('sku_metrics', () => wbSyncSkuMetrics_(env, syncDate)),
    run('cards',       () => wbSyncCardContent_(env, syncDate)),
    run('cost_data',   () => wbSyncCostData_(env, syncDate)),
    run('returns',     () => typeof wbSyncReturnsData_ === 'function'
      ? wbSyncReturnsData_(env, syncDate)
      : Promise.resolve({ ok: true, records_written: 0, source_status: 'skipped' })),
  ]);

  // Step 6 is derived from the results of steps 1–2
  await run('procurement', () => wbSyncProcurementSnapshot_(env, syncDate));

  const duration     = Date.now() - startMs;
  const totalRecords = Object.values(results).reduce((s, r) => s + (r.records || 0), 0);
  const status       = errorParts.length > 0 ? 'partial' : 'ok';

  try {
    await env.DB.prepare(`
      UPDATE wb_sync_log
      SET status          = ?,
          finished_at     = datetime('now'),
          duration_ms     = ?,
          records_written = ?,
          error           = ?
      WHERE id = ?
    `).bind(
      status, duration, totalRecords,
      errorParts.length > 0 ? errorParts.join('; ') : null,
      syncId,
    ).run();
  } catch (_) {}

  return {
    sync_id:       syncId,
    sync_date:     syncDate,
    status,
    duration_ms:   duration,
    total_records: totalRecords,
    results,
  };
}

// ── §8 Scheduler job wrapper ───────────────────────────────────────────────

async function runWbSyncJob_(env) {
  return runWbDataSync_(env);
}

// ── §9 HTTP routes ─────────────────────────────────────────────────────────

async function handleWbSyncRoutes_(env, request) {
  const pathname = new URL(request.url).pathname;

  // GET /agent/wb/sync/status — last 20 sync runs
  if (request.method === 'GET' && pathname === '/agent/wb/sync/status') {
    await ensureWbSyncSchema_(env);
    const rows = await env.DB.prepare(
      `SELECT * FROM wb_sync_log ORDER BY started_at DESC LIMIT 20`
    ).all();
    return new Response(JSON.stringify({ ok: true, logs: rows?.results || [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /agent/wb/sync/run — manual trigger
  if (request.method === 'POST' && pathname === '/agent/wb/sync/run') {
    const result = await runWbDataSync_(env);
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}

// ── §10 Telegram commands ──────────────────────────────────────────────────

async function routeWbSyncTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim().split('@')[0].toLowerCase();

  // /wb_sync — show last sync status
  if (text === '/wb_sync') {
    let row = null;
    try {
      await ensureWbSyncSchema_(env);
      row = await env.DB.prepare(
        `SELECT * FROM wb_sync_log ORDER BY started_at DESC LIMIT 1`
      ).first();
    } catch (_) {}

    const esc = (s) => String(s || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

    if (!row) {
      await sendTelegramMessage_(env, chatId,
        '*WB Sync*\nСинхронизация ещё не запускалась\\.\nЗапустить: /wb\\_sync\\_run',
        { parse_mode: 'MarkdownV2' });
      return true;
    }

    const icon = row.status === 'ok' ? '✅' : row.status === 'partial' ? '⚠️' : '🔄';
    const dur  = row.duration_ms ? `${Math.round(row.duration_ms / 1000)}с` : 'N/A';
    const lines = [
      `*WB Sync — последний запуск*`,
      `Дата: ${esc(row.sync_date)}`,
      `Статус: ${icon} ${esc(row.status)}`,
      `Начало: ${esc(row.started_at)}`,
      `Длительность: ${esc(dur)}`,
      `Записей: ${esc(row.records_written || 0)}`,
    ];
    if (row.error) lines.push(`Ошибки: ${esc(row.error.slice(0, 300))}`);
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
    return true;
  }

  // /wb_sync_run — manual sync trigger
  if (text === '/wb_sync_run') {
    await sendTelegramMessage_(env, chatId, '⏳ Синхронизация данных WB запущена...');
    try {
      const result = await runWbDataSync_(env);
      const r = result.results || {};
      const icon = result.status === 'ok' ? '✅' : '⚠️';
      const lines = [
        `*WB Sync завершён* ${icon}`,
        `Дата: ${result.sync_date}  |  Время: ${Math.round(result.duration_ms / 1000)}с`,
        '',
        `📦 Остатки: ${r.stocks?.records || 0} SKU \\(${r.stocks?.source_status || '—'}\\)`,
        `📊 Ср\\. дн\\. заказы: ${r.avg_daily?.records || 0} SKU`,
        `📈 Метрики NM: ${r.sku_metrics?.records || 0} SKU`,
        `🖼 Карточки: ${r.cards?.records || 0} SKU`,
        `💰 Цены: ${r.cost_data?.records || 0} SKU`,
        `🚚 Закупки: ${r.procurement?.records || 0} SKU`,
        `*Всего: ${result.total_records} записей*`,
      ];
      await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка синхронизации: ${e.message}`);
    }
    return true;
  }

  return false;
}
// ============================================================
// wb_pricing_v1.gs — WB Price & Discount Advisor
// Build: ai_helpers_wb_pricing_v1
//
// Analyses current prices, stock velocity, and ad efficiency
// to generate price-change proposals for human review.
// Runs at 11:00 UTC (after all chiefs have processed fresh data).
//
// ── Sub-agents ───────────────────────────────────────────────
//   runMarginAnalysisAgent_    — flags SKUs with dangerously low margin
//   runSlowMoversAgent_        — proposes discounts for stuck inventory
//   runDrrOptimizerAgent_      — proposes price increase when DRR is low
//
// ── Tables written ───────────────────────────────────────────
//   wb_pricing_proposal  — price/discount change proposals
//   wb_pricing_history   — daily price snapshots
//
// ── Safety invariants ────────────────────────────────────────
//   ✗ Never auto-applies price changes
//   ✗ Never auto-applies discount changes
//   ✓ Every proposal: requires_confirmation = 1
//   ✓ Every proposal: unique confirmation_id
//   ✓ source_status = 'missing' when WB_API_TOKEN absent
// ============================================================

// ── Constants ──────────────────────────────────────────────────────────────

const PRICING_MIN_MARGIN_PCT    = 15;   // flag if margin < 15%
const PRICING_SLOW_MOVER_DAYS   = 60;   // flag if days_of_stock > 60
const PRICING_LOW_DRR_THRESHOLD = 10;   // DRR < 10% → price may be raised
const PRICING_HIGH_DRR_THRESHOLD= 40;   // DRR > 40% → price review needed
const PRICING_MAX_DISCOUNT_PCT  = 70;   // never propose > 70% discount
const PRICING_PROPOSAL_TTL_DAYS = 3;    // proposals expire after 3 days

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureWbPricingSchema_(env) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS wb_pricing_proposal (
      id                    TEXT PRIMARY KEY,
      proposal_date         TEXT NOT NULL,
      nm_id                 INTEGER NOT NULL,
      vendor_code           TEXT,
      sku_title             TEXT,
      proposal_type         TEXT NOT NULL,
      current_price         REAL,
      proposed_price        REAL,
      current_discount_pct  REAL,
      proposed_discount_pct REAL,
      margin_pct_estimated  REAL,
      rationale             TEXT,
      ai_analysis           TEXT,
      priority              TEXT DEFAULT 'medium',
      status                TEXT DEFAULT 'pending',
      confirmation_id       TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      confirmed_at          TEXT,
      confirmed_by          TEXT,
      expires_at            TEXT,
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wb_pricing_proposal_date
      ON wb_pricing_proposal(proposal_date, status)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_pricing_proposal_nm
      ON wb_pricing_proposal(nm_id, status)`,
    `CREATE TABLE IF NOT EXISTS wb_pricing_history (
      id           TEXT PRIMARY KEY,
      nm_id        INTEGER NOT NULL,
      vendor_code  TEXT,
      record_date  TEXT NOT NULL,
      price        REAL,
      discount_pct REAL,
      source       TEXT DEFAULT 'sync',
      proposal_id  TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      UNIQUE(nm_id, record_date, source)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wb_pricing_history_nm
      ON wb_pricing_history(nm_id, record_date DESC)`,
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).run(); } catch (_) {}
  }
}

// ── ID helpers ─────────────────────────────────────────────────────────────

function pricingGenId_(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function pricingConfirmId_(nmId, type) {
  return `price_${type}_${nmId}_${Date.now().toString(36)}`;
}

// ── AI helper ──────────────────────────────────────────────────────────────

async function callPricingAi_(env, prompt) {
  // Gemini
  if (env.GEMINI_API_KEY) {
    try {
      const model = env.GEMINI_CLASSIFICATION_MODEL || 'gemini-1.5-flash-latest';
      const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      const res   = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal:  AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text.trim().slice(0, 600);
      }
    } catch (_) {}
  }
  // Groq fallback
  if (env.GROQ_API_KEY) {
    try {
      const base  = env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
      const model = env.GROQ_MODEL    || 'llama3-8b-8192';
      const res   = await fetch(`${base}/chat/completions`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 300 }),
        signal:  AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return text.trim().slice(0, 600);
      }
    } catch (_) {}
  }
  return null;
}

// ── Price history snapshot ──────────────────────────────────────────────────

async function snapshotPricingHistory_(env, today) {
  // Copy today's cost_data into wb_pricing_history
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, vendor_code, cost_per_unit
      FROM wb_cost_data
      WHERE effective_date = ?
    `).bind(today).all();
  } catch (_) {
    return 0;
  }
  let written = 0;
  for (const r of (rows?.results || [])) {
    try {
      await env.DB.prepare(`
        INSERT INTO wb_pricing_history (id, nm_id, vendor_code, record_date, price, source)
        VALUES (?, ?, ?, ?, ?, 'sync')
        ON CONFLICT(nm_id, record_date, source) DO UPDATE SET
          price = excluded.price
      `).bind(
        pricingGenId_('phist'), r.nm_id, r.vendor_code || '', today, r.cost_per_unit || 0,
      ).run();
      written++;
    } catch (_) {}
  }
  return written;
}

// ── §1 Margin Analysis Agent ───────────────────────────────────────────────
//
// Flags SKUs where the estimated margin is below PRICING_MIN_MARGIN_PCT.
// Margin estimate = (price - cost_per_unit - logistics) / price
// If WB commission data is present, deducts it too.
// Proposes a price increase to restore margin.

async function runMarginAnalysisAgent_(env, today) {
  // Join cost_data (has COGS + logistics + commission) with today's price
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT c.nm_id, c.vendor_code, c.cost_per_unit AS selling_price,
             c.commission_pct, c.logistics_rub
      FROM wb_cost_data c
      WHERE c.effective_date = ?
        AND c.cost_per_unit > 0
    `).bind(today).all();
  } catch (_) {
    return { proposals: 0, source_status: 'db_error' };
  }

  const entries = rows?.results || [];
  let proposals = 0;

  for (const e of entries) {
    const price      = e.selling_price || 0;
    if (price <= 0) continue;

    // Estimate margin: deduct commission (%) and logistics (flat)
    const commPct    = e.commission_pct || 20; // WB avg ~20% if not set
    const logistics  = e.logistics_rub  || 0;
    const afterComm  = price * (1 - commPct / 100);
    const afterLogis = afterComm - logistics;
    const marginPct  = price > 0 ? (afterLogis / price) * 100 : null;

    if (marginPct === null || marginPct >= PRICING_MIN_MARGIN_PCT) continue;

    // Need at least PRICING_MIN_MARGIN_PCT margin
    // Solve: proposed * (1 - comm/100) - logistics >= proposed * minMargin/100
    // proposed * (1 - comm/100 - minMargin/100) >= logistics
    const factor = 1 - commPct / 100 - PRICING_MIN_MARGIN_PCT / 100;
    if (factor <= 0) continue; // impossible without structural change
    const minPrice    = Math.ceil(logistics / factor / 10) * 10; // round up to nearest 10
    const proposedPrice = Math.max(minPrice, Math.ceil(price * 1.1 / 10) * 10);
    if (proposedPrice <= price) continue;

    // Check if a pending proposal already exists for this nm_id
    try {
      const existing = await env.DB.prepare(`
        SELECT id FROM wb_pricing_proposal
        WHERE nm_id = ? AND proposal_type = 'margin_increase'
          AND status = 'pending' AND proposal_date = ?
      `).bind(e.nm_id, today).first();
      if (existing) continue;
    } catch (_) {}

    const confirmId  = pricingConfirmId_(e.nm_id, 'margin');
    const expiresAt  = new Date(Date.now() + PRICING_PROPOSAL_TTL_DAYS * 86400000).toISOString();
    const rationale  = `Оценочная маржа ${marginPct.toFixed(1)}% ниже порога ${PRICING_MIN_MARGIN_PCT}%. ` +
      `Комиссия: ${commPct}%, логистика: ${logistics}₽. ` +
      `Предложена цена ${proposedPrice}₽ (текущая: ${price}₽).`;

    try {
      await env.DB.prepare(`
        INSERT INTO wb_pricing_proposal
          (id, proposal_date, nm_id, vendor_code,
           proposal_type, current_price, proposed_price,
           margin_pct_estimated, rationale, priority,
           confirmation_id, requires_confirmation, expires_at)
        VALUES (?, ?, ?, ?, 'margin_increase', ?, ?, ?, ?, 'high', ?, 1, ?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        pricingGenId_('ppr'), today, e.nm_id, e.vendor_code || '',
        price, proposedPrice, marginPct, rationale, confirmId, expiresAt,
      ).run();
      proposals++;
    } catch (_) {}
  }
  return { proposals, source_status: 'ready' };
}

// ── §2 Slow Movers Agent ───────────────────────────────────────────────────
//
// Finds SKUs with too many days of stock and low sales velocity.
// Proposes a discount to stimulate orders and reduce overstock.

async function runSlowMoversAgent_(env, today) {
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT s.nm_id, s.vendor_code, s.sku_title,
             s.stock_total, s.days_of_stock, s.avg_daily_orders_7d,
             c.cost_per_unit AS current_price,
             c.discount_pct  AS current_discount
      FROM wb_stock_snapshot_v2 s
      LEFT JOIN wb_cost_data c
        ON c.nm_id = CAST(s.nm_id AS TEXT) AND c.effective_date = ?
      WHERE s.date = ?
        AND s.days_of_stock > ?
        AND (s.avg_daily_orders_7d IS NULL OR s.avg_daily_orders_7d < 1)
        AND s.stock_total > 0
    `).bind(today, today, PRICING_SLOW_MOVER_DAYS).all();
  } catch (_) {
    return { proposals: 0, source_status: 'db_error' };
  }

  const entries = rows?.results || [];
  let proposals = 0;

  for (const e of entries) {
    const price          = e.current_price || 0;
    const currDiscount   = e.current_discount || 0;
    // Propose 10-20% more discount; don't exceed PRICING_MAX_DISCOUNT_PCT
    const newDiscount    = Math.min(
      Math.round((currDiscount + 15) / 5) * 5,
      PRICING_MAX_DISCOUNT_PCT
    );
    if (newDiscount <= currDiscount) continue;

    try {
      const existing = await env.DB.prepare(`
        SELECT id FROM wb_pricing_proposal
        WHERE nm_id = ? AND proposal_type = 'discount_increase'
          AND status = 'pending' AND proposal_date = ?
      `).bind(e.nm_id, today).first();
      if (existing) continue;
    } catch (_) {}

    const days       = e.days_of_stock ? Math.round(e.days_of_stock) : '?';
    const confirmId  = pricingConfirmId_(e.nm_id, 'discount');
    const expiresAt  = new Date(Date.now() + PRICING_PROPOSAL_TTL_DAYS * 86400000).toISOString();
    const priority   = e.days_of_stock > 120 ? 'high' : 'medium';
    const rationale  = `Остаток: ${days} дней. Ср. продажи: ${(e.avg_daily_orders_7d || 0).toFixed(2)}/день. ` +
      `Предложена скидка ${newDiscount}% (текущая: ${currDiscount}%). ` +
      `Цель: стимулировать продажи и снизить срок хранения.`;

    try {
      await env.DB.prepare(`
        INSERT INTO wb_pricing_proposal
          (id, proposal_date, nm_id, vendor_code, sku_title,
           proposal_type, current_price, current_discount_pct, proposed_discount_pct,
           rationale, priority,
           confirmation_id, requires_confirmation, expires_at)
        VALUES (?, ?, ?, ?, ?, 'discount_increase', ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        pricingGenId_('ppr'), today, e.nm_id, e.vendor_code || '', e.sku_title || '',
        price, currDiscount, newDiscount,
        rationale, priority, confirmId, expiresAt,
      ).run();
      proposals++;
    } catch (_) {}
  }
  return { proposals, source_status: 'ready' };
}

// ── §3 DRR Optimizer Agent ─────────────────────────────────────────────────
//
// When ad DRR is very low (ads efficient, low cost per order) and conversion
// is good, the price may be raised — the product sells well even at higher
// price. When DRR is very high, flags the SKU for price/ad review.

async function runDrrOptimizerAgent_(env, today) {
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT a.nm_id,
             SUM(a.ad_spend) AS total_spend,
             SUM(a.ad_orders) AS total_ad_orders,
             AVG(a.drr) AS avg_drr,
             AVG(a.cr)  AS avg_cr,
             c.cost_per_unit AS current_price,
             k.orders_count AS orders_30d,
             k.vendor_code,
             k.title AS sku_title
      FROM wb_ads_snapshot a
      LEFT JOIN wb_cost_data c
        ON c.nm_id = CAST(a.nm_id AS TEXT) AND c.effective_date = ?
      LEFT JOIN wb_sku_snapshot k
        ON k.nm_id = CAST(a.nm_id AS TEXT) AND k.date = ? AND k.marketplace = 'WB'
      WHERE a.date = ?
        AND a.ad_spend > 500
      GROUP BY a.nm_id
      HAVING avg_drr IS NOT NULL
    `).bind(today, today, today).all();
  } catch (_) {
    return { proposals: 0, source_status: 'db_error' };
  }

  const entries = rows?.results || [];
  let proposals = 0;

  for (const e of entries) {
    const drr   = e.avg_drr || 0;
    const price = e.current_price || 0;
    if (price <= 0) continue;

    // Low DRR: ads efficient — consider raising price by 5-10%
    if (drr < PRICING_LOW_DRR_THRESHOLD && drr > 0 && e.orders_30d > 5) {
      const proposedPrice = Math.ceil(price * 1.07 / 10) * 10;
      if (proposedPrice <= price) continue;

      try {
        const existing = await env.DB.prepare(`
          SELECT id FROM wb_pricing_proposal
          WHERE nm_id = ? AND proposal_type = 'price_increase_drr'
            AND status = 'pending' AND proposal_date = ?
        `).bind(Number(e.nm_id), today).first();
        if (existing) continue;
      } catch (_) {}

      const confirmId = pricingConfirmId_(e.nm_id, 'drr_up');
      const expiresAt = new Date(Date.now() + PRICING_PROPOSAL_TTL_DAYS * 86400000).toISOString();
      const rationale = `DRR = ${drr.toFixed(1)}% (< ${PRICING_LOW_DRR_THRESHOLD}%) — реклама эффективна. ` +
        `Заказов за 30 дней: ${e.orders_30d}. ` +
        `Потенциал повысить цену с ${price}₽ до ${proposedPrice}₽ (+7%) без потери объёма.`;

      try {
        await env.DB.prepare(`
          INSERT INTO wb_pricing_proposal
            (id, proposal_date, nm_id, vendor_code, sku_title,
             proposal_type, current_price, proposed_price,
             rationale, priority,
             confirmation_id, requires_confirmation, expires_at)
          VALUES (?, ?, ?, ?, ?, 'price_increase_drr', ?, ?, ?, 'medium', ?, 1, ?)
          ON CONFLICT(confirmation_id) DO NOTHING
        `).bind(
          pricingGenId_('ppr'), today, Number(e.nm_id), e.vendor_code || '', e.sku_title || '',
          price, proposedPrice, rationale, confirmId, expiresAt,
        ).run();
        proposals++;
      } catch (_) {}
    }

    // High DRR: ads very expensive relative to revenue — flag for review
    if (drr > PRICING_HIGH_DRR_THRESHOLD) {
      try {
        const existing = await env.DB.prepare(`
          SELECT id FROM wb_pricing_proposal
          WHERE nm_id = ? AND proposal_type = 'high_drr_alert'
            AND status = 'pending' AND proposal_date = ?
        `).bind(Number(e.nm_id), today).first();
        if (existing) continue;
      } catch (_) {}

      const confirmId = pricingConfirmId_(e.nm_id, 'high_drr');
      const expiresAt = new Date(Date.now() + PRICING_PROPOSAL_TTL_DAYS * 86400000).toISOString();
      const rationale = `DRR = ${drr.toFixed(1)}% (> ${PRICING_HIGH_DRR_THRESHOLD}%) — ` +
        `рекламные расходы высоки. Расход: ${(e.total_spend || 0).toFixed(0)}₽. ` +
        `Рекомендуется: снизить ставку или пересмотреть цену.`;

      try {
        await env.DB.prepare(`
          INSERT INTO wb_pricing_proposal
            (id, proposal_date, nm_id, vendor_code, sku_title,
             proposal_type, current_price,
             rationale, priority,
             confirmation_id, requires_confirmation, expires_at)
          VALUES (?, ?, ?, ?, ?, 'high_drr_alert', ?, ?, 'high', ?, 1, ?)
          ON CONFLICT(confirmation_id) DO NOTHING
        `).bind(
          pricingGenId_('ppr'), today, Number(e.nm_id), e.vendor_code || '', e.sku_title || '',
          price, rationale, confirmId, expiresAt,
        ).run();
        proposals++;
      } catch (_) {}
    }
  }
  return { proposals, source_status: 'ready' };
}

// ── §4 AI enrichment ───────────────────────────────────────────────────────

async function enrichPricingProposalsWithAi_(env, today) {
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) return 0;

  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT id, nm_id, sku_title, proposal_type,
             current_price, proposed_price,
             current_discount_pct, proposed_discount_pct,
             margin_pct_estimated, rationale
      FROM wb_pricing_proposal
      WHERE proposal_date = ? AND ai_analysis IS NULL AND status = 'pending'
      LIMIT 10
    `).bind(today).all();
  } catch (_) { return 0; }

  let enriched = 0;
  for (const row of (rows?.results || [])) {
    const prompt = `Ты аналитик ценообразования Wildberries.
Товар: "${row.sku_title || 'N/A'}" (nm_id: ${row.nm_id})
Тип предложения: ${row.proposal_type}
${row.current_price ? `Текущая цена: ${row.current_price}₽` : ''}
${row.proposed_price ? `Предложенная цена: ${row.proposed_price}₽` : ''}
${row.current_discount_pct != null ? `Текущая скидка: ${row.current_discount_pct}%` : ''}
${row.proposed_discount_pct != null ? `Предложенная скидка: ${row.proposed_discount_pct}%` : ''}
${row.margin_pct_estimated != null ? `Оценка маржи: ${Number(row.margin_pct_estimated).toFixed(1)}%` : ''}
Обоснование системы: ${row.rationale || 'N/A'}

Напиши краткий (2-3 предложения) анализ: целесообразно ли это изменение и какие риски нужно учесть. Только на русском языке.`;

    const analysis = await callPricingAi_(env, prompt);
    if (!analysis) continue;

    try {
      await env.DB.prepare(`
        UPDATE wb_pricing_proposal SET ai_analysis = ? WHERE id = ?
      `).bind(analysis, row.id).run();
      enriched++;
    } catch (_) {}
  }
  return enriched;
}

// ── §5 Expire old proposals ────────────────────────────────────────────────

async function expirePricingProposals_(env) {
  try {
    const res = await env.DB.prepare(`
      UPDATE wb_pricing_proposal
      SET status = 'expired', updated_at = datetime('now')
      WHERE status = 'pending' AND expires_at < datetime('now')
    `).run();
    return res?.meta?.changes || 0;
  } catch (_) { return 0; }
}

// ── §6 Orchestrator ────────────────────────────────────────────────────────

async function runPricingChief_(env) {
  await ensureWbPricingSchema_(env);
  const today   = new Date().toISOString().slice(0, 10);
  const results = {};

  await expirePricingProposals_(env);

  try { results.history   = await snapshotPricingHistory_(env, today); } catch (_) { results.history = 0; }
  try { results.margin    = await runMarginAnalysisAgent_(env, today); } catch (e) { results.margin = { proposals: 0, error: e.message }; }
  try { results.slow      = await runSlowMoversAgent_(env, today); }    catch (e) { results.slow   = { proposals: 0, error: e.message }; }
  try { results.drr       = await runDrrOptimizerAgent_(env, today); }  catch (e) { results.drr    = { proposals: 0, error: e.message }; }
  try { results.enriched  = await enrichPricingProposalsWithAi_(env, today); } catch (_) { results.enriched = 0; }

  const totalProposals =
    (results.margin?.proposals || 0) +
    (results.slow?.proposals   || 0) +
    (results.drr?.proposals    || 0);

  return {
    date:             today,
    total_proposals:  totalProposals,
    history_snapped:  results.history,
    ai_enriched:      results.enriched,
    results,
  };
}

// ── §7 Callback routing ────────────────────────────────────────────────────

async function routePricingCallbackQuery_(env, cq) {
  const data = cq?.data || '';
  if (!data.startsWith('price_confirm_') && !data.startsWith('price_skip_')) return false;

  const chatId    = cq?.message?.chat?.id;
  const messageId = cq?.message?.message_id;

  const isConfirm = data.startsWith('price_confirm_');
  const confirmId = isConfirm
    ? data.replace('price_confirm_', '')
    : data.replace('price_skip_', '');

  let row;
  try {
    row = await env.DB.prepare(
      `SELECT * FROM wb_pricing_proposal WHERE confirmation_id = ?`
    ).bind(confirmId).first();
  } catch (_) {}

  if (!row) {
    if (typeof answerCallbackQuery_ === 'function')
      await answerCallbackQuery_(env, cq.id, 'Предложение не найдено');
    return true;
  }

  const newStatus = isConfirm ? 'confirmed' : 'rejected';
  try {
    await env.DB.prepare(`
      UPDATE wb_pricing_proposal
      SET status = ?, confirmed_at = datetime('now'), confirmed_by = ?, updated_at = datetime('now')
      WHERE confirmation_id = ?
    `).bind(newStatus, String(cq.from?.id || ''), confirmId).run();
  } catch (_) {}

  const icon     = isConfirm ? '✅' : '❌';
  const action   = isConfirm ? 'подтверждено' : 'отклонено';
  const replyTxt = `${icon} Предложение ${action}: nm_id ${row.nm_id}`;

  if (typeof editTelegramMessage_ === 'function') {
    await editTelegramMessage_(env, chatId, messageId, replyTxt, {});
  } else if (typeof sendTelegramMessage_ === 'function') {
    await sendTelegramMessage_(env, chatId, replyTxt);
  }
  if (typeof answerCallbackQuery_ === 'function')
    await answerCallbackQuery_(env, cq.id, action);
  return true;
}

// ── §8 Telegram commands ───────────────────────────────────────────────────

async function routePricingTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim().split('@')[0].toLowerCase();

  if (text !== '/pricing' && text !== '/pricing_proposals') return false;

  await ensureWbPricingSchema_(env);
  const today = new Date().toISOString().slice(0, 10);

  // /pricing — summary for today
  if (text === '/pricing') {
    let rows;
    try {
      rows = await env.DB.prepare(`
        SELECT status, COUNT(*) AS cnt
        FROM wb_pricing_proposal
        WHERE proposal_date = ?
        GROUP BY status
      `).bind(today).all();
    } catch (_) {}

    const counts = {};
    for (const r of (rows?.results || [])) counts[r.status] = r.cnt;

    const lines = [
      `*Ценообразование — ${today}*`,
      `Ожидают подтверждения: ${counts.pending || 0}`,
      `Подтверждено: ${counts.confirmed || 0}`,
      `Отклонено: ${counts.rejected || 0}`,
      `Истекло: ${counts.expired || 0}`,
      '',
      `Детали: /pricing\\_proposals`,
    ];
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  // /pricing_proposals — list pending proposals with buttons
  if (text === '/pricing_proposals') {
    let rows;
    try {
      rows = await env.DB.prepare(`
        SELECT * FROM wb_pricing_proposal
        WHERE status = 'pending'
        ORDER BY priority DESC, created_at DESC
        LIMIT 5
      `).bind().all();
    } catch (_) {}

    const proposals = rows?.results || [];
    if (proposals.length === 0) {
      await sendTelegramMessage_(env, chatId, 'Нет ожидающих предложений по ценам.');
      return true;
    }

    for (const p of proposals) {
      const typeLabel = {
        margin_increase:    '📈 Повышение цены (маржа)',
        discount_increase:  '🏷 Увеличение скидки (зависание)',
        price_increase_drr: '📈 Повышение цены (DRR)',
        high_drr_alert:     '⚠️ Высокий DRR — требует внимания',
      }[p.proposal_type] || p.proposal_type;

      const priceInfo = p.proposed_price
        ? `${p.current_price}₽ → ${p.proposed_price}₽`
        : p.proposed_discount_pct != null
          ? `Скидка ${p.current_discount_pct || 0}% → ${p.proposed_discount_pct}%`
          : `Текущая цена: ${p.current_price || '—'}₽`;

      const lines = [
        `${typeLabel}`,
        `nm\\_id: ${p.nm_id}${p.sku_title ? ' — ' + p.sku_title.slice(0, 40) : ''}`,
        `${priceInfo}`,
        `Приоритет: ${p.priority}`,
        `_${(p.rationale || '').slice(0, 200)}_`,
      ];
      if (p.ai_analysis) lines.push(`\n🤖 ${p.ai_analysis.slice(0, 250)}`);

      const keyboard = {
        inline_keyboard: [[
          { text: '✅ Подтвердить', callback_data: `price_confirm_${p.confirmation_id}` },
          { text: '❌ Отклонить',  callback_data: `price_skip_${p.confirmation_id}`    },
        ]],
      };
      await sendTelegramMessage_(env, chatId, lines.join('\n'), {
        parse_mode:   'Markdown',
        reply_markup: JSON.stringify(keyboard),
      });
    }

    if (proposals.length === 5) {
      await sendTelegramMessage_(env, chatId, '_Показано 5 из ожидающих предложений._', { parse_mode: 'Markdown' });
    }
    return true;
  }

  return false;
}

// ── §9 HTTP routes ─────────────────────────────────────────────────────────

async function handlePricingRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;
  const json     = (obj, st) => new Response(JSON.stringify(obj), {
    status: st || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  if (!pathname.startsWith('/agent/pricing/')) return null;

  await ensureWbPricingSchema_(env);

  // GET /agent/pricing/proposals?status=pending&date=YYYY-MM-DD
  if (request.method === 'GET' && pathname === '/agent/pricing/proposals') {
    const status = url.searchParams.get('status') || 'pending';
    const date   = url.searchParams.get('date')   || new Date().toISOString().slice(0, 10);
    try {
      const rows = await env.DB.prepare(`
        SELECT * FROM wb_pricing_proposal
        WHERE status = ? AND proposal_date = ?
        ORDER BY priority DESC, created_at DESC
        LIMIT 50
      `).bind(status, date).all();
      return json({ ok: true, proposals: rows?.results || [] });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/pricing/proposals/:id/confirm
  const confirmMatch = pathname.match(/^\/agent\/pricing\/proposals\/([^/]+)\/(confirm|reject)$/);
  if (request.method === 'POST' && confirmMatch) {
    const confirmId = confirmMatch[1];
    const action    = confirmMatch[2];
    const newStatus = action === 'confirm' ? 'confirmed' : 'rejected';
    try {
      await env.DB.prepare(`
        UPDATE wb_pricing_proposal
        SET status = ?, confirmed_at = datetime('now'), updated_at = datetime('now')
        WHERE confirmation_id = ? AND status = 'pending'
      `).bind(newStatus, confirmId).run();
      return json({ ok: true, status: newStatus });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/pricing/run — manual trigger
  if (request.method === 'POST' && pathname === '/agent/pricing/run') {
    const result = await runPricingChief_(env);
    return json({ ok: true, result });
  }

  // GET /agent/pricing/history?nm_id=123
  if (request.method === 'GET' && pathname === '/agent/pricing/history') {
    const nmId = url.searchParams.get('nm_id');
    if (!nmId) return json({ ok: false, error: 'nm_id required' }, 400);
    try {
      const rows = await env.DB.prepare(`
        SELECT * FROM wb_pricing_history
        WHERE nm_id = ?
        ORDER BY record_date DESC
        LIMIT 30
      `).bind(Number(nmId)).all();
      return json({ ok: true, history: rows?.results || [] });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
// ============================================================
// supplier_management_v1.gs — Supplier Directory & Price History
// Build: ai_helpers_supplier_management_v1
//
// Manages the supplier_directory and procurement_price_history
// tables so the Procurement Chief has real data to work with.
//
// ── What this unlocks ────────────────────────────────────────
//   Procurement Chief reads supplier_directory to:
//     - find min_order_qty when drafting purchase orders
//     - find default lead times (production + delivery days)
//     - look up supplier contact details for confirmed orders
//   Price history is used to detect price anomalies (>30% increase)
//   and to populate estimated_unit_cost in procurement_order.
//
// ── Telegram commands ────────────────────────────────────────
//   /suppliers            — list active suppliers
//   /supplier_add         — guided add (name, lead times, min_qty)
//   /supplier_view <id>   — full details + recent prices
//   /supplier_prices <nm_id> — price history for a SKU
//
// ── HTTP API ─────────────────────────────────────────────────
//   GET    /agent/suppliers              — list all (filter: active=1)
//   POST   /agent/suppliers              — create
//   GET    /agent/suppliers/:id          — get one
//   PUT    /agent/suppliers/:id          — update
//   DELETE /agent/suppliers/:id          — deactivate (soft)
//   GET    /agent/suppliers/prices       — price history (?nm_id=N&supplier_id=S)
//   POST   /agent/suppliers/prices       — add price record
//   GET    /agent/suppliers/nm/:nm_id    — all suppliers for a SKU (with latest price)
// ============================================================

// ── ID helper ──────────────────────────────────────────────────────────────

function supplierGenId_(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Validation helpers ─────────────────────────────────────────────────────

function supplierValidate_(data) {
  const errors = [];
  if (!data.supplier_name || String(data.supplier_name).trim().length < 2) {
    errors.push('supplier_name обязателен (минимум 2 символа)');
  }
  if (data.default_production_days != null && (isNaN(data.default_production_days) || data.default_production_days < 0)) {
    errors.push('default_production_days должен быть >= 0');
  }
  if (data.default_delivery_days != null && (isNaN(data.default_delivery_days) || data.default_delivery_days < 0)) {
    errors.push('default_delivery_days должен быть >= 0');
  }
  if (data.min_order_qty != null && (isNaN(data.min_order_qty) || data.min_order_qty < 0)) {
    errors.push('min_order_qty должен быть >= 0');
  }
  return errors;
}

// ── §1 Supplier CRUD ───────────────────────────────────────────────────────

async function createSupplier_(env, data) {
  const errors = supplierValidate_(data);
  if (errors.length) return { ok: false, errors };

  const id  = supplierGenId_('sup');
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO supplier_directory
      (id, supplier_name, contact_person, contact_email, contact_phone,
       default_production_days, default_delivery_days,
       min_order_qty, min_order_amount, currency,
       payment_terms, notes, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    id,
    String(data.supplier_name).trim(),
    data.contact_person  || null,
    data.contact_email   || null,
    data.contact_phone   || null,
    Number(data.default_production_days ?? 14),
    Number(data.default_delivery_days   ?? 7),
    Number(data.min_order_qty           ?? 1),
    Number(data.min_order_amount        ?? 0),
    data.currency      || 'RUB',
    data.payment_terms || null,
    data.notes         || null,
    now, now,
  ).run();

  return { ok: true, id };
}

async function updateSupplier_(env, id, data) {
  const existing = await env.DB.prepare(
    `SELECT id FROM supplier_directory WHERE id = ?`
  ).bind(id).first();
  if (!existing) return { ok: false, error: 'Поставщик не найден' };

  const errors = supplierValidate_({ supplier_name: 'placeholder', ...data });
  if (data.supplier_name != null && errors.some(e => e.includes('supplier_name'))) {
    return { ok: false, errors };
  }

  const fields = [];
  const values = [];

  const allowed = [
    'supplier_name', 'contact_person', 'contact_email', 'contact_phone',
    'default_production_days', 'default_delivery_days',
    'min_order_qty', 'min_order_amount', 'currency', 'payment_terms', 'notes',
  ];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(data[key]);
    }
  }
  if (fields.length === 0) return { ok: false, error: 'Нет полей для обновления' };

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  await env.DB.prepare(
    `UPDATE supplier_directory SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  return { ok: true };
}

async function getSupplier_(env, id) {
  const row = await env.DB.prepare(
    `SELECT * FROM supplier_directory WHERE id = ?`
  ).bind(id).first();
  return row || null;
}

async function listSuppliers_(env, onlyActive) {
  const sql = onlyActive
    ? `SELECT * FROM supplier_directory WHERE is_active = 1 ORDER BY supplier_name`
    : `SELECT * FROM supplier_directory ORDER BY is_active DESC, supplier_name`;
  const rows = await env.DB.prepare(sql).all();
  return rows?.results || [];
}

async function deactivateSupplier_(env, id) {
  const existing = await env.DB.prepare(
    `SELECT id FROM supplier_directory WHERE id = ?`
  ).bind(id).first();
  if (!existing) return { ok: false, error: 'Поставщик не найден' };

  await env.DB.prepare(`
    UPDATE supplier_directory SET is_active = 0, updated_at = ? WHERE id = ?
  `).bind(new Date().toISOString(), id).run();

  return { ok: true };
}

// ── §2 Price History ───────────────────────────────────────────────────────

async function addPriceRecord_(env, data) {
  if (!data.nm_id || !data.unit_cost || !data.price_date) {
    return { ok: false, error: 'nm_id, unit_cost, price_date обязательны' };
  }

  // Look up supplier name if id provided
  let supplierName = data.supplier_name || null;
  if (data.supplier_id && !supplierName) {
    try {
      const sup = await env.DB.prepare(
        `SELECT supplier_name FROM supplier_directory WHERE id = ?`
      ).bind(data.supplier_id).first();
      supplierName = sup?.supplier_name || null;
    } catch (_) {}
  }

  const id = supplierGenId_('prh');
  await env.DB.prepare(`
    INSERT INTO procurement_price_history
      (id, nm_id, vendor_code, supplier_id, supplier_name,
       price_date, unit_cost, currency, min_order_qty, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(nm_id, supplier_id, price_date) DO UPDATE SET
      unit_cost     = excluded.unit_cost,
      currency      = excluded.currency,
      min_order_qty = excluded.min_order_qty,
      notes         = excluded.notes
  `).bind(
    id,
    Number(data.nm_id),
    data.vendor_code   || null,
    data.supplier_id   || null,
    supplierName,
    data.price_date,
    Number(data.unit_cost),
    data.currency      || 'RUB',
    data.min_order_qty != null ? Number(data.min_order_qty) : null,
    data.notes         || null,
  ).run();

  return { ok: true, id };
}

async function getPriceHistory_(env, nmId, supplierId) {
  let sql, binds;
  if (supplierId) {
    sql   = `SELECT ph.*, s.supplier_name AS sup_name
             FROM procurement_price_history ph
             LEFT JOIN supplier_directory s ON s.id = ph.supplier_id
             WHERE ph.nm_id = ? AND ph.supplier_id = ?
             ORDER BY ph.price_date DESC LIMIT 30`;
    binds = [Number(nmId), supplierId];
  } else {
    sql   = `SELECT ph.*, s.supplier_name AS sup_name
             FROM procurement_price_history ph
             LEFT JOIN supplier_directory s ON s.id = ph.supplier_id
             WHERE ph.nm_id = ?
             ORDER BY ph.price_date DESC LIMIT 30`;
    binds = [Number(nmId)];
  }
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return rows?.results || [];
}

// Latest price per supplier for a given nm_id (used by Procurement Chief)
async function getLatestPricesForNm_(env, nmId) {
  const rows = await env.DB.prepare(`
    SELECT ph.supplier_id, ph.supplier_name, ph.unit_cost,
           ph.currency, ph.min_order_qty, ph.price_date,
           s.contact_person, s.contact_email, s.contact_phone,
           s.default_production_days, s.default_delivery_days,
           s.payment_terms
    FROM procurement_price_history ph
    LEFT JOIN supplier_directory s ON s.id = ph.supplier_id
    WHERE ph.nm_id = ?
      AND ph.price_date = (
        SELECT MAX(ph2.price_date) FROM procurement_price_history ph2
        WHERE ph2.nm_id = ph.nm_id AND ph2.supplier_id = ph.supplier_id
      )
    ORDER BY ph.unit_cost ASC
  `).bind(Number(nmId)).all();
  return rows?.results || [];
}

// ── §3 Telegram commands ───────────────────────────────────────────────────

async function routeSupplierTelegramCommand_(env, msg, chatId, userId) {
  const raw  = (msg.text || '').trim();
  const text = raw.split('@')[0].toLowerCase();
  const args = raw.split(/\s+/).slice(1);

  // /suppliers — list active suppliers
  if (text === '/suppliers') {
    let suppliers;
    try {
      suppliers = await listSuppliers_(env, true);
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка: ${e.message}`);
      return true;
    }

    if (suppliers.length === 0) {
      const lines = [
        '*Справочник поставщиков пуст*',
        '',
        'Добавьте первого поставщика через API:',
        '`POST /agent/suppliers`',
        '`{"supplier_name":"Имя","min_order_qty":50,"default_production_days":14}`',
      ];
      await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return true;
    }

    const lines = [`*Поставщики (${suppliers.length})*`, ''];
    for (const s of suppliers) {
      const lead = (s.default_production_days || 14) + (s.default_delivery_days || 7);
      lines.push(
        `• *${s.supplier_name}* \`${s.id}\`` +
        `\n  MOQ: ${s.min_order_qty || 1} шт | Lead: ${lead}д | ${s.currency || 'RUB'}` +
        (s.contact_person ? `\n  ${s.contact_person}` : '')
      );
    }
    lines.push('', 'Детали: /supplier\\_view \\<id\\>');
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  // /supplier_view <id> — full details + last 5 price records
  if (text === '/supplier_view') {
    const id = args[0];
    if (!id) {
      await sendTelegramMessage_(env, chatId, 'Использование: /supplier\\_view \\<id\\>', { parse_mode: 'Markdown' });
      return true;
    }
    let sup;
    try {
      sup = await getSupplier_(env, id);
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка: ${e.message}`);
      return true;
    }
    if (!sup) {
      await sendTelegramMessage_(env, chatId, `Поставщик \`${id}\` не найден.`, { parse_mode: 'Markdown' });
      return true;
    }

    const active = sup.is_active ? '✅ Активен' : '❌ Неактивен';
    const lead   = (sup.default_production_days || 14) + (sup.default_delivery_days || 7);
    const lines  = [
      `*${sup.supplier_name}*  ${active}`,
      `ID: \`${sup.id}\``,
      `MOQ: ${sup.min_order_qty || 1} шт | Мин. сумма: ${sup.min_order_amount || 0} ${sup.currency || 'RUB'}`,
      `Lead time: ${lead}д (произв: ${sup.default_production_days || 14}д + доставка: ${sup.default_delivery_days || 7}д)`,
    ];
    if (sup.payment_terms)  lines.push(`Оплата: ${sup.payment_terms}`);
    if (sup.contact_person) lines.push(`Контакт: ${sup.contact_person}`);
    if (sup.contact_email)  lines.push(`Email: ${sup.contact_email}`);
    if (sup.contact_phone)  lines.push(`Тел: ${sup.contact_phone}`);
    if (sup.notes)          lines.push(`Заметки: ${sup.notes.slice(0, 200)}`);

    // Last 5 price records
    try {
      const priceRows = await env.DB.prepare(`
        SELECT nm_id, vendor_code, unit_cost, currency, price_date, min_order_qty
        FROM procurement_price_history
        WHERE supplier_id = ?
        ORDER BY price_date DESC LIMIT 5
      `).bind(id).all();
      const prices = priceRows?.results || [];
      if (prices.length > 0) {
        lines.push('', '*Последние цены:*');
        for (const p of prices) {
          lines.push(`  nm ${p.nm_id}${p.vendor_code ? ' ' + p.vendor_code : ''}: ${p.unit_cost}₽ (${p.price_date})`);
        }
      }
    } catch (_) {}

    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  // /supplier_prices <nm_id> — price history for a SKU across all suppliers
  if (text === '/supplier_prices') {
    const nmId = Number(args[0]);
    if (!nmId) {
      await sendTelegramMessage_(env, chatId, 'Использование: /supplier\\_prices \\<nm\\_id\\>', { parse_mode: 'Markdown' });
      return true;
    }
    let prices;
    try {
      prices = await getLatestPricesForNm_(env, nmId);
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка: ${e.message}`);
      return true;
    }

    if (prices.length === 0) {
      await sendTelegramMessage_(env, chatId, `Нет данных о ценах для nm_id ${nmId}.`);
      return true;
    }

    const lines = [`*Цены поставщиков — nm_id ${nmId}*`, ''];
    for (const p of prices) {
      const lead = (p.default_production_days || 14) + (p.default_delivery_days || 7);
      lines.push(
        `• *${p.supplier_name || p.supplier_id || '—'}*` +
        `\n  ${p.unit_cost}${p.currency || '₽'} / шт` +
        (p.min_order_qty ? ` | MOQ: ${p.min_order_qty}` : '') +
        `\n  Lead: ${lead}д | Актуально: ${p.price_date}`
      );
    }
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  return false;
}

// ── §4 HTTP routes ─────────────────────────────────────────────────────────

async function handleSupplierRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;

  if (!pathname.startsWith('/agent/suppliers')) return null;

  const json = (obj, st) => new Response(JSON.stringify(obj), {
    status:  st || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  // GET /agent/suppliers — list
  if (request.method === 'GET' && pathname === '/agent/suppliers') {
    const activeOnly = url.searchParams.get('active') !== '0';
    try {
      const list = await listSuppliers_(env, activeOnly);
      return json({ ok: true, suppliers: list });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/suppliers — create
  if (request.method === 'POST' && pathname === '/agent/suppliers') {
    let body;
    try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Invalid JSON' }, 400); }
    try {
      const result = await createSupplier_(env, body);
      return json(result, result.ok ? 201 : 400);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/suppliers/prices — price history
  if (request.method === 'GET' && pathname === '/agent/suppliers/prices') {
    const nmId      = url.searchParams.get('nm_id');
    const suppId    = url.searchParams.get('supplier_id') || null;
    if (!nmId) return json({ ok: false, error: 'nm_id required' }, 400);
    try {
      const history = await getPriceHistory_(env, Number(nmId), suppId);
      return json({ ok: true, history });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/suppliers/prices — add price record
  if (request.method === 'POST' && pathname === '/agent/suppliers/prices') {
    let body;
    try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Invalid JSON' }, 400); }
    try {
      const result = await addPriceRecord_(env, body);
      return json(result, result.ok ? 201 : 400);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // Routes with /:id
  const idMatch = pathname.match(/^\/agent\/suppliers\/([^/]+)$/);
  if (idMatch) {
    const id = idMatch[1];

    // GET /agent/suppliers/:id
    if (request.method === 'GET') {
      try {
        const sup = await getSupplier_(env, id);
        if (!sup) return json({ ok: false, error: 'Not found' }, 404);
        // Also return latest prices per nm_id
        const prices = await env.DB.prepare(`
          SELECT nm_id, vendor_code, unit_cost, currency, price_date, min_order_qty
          FROM procurement_price_history WHERE supplier_id = ?
          ORDER BY price_date DESC LIMIT 20
        `).bind(id).all();
        return json({ ok: true, supplier: sup, prices: prices?.results || [] });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // PUT /agent/suppliers/:id
    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      try {
        const result = await updateSupplier_(env, id, body);
        return json(result, result.ok ? 200 : 400);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // DELETE /agent/suppliers/:id — soft deactivate
    if (request.method === 'DELETE') {
      try {
        const result = await deactivateSupplier_(env, id);
        return json(result, result.ok ? 200 : 404);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }
  }

  // GET /agent/suppliers/nm/:nm_id — all suppliers + latest prices for a SKU
  const nmMatch = pathname.match(/^\/agent\/suppliers\/nm\/(\d+)$/);
  if (request.method === 'GET' && nmMatch) {
    const nmId = Number(nmMatch[1]);
    try {
      const prices = await getLatestPricesForNm_(env, nmId);
      return json({ ok: true, nm_id: nmId, suppliers: prices });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
// ============================================================
// bot_setup_v1.gs — Telegram Bot Setup & Help System
// Build: ai_helpers_bot_setup_v1
//
// Provides /start, /help, /status, and webhook setup endpoints.
// /start registers the user's chat_id in scheduler_config so
// every chief knows where to send notifications.
//
// ── Tables ────────────────────────────────────────────────────
//   bot_users — registered Telegram users
//
// ── Telegram commands ────────────────────────────────────────
//   /start         — welcome + register
//   /help          — full command reference
//   /status        — system health snapshot
//   /setup_notify  — set this chat as notification target
//
// ── HTTP API ─────────────────────────────────────────────────
//   POST /webhook/setup          — register webhook + bot commands
//   GET  /agent/bot/users        — list registered users
//   GET  /agent/bot/status       — system status JSON
// ============================================================

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureBotSetupSchema_(env) {
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS bot_users (
        id              TEXT PRIMARY KEY,
        telegram_user_id TEXT NOT NULL UNIQUE,
        telegram_chat_id TEXT NOT NULL,
        username        TEXT,
        first_name      TEXT,
        is_admin        INTEGER DEFAULT 0,
        registered_at   TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
      )
    `).run();
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_bot_users_tg
        ON bot_users(telegram_user_id)
    `).run();
  } catch (_) {}
}

// ── Bot API helpers ────────────────────────────────────────────────────────

async function botApiCall_(token, method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(10000),
    });
    return res.json();
  } catch (_) {
    return { ok: false };
  }
}

// ── Webhook setup ──────────────────────────────────────────────────────────

async function setupTelegramWebhook_(env, workerUrl) {
  const token  = env.TELEGRAM_BOT_TOKEN;
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };

  const webhookUrl = `${workerUrl.replace(/\/$/, '')}/telegram/webhook`;

  const r1 = await botApiCall_(token, 'setWebhook', {
    url:          webhookUrl,
    secret_token: secret || undefined,
    allowed_updates: ['message', 'callback_query'],
    max_connections: 40,
  });

  // Register bot command list with Telegram
  const commands = [
    { command: 'start',               description: 'Запустить бота и зарегистрироваться' },
    { command: 'help',                description: 'Список всех команд' },
    { command: 'status',              description: 'Статус системы' },
    { command: 'setup_notify',        description: 'Назначить этот чат для уведомлений' },
    { command: 'wb',                  description: 'WB Operations — сводка' },
    { command: 'wb_sync_run',         description: 'Запустить синхронизацию данных WB' },
    { command: 'pricing_proposals',   description: 'Предложения по ценам (подтвердить/отклонить)' },
    { command: 'suppliers',           description: 'Список поставщиков' },
    { command: 'fulfillment_tz',      description: 'ТЗ на поставку (подтвердить/отклонить)' },
    { command: 'procurement_orders',  description: 'Заказы закупки (подтвердить/отклонить)' },
    { command: 'alerts',              description: 'Активные алерты' },
    { command: 'qa',                  description: 'QA-проверка системы' },
    { command: 'scheduler_status',    description: 'Статус планировщика (все задачи)' },
  ];

  const r2 = await botApiCall_(token, 'setMyCommands', { commands });

  return { ok: r1.ok, webhook: r1, commands: r2 };
}

// ── /status helper ─────────────────────────────────────────────────────────

async function getBotSystemStatus_(env) {
  const today  = new Date().toISOString().slice(0, 10);
  const status = { date: today };

  // Last sync
  try {
    const sync = await env.DB.prepare(
      `SELECT status, finished_at, records_written FROM wb_sync_log
       WHERE sync_date = ? ORDER BY started_at DESC LIMIT 1`
    ).bind(today).first();
    status.sync = sync
      ? `${sync.status === 'ok' ? '✅' : '⚠️'} ${sync.status} (${sync.records_written || 0} записей)`
      : '❓ не запускалась сегодня';
  } catch (_) { status.sync = '—'; }

  // Pending proposals
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM wb_pricing_proposal WHERE status = 'pending'`
    ).first();
    status.pricing_pending = row?.cnt || 0;
  } catch (_) { status.pricing_pending = 0; }

  // Pending fulfillment TZ
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM fulfillment_tz_item WHERE status = 'draft'`
    ).first();
    status.tz_pending = row?.cnt || 0;
  } catch (_) { status.tz_pending = 0; }

  // Pending procurement orders
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM procurement_order WHERE status = 'draft'`
    ).first();
    status.proc_pending = row?.cnt || 0;
  } catch (_) { status.proc_pending = 0; }

  // Critical stock items
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM wb_stock_snapshot_v2
       WHERE date = ? AND risk_level = 'critical'`
    ).bind(today).first();
    status.stock_critical = row?.cnt || 0;
  } catch (_) { status.stock_critical = 0; }

  // Active suppliers
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM supplier_directory WHERE is_active = 1`
    ).first();
    status.active_suppliers = row?.cnt || 0;
  } catch (_) { status.active_suppliers = 0; }

  // Last scheduler jobs
  try {
    const rows = await env.DB.prepare(
      `SELECT job_name, last_status, last_run_at FROM scheduler_config
       WHERE last_run_at IS NOT NULL ORDER BY last_run_at DESC LIMIT 3`
    ).all();
    status.recent_jobs = (rows?.results || []).map(r =>
      `${r.last_status === 'ok' ? '✅' : '❌'} ${r.job_name}`
    );
  } catch (_) { status.recent_jobs = []; }

  return status;
}

// ── /help text ─────────────────────────────────────────────────────────────

function buildHelpText_() {
  const sections = [
    ['🚀 Старт', [
      '/start — регистрация и приветствие',
      '/help — этот список',
      '/status — снимок состояния системы',
      '/setup\\_notify — назначить чат для уведомлений',
    ]],
    ['📊 WB Operations', [
      '/wb — сводный отчёт',
      '/wb\\_sync — статус синхронизации данных',
      '/wb\\_sync\\_run — принудительная синхронизация',
      '/wb\\_proposals — предложения WB',
    ]],
    ['💰 Ценообразование', [
      '/pricing — сводка по ценам',
      '/pricing\\_proposals — предложения цен (подтвердить/отклонить)',
    ]],
    ['🏪 CS', [
      '/cs — сводка CS',
      '/cs\\_inbox — входящие обращения',
      '/cs\\_appeals — апелляции',
    ]],
    ['🎨 Design', [
      '/design — сводка Design Chief',
      '/design\\_handoffs — задачи от других шефов',
      '/design\\_plan — план контента',
    ]],
    ['📈 ROP', [
      '/rop — KPI сводка',
      '/rop\\_kpi — метрики по SKU',
      '/rop\\_targets — цели периода',
    ]],
    ['🚚 Фулфилмент', [
      '/fulfillment — сводка фулфилмент',
      '/fulfillment\\_fbs — остатки FBS',
      '/fulfillment\\_tz — ТЗ на поставку',
      '/fulfillment\\_schedule — график поставок',
    ]],
    ['🛒 Закупки', [
      '/procurement — сводка закупок',
      '/procurement\\_orders — заказы (подтвердить/отклонить)',
      '/procurement\\_suppliers — поставщики в закупках',
    ]],
    ['🏭 Поставщики', [
      '/suppliers — справочник поставщиков',
      '/supplier\\_view \\<id\\> — детали поставщика',
      '/supplier\\_prices \\<nm\\_id\\> — цены по SKU',
    ]],
    ['🔔 Алерты', [
      '/alerts — активные алерты',
      '/alerts\\_config — настройки алертов',
    ]],
    ['⚙️ Система', [
      '/scheduler\\_status — статус всех задач',
      '/scheduler\\_logs — последние запуски',
      '/qa — быстрая QA проверка',
      '/qa\\_full — полная QA проверка',
    ]],
  ];

  const lines = ['*Команды ИИ агентов-помощников*', ''];
  for (const [title, cmds] of sections) {
    lines.push(`*${title}*`);
    lines.push(...cmds);
    lines.push('');
  }
  lines.push('_Все рискованные действия требуют подтверждения_');
  return lines.join('\n');
}

// ── Telegram command router ────────────────────────────────────────────────

async function routeBotSetupTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim().split('@')[0].toLowerCase();

  // /start — register user + welcome
  if (text === '/start') {
    await ensureBotSetupSchema_(env);
    const from     = msg.from || {};
    const tgUserId = String(from.id || userId);
    const name     = from.first_name || from.username || 'Пользователь';

    // Upsert bot_users
    try {
      await env.DB.prepare(`
        INSERT INTO bot_users
          (id, telegram_user_id, telegram_chat_id, username, first_name, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          telegram_chat_id = excluded.telegram_chat_id,
          username         = excluded.username,
          first_name       = excluded.first_name,
          updated_at       = datetime('now')
      `).bind(
        `bu_${Date.now().toString(36)}`, tgUserId, String(chatId),
        from.username || null, from.first_name || null,
      ).run();
    } catch (_) {}

    const welcome = [
      `Привет, *${name}*\\! 👋`,
      '',
      'Я — система ИИ агентов-помощников для управления бизнесом на Wildberries\\.',
      '',
      '*Что я умею:*',
      '• Ежедневные отчёты по WB, CS, ROP, Design, Fulfilment, Procurement',
      '• Предложения по ценам и скидкам с подтверждением',
      '• Мониторинг остатков и алерты о критических ситуациях',
      '• Управление справочником поставщиков и историей цен',
      '',
      'Используй /setup\\_notify чтобы получать уведомления от шефов\\.',
      'Полный список команд: /help',
    ].join('\n');

    await sendTelegramMessage_(env, chatId, welcome, { parse_mode: 'MarkdownV2' });
    return true;
  }

  // /help — full command reference
  if (text === '/help') {
    await sendTelegramMessage_(env, chatId, buildHelpText_(), { parse_mode: 'Markdown' });
    return true;
  }

  // /status — system health snapshot
  if (text === '/status') {
    let s;
    try {
      s = await getBotSystemStatus_(env);
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка статуса: ${e.message}`);
      return true;
    }

    const needsAction = (s.pricing_pending || 0) + (s.tz_pending || 0) + (s.proc_pending || 0);
    const lines = [
      `*Статус системы — ${s.date}*`,
      '',
      `🔄 Синхронизация: ${s.sync}`,
      `📦 Критич. остатки: ${s.stock_critical || 0} SKU`,
      `🏭 Поставщики: ${s.active_suppliers || 0} активных`,
      '',
      '*Требуют подтверждения:*',
      `  💰 Цены: ${s.pricing_pending} предложений`,
      `  🚚 ТЗ фулфилмент: ${s.tz_pending} черновиков`,
      `  🛒 Заказы закупки: ${s.proc_pending} черновиков`,
    ];
    if (needsAction > 0) {
      lines.push('', `⚡ Всего ожидает: *${needsAction}* действий`);
    }
    if (s.recent_jobs?.length) {
      lines.push('', '*Последние задачи:*');
      for (const j of s.recent_jobs) lines.push(`  ${j}`);
    }

    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  // /setup_notify — configure this chat_id for all scheduler jobs
  if (text === '/setup_notify') {
    try {
      await env.DB.prepare(`
        UPDATE scheduler_config SET notify_chat_id = ?, updated_at = datetime('now')
        WHERE notify_chat_id IS NULL OR notify_chat_id = ''
      `).bind(String(chatId)).run();

      // Also set for all jobs that have no chat yet (idempotent bulk set)
      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM scheduler_config WHERE notify_chat_id = ?`
      ).bind(String(chatId)).first();

      await sendTelegramMessage_(env, chatId,
        `✅ Этот чат назначен для уведомлений\\.\n` +
        `Задач настроено: *${count?.cnt || 0}*\n\n` +
        `_Уведомления о сбоях включены для всех задач\\._` +
        `\n_Уведомления об успехе выключены — включите через API если нужно\\._`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  return false;
}

// ── HTTP routes ────────────────────────────────────────────────────────────

async function handleBotSetupRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;
  const json     = (obj, st) => new Response(JSON.stringify(obj), {
    status:  st || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  // POST /webhook/setup — register webhook + commands with Telegram
  if (request.method === 'POST' && pathname === '/webhook/setup') {
    const workerUrl = `${url.protocol}//${url.host}`;
    const result    = await setupTelegramWebhook_(env, workerUrl);
    return json(result, result.ok ? 200 : 500);
  }

  // GET /agent/bot/users — list registered users
  if (request.method === 'GET' && pathname === '/agent/bot/users') {
    await ensureBotSetupSchema_(env);
    try {
      const rows = await env.DB.prepare(
        `SELECT * FROM bot_users ORDER BY registered_at DESC LIMIT 100`
      ).all();
      return json({ ok: true, users: rows?.results || [] });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/bot/status — JSON system status
  if (request.method === 'GET' && pathname === '/agent/bot/status') {
    try {
      const s = await getBotSystemStatus_(env);
      return json({ ok: true, status: s });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
// ============================================================
// alerts_v1.gs — Real-time Alert System
// Build: ai_helpers_alerts_v1
//
// Monitors snapshot tables for critical conditions and sends
// immediate Telegram notifications. Runs at 05:30 UTC (after
// wb_data_sync and wb_daily_report have run).
//
// ── Alert types ──────────────────────────────────────────────
//   stock_critical      — wb_stock_snapshot_v2.risk_level='critical'
//   stock_out           — stock_total = 0, had orders recently
//   drr_spike           — ads DRR > 60% (runaway ad spend)
//   return_rate_spike   — returns/orders > 40% for SKU
//   rating_drop         — avg_rating < 3.8 in wb_sku_snapshot
//   pricing_no_margin   — wb_pricing_proposal with margin < 0
//   sync_failed         — wb_sync_log last run has errors
//
// ── Deduplication ────────────────────────────────────────────
//   alert_log.idempotency_key = type:nm_id:date
//   Same alert not re-sent within cooldown_hours (default 24h)
//
// ── Tables ───────────────────────────────────────────────────
//   alert_config — per-type enable/threshold config
//   alert_log    — sent alert history (dedup)
//
// ── Telegram commands ────────────────────────────────────────
//   /alerts         — today's active alerts
//   /alerts_config  — list current thresholds
//
// ── HTTP API ─────────────────────────────────────────────────
//   GET  /agent/alerts           — recent alerts
//   POST /agent/alerts/config    — update thresholds
//   POST /agent/alerts/run       — manual trigger
// ============================================================

// ── Default thresholds ─────────────────────────────────────────────────────

const ALERT_DEFAULTS = {
  stock_critical:    { enabled: 1, threshold: 3,    cooldown_hours: 24 },  // days_of_stock < 3
  stock_out:         { enabled: 1, threshold: 0,    cooldown_hours: 12 },  // stock_total = 0
  drr_spike:         { enabled: 1, threshold: 60,   cooldown_hours: 24 },  // DRR > 60%
  return_rate_spike: { enabled: 1, threshold: 40,   cooldown_hours: 24 },  // returns > 40%
  rating_drop:       { enabled: 1, threshold: 3.8,  cooldown_hours: 48 },  // rating < 3.8
  pricing_no_margin: { enabled: 1, threshold: 0,    cooldown_hours: 24 },  // margin_pct < 0
  sync_failed:       { enabled: 1, threshold: 0,    cooldown_hours: 6  },  // any sync error
};

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureAlertsSchema_(env) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS alert_config (
      id             TEXT PRIMARY KEY,
      alert_type     TEXT NOT NULL UNIQUE,
      enabled        INTEGER DEFAULT 1,
      threshold      REAL,
      cooldown_hours INTEGER DEFAULT 24,
      notify_chat_id TEXT,
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS alert_log (
      id               TEXT PRIMARY KEY,
      alert_type       TEXT NOT NULL,
      nm_id            INTEGER,
      sku_title        TEXT,
      severity         TEXT DEFAULT 'warning',
      message          TEXT NOT NULL,
      chat_id          TEXT,
      idempotency_key  TEXT UNIQUE,
      sent_at          TEXT DEFAULT (datetime('now')),
      created_at       TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_alert_log_type
      ON alert_log(alert_type, sent_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_alert_log_idem
      ON alert_log(idempotency_key)`,
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).run(); } catch (_) {}
  }

  // Seed default configs
  for (const [type, def] of Object.entries(ALERT_DEFAULTS)) {
    try {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO alert_config (id, alert_type, enabled, threshold, cooldown_hours)
        VALUES (?, ?, ?, ?, ?)
      `).bind(`alrt_${type}`, type, def.enabled, def.threshold, def.cooldown_hours).run();
    } catch (_) {}
  }
}

// ── Alert send helper ──────────────────────────────────────────────────────

async function sendAlertMessage_(env, chatId, message, alertType, nmId, idemKey, severity) {
  // Check cooldown via idempotency key
  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM alert_log WHERE idempotency_key = ?`
    ).bind(idemKey).first();
    if (existing) return false; // already sent within cooldown window
  } catch (_) {}

  // Send Telegram message
  try {
    await sendTelegramMessage_(env, chatId, message, { parse_mode: 'Markdown' });
  } catch (_) {}

  // Log the sent alert
  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO alert_log
        (id, alert_type, nm_id, severity, message, chat_id, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      `alog_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      alertType, nmId || null, severity || 'warning',
      message.slice(0, 1000), String(chatId), idemKey,
    ).run();
  } catch (_) {}

  return true;
}

// ── Config loader ──────────────────────────────────────────────────────────

async function loadAlertConfig_(env, alertType) {
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM alert_config WHERE alert_type = ?`
    ).bind(alertType).first();
    if (row) return row;
  } catch (_) {}
  return ALERT_DEFAULTS[alertType] || { enabled: 0 };
}

async function getNotifyChatId_(env, alertType) {
  // 1. alert_config.notify_chat_id (per-type override)
  try {
    const row = await env.DB.prepare(
      `SELECT notify_chat_id FROM alert_config WHERE alert_type = ?`
    ).bind(alertType).first();
    if (row?.notify_chat_id) return row.notify_chat_id;
  } catch (_) {}

  // 2. scheduler_config for any job that has a chat set
  try {
    const row = await env.DB.prepare(
      `SELECT notify_chat_id FROM scheduler_config WHERE notify_chat_id IS NOT NULL LIMIT 1`
    ).first();
    if (row?.notify_chat_id) return row.notify_chat_id;
  } catch (_) {}

  return null;
}

// ── §1 Stock critical alert ────────────────────────────────────────────────

async function runStockCriticalAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'stock_critical');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'stock_critical');
  if (!chatId) return 0;

  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, vendor_code, sku_title,
             stock_total, days_of_stock, avg_daily_orders_7d, risk_level
      FROM wb_stock_snapshot_v2
      WHERE date = ?
        AND risk_level = 'critical'
        AND days_of_stock < ?
      ORDER BY days_of_stock ASC
      LIMIT 20
    `).bind(today, cfg.threshold || 3).all();
  } catch (_) { return 0; }

  let sent = 0;
  for (const r of (rows?.results || [])) {
    const days   = r.days_of_stock != null ? r.days_of_stock.toFixed(1) : '?';
    const idem   = `stock_critical:${r.nm_id}:${today}`;
    const msg    = [
      `🚨 *КРИТИЧНЫЙ ОСТАТОК*`,
      `nm_id: ${r.nm_id}${r.sku_title ? ' — ' + r.sku_title.slice(0, 40) : ''}`,
      `Остаток: ${r.stock_total || 0} шт | Дней: *${days}*`,
      `Ср. заказов/день: ${(r.avg_daily_orders_7d || 0).toFixed(2)}`,
      `Действие: /fulfillment\\_tz`,
    ].join('\n');
    if (await sendAlertMessage_(env, chatId, msg, 'stock_critical', r.nm_id, idem, 'critical')) sent++;
  }
  return sent;
}

// ── §2 Stock-out alert ─────────────────────────────────────────────────────

async function runStockOutAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'stock_out');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'stock_out');
  if (!chatId) return 0;

  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT s.nm_id, s.vendor_code, s.sku_title,
             s.stock_total, s.avg_daily_orders_7d
      FROM wb_stock_snapshot_v2 s
      WHERE s.date = ?
        AND s.stock_total = 0
        AND s.avg_daily_orders_7d > 0
      LIMIT 10
    `).bind(today).all();
  } catch (_) { return 0; }

  let sent = 0;
  for (const r of (rows?.results || [])) {
    const idem = `stock_out:${r.nm_id}:${today}`;
    const msg  = [
      `⛔ *ТОВАР ЗАКОНЧИЛСЯ*`,
      `nm_id: ${r.nm_id}${r.sku_title ? ' — ' + r.sku_title.slice(0, 40) : ''}`,
      `Остаток: 0 шт | Ср. заказов: ${(r.avg_daily_orders_7d || 0).toFixed(2)}/день`,
      `Действие: срочная поставка — /fulfillment`,
    ].join('\n');
    if (await sendAlertMessage_(env, chatId, msg, 'stock_out', r.nm_id, idem, 'critical')) sent++;
  }
  return sent;
}

// ── §3 DRR spike alert ─────────────────────────────────────────────────────

async function runDrrSpikeAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'drr_spike');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'drr_spike');
  if (!chatId) return 0;
  const threshold = cfg.threshold || 60;

  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, AVG(drr) AS avg_drr, SUM(ad_spend) AS total_spend
      FROM wb_ads_snapshot
      WHERE date = ?
        AND drr > ?
        AND ad_spend > 100
      GROUP BY nm_id
      ORDER BY avg_drr DESC
      LIMIT 10
    `).bind(today, threshold).all();
  } catch (_) { return 0; }

  let sent = 0;
  for (const r of (rows?.results || [])) {
    const drr  = (r.avg_drr || 0).toFixed(1);
    const idem = `drr_spike:${r.nm_id}:${today}`;
    const msg  = [
      `⚠️ *ВЫСОКИЙ DRR*`,
      `nm_id: ${r.nm_id}`,
      `DRR: *${drr}%* (порог: ${threshold}%)`,
      `Расход на рекламу: ${(r.total_spend || 0).toFixed(0)}₽`,
      `Действие: проверить ставки и цену — /pricing\\_proposals`,
    ].join('\n');
    if (await sendAlertMessage_(env, chatId, msg, 'drr_spike', r.nm_id, idem, 'warning')) sent++;
  }
  return sent;
}

// ── §4 Return rate spike alert ─────────────────────────────────────────────

async function runReturnRateAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'return_rate_spike');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'return_rate_spike');
  if (!chatId) return 0;
  const threshold = (cfg.threshold || 40) / 100;

  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, vendor_code, title,
             orders_count, returns_count,
             CAST(returns_count AS REAL) / orders_count AS return_rate
      FROM wb_sku_snapshot
      WHERE date = ? AND marketplace = 'WB'
        AND orders_count > 5
        AND CAST(returns_count AS REAL) / orders_count > ?
      ORDER BY return_rate DESC
      LIMIT 10
    `).bind(today, threshold).all();
  } catch (_) { return 0; }

  let sent = 0;
  for (const r of (rows?.results || [])) {
    const rate = ((r.return_rate || 0) * 100).toFixed(1);
    const idem = `return_rate:${r.nm_id}:${today}`;
    const msg  = [
      `⚠️ *ВЫСОКИЙ ПРОЦЕНТ ВОЗВРАТОВ*`,
      `nm_id: ${r.nm_id}${r.title ? ' — ' + r.title.slice(0, 40) : ''}`,
      `Возвраты: *${rate}%* (порог: ${(threshold * 100).toFixed(0)}%)`,
      `Заказов: ${r.orders_count} | Возвратов: ${r.returns_count}`,
      `Действие: анализ причин — /cs\\_appeals`,
    ].join('\n');
    if (await sendAlertMessage_(env, chatId, msg, 'return_rate_spike', r.nm_id, idem, 'warning')) sent++;
  }
  return sent;
}

// ── §5 Rating drop alert ───────────────────────────────────────────────────

async function runRatingDropAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'rating_drop');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'rating_drop');
  if (!chatId) return 0;
  const threshold = cfg.threshold || 3.8;

  // rop_kpi_snapshot has avg_rating
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, vendor_code, sku_title, avg_rating, reviews_count
      FROM rop_kpi_snapshot
      WHERE snapshot_date = ?
        AND avg_rating IS NOT NULL
        AND avg_rating < ?
        AND reviews_count > 3
      ORDER BY avg_rating ASC
      LIMIT 10
    `).bind(today, threshold).all();
  } catch (_) { return 0; }

  let sent = 0;
  for (const r of (rows?.results || [])) {
    const idem = `rating_drop:${r.nm_id}:${today}`;
    const msg  = [
      `⭐ *НИЗКИЙ РЕЙТИНГ*`,
      `nm_id: ${r.nm_id}${r.sku_title ? ' — ' + r.sku_title.slice(0, 40) : ''}`,
      `Рейтинг: *${(r.avg_rating || 0).toFixed(1)}* / 5.0 (порог: ${threshold})`,
      `Отзывов: ${r.reviews_count}`,
      `Действие: разобрать отзывы — /cs\\_inbox`,
    ].join('\n');
    if (await sendAlertMessage_(env, chatId, msg, 'rating_drop', r.nm_id, idem, 'warning')) sent++;
  }
  return sent;
}

// ── §6 Sync failed alert ───────────────────────────────────────────────────

async function runSyncFailedAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'sync_failed');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'sync_failed');
  if (!chatId) return 0;

  let row;
  try {
    row = await env.DB.prepare(`
      SELECT id, status, error, records_written
      FROM wb_sync_log
      WHERE sync_date = ?
      ORDER BY started_at DESC LIMIT 1
    `).bind(today).first();
  } catch (_) { return 0; }

  if (!row || row.status === 'ok') return 0;

  const idem = `sync_failed:${today}`;
  const msg  = [
    `🔴 *ОШИБКА СИНХРОНИЗАЦИИ WB*`,
    `Статус: ${row.status}`,
    `Записей: ${row.records_written || 0}`,
    row.error ? `Ошибки: ${String(row.error).slice(0, 200)}` : '',
    `Действие: /wb\\_sync\\_run для повтора`,
  ].filter(Boolean).join('\n');

  return await sendAlertMessage_(env, chatId, msg, 'sync_failed', null, idem, 'error') ? 1 : 0;
}

// ── §7 Orchestrator ────────────────────────────────────────────────────────

async function runAllAlerts_(env) {
  await ensureAlertsSchema_(env);
  const today   = new Date().toISOString().slice(0, 10);
  const results = {};

  const run = async (key, fn) => {
    try { results[key] = await fn(); } catch (e) { results[key] = 0; }
  };

  await Promise.all([
    run('stock_critical',    () => runStockCriticalAlert_(env, today)),
    run('stock_out',         () => runStockOutAlert_(env, today)),
    run('drr_spike',         () => runDrrSpikeAlert_(env, today)),
    run('return_rate_spike', () => runReturnRateAlert_(env, today)),
    run('rating_drop',       () => runRatingDropAlert_(env, today)),
    run('sync_failed',       () => runSyncFailedAlert_(env, today)),
  ]);

  const total = Object.values(results).reduce((s, n) => s + (n || 0), 0);
  return { date: today, total_sent: total, results };
}

// ── §8 Telegram commands ───────────────────────────────────────────────────

async function routeAlertsCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim().split('@')[0].toLowerCase();

  // /alerts — recent alerts today
  if (text === '/alerts') {
    await ensureAlertsSchema_(env);
    const today = new Date().toISOString().slice(0, 10);
    let rows;
    try {
      rows = await env.DB.prepare(`
        SELECT alert_type, nm_id, severity, message, sent_at
        FROM alert_log
        WHERE DATE(sent_at) = ?
        ORDER BY sent_at DESC
        LIMIT 10
      `).bind(today).all();
    } catch (_) {}

    const alerts = rows?.results || [];
    if (alerts.length === 0) {
      await sendTelegramMessage_(env, chatId, `✅ Алертов за ${today} нет.`);
      return true;
    }

    const lines = [`*Алерты за ${today}* (${alerts.length})`, ''];
    for (const a of alerts) {
      const icon = a.severity === 'critical' ? '🚨' : a.severity === 'error' ? '🔴' : '⚠️';
      const nm   = a.nm_id ? ` nm${a.nm_id}` : '';
      lines.push(`${icon} *${a.alert_type}*${nm}`);
      lines.push(`  ${(a.message || '').split('\n')[1] || ''}`);
    }
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  // /alerts_config — show current thresholds
  if (text === '/alerts_config') {
    await ensureAlertsSchema_(env);
    let rows;
    try {
      rows = await env.DB.prepare(
        `SELECT * FROM alert_config ORDER BY alert_type`
      ).all();
    } catch (_) {}

    const configs = rows?.results || [];
    const lines   = ['*Конфигурация алертов*', ''];
    for (const c of configs) {
      const status = c.enabled ? '✅' : '❌';
      lines.push(`${status} *${c.alert_type}*`);
      if (c.threshold != null) lines.push(`  Порог: ${c.threshold}`);
      lines.push(`  Cooldown: ${c.cooldown_hours}ч`);
      if (c.notify_chat_id) lines.push(`  Chat: ${c.notify_chat_id}`);
    }
    lines.push('', '_Настройка через API: POST /agent/alerts/config_');
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  return false;
}

// ── §9 HTTP routes ─────────────────────────────────────────────────────────

async function handleAlertsRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;
  if (!pathname.startsWith('/agent/alerts')) return null;

  const json = (obj, st) => new Response(JSON.stringify(obj), {
    status:  st || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await ensureAlertsSchema_(env);

  // GET /agent/alerts — recent alert log
  if (request.method === 'GET' && pathname === '/agent/alerts') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    const type  = url.searchParams.get('type') || null;
    try {
      let rows;
      if (type) {
        rows = await env.DB.prepare(
          `SELECT * FROM alert_log WHERE alert_type = ? ORDER BY sent_at DESC LIMIT ?`
        ).bind(type, limit).all();
      } else {
        rows = await env.DB.prepare(
          `SELECT * FROM alert_log ORDER BY sent_at DESC LIMIT ?`
        ).bind(limit).all();
      }
      return json({ ok: true, alerts: rows?.results || [] });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/alerts/config — update thresholds
  if (request.method === 'POST' && pathname === '/agent/alerts/config') {
    let body;
    try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Invalid JSON' }, 400); }

    const { alert_type, enabled, threshold, cooldown_hours, notify_chat_id } = body || {};
    if (!alert_type) return json({ ok: false, error: 'alert_type required' }, 400);

    try {
      await env.DB.prepare(`
        INSERT INTO alert_config (id, alert_type, enabled, threshold, cooldown_hours, notify_chat_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(alert_type) DO UPDATE SET
          enabled        = COALESCE(excluded.enabled, enabled),
          threshold      = COALESCE(excluded.threshold, threshold),
          cooldown_hours = COALESCE(excluded.cooldown_hours, cooldown_hours),
          notify_chat_id = COALESCE(excluded.notify_chat_id, notify_chat_id),
          updated_at     = datetime('now')
      `).bind(
        `alrt_${alert_type}`, alert_type,
        enabled        != null ? (enabled ? 1 : 0) : null,
        threshold      != null ? Number(threshold) : null,
        cooldown_hours != null ? Number(cooldown_hours) : null,
        notify_chat_id || null,
      ).run();
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/alerts/run — manual trigger
  if (request.method === 'POST' && pathname === '/agent/alerts/run') {
    const result = await runAllAlerts_(env);
    return json({ ok: true, result });
  }

  return null;
}
// ============================================================
// WB Analytics — Cross-Period Business Analytics  v1
// Build: ai_helpers_wb_analytics_v1
//
// Reads existing D1 snapshots (populated by wb_sync_v1.gs) and
// computes week-over-week business trends. No extra WB API calls.
//
// ── Reads from ───────────────────────────────────────────────
//   wb_sku_snapshot      — orders, revenue, returns per SKU per day
//   wb_finance_snapshot  — margin, profit, finance_status per SKU
//   wb_ads_snapshot      — ad spend, DRR per campaign per day
//   wb_stock_snapshot_v2 — stock levels
//
// ── New table ────────────────────────────────────────────────
//   wb_analytics_run     — cached weekly/period analytics results
//
// ── Telegram commands ────────────────────────────────────────
//   /analytics        — current week vs previous week summary
//   /week_summary     — same as /analytics (alias)
//   /trends           — top growing and declining SKUs
//   /analytics_sku <nm_id> — 14-day per-SKU trend
//
// ── REST API ─────────────────────────────────────────────────
//   GET /agent/analytics/week         — current week aggregate
//   GET /agent/analytics/trends       — SKU movers
//   GET /agent/analytics/sku/:nm_id   — per-SKU 14-day history
//   POST /agent/analytics/run         — trigger manual run
//
// ── Cron ─────────────────────────────────────────────────────
//   Triggered from runWeeklyInsightsJob_ in scheduler_v1.gs
//   (30 6 * * 1 — every Monday)
// ============================================================

const WB_ANALYTICS_BUILD = 'ai_helpers_wb_analytics_v1';

// Minimum days of data required to compute a meaningful comparison
const WB_ANALYTICS_MIN_DAYS = 3;
// Period length in days for the two comparison windows
const WB_ANALYTICS_PERIOD_DAYS = 7;

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureWbAnalyticsSchema_(env) {
  const db = env.DB;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS wb_analytics_run (
        id                TEXT PRIMARY KEY,
        period_start      TEXT NOT NULL,
        period_end        TEXT NOT NULL,
        period_type       TEXT NOT NULL DEFAULT 'week',
        revenue_cur       REAL,
        revenue_prev      REAL,
        orders_cur        INTEGER,
        orders_prev       INTEGER,
        returns_cur       INTEGER,
        returns_prev      INTEGER,
        ad_spend_cur      REAL,
        ad_spend_prev     REAL,
        avg_margin_cur    REAL,
        avg_margin_prev   REAL,
        net_profit_cur    REAL,
        net_profit_prev   REAL,
        skus_count_cur    INTEGER,
        top_signals_json  TEXT,
        top_growth_json   TEXT,
        top_decline_json  TEXT,
        ai_commentary     TEXT,
        status            TEXT NOT NULL DEFAULT 'ok',
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(period_start, period_end, period_type)
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_wb_analytics_run_period
        ON wb_analytics_run(period_start, period_type)
    `).run();
  } catch (_) {}
}

// ── Date helpers ───────────────────────────────────────────────────────────

function analyticsDateRange_(endDaysAgo, lengthDays) {
  const end   = new Date();
  end.setDate(end.getDate() - endDaysAgo);
  const start = new Date(end);
  start.setDate(start.getDate() - (lengthDays - 1));
  const fmt = d => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// ── Aggregation queries ────────────────────────────────────────────────────

async function aggregatePeriodRevenue_(db, start, end) {
  try {
    const row = await db.prepare(`
      SELECT
        COALESCE(SUM(orders_revenue), 0) AS revenue,
        COALESCE(SUM(orders_count),   0) AS orders,
        COALESCE(SUM(returns_count),  0) AS returns,
        COUNT(DISTINCT nm_id)            AS skus_count,
        COUNT(DISTINCT date)             AS days_with_data
      FROM wb_sku_snapshot
      WHERE date BETWEEN ? AND ?
    `).bind(start, end).first();
    return row || { revenue: 0, orders: 0, returns: 0, skus_count: 0, days_with_data: 0 };
  } catch (_) {
    return { revenue: 0, orders: 0, returns: 0, skus_count: 0, days_with_data: 0 };
  }
}

async function aggregatePeriodFinance_(db, start, end) {
  try {
    const row = await db.prepare(`
      SELECT
        AVG(margin_pct_after_ads)                                    AS avg_margin,
        COALESCE(SUM(profit_after_ads), 0)                          AS net_profit,
        COUNT(CASE WHEN finance_status IN ('loss','critical_loss') THEN 1 END) AS loss_skus,
        COUNT(CASE WHEN finance_status = 'good' THEN 1 END)         AS good_skus
      FROM wb_finance_snapshot
      WHERE date BETWEEN ? AND ?
    `).bind(start, end).first();
    return row || { avg_margin: null, net_profit: 0, loss_skus: 0, good_skus: 0 };
  } catch (_) {
    return { avg_margin: null, net_profit: 0, loss_skus: 0, good_skus: 0 };
  }
}

async function aggregatePeriodAds_(db, start, end) {
  try {
    const row = await db.prepare(`
      SELECT
        COALESCE(SUM(ad_spend),  0) AS total_spend,
        COALESCE(SUM(ad_orders), 0) AS ad_orders,
        COALESCE(SUM(ad_views),  0) AS total_views,
        COUNT(DISTINCT campaign_id) AS campaigns_count
      FROM wb_ads_snapshot
      WHERE date BETWEEN ? AND ?
    `).bind(start, end).first();
    return row || { total_spend: 0, ad_orders: 0, total_views: 0, campaigns_count: 0 };
  } catch (_) {
    return { total_spend: 0, ad_orders: 0, total_views: 0, campaigns_count: 0 };
  }
}

async function getTopSkusByCurrent_(db, start, end, limit) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT nm_id, SUM(orders_revenue) AS revenue, SUM(orders_count) AS orders
      FROM wb_sku_snapshot
      WHERE date BETWEEN ? AND ?
      GROUP BY nm_id
      ORDER BY revenue DESC
      LIMIT ?
    `).bind(start, end, limit).all();
    return results;
  } catch (_) { return []; }
}

async function getSkuRevenueByPeriod_(db, start, end) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT nm_id, SUM(orders_revenue) AS revenue, SUM(orders_count) AS orders
      FROM wb_sku_snapshot
      WHERE date BETWEEN ? AND ?
      GROUP BY nm_id
    `).bind(start, end).all();
    const map = {};
    for (const r of results) map[r.nm_id] = r;
    return map;
  } catch (_) { return {}; }
}

async function computeTopMovers_(db, curStart, curEnd, prevStart, prevEnd) {
  const [curMap, prevMap] = await Promise.all([
    getSkuRevenueByPeriod_(db, curStart, curEnd),
    getSkuRevenueByPeriod_(db, prevStart, prevEnd),
  ]);

  const allNmIds = new Set([...Object.keys(curMap), ...Object.keys(prevMap)]);
  const movers = [];

  for (const nmId of allNmIds) {
    const cur  = curMap[nmId]?.revenue  || 0;
    const prev = prevMap[nmId]?.revenue || 0;
    const delta = cur - prev;
    const deltaPct = prev > 0 ? (delta / prev) * 100 : (cur > 0 ? 100 : 0);
    movers.push({ nm_id: nmId, revenue_cur: cur, revenue_prev: prev, delta, delta_pct: wbRound_(deltaPct, 1) });
  }

  movers.sort((a, b) => b.delta - a.delta);

  const top_growth  = movers.filter(m => m.delta > 0).slice(0, 5);
  const top_decline = movers.filter(m => m.delta < 0).reverse().slice(0, 5);

  return { top_growth, top_decline };
}

// ── Trend signal detection ─────────────────────────────────────────────────

function buildTrendSignals_(cur, prev) {
  const signals = [];

  const revDelta    = prev.revenue.revenue > 0 ? ((cur.revenue.revenue - prev.revenue.revenue) / prev.revenue.revenue) * 100 : null;
  const ordersDelta = prev.revenue.orders  > 0 ? ((cur.revenue.orders  - prev.revenue.orders)  / prev.revenue.orders)  * 100 : null;
  const marginDelta = (cur.finance.avg_margin != null && prev.finance.avg_margin != null)
    ? cur.finance.avg_margin - prev.finance.avg_margin : null;
  const adSpendDelta = prev.ads.total_spend > 0
    ? ((cur.ads.total_spend - prev.ads.total_spend) / prev.ads.total_spend) * 100 : null;
  const returnDelta  = prev.revenue.returns > 0
    ? ((cur.revenue.returns - prev.revenue.returns) / prev.revenue.returns) * 100 : null;

  // Revenue signals
  if (revDelta !== null) {
    if (revDelta >= 15)       signals.push({ type: 'revenue_up',     severity: 'positive', text: `Выручка +${wbRound_(revDelta, 1)}% к прошлой неделе` });
    else if (revDelta <= -15) signals.push({ type: 'revenue_down',   severity: 'negative', text: `Выручка ${wbRound_(revDelta, 1)}% к прошлой неделе` });
    else if (revDelta >= 5)   signals.push({ type: 'revenue_slight_up',  severity: 'positive', text: `Выручка +${wbRound_(revDelta, 1)}%` });
    else if (revDelta <= -5)  signals.push({ type: 'revenue_slight_down', severity: 'warning', text: `Выручка ${wbRound_(revDelta, 1)}%` });
  }

  // Margin signals
  if (marginDelta !== null) {
    if (marginDelta >= 3)      signals.push({ type: 'margin_up',   severity: 'positive', text: `Маржа +${wbRound_(marginDelta, 1)} п.п.` });
    else if (marginDelta <= -3) signals.push({ type: 'margin_down', severity: 'negative', text: `Маржа ${wbRound_(marginDelta, 1)} п.п.` });
  }

  // Ad spend efficiency
  if (adSpendDelta !== null && cur.revenue.revenue > 0 && prev.revenue.revenue > 0) {
    const curDrr  = cur.revenue.revenue  > 0 ? (cur.ads.total_spend  / cur.revenue.revenue)  * 100 : null;
    const prevDrr = prev.revenue.revenue > 0 ? (prev.ads.total_spend / prev.revenue.revenue) * 100 : null;
    if (curDrr !== null && prevDrr !== null) {
      const drrDelta = curDrr - prevDrr;
      if (drrDelta >= 5)       signals.push({ type: 'drr_up',   severity: 'warning',  text: `ДРР вырос до ${wbRound_(curDrr, 1)}% (было ${wbRound_(prevDrr, 1)}%)` });
      else if (drrDelta <= -5) signals.push({ type: 'drr_down', severity: 'positive', text: `ДРР снизился до ${wbRound_(curDrr, 1)}% (было ${wbRound_(prevDrr, 1)}%)` });
    }
  }

  // Returns
  if (returnDelta !== null && cur.revenue.returns > 0) {
    if (returnDelta >= 20) signals.push({ type: 'returns_spike', severity: 'negative', text: `Возвраты +${wbRound_(returnDelta, 1)}%` });
  }

  // Loss SKUs
  if (cur.finance.loss_skus > 0) {
    const prevLoss = prev.finance.loss_skus || 0;
    if (cur.finance.loss_skus > prevLoss + 2) {
      signals.push({ type: 'loss_skus_up', severity: 'negative', text: `Убыточных SKU: ${cur.finance.loss_skus} (было ${prevLoss})` });
    }
  }

  // Orders conversion
  if (ordersDelta !== null && revDelta !== null && ordersDelta < revDelta - 10) {
    signals.push({ type: 'aov_up', severity: 'positive', text: 'Средний чек вырос (заказов меньше, выручка выше)' });
  }

  return {
    revenue_delta_pct: revDelta,
    orders_delta_pct: ordersDelta,
    margin_delta_pts: marginDelta,
    ad_spend_delta_pct: adSpendDelta,
    returns_delta_pct: returnDelta,
    signals,
  };
}

// ── AI enrichment ──────────────────────────────────────────────────────────

async function enrichAnalyticsWithAi_(env, analyticsData) {
  const prompt = `Ты — аналитик WB бизнеса. Проанализируй данные за неделю и дай короткий (3-5 предложений) бизнес-вывод.

Текущая неделя:
- Выручка: ${wbRound_(analyticsData.revenue_cur, 0)} руб. (${analyticsData.revenue_delta_pct !== null ? (analyticsData.revenue_delta_pct >= 0 ? '+' : '') + wbRound_(analyticsData.revenue_delta_pct, 1) + '% к прошлой неделе' : 'нет сравнения'})
- Заказы: ${analyticsData.orders_cur} шт. (${analyticsData.orders_delta_pct !== null ? (analyticsData.orders_delta_pct >= 0 ? '+' : '') + wbRound_(analyticsData.orders_delta_pct, 1) + '%' : '—'})
- Средняя маржа: ${analyticsData.avg_margin_cur !== null ? wbRound_(analyticsData.avg_margin_cur, 1) + '%' : 'нет данных'}
- Расход на рекламу: ${wbRound_(analyticsData.ad_spend_cur, 0)} руб.
- Убыточных SKU: ${analyticsData.loss_skus_cur || 0}

Сигналы: ${(analyticsData.signals || []).map(s => s.text).join('; ') || 'нет существенных отклонений'}

Дай краткий вывод: что произошло, на что обратить внимание, 1 конкретная рекомендация.`;

  // Try Gemini first
  if (env.GEMINI_API_KEY) {
    try {
      const model = env.GEMINI_CLASSIFICATION_MODEL || 'gemini-1.5-flash-latest';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 300, temperature: 0.3 },
          }),
          signal: AbortSignal.timeout(15000),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text.trim();
      }
    } catch (_) {}
  }

  // Fallback: Groq
  if (env.GROQ_API_KEY) {
    try {
      const base = env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
      const model = env.GROQ_MODEL || 'llama3-8b-8192';
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return text.trim();
      }
    } catch (_) {}
  }

  // Static fallback
  const rev = analyticsData.revenue_delta_pct;
  if (rev === null) return 'Данных за прошлую неделю недостаточно для сравнения.';
  if (rev >= 15) return `Сильный рост выручки (+${wbRound_(rev, 1)}%). Продолжайте текущую стратегию.`;
  if (rev <= -15) return `Выручка снизилась на ${wbRound_(Math.abs(rev), 1)}%. Проверьте остатки и рекламные кампании.`;
  return `Стабильная неделя, изменение выручки ${rev >= 0 ? '+' : ''}${wbRound_(rev, 1)}%. Следите за маржой и возвратами.`;
}

// ── Main orchestrator ──────────────────────────────────────────────────────

async function runWbWeeklyAnalytics_(env) {
  await ensureWbAnalyticsSchema_(env);
  const db = env.DB;

  // Current = last 7 days (yesterday inclusive)
  const cur  = analyticsDateRange_(1, WB_ANALYTICS_PERIOD_DAYS);
  // Previous = 7 days before that
  const prev = analyticsDateRange_(1 + WB_ANALYTICS_PERIOD_DAYS, WB_ANALYTICS_PERIOD_DAYS);

  // Parallel queries
  const [
    revCur, revPrev,
    finCur, finPrev,
    adsCur, adsPrev,
    movers,
  ] = await Promise.all([
    aggregatePeriodRevenue_(db, cur.start, cur.end),
    aggregatePeriodRevenue_(db, prev.start, prev.end),
    aggregatePeriodFinance_(db, cur.start, cur.end),
    aggregatePeriodFinance_(db, prev.start, prev.end),
    aggregatePeriodAds_(db, cur.start, cur.end),
    aggregatePeriodAds_(db, prev.start, prev.end),
    computeTopMovers_(db, cur.start, cur.end, prev.start, prev.end),
  ]);

  const hasEnoughData = revCur.days_with_data >= WB_ANALYTICS_MIN_DAYS;

  const trendData = buildTrendSignals_(
    { revenue: revCur, finance: finCur, ads: adsCur },
    { revenue: revPrev, finance: finPrev, ads: adsPrev }
  );

  const analyticsPayload = {
    revenue_cur:       wbRound_(revCur.revenue, 2),
    revenue_prev:      wbRound_(revPrev.revenue, 2),
    orders_cur:        revCur.orders,
    orders_prev:       revPrev.orders,
    returns_cur:       revCur.returns,
    returns_prev:      revPrev.returns,
    ad_spend_cur:      wbRound_(adsCur.total_spend, 2),
    ad_spend_prev:     wbRound_(adsPrev.total_spend, 2),
    avg_margin_cur:    finCur.avg_margin != null ? wbRound_(finCur.avg_margin, 2) : null,
    avg_margin_prev:   finPrev.avg_margin != null ? wbRound_(finPrev.avg_margin, 2) : null,
    net_profit_cur:    wbRound_(finCur.net_profit, 2),
    net_profit_prev:   wbRound_(finPrev.net_profit, 2),
    loss_skus_cur:     finCur.loss_skus,
    skus_count_cur:    revCur.skus_count,
    ...trendData,
  };

  let ai_commentary = null;
  if (hasEnoughData) {
    try {
      ai_commentary = await enrichAnalyticsWithAi_(env, analyticsPayload);
    } catch (_) {}
  }

  const runId = `ana_${Date.now().toString(36)}`;
  try {
    await db.prepare(`
      INSERT INTO wb_analytics_run
        (id, period_start, period_end, period_type,
         revenue_cur, revenue_prev, orders_cur, orders_prev,
         returns_cur, returns_prev, ad_spend_cur, ad_spend_prev,
         avg_margin_cur, avg_margin_prev, net_profit_cur, net_profit_prev,
         skus_count_cur, top_signals_json, top_growth_json, top_decline_json,
         ai_commentary, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(period_start, period_end, period_type) DO UPDATE SET
        revenue_cur = excluded.revenue_cur,
        orders_cur  = excluded.orders_cur,
        top_signals_json = excluded.top_signals_json,
        ai_commentary    = excluded.ai_commentary,
        status           = excluded.status
    `).bind(
      runId, cur.start, cur.end, 'week',
      analyticsPayload.revenue_cur,   analyticsPayload.revenue_prev,
      analyticsPayload.orders_cur,    analyticsPayload.orders_prev,
      analyticsPayload.returns_cur,   analyticsPayload.returns_prev,
      analyticsPayload.ad_spend_cur,  analyticsPayload.ad_spend_prev,
      analyticsPayload.avg_margin_cur, analyticsPayload.avg_margin_prev,
      analyticsPayload.net_profit_cur, analyticsPayload.net_profit_prev,
      analyticsPayload.skus_count_cur,
      JSON.stringify(trendData.signals),
      JSON.stringify(movers.top_growth),
      JSON.stringify(movers.top_decline),
      ai_commentary || null,
      hasEnoughData ? 'ok' : 'insufficient_data',
    ).run();
  } catch (e) {
    try {
      await wbLog_(db, {
        source_agent: WB_ANALYTICS_BUILD,
        event_type: 'analytics_save_error',
        details_json: JSON.stringify({ error: String(e) }),
      });
    } catch (_) {}
  }

  return {
    run_id: runId,
    period: cur,
    prev_period: prev,
    has_enough_data: hasEnoughData,
    ...analyticsPayload,
    movers,
    ai_commentary,
  };
}

// ── Per-SKU history ────────────────────────────────────────────────────────

async function getSkuAnalyticsHistory_(db, nmId, days) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        s.date,
        s.orders_count,
        s.orders_revenue,
        s.returns_count,
        f.margin_pct_after_ads AS margin_pct,
        f.profit_after_ads     AS profit,
        f.finance_status
      FROM wb_sku_snapshot s
      LEFT JOIN wb_finance_snapshot f ON f.date = s.date AND f.nm_id = s.nm_id
      WHERE s.nm_id = ?
      ORDER BY s.date DESC
      LIMIT ?
    `).bind(String(nmId), days).all();
    return results;
  } catch (_) { return []; }
}

// ── Telegram formatting ────────────────────────────────────────────────────

function formatDelta_(delta, unit) {
  if (delta === null || delta === undefined) return '—';
  const sign = delta >= 0 ? '▲' : '▼';
  const abs  = Math.abs(wbRound_(delta, 1));
  return `${sign} ${abs}${unit}`;
}

function formatAnalyticsForTelegram_(data) {
  const { revenue_cur, revenue_prev, orders_cur, orders_prev,
    ad_spend_cur, avg_margin_cur, net_profit_cur,
    revenue_delta_pct, orders_delta_pct, margin_delta_pts,
    loss_skus_cur, skus_count_cur, signals, ai_commentary, period } = data;

  const lines = [
    `📊 *Аналитика недели ${period.start} — ${period.end}*`,
    '',
    `💰 Выручка: *${(revenue_cur || 0).toLocaleString('ru-RU')} ₽*  ${formatDelta_(revenue_delta_pct, '%')}`,
    `📦 Заказы: *${orders_cur || 0}*  ${formatDelta_(orders_delta_pct, '%')}`,
    `📈 Маржа: *${avg_margin_cur != null ? avg_margin_cur + '%' : 'нет данных'}*  ${formatDelta_(margin_delta_pts, ' п.п.')}`,
    `📣 Реклама: *${(ad_spend_cur || 0).toLocaleString('ru-RU')} ₽*`,
    `💵 Прибыль (оценка): *${(net_profit_cur || 0).toLocaleString('ru-RU')} ₽*`,
  ];

  if ((loss_skus_cur || 0) > 0) {
    lines.push(`⚠️ Убыточных SKU: *${loss_skus_cur}* из ${skus_count_cur || 0}`);
  }

  if (signals && signals.length > 0) {
    lines.push('', '*Сигналы:*');
    for (const s of signals.slice(0, 5)) {
      const icon = s.severity === 'positive' ? '✅' : s.severity === 'negative' ? '❌' : '⚠️';
      lines.push(`${icon} ${s.text}`);
    }
  }

  if (ai_commentary) {
    lines.push('', '*Вывод AI:*', ai_commentary);
  }

  return lines.join('\n');
}

function formatTopMoversForTelegram_(movers, period) {
  const { top_growth = [], top_decline = [] } = movers;

  const lines = [`🔍 *Топ изменений SKU (${period.start} — ${period.end})*`];

  if (top_growth.length > 0) {
    lines.push('', '📈 *Рост выручки:*');
    for (const s of top_growth) {
      const delta = s.revenue_prev > 0
        ? ` (+${wbRound_((s.delta / s.revenue_prev) * 100, 0)}%)`
        : ' (новый)';
      lines.push(`▸ SKU ${s.nm_id}: ${(s.revenue_cur).toLocaleString('ru-RU')} ₽${delta}`);
    }
  }

  if (top_decline.length > 0) {
    lines.push('', '📉 *Снижение выручки:*');
    for (const s of top_decline) {
      const pct = s.revenue_prev > 0 ? ` (${wbRound_((s.delta / s.revenue_prev) * 100, 0)}%)` : '';
      lines.push(`▸ SKU ${s.nm_id}: ${(s.revenue_cur).toLocaleString('ru-RU')} ₽${pct}`);
    }
  }

  if (top_growth.length === 0 && top_decline.length === 0) {
    lines.push('', '_Недостаточно данных для сравнения_');
  }

  return lines.join('\n');
}

// ── Telegram command router ────────────────────────────────────────────────

async function routeAnalyticsTelegramCommand_(env, msg, chatId, userId) {
  const text    = (msg.text || '').trim().split('@')[0];
  const parts   = text.split(/\s+/);
  const command = parts[0].toLowerCase();

  const sendMsg = (t) => sendTelegramMessage_(env, chatId, t, { parse_mode: 'Markdown' });

  if (command === '/analytics' || command === '/week_summary') {
    await sendMsg('⏳ Вычисляю аналитику недели...');
    try {
      const result = await runWbWeeklyAnalytics_(env);
      if (!result.has_enough_data) {
        await sendMsg('⚠️ Данных меньше 3 дней — сравнение неполное.\n\n' + formatAnalyticsForTelegram_(result));
      } else {
        await sendMsg(formatAnalyticsForTelegram_(result));
      }
    } catch (e) {
      await sendMsg(`❌ Ошибка аналитики: ${e.message}`);
    }
    return true;
  }

  if (command === '/trends') {
    await sendMsg('⏳ Анализирую движение SKU...');
    try {
      const cur  = analyticsDateRange_(1, WB_ANALYTICS_PERIOD_DAYS);
      const prev = analyticsDateRange_(1 + WB_ANALYTICS_PERIOD_DAYS, WB_ANALYTICS_PERIOD_DAYS);
      const movers = await computeTopMovers_(env.DB, cur.start, cur.end, prev.start, prev.end);
      await sendMsg(formatTopMoversForTelegram_(movers, cur));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/analytics_sku') {
    const nmId = parts[1];
    if (!nmId) {
      await sendMsg('Использование: `/analytics_sku <nm_id>`');
      return true;
    }
    try {
      const rows = await getSkuAnalyticsHistory_(env.DB, nmId, 14);
      if (!rows.length) {
        await sendMsg(`SKU ${nmId}: данных в снапшотах нет.`);
        return true;
      }
      const lines = [`📦 *SKU ${nmId} — последние ${rows.length} дней*`, ''];
      for (const r of rows) {
        const margin = r.margin_pct != null ? `${wbRound_(r.margin_pct, 1)}%` : '—';
        const statusIcon = r.finance_status === 'good' ? '✅' : r.finance_status === 'loss' ? '❌' : r.finance_status === 'critical_loss' ? '🔴' : '⚪';
        lines.push(`${r.date}: ${r.orders_count} зак. / ${(r.orders_revenue || 0).toLocaleString('ru-RU')} ₽ / маржа ${margin} ${statusIcon}`);
      }
      await sendMsg(lines.join('\n'));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  return false;
}

// ── HTTP API routes ────────────────────────────────────────────────────────

async function handleAnalyticsRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;

  if (!pathname.startsWith('/agent/analytics')) return null;

  const json = (obj, st) => new Response(JSON.stringify(obj, null, 2), {
    status: st || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

  // GET /agent/analytics/week — current week vs previous week
  if (request.method === 'GET' && pathname === '/agent/analytics/week') {
    try {
      await ensureWbAnalyticsSchema_(env);
      const cur  = analyticsDateRange_(1, WB_ANALYTICS_PERIOD_DAYS);
      const prev = analyticsDateRange_(1 + WB_ANALYTICS_PERIOD_DAYS, WB_ANALYTICS_PERIOD_DAYS);

      // Try to serve cached result first (< 2h old)
      const cached = await env.DB.prepare(`
        SELECT * FROM wb_analytics_run
        WHERE period_start = ? AND period_end = ? AND period_type = 'week'
        AND created_at > datetime('now', '-2 hours')
        ORDER BY created_at DESC LIMIT 1
      `).bind(cur.start, cur.end).first();

      if (cached) {
        return json({ ok: true, cached: true, data: cached });
      }

      const result = await runWbWeeklyAnalytics_(env);
      return json({ ok: true, cached: false, data: result });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/analytics/trends — SKU movers
  if (request.method === 'GET' && pathname === '/agent/analytics/trends') {
    try {
      const cur  = analyticsDateRange_(1, WB_ANALYTICS_PERIOD_DAYS);
      const prev = analyticsDateRange_(1 + WB_ANALYTICS_PERIOD_DAYS, WB_ANALYTICS_PERIOD_DAYS);
      const movers = await computeTopMovers_(env.DB, cur.start, cur.end, prev.start, prev.end);
      return json({ ok: true, period: cur, prev_period: prev, ...movers });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/analytics/sku/:nm_id — per-SKU history
  const skuMatch = pathname.match(/^\/agent\/analytics\/sku\/(.+)$/);
  if (request.method === 'GET' && skuMatch) {
    const nmId = skuMatch[1];
    const days = parseInt(url.searchParams.get('days') || '14', 10);
    try {
      const rows = await getSkuAnalyticsHistory_(env.DB, nmId, Math.min(days, 90));
      return json({ ok: true, nm_id: nmId, days, rows });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/analytics/run — trigger manual run
  if (request.method === 'POST' && pathname === '/agent/analytics/run') {
    try {
      const result = await runWbWeeklyAnalytics_(env);
      return json({ ok: true, result });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
// ============================================================
// WB Ads Chief — Advertising Analytics  v1
// Build: ai_helpers_wb_ads_chief_v1
//
// Multi-day campaign performance analysis using wb_ads_snapshot.
// No new WB API calls — reads from D1 snapshots populated by
// wb_sync_v1.gs / wb_api_client_v1.gs.
//
// ── Analysis ─────────────────────────────────────────────────
//   1. Campaign efficiency ranking (CPO, DRR, CTR)
//   2. Waste detection: spend > 0, orders = 0 for N+ days
//   3. Scale opportunities: DRR < threshold, consistent CTR
//   4. Budget concentration (top-3 campaigns vs total)
//   5. Per-SKU ad spend attribution
//
// ── Telegram commands ─────────────────────────────────────────
//   /ads_report      — today's ad summary with top issues
//   /ads_campaigns   — 7-day campaign efficiency ranking
//   /ads_waste       — campaigns wasting budget (spend, 0 orders)
//   /ads_sku <nm_id> — per-SKU ad attribution
//
// ── REST API ─────────────────────────────────────────────────
//   GET /agent/ads/report          — today's analysis JSON
//   GET /agent/ads/campaigns       — 7-day campaign ranking
//   GET /agent/ads/waste           — waste detection
//   GET /agent/ads/sku/:nm_id      — per-SKU ad data
//
// ── Safety ───────────────────────────────────────────────────
//   Read-only. All recommendations require_confirmation=true.
//   No automated budget changes. No automated campaign pauses.
// ============================================================

const WB_ADS_CHIEF_BUILD = 'ai_helpers_wb_ads_chief_v1';

// Thresholds
const ADS_WASTE_MIN_DAYS       = 3;    // days of spend with 0 orders = wasted
const ADS_SCALE_MAX_DRR        = 0.10; // 10% DRR — good enough to scale
const ADS_SCALE_MIN_ORDERS     = 3;    // minimum orders to consider scaling
const ADS_HIGH_DRR_THRESHOLD   = 0.40; // 40% DRR — high
const ADS_CRITICAL_DRR         = 0.60; // 60% DRR — critical
const ADS_LOW_CTR_THRESHOLD    = 0.003; // 0.3% CTR — card quality issue

// ── Core data queries ──────────────────────────────────────────────────────

async function adsCampaignPeriodStats_(db, startDate, endDate) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        campaign_id,
        MAX(campaign_name) AS campaign_name,
        COUNT(DISTINCT date)  AS days_active,
        COUNT(DISTINCT nm_id) AS skus_count,
        SUM(ad_spend)         AS total_spend,
        SUM(ad_orders)        AS total_orders,
        SUM(impressions)      AS total_impressions,
        SUM(clicks)           AS total_clicks,
        AVG(CASE WHEN drr IS NOT NULL THEN drr END) AS avg_drr,
        AVG(CASE WHEN ctr IS NOT NULL THEN ctr END) AS avg_ctr,
        AVG(CASE WHEN cpc IS NOT NULL THEN cpc END) AS avg_cpc,
        SUM(CASE WHEN ad_spend > 0 AND ad_orders = 0 THEN 1 ELSE 0 END) AS zero_order_days
      FROM wb_ads_snapshot
      WHERE date BETWEEN ? AND ?
      GROUP BY campaign_id
      ORDER BY total_spend DESC
    `).bind(startDate, endDate).all();
    return results;
  } catch (_) { return []; }
}

async function adsWastedCampaigns_(db, startDate, endDate, minDays) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        campaign_id,
        MAX(campaign_name) AS campaign_name,
        COUNT(DISTINCT date) AS days_with_spend,
        SUM(ad_spend)        AS total_spend,
        SUM(ad_orders)       AS total_orders
      FROM wb_ads_snapshot
      WHERE date BETWEEN ? AND ? AND ad_spend > 0
      GROUP BY campaign_id
      HAVING total_orders = 0 AND days_with_spend >= ?
      ORDER BY total_spend DESC
    `).bind(startDate, endDate, minDays).all();
    return results;
  } catch (_) { return []; }
}

async function adsDaySummary_(db, date) {
  try {
    const row = await db.prepare(`
      SELECT
        COUNT(DISTINCT campaign_id) AS campaigns_count,
        COUNT(DISTINCT nm_id)       AS skus_with_ads,
        COALESCE(SUM(ad_spend),  0) AS total_spend,
        COALESCE(SUM(ad_orders), 0) AS total_orders,
        COALESCE(SUM(impressions), 0) AS total_impressions,
        COALESCE(SUM(clicks),    0) AS total_clicks,
        COUNT(CASE WHEN ads_status = 'critical' THEN 1 END) AS critical_count,
        COUNT(CASE WHEN ads_status = 'risk'     THEN 1 END) AS risk_count
      FROM wb_ads_snapshot
      WHERE date = ?
    `).bind(date).first();
    return row || {};
  } catch (_) { return {}; }
}

async function adsSkuBreakdown_(db, nmId, days) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        date,
        campaign_id,
        MAX(campaign_name) AS campaign_name,
        SUM(ad_spend)      AS spend,
        SUM(ad_orders)     AS orders,
        SUM(impressions)   AS impressions,
        AVG(ctr)           AS ctr,
        AVG(drr)           AS drr,
        MAX(ads_status)    AS ads_status
      FROM wb_ads_snapshot
      WHERE nm_id = ?
      GROUP BY date, campaign_id
      ORDER BY date DESC, spend DESC
      LIMIT ?
    `).bind(String(nmId), days * 5).all();
    return results;
  } catch (_) { return []; }
}

// ── Efficiency scoring ─────────────────────────────────────────────────────

function scoreCampaign_(c) {
  const spend  = c.total_spend  || 0;
  const orders = c.total_orders || 0;
  const drr    = c.avg_drr;
  const ctr    = c.avg_ctr;

  if (spend === 0) return { ...c, cpo: null, efficiency: 'no_spend', score: 0 };
  if (orders === 0) return { ...c, cpo: null, efficiency: 'waste',   score: -100 };

  const cpo = wbRound_(spend / orders, 2);

  let efficiency;
  if (drr !== null && drr <= ADS_SCALE_MAX_DRR && orders >= ADS_SCALE_MIN_ORDERS) {
    efficiency = 'scale';
  } else if (drr !== null && drr >= ADS_CRITICAL_DRR) {
    efficiency = 'critical';
  } else if (drr !== null && drr >= ADS_HIGH_DRR_THRESHOLD) {
    efficiency = 'high_drr';
  } else if (ctr !== null && ctr < ADS_LOW_CTR_THRESHOLD) {
    efficiency = 'low_ctr';
  } else {
    efficiency = 'normal';
  }

  // Score: lower CPO + lower DRR = better
  const drrScore   = drr   !== null ? Math.max(0, 100 - drr * 100)   : 50;
  const orderScore = Math.min(orders * 5, 50);
  const score      = drrScore + orderScore;

  return { ...c, cpo, efficiency, score: wbRound_(score, 1) };
}

function classifyScalingOpportunities_(campaigns) {
  return campaigns
    .filter(c => c.efficiency === 'scale')
    .map(c => ({
      campaign_id:   c.campaign_id,
      campaign_name: c.campaign_name || c.campaign_id,
      total_spend:   c.total_spend,
      total_orders:  c.total_orders,
      avg_drr_pct:   c.avg_drr != null ? wbRound_(c.avg_drr * 100, 1) : null,
      avg_ctr_pct:   c.avg_ctr != null ? wbRound_(c.avg_ctr * 100, 2) : null,
      cpo:           c.cpo,
      recommendation: 'Рассмотреть увеличение бюджета — эффективная кампания',
      requires_confirmation: true,
    }));
}

// ── AI enrichment ──────────────────────────────────────────────────────────

async function enrichAdsWithAi_(env, reportData) {
  const { day_summary, wasted, scale_opps, total_efficiency } = reportData;

  const prompt = `Ты — аналитик рекламы на Wildberries. Дай краткий (2-3 предложения) вывод по рекламным кампаниям.

Сегодня:
- Кампаний: ${day_summary.campaigns_count || 0}, SKU с рекламой: ${day_summary.skus_with_ads || 0}
- Общий расход: ${wbRound_(day_summary.total_spend || 0, 0)} ₽
- Заказов: ${day_summary.total_orders || 0}
- Критичных/рисковых: ${(day_summary.critical_count || 0) + (day_summary.risk_count || 0)}

Проблемы (последние 7 дней):
- Кампаний с расходом и 0 заказами: ${wasted.length}
- Потрачено впустую: ${wbRound_(wasted.reduce((s, w) => s + (w.total_spend || 0), 0), 0)} ₽

Возможности:
- Кампаний для масштабирования: ${scale_opps.length}

Дай вывод и 1 конкретный приоритет.`;

  if (env.GEMINI_API_KEY) {
    try {
      const model = env.GEMINI_CLASSIFICATION_MODEL || 'gemini-1.5-flash-latest';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 200, temperature: 0.3 },
          }),
          signal: AbortSignal.timeout(12000),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text.trim();
      }
    } catch (_) {}
  }

  if (env.GROQ_API_KEY) {
    try {
      const base  = env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
      const model = env.GROQ_MODEL    || 'llama3-8b-8192';
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 200,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return text.trim();
      }
    } catch (_) {}
  }

  if (wasted.length > 0) return `${wasted.length} кампаний расходуют бюджет без заказов. Приоритет — остановить или скорректировать их.`;
  if (scale_opps.length > 0) return `${scale_opps.length} кампаний показывают хорошую эффективность. Рассмотрите увеличение бюджета.`;
  return 'Реклама работает в штатном режиме. Контролируйте ДРР по кампаниям.';
}

// ── Main analysis orchestrator ─────────────────────────────────────────────

async function runAdsChief_(env) {
  const db    = env.DB;
  const today = new Date().toISOString().slice(0, 10);

  const periodEnd   = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const periodStart = (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })();

  const [daySummary, periodCampaigns, wasted] = await Promise.all([
    adsDaySummary_(db, periodEnd),
    adsCampaignPeriodStats_(db, periodStart, periodEnd),
    adsWastedCampaigns_(db, periodStart, periodEnd, ADS_WASTE_MIN_DAYS),
  ]);

  const scoredCampaigns = periodCampaigns.map(scoreCampaign_);
  scoredCampaigns.sort((a, b) => b.score - a.score);

  const scaleOpps = classifyScalingOpportunities_(scoredCampaigns);
  const highDrrCampaigns = scoredCampaigns.filter(c => c.efficiency === 'critical' || c.efficiency === 'high_drr');
  const lowCtrCampaigns  = scoredCampaigns.filter(c => c.efficiency === 'low_ctr');

  const totalSpend7d = periodCampaigns.reduce((s, c) => s + (c.total_spend || 0), 0);
  const top3Spend    = scoredCampaigns.slice(0, 3).reduce((s, c) => s + (c.total_spend || 0), 0);
  const concentrationPct = totalSpend7d > 0 ? wbRound_((top3Spend / totalSpend7d) * 100, 1) : 0;

  const reportData = {
    period: { start: periodStart, end: periodEnd },
    day_summary: daySummary,
    campaigns: scoredCampaigns,
    wasted,
    scale_opps: scaleOpps,
    high_drr: highDrrCampaigns,
    low_ctr: lowCtrCampaigns,
    total_spend_7d: wbRound_(totalSpend7d, 2),
    concentration_pct: concentrationPct,
  };

  let ai_commentary = null;
  try {
    ai_commentary = await enrichAdsWithAi_(env, reportData);
  } catch (_) {}

  try {
    await wbLog_(db, {
      source_agent: WB_ADS_CHIEF_BUILD,
      event_type:   'ads_chief_run',
      status:       'success',
      payload: {
        campaigns_count: scoredCampaigns.length,
        wasted_count:    wasted.length,
        scale_opps:      scaleOpps.length,
        total_spend_7d:  reportData.total_spend_7d,
      },
    });
  } catch (_) {}

  return { ...reportData, ai_commentary };
}

// ── Telegram formatting ────────────────────────────────────────────────────

function formatAdsDayReport_(report) {
  const { day_summary: d, wasted, scale_opps, high_drr, total_spend_7d, concentration_pct, ai_commentary, period } = report;

  const spend     = wbRound_(d.total_spend || 0, 0);
  const orders    = d.total_orders || 0;
  const cpo       = orders > 0 ? wbRound_(spend / orders, 0) : null;
  const critRisk  = (d.critical_count || 0) + (d.risk_count || 0);

  const lines = [
    `📣 *Реклама — отчёт (${period.start} — ${period.end})*`,
    '',
    `💰 Расход (7д): *${total_spend_7d.toLocaleString('ru-RU')} ₽*`,
    `📦 Заказов (${period.end}): *${orders}* шт.${cpo ? `  CPO: ${cpo} ₽` : ''}`,
    `🎯 Кампаний: ${d.campaigns_count || 0}  SKU: ${d.skus_with_ads || 0}`,
  ];

  if (concentration_pct >= 70) {
    lines.push(`⚠️ Концентрация: топ-3 кампании = ${concentration_pct}% расхода`);
  }

  if (critRisk > 0) {
    lines.push(`\n⚠️ Требуют внимания сегодня: ${critRisk} кампаний`);
  }

  if (wasted.length > 0) {
    const wastedTotal = wbRound_(wasted.reduce((s, w) => s + (w.total_spend || 0), 0), 0);
    lines.push(`\n🚫 *Слив бюджета (${ADS_WASTE_MIN_DAYS}+ дней без заказов):*`);
    for (const w of wasted.slice(0, 4)) {
      lines.push(`  — ${w.campaign_name || w.campaign_id}: ${wbRound_(w.total_spend || 0, 0)} ₽ / ${w.days_with_spend}д`);
    }
    if (wasted.length > 4) lines.push(`  _...и ещё ${wasted.length - 4}_`);
    lines.push(`  Итого: *${wastedTotal.toLocaleString('ru-RU')} ₽* — рекомендуется приостановить`);
  }

  if (high_drr.length > 0) {
    lines.push(`\n❌ *Высокий ДРР:*`);
    for (const c of high_drr.slice(0, 3)) {
      const drr = c.avg_drr != null ? `${wbRound_(c.avg_drr * 100, 1)}%` : '—';
      lines.push(`  — ${c.campaign_name || c.campaign_id}: ДРР ${drr}`);
    }
  }

  if (scale_opps.length > 0) {
    lines.push(`\n✅ *Масштабировать (хорошая эффективность):*`);
    for (const s of scale_opps.slice(0, 3)) {
      lines.push(`  — ${s.campaign_name || s.campaign_id}: ДРР ${s.avg_drr_pct}%, ${s.total_orders} зак.`);
    }
  }

  if (ai_commentary) {
    lines.push('', `_${ai_commentary}_`);
  }

  return lines.join('\n');
}

function formatAdsCampaignList_(campaigns) {
  if (!campaigns.length) return '📣 *Кампании*\n\nДанных нет.';

  const lines = [`📣 *Кампании — эффективность (7 дней)*`, ''];

  const icons = { scale: '🚀', normal: '✅', low_ctr: '📉', high_drr: '⚠️', critical: '❌', waste: '🚫', no_spend: '⏸' };

  for (const c of campaigns.slice(0, 10)) {
    const icon  = icons[c.efficiency] || '•';
    const name  = (c.campaign_name || c.campaign_id || '—').slice(0, 30);
    const spend = wbRound_(c.total_spend || 0, 0);
    const drr   = c.avg_drr != null ? `ДРР ${wbRound_(c.avg_drr * 100, 1)}%` : '';
    const cpo   = c.cpo ? `CPO ${c.cpo}₽` : '';
    const meta  = [drr, cpo].filter(Boolean).join(' / ');
    lines.push(`${icon} ${name}`);
    lines.push(`  ${spend.toLocaleString('ru-RU')} ₽  ${c.total_orders || 0} зак.  ${meta}`);
  }

  if (campaigns.length > 10) {
    lines.push('', `_...и ещё ${campaigns.length - 10} кампаний_`);
  }

  return lines.join('\n');
}

function formatAdsWasteReport_(wasted) {
  if (!wasted.length) return '✅ *Слив бюджета*\n\nНет кампаний с расходом и нулём заказов.';

  const total = wbRound_(wasted.reduce((s, w) => s + (w.total_spend || 0), 0), 0);
  const lines = [`🚫 *Слив бюджета — ${wasted.length} кампаний*`, `Потрачено впустую (7 дней): *${total.toLocaleString('ru-RU')} ₽*`, ''];

  for (const w of wasted) {
    const name = (w.campaign_name || w.campaign_id || '—').slice(0, 35);
    lines.push(`— ${name}`);
    lines.push(`  ${wbRound_(w.total_spend || 0, 0).toLocaleString('ru-RU')} ₽ за ${w.days_with_spend} дн., 0 заказов`);
  }

  lines.push('', '_Рекомендация: проверить настройки таргетинга или приостановить кампании_');
  lines.push('_Все изменения требуют подтверждения_');

  return lines.join('\n');
}

// ── Telegram command router ────────────────────────────────────────────────

async function routeAdsTelegramCommand_(env, msg, chatId, userId) {
  const text    = (msg.text || '').trim().split('@')[0];
  const parts   = text.split(/\s+/);
  const command = parts[0].toLowerCase();

  const sendMsg = (t) => sendTelegramMessage_(env, chatId, t, { parse_mode: 'Markdown' });

  if (command === '/ads_report') {
    await sendMsg('⏳ Анализирую рекламные кампании...');
    try {
      const report = await runAdsChief_(env);
      await sendMsg(formatAdsDayReport_(report));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/ads_campaigns') {
    await sendMsg('⏳ Загружаю рейтинг кампаний...');
    try {
      const periodEnd   = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
      const periodStart = (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })();
      const campaigns = (await adsCampaignPeriodStats_(env.DB, periodStart, periodEnd)).map(scoreCampaign_);
      campaigns.sort((a, b) => b.score - a.score);
      await sendMsg(formatAdsCampaignList_(campaigns));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/ads_waste') {
    await sendMsg('⏳ Ищу неэффективные кампании...');
    try {
      const periodEnd   = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
      const periodStart = (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })();
      const wasted = await adsWastedCampaigns_(env.DB, periodStart, periodEnd, ADS_WASTE_MIN_DAYS);
      await sendMsg(formatAdsWasteReport_(wasted));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/ads_sku') {
    const nmId = parts[1];
    if (!nmId) {
      await sendMsg('Использование: `/ads_sku <nm_id>`');
      return true;
    }
    try {
      const rows = await adsSkuBreakdown_(env.DB, nmId, 7);
      if (!rows.length) {
        await sendMsg(`SKU ${nmId}: данных о рекламе нет.`);
        return true;
      }
      const lines = [`📣 *Реклама SKU ${nmId} — 7 дней*`, ''];
      let prevDate = null;
      for (const r of rows) {
        if (r.date !== prevDate) {
          lines.push(`*${r.date}*`);
          prevDate = r.date;
        }
        const ctrPct  = r.ctr  != null ? `CTR ${wbRound_(r.ctr * 100, 2)}%` : '';
        const drrPct  = r.drr  != null ? `ДРР ${wbRound_(r.drr * 100, 1)}%` : '';
        const name    = (r.campaign_name || r.campaign_id || '—').slice(0, 25);
        lines.push(`  — ${name}: ${wbRound_(r.spend || 0, 0)}₽ / ${r.orders || 0}зак  ${[ctrPct, drrPct].filter(Boolean).join(' ')}`);
      }
      await sendMsg(lines.join('\n'));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  return false;
}

// ── HTTP routes ────────────────────────────────────────────────────────────

async function handleAdsChiefRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;

  if (!pathname.startsWith('/agent/ads')) return null;

  const json = (obj, st) => new Response(JSON.stringify(obj, null, 2), {
    status: st || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

  const periodEnd   = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const periodStart = (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })();

  // GET /agent/ads/report
  if (request.method === 'GET' && pathname === '/agent/ads/report') {
    try {
      const report = await runAdsChief_(env);
      return json({ ok: true, ...report });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/ads/campaigns?days=7
  if (request.method === 'GET' && pathname === '/agent/ads/campaigns') {
    try {
      const days    = Math.min(parseInt(url.searchParams.get('days') || '7', 10), 30);
      const start   = (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - (days - 1)); return d.toISOString().slice(0, 10); })();
      const campaigns = (await adsCampaignPeriodStats_(env.DB, start, periodEnd)).map(scoreCampaign_);
      campaigns.sort((a, b) => b.score - a.score);
      return json({ ok: true, period: { start, end: periodEnd }, campaigns });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/ads/waste
  if (request.method === 'GET' && pathname === '/agent/ads/waste') {
    try {
      const minDays = parseInt(url.searchParams.get('min_days') || String(ADS_WASTE_MIN_DAYS), 10);
      const wasted  = await adsWastedCampaigns_(env.DB, periodStart, periodEnd, minDays);
      const total   = wasted.reduce((s, w) => s + (w.total_spend || 0), 0);
      return json({ ok: true, period: { start: periodStart, end: periodEnd }, wasted, total_wasted: wbRound_(total, 2) });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/ads/sku/:nm_id
  const skuMatch = pathname.match(/^\/agent\/ads\/sku\/(.+)$/);
  if (request.method === 'GET' && skuMatch) {
    const nmId = skuMatch[1];
    const days = parseInt(url.searchParams.get('days') || '14', 10);
    try {
      const rows = await adsSkuBreakdown_(env.DB, nmId, Math.min(days, 60));
      return json({ ok: true, nm_id: nmId, days, rows });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/ads/run
  if (request.method === 'POST' && pathname === '/agent/ads/run') {
    try {
      const report = await runAdsChief_(env);
      return json({ ok: true, report });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
// ============================================================
// WB Returns Analysis  v1
// Build: ai_helpers_wb_returns_v1
//
// Persists WB returns data from the API into D1, computes per-SKU
// return rates and reason breakdowns. Plugs into the wb_sync pipeline.
//
// ── Tables ────────────────────────────────────────────────────
//   wb_returns_log      — raw per-order return records
//   wb_returns_summary  — daily per-SKU aggregated return stats
//
// ── Sync hook ────────────────────────────────────────────────
//   wbSyncReturnsData_(env, syncDate)  — called by runWbDataSync_()
//
// ── Analysis ─────────────────────────────────────────────────
//   1. Return rate per SKU (returns / (orders + returns))
//   2. Return reason breakdown (top reasons globally + per SKU)
//   3. High return rate SKUs (>30% threshold)
//   4. Return spikes vs 7-day average
//
// ── Telegram commands ─────────────────────────────────────────
//   /returns_report    — overall returns summary (last 7 days)
//   /returns_reasons   — top return reasons (last 30 days)
//   /returns_sku <nm_id> — per-SKU return stats + top reasons
//   /returns_risk      — SKUs with return rate >30%
//
// ── REST API ─────────────────────────────────────────────────
//   GET /agent/returns/report          — 7-day summary
//   GET /agent/returns/reasons         — global reason breakdown
//   GET /agent/returns/sku/:nm_id      — per-SKU detail
//   GET /agent/returns/risk            — high return rate SKUs
// ============================================================

const WB_RETURNS_BUILD  = 'ai_helpers_wb_returns_v1';
const RETURNS_HIGH_RATE = 0.30;  // 30% return rate = quality risk
const RETURNS_SPIKE_PCT = 0.50;  // 50% above 7-day avg = spike
const RETURNS_LOOKBACK  = 7;     // default lookback days

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureReturnsSchema_(env) {
  const db = env.DB;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS wb_returns_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        date           TEXT NOT NULL,
        nm_id          TEXT,
        vendor_code    TEXT,
        order_id       TEXT NOT NULL DEFAULT '',
        barcode        TEXT,
        subject_name   TEXT,
        warehouse_name TEXT,
        return_reason  TEXT,
        quantity       INTEGER DEFAULT 1,
        created_at     TEXT DEFAULT (datetime('now')),
        UNIQUE(date, nm_id, order_id)
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_wb_returns_log_date
        ON wb_returns_log(date, nm_id)
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_wb_returns_log_reason
        ON wb_returns_log(return_reason, date)
    `).run();
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS wb_returns_summary (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        date             TEXT NOT NULL,
        nm_id            TEXT NOT NULL,
        vendor_code      TEXT,
        total_returns    INTEGER DEFAULT 0,
        dominant_reason  TEXT,
        reason_breakdown TEXT,
        return_rate      REAL,
        updated_at       TEXT DEFAULT (datetime('now')),
        UNIQUE(date, nm_id)
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_wb_returns_summary_date
        ON wb_returns_summary(date, nm_id)
    `).run();
  } catch (_) {}
}

// ── Sync hook (called by wb_sync_v1.gs) ───────────────────────────────────

async function wbSyncReturnsData_(env, syncDate) {
  await ensureReturnsSchema_(env);
  const db = env.DB;

  let returnsData = { data: [], source_status: 'missing' };
  try {
    if (typeof loadWbReturns_ === 'function') {
      returnsData = await loadWbReturns_(env, syncDate);
    }
  } catch (e) {
    await wbLog_(db, {
      source_agent: WB_RETURNS_BUILD,
      event_type:   'returns_sync_load_error',
      details_json: JSON.stringify({ date: syncDate, error: String(e) }),
    });
    return { ok: false, error: String(e), source_status: 'error' };
  }

  if (!returnsData.data?.length) {
    return { ok: true, source_status: returnsData.source_status, records_written: 0 };
  }

  let written = 0;
  const byNm = {};

  // Write raw rows and aggregate by nm_id
  for (const r of returnsData.data) {
    const nmId = String(r.nm_id || '');
    try {
      await db.prepare(`
        INSERT INTO wb_returns_log
          (date, nm_id, vendor_code, order_id, barcode,
           subject_name, warehouse_name, return_reason, quantity)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(date, nm_id, order_id) DO NOTHING
      `).bind(
        r.date || syncDate,
        nmId,
        r.vendor_code || null,
        r.order_id || '',
        r.barcode || null,
        r.subject_name || null,
        r.warehouse_name || null,
        r.return_reason || null,
        r.quantity || 1,
      ).run();
      written++;
    } catch (_) {}

    if (nmId) {
      if (!byNm[nmId]) byNm[nmId] = { vendor_code: r.vendor_code, total: 0, reasons: {} };
      byNm[nmId].total += r.quantity || 1;
      const reason = r.return_reason || 'не указана';
      byNm[nmId].reasons[reason] = (byNm[nmId].reasons[reason] || 0) + (r.quantity || 1);
    }
  }

  // Write daily summaries
  for (const [nmId, agg] of Object.entries(byNm)) {
    const sortedReasons = Object.entries(agg.reasons).sort((a, b) => b[1] - a[1]);
    const dominantReason = sortedReasons[0]?.[0] || null;

    // Compute return rate using wb_sku_snapshot for same day
    let returnRate = null;
    try {
      const skuRow = await db.prepare(
        `SELECT orders_count FROM wb_sku_snapshot WHERE date = ? AND nm_id = ? LIMIT 1`
      ).bind(syncDate, nmId).first();
      if (skuRow?.orders_count != null) {
        const total = (skuRow.orders_count || 0) + agg.total;
        returnRate = total > 0 ? wbRound_(agg.total / total, 4) : 0;
      }
    } catch (_) {}

    try {
      await db.prepare(`
        INSERT INTO wb_returns_summary
          (date, nm_id, vendor_code, total_returns, dominant_reason,
           reason_breakdown, return_rate, updated_at)
        VALUES (?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(date, nm_id) DO UPDATE SET
          total_returns    = excluded.total_returns,
          dominant_reason  = excluded.dominant_reason,
          reason_breakdown = excluded.reason_breakdown,
          return_rate      = excluded.return_rate,
          updated_at       = datetime('now')
      `).bind(
        syncDate, nmId, agg.vendor_code || null,
        agg.total, dominantReason,
        JSON.stringify(Object.fromEntries(sortedReasons)),
        returnRate,
      ).run();
    } catch (_) {}
  }

  await wbLog_(db, {
    source_agent: WB_RETURNS_BUILD,
    event_type:   'returns_sync_ok',
    status:       'success',
    payload: { date: syncDate, records: written, skus: Object.keys(byNm).length },
  });

  return { ok: true, source_status: 'ok', records_written: written, skus_with_returns: Object.keys(byNm).length };
}

// ── Analysis queries ───────────────────────────────────────────────────────

async function getReturnsSummaryPeriod_(db, startDate, endDate) {
  try {
    const row = await db.prepare(`
      SELECT
        COALESCE(SUM(total_returns), 0) AS total_returns,
        COUNT(DISTINCT nm_id)           AS skus_with_returns,
        COUNT(DISTINCT date)            AS days_with_data
      FROM wb_returns_summary
      WHERE date BETWEEN ? AND ?
    `).bind(startDate, endDate).first();
    return row || { total_returns: 0, skus_with_returns: 0, days_with_data: 0 };
  } catch (_) { return { total_returns: 0, skus_with_returns: 0, days_with_data: 0 }; }
}

async function getTopReturnReasons_(db, startDate, endDate, limit) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        return_reason,
        SUM(quantity) AS total_qty,
        COUNT(DISTINCT nm_id) AS skus_affected
      FROM wb_returns_log
      WHERE date BETWEEN ? AND ?
        AND return_reason IS NOT NULL
      GROUP BY return_reason
      ORDER BY total_qty DESC
      LIMIT ?
    `).bind(startDate, endDate, limit || 10).all();
    return results;
  } catch (_) { return []; }
}

async function getHighReturnRateSkus_(db, startDate, endDate, threshold) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        nm_id,
        MAX(vendor_code) AS vendor_code,
        AVG(return_rate) AS avg_return_rate,
        SUM(total_returns) AS total_returns,
        MAX(dominant_reason) AS dominant_reason
      FROM wb_returns_summary
      WHERE date BETWEEN ? AND ?
        AND return_rate IS NOT NULL
      GROUP BY nm_id
      HAVING avg_return_rate >= ?
      ORDER BY avg_return_rate DESC
      LIMIT 20
    `).bind(startDate, endDate, threshold || RETURNS_HIGH_RATE).all();
    return results;
  } catch (_) { return []; }
}

async function getSkuReturnHistory_(db, nmId, days) {
  try {
    const { results: summary = [] } = await db.prepare(`
      SELECT date, total_returns, return_rate, dominant_reason, reason_breakdown
      FROM wb_returns_summary
      WHERE nm_id = ?
      ORDER BY date DESC
      LIMIT ?
    `).bind(String(nmId), days).all();

    const { results: reasons = [] } = await db.prepare(`
      SELECT return_reason, SUM(quantity) AS qty
      FROM wb_returns_log
      WHERE nm_id = ?
      GROUP BY return_reason
      ORDER BY qty DESC
      LIMIT 10
    `).bind(String(nmId)).all();

    return { summary, reasons };
  } catch (_) { return { summary: [], reasons: [] }; }
}

async function detectReturnSpikes_(db, date) {
  const prevStart = (() => { const d = new Date(date); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })();
  const prevEnd   = (() => { const d = new Date(date); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();

  try {
    const { results: today = [] } = await db.prepare(`
      SELECT nm_id, total_returns FROM wb_returns_summary WHERE date = ?
    `).bind(date).all();

    const { results: avgRows = [] } = await db.prepare(`
      SELECT nm_id, AVG(total_returns) AS avg_returns
      FROM wb_returns_summary
      WHERE date BETWEEN ? AND ?
      GROUP BY nm_id
    `).bind(prevStart, prevEnd).all();

    const avgMap = {};
    for (const r of avgRows) avgMap[r.nm_id] = r.avg_returns;

    const spikes = [];
    for (const t of today) {
      const avg = avgMap[t.nm_id] || 0;
      if (avg > 0 && t.total_returns > avg * (1 + RETURNS_SPIKE_PCT)) {
        spikes.push({
          nm_id: t.nm_id,
          today_returns: t.total_returns,
          avg_returns:   wbRound_(avg, 1),
          spike_pct:     wbRound_(((t.total_returns - avg) / avg) * 100, 1),
        });
      }
    }
    spikes.sort((a, b) => b.spike_pct - a.spike_pct);
    return spikes;
  } catch (_) { return []; }
}

// ── Main report orchestrator ───────────────────────────────────────────────

async function runReturnsAnalysis_(env) {
  const db    = env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const start = (() => { const d = new Date(); d.setDate(d.getDate() - RETURNS_LOOKBACK); return d.toISOString().slice(0, 10); })();

  const [summary, reasons, highRateSkus, spikes] = await Promise.all([
    getReturnsSummaryPeriod_(db, start, today),
    getTopReturnReasons_(db, start, today, 8),
    getHighReturnRateSkus_(db, start, today, RETURNS_HIGH_RATE),
    detectReturnSpikes_(db, today),
  ]);

  return { date: today, period: { start, end: today }, summary, reasons, high_rate_skus: highRateSkus, spikes };
}

// ── Telegram formatting ────────────────────────────────────────────────────

function formatReturnsReport_(report) {
  const { date, period, summary, reasons, high_rate_skus, spikes } = report;

  const lines = [
    `↩️ *Возвраты — ${period.start} — ${period.end}*`,
    '',
    `📦 Всего возвратов: *${summary.total_returns || 0}*`,
    `🔢 SKU с возвратами: ${summary.skus_with_returns || 0}`,
  ];

  if (spikes.length > 0) {
    lines.push('', `⚠️ *Всплески сегодня (>${Math.round(RETURNS_SPIKE_PCT * 100)}% выше нормы):*`);
    for (const s of spikes.slice(0, 4)) {
      lines.push(`  — SKU ${s.nm_id}: ${s.today_returns} возвр. (+${s.spike_pct}%)`);
    }
  }

  if (high_rate_skus.length > 0) {
    lines.push('', `❌ *Высокий % возвратов (>${Math.round(RETURNS_HIGH_RATE * 100)}%):*`);
    for (const s of high_rate_skus.slice(0, 5)) {
      const pct = s.avg_return_rate != null ? `${wbRound_(s.avg_return_rate * 100, 1)}%` : '—';
      const reason = s.dominant_reason ? ` — "${s.dominant_reason}"` : '';
      lines.push(`  — SKU ${s.nm_id}: ${pct}${reason}`);
    }
  }

  if (reasons.length > 0) {
    lines.push('', '*Топ причин возвратов:*');
    for (const r of reasons.slice(0, 5)) {
      lines.push(`  ${r.total_qty} шт. — ${r.return_reason || 'не указана'} (${r.skus_affected} SKU)`);
    }
  }

  if (!spikes.length && !high_rate_skus.length) {
    lines.push('', '✅ Критичных ситуаций с возвратами нет');
  }

  return lines.join('\n');
}

function formatReturnReasons_(reasons, period) {
  if (!reasons.length) return `↩️ *Причины возвратов*\n\n_Данных нет за ${period.start} — ${period.end}_`;

  const total = reasons.reduce((s, r) => s + (r.total_qty || 0), 0);
  const lines = [`↩️ *Причины возвратов (${period.start} — ${period.end})*`, ''];

  for (const r of reasons) {
    const pct = total > 0 ? wbRound_((r.total_qty / total) * 100, 1) : 0;
    lines.push(`*${r.total_qty}* шт. (${pct}%) — ${r.return_reason || 'не указана'}`);
    lines.push(`  SKU: ${r.skus_affected}`);
  }
  return lines.join('\n');
}

function formatSkuReturns_(nmId, data) {
  const { summary, reasons } = data;
  if (!summary.length) return `↩️ *SKU ${nmId}*\n\nДанных о возвратах нет.`;

  const lines = [`↩️ *Возвраты SKU ${nmId}*`, ''];
  for (const r of summary.slice(0, 10)) {
    const rate = r.return_rate != null ? `${wbRound_(r.return_rate * 100, 1)}%` : '—';
    lines.push(`${r.date}: ${r.total_returns} шт. / ${rate}${r.dominant_reason ? ` — "${r.dominant_reason}"` : ''}`);
  }

  if (reasons.length > 0) {
    lines.push('', '*Частые причины:*');
    for (const r of reasons.slice(0, 5)) {
      lines.push(`  ${r.qty} шт. — ${r.return_reason || 'не указана'}`);
    }
  }

  return lines.join('\n');
}

// ── Telegram command router ────────────────────────────────────────────────

async function routeReturnsTelegramCommand_(env, msg, chatId, userId) {
  const text    = (msg.text || '').trim().split('@')[0];
  const parts   = text.split(/\s+/);
  const command = parts[0].toLowerCase();

  const sendMsg = (t) => sendTelegramMessage_(env, chatId, t, { parse_mode: 'Markdown' });

  if (command === '/returns_report') {
    await sendMsg('⏳ Анализирую возвраты...');
    try {
      const report = await runReturnsAnalysis_(env);
      await sendMsg(formatReturnsReport_(report));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/returns_reasons') {
    try {
      const days  = 30;
      const end   = new Date().toISOString().slice(0, 10);
      const start = (() => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); })();
      const reasons = await getTopReturnReasons_(env.DB, start, end, 10);
      await sendMsg(formatReturnReasons_(reasons, { start, end }));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/returns_sku') {
    const nmId = parts[1];
    if (!nmId) {
      await sendMsg('Использование: `/returns_sku <nm_id>`');
      return true;
    }
    try {
      const data = await getSkuReturnHistory_(env.DB, nmId, 14);
      await sendMsg(formatSkuReturns_(nmId, data));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/returns_risk') {
    await sendMsg('⏳ Ищу SKU с высоким % возвратов...');
    try {
      const end   = new Date().toISOString().slice(0, 10);
      const start = (() => { const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString().slice(0, 10); })();
      const skus  = await getHighReturnRateSkus_(env.DB, start, end, RETURNS_HIGH_RATE);
      if (!skus.length) {
        await sendMsg(`✅ *Возвраты в норме*\n\nНет SKU с % возвратов выше ${Math.round(RETURNS_HIGH_RATE * 100)}%`);
        return true;
      }
      const lines = [`❌ *SKU с высоким % возвратов (>${Math.round(RETURNS_HIGH_RATE * 100)}%, 14 дней)*`, ''];
      for (const s of skus) {
        const pct    = s.avg_return_rate != null ? `${wbRound_(s.avg_return_rate * 100, 1)}%` : '—';
        const reason = s.dominant_reason ? `\n  Главная причина: "${s.dominant_reason}"` : '';
        lines.push(`— SKU ${s.nm_id}: ${pct} возвратов, ${s.total_returns} шт.${reason}`);
      }
      await sendMsg(lines.join('\n'));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  return false;
}

// ── HTTP routes ────────────────────────────────────────────────────────────

async function handleReturnsRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;

  if (!pathname.startsWith('/agent/returns')) return null;

  const json = (obj, st) => new Response(JSON.stringify(obj, null, 2), {
    status: st || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = (() => { const d = new Date(); d.setDate(d.getDate() - RETURNS_LOOKBACK); return d.toISOString().slice(0, 10); })();

  // GET /agent/returns/report
  if (request.method === 'GET' && pathname === '/agent/returns/report') {
    try {
      const report = await runReturnsAnalysis_(env);
      return json({ ok: true, ...report });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/returns/reasons?days=30
  if (request.method === 'GET' && pathname === '/agent/returns/reasons') {
    try {
      const days  = Math.min(parseInt(url.searchParams.get('days') || '30', 10), 90);
      const start = (() => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); })();
      const reasons = await getTopReturnReasons_(env.DB, start, today, 20);
      return json({ ok: true, period: { start, end: today }, reasons });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/returns/sku/:nm_id
  const skuMatch = pathname.match(/^\/agent\/returns\/sku\/(.+)$/);
  if (request.method === 'GET' && skuMatch) {
    const nmId = skuMatch[1];
    const days = parseInt(url.searchParams.get('days') || '30', 10);
    try {
      const data = await getSkuReturnHistory_(env.DB, nmId, Math.min(days, 90));
      return json({ ok: true, nm_id: nmId, ...data });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/returns/risk?threshold=0.3
  if (request.method === 'GET' && pathname === '/agent/returns/risk') {
    try {
      const threshold = parseFloat(url.searchParams.get('threshold') || String(RETURNS_HIGH_RATE));
      const days  = parseInt(url.searchParams.get('days') || '14', 10);
      const start = (() => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); })();
      const skus  = await getHighReturnRateSkus_(env.DB, start, today, threshold);
      return json({ ok: true, threshold, period: { start, end: today }, skus });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
// ============================================================
// WB API Client — production-ready замена стабов
// Build: ai_helpers_wb_api_client_v1
//
// Заменяет stub-функции из Stage 1 реальными вызовами WB API.
// Если WB_API_TOKEN не задан — возвращает { data: [], source_status: 'missing' }.
//
// ── Используемые WB API эндпоинты ───────────────────────────
// GET  statistics-api.wb.ru/api/v5/supplier/reportDetailByPeriod  ← loadWbSkuData_
// GET  statistics-api.wb.ru/api/v1/supplier/stocks                ← loadWbStockData_
// GET  advert-api.wb.ru/adv/v2/adverts                            ← loadWbAdsData_ (step 1)
// POST advert-api.wb.ru/adv/v2/fullstats                          ← loadWbAdsData_ (step 2)
// GET  feedbacks-api.wb.ru/api/v1/feedbacks                       ← loadWbReviews_
// GET  feedbacks-api.wb.ru/api/v1/questions                       ← loadWbQuestions_
// GET  marketplace-api.wb.ru/api/v3/warehouses                    ← loadWbStockData_ (warehouses)
// GET  marketplace-api.wb.ru/api/v3/returns                       ← loadWbReturns_
// POST discounts-prices-api.wb.ru/api/v2/list/goods/filter        ← loadWbPricesAndDiscounts_
// GET  marketplace-api.wb.ru/api/v3/tariffs/commission            ← loadWbCommissions_
//
// ── Новые API ────────────────────────────────────────────────
// GET /agent/wb/api/health
// GET /agent/wb/api/prices?nm_ids=1,2,3
// GET /agent/wb/api/commissions
//
// ВАЖНО: Эти функции определены ПОСЛЕДНИМИ в цепочке загрузки,
// поэтому переопределяют одноимённые стабы из Stage 1.
// ============================================================

const WB_API_BASE = {
  STATISTICS:  'https://statistics-api.wildberries.ru',
  CONTENT:     'https://content-api.wildberries.ru',
  ADS:         'https://advert-api.wildberries.ru',
  MARKETPLACE: 'https://marketplace-api.wildberries.ru',
  FEEDBACKS:   'https://feedbacks-api.wildberries.ru',
  PRICES:      'https://discounts-prices-api.wildberries.ru',
};

const WB_API_TIMEOUT_MS    = 25000;
const WB_API_MAX_RETRIES   = 2;
const WB_API_PAGE_DELAY_MS = 250;

// ── Section 1: HTTP helpers ───────────────────────────────────

async function wbApiFetch_(token, url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WB_API_TIMEOUT_MS);

  let lastError = null;
  let attempt = 0;

  while (attempt <= WB_API_MAX_RETRIES) {
    try {
      const res = await fetch(url, {
        ...opts,
        signal: controller.signal,
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          ...(opts?.headers || {}),
        },
      });

      clearTimeout(timer);

      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, error: 'auth_failed', data: null };
      }

      if (res.status === 429) {
        if (attempt < WB_API_MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 60000));
          attempt++;
          continue;
        }
        return { ok: false, status: 429, error: 'rate_limited', data: null };
      }

      if (res.status >= 500) {
        if (attempt < WB_API_MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          attempt++;
          continue;
        }
        return { ok: false, status: res.status, error: `server_error_${res.status}`, data: null };
      }

      if (!res.ok) {
        return { ok: false, status: res.status, error: `http_${res.status}`, data: null };
      }

      const data = await res.json().catch(() => null);
      return { ok: true, status: res.status, data, error: null };

    } catch (e) {
      clearTimeout(timer);
      lastError = String(e);
      if (attempt < WB_API_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        attempt++;
        continue;
      }
      return { ok: false, status: 0, error: lastError, data: null };
    }
  }

  return { ok: false, status: 0, error: lastError || 'max_retries', data: null };
}

async function wbApiGet_(token, baseUrl, path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return wbApiFetch_(token, baseUrl + path + qs, { method: 'GET' });
}

async function wbApiPost_(token, baseUrl, path, body) {
  return wbApiFetch_(token, baseUrl + path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function wbApiDelay_() {
  await new Promise(r => setTimeout(r, WB_API_PAGE_DELAY_MS));
}

// ── Section 2: SKU / Sales loader (overrides Stage 1 stub) ───

async function loadWbSkuData_(env, date) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;
  const allRows = [];
  let rrdid = 0;
  let pages = 0;
  const MAX_PAGES = 20;

  try {
    while (pages < MAX_PAGES) {
      const res = await wbApiGet_(token, WB_API_BASE.STATISTICS,
        '/api/v5/supplier/reportDetailByPeriod', {
          dateFrom: date,
          dateTo:   date,
          limit:    100000,
          rrdid,
        });

      if (!res.ok) {
        await wbLog_(env.DB, {
          event_type: 'wb_api_sku_error',
          details_json: JSON.stringify({ error: res.error, status: res.status }),
        });
        break;
      }

      const rows = Array.isArray(res.data) ? res.data : (res.data?.data || []);
      allRows.push(...rows);

      if (rows.length < 100000) break;  // last page
      rrdid = rows[rows.length - 1]?.rr_dt || 0;
      pages++;
      await wbApiDelay_();
    }

    if (!allRows.length) return { data: [], source_status: 'ready', rows_count: 0 };

    // Aggregate by nm_id
    const byNm = {};
    for (const row of allRows) {
      const nmId = row.nm_id;
      if (!nmId) continue;
      if (!byNm[nmId]) {
        byNm[nmId] = {
          nm_id:        nmId,
          vendor_code:  row.sa_name,
          subject_name: row.subject_name,
          brand_name:   row.brand_name,
          orders_count:  0,
          orders_revenue: 0,
          returns_count: 0,
          returns_amount: 0,
          commission_pct: row.commission_percent || 0,
        };
      }
      const opType = (row.supplier_oper_name || '').toLowerCase();
      if (opType.includes('продажа') || opType.includes('реализация')) {
        byNm[nmId].orders_count++;
        byNm[nmId].orders_revenue += row.retail_price_withdisc_rub || 0;
      } else if (opType.includes('возврат')) {
        byNm[nmId].returns_count++;
        byNm[nmId].returns_amount += row.retail_price_withdisc_rub || 0;
      }
    }

    const data = Object.values(byNm).map(r => ({
      ...r,
      orders_revenue: wbRound_(r.orders_revenue, 2),
      returns_amount: wbRound_(r.returns_amount, 2),
    }));

    return { data, source_status: 'ready', rows_count: allRows.length };

  } catch (e) {
    await wbLog_(env.DB, { event_type: 'wb_api_sku_exception', details_json: JSON.stringify({ error: String(e) }) });
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 3: Ads loader (overrides Stage 1 stub) ────────────

async function loadWbAdsData_(env, date) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;

  try {
    // Step 1: get active campaign list
    const advertsRes = await wbApiGet_(token, WB_API_BASE.ADS, '/adv/v2/adverts', {
      status: 9,  // active
    });

    if (!advertsRes.ok) {
      await wbLog_(env.DB, { event_type: 'wb_api_ads_list_error', details_json: JSON.stringify({ error: advertsRes.error }) });
      return { data: [], source_status: 'missing' };
    }

    const adverts = Array.isArray(advertsRes.data) ? advertsRes.data : [];
    if (!adverts.length) return { data: [], source_status: 'ready', campaigns_count: 0 };

    const advertIds = adverts.map(a => a.advertId);

    // Step 2: batch stats (max 100 per request)
    const allStats = [];
    const BATCH = 100;

    for (let i = 0; i < advertIds.length; i += BATCH) {
      const batch = advertIds.slice(i, i + BATCH);
      await wbApiDelay_();

      const statsRes = await wbApiPost_(token, WB_API_BASE.ADS, '/adv/v2/fullstats', batch);
      if (!statsRes.ok) continue;

      const statsArr = Array.isArray(statsRes.data) ? statsRes.data : [];
      allStats.push(...statsArr);
    }

    // Merge adverts with stats
    const statsById = {};
    for (const s of allStats) {
      if (s.advertId) statsById[String(s.advertId)] = s;
    }

    const data = adverts.map(adv => {
      const stats = statsById[String(adv.advertId)] || {};
      const views  = stats.views  || 0;
      const clicks = stats.clicks || 0;
      const spend  = stats.sum    || 0;
      const orders = stats.orders || 0;

      return {
        campaign_id:   String(adv.advertId),
        nm_id:         stats.nmId || null,
        campaign_name: adv.name || '',
        campaign_type: adv.type,
        ad_spend:      wbRound_(spend, 2),
        ad_orders:     orders,
        ad_views:      views,
        ad_clicks:     clicks,
        ctr:           views ? wbRound_(clicks / views, 4) : 0,
        cpc:           clicks ? wbRound_(spend / clicks, 2) : 0,
        drr:           orders > 0 ? null : null,  // needs revenue data from SKU
        daily_budget:  adv.dailyBudget || 0,
      };
    });

    return { data, source_status: 'ready', campaigns_count: adverts.length };

  } catch (e) {
    await wbLog_(env.DB, { event_type: 'wb_api_ads_exception', details_json: JSON.stringify({ error: String(e) }) });
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 4: Stock loader (overrides Stage 1 stub) ──────────

async function loadWbStockData_(env, date) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;

  try {
    // Parallel: warehouses + stocks
    const [warehousesRes, stocksRes] = await Promise.all([
      wbApiGet_(token, WB_API_BASE.MARKETPLACE, '/api/v3/warehouses', {}),
      wbApiGet_(token, WB_API_BASE.STATISTICS, '/api/v1/supplier/stocks', { dateFrom: date }),
    ]);

    const warehouses = warehousesRes.ok ? (Array.isArray(warehousesRes.data) ? warehousesRes.data : []) : [];
    const stockRows  = stocksRes.ok ? (Array.isArray(stocksRes.data) ? stocksRes.data : []) : [];

    if (!stockRows.length) {
      return { data: [], source_status: stocksRes.ok ? 'ready' : 'missing', warehouses_count: warehouses.length };
    }

    // Aggregate by nmId
    const byNm = {};
    for (const row of stockRows) {
      const nmId = row.nmId;
      if (!nmId) continue;
      if (!byNm[nmId]) {
        byNm[nmId] = {
          nm_id:                  nmId,
          vendor_code:            row.supplierArticle,
          subject_name:           row.subject,
          stock_total:            0,
          stock_in_transit:       0,
          stock_reserved:         0,
          stock_by_warehouse_json: {},
        };
      }
      const qty     = row.quantityFull   || 0;
      const inWay   = row.inWayToClient  || 0;
      const notInOrd = row.quantityNotInOrders || 0;

      byNm[nmId].stock_total        += qty;
      byNm[nmId].stock_in_transit   += inWay;
      byNm[nmId].stock_reserved     += Math.max(0, qty - notInOrd);

      const wh = row.warehouseName || 'unknown';
      byNm[nmId].stock_by_warehouse_json[wh] =
        (byNm[nmId].stock_by_warehouse_json[wh] || 0) + qty;
    }

    const data = Object.values(byNm).map(r => ({
      ...r,
      stock_by_warehouse_json: JSON.stringify(r.stock_by_warehouse_json),
    }));

    return { data, source_status: 'ready', warehouses_count: warehouses.length, rows_count: stockRows.length };

  } catch (e) {
    await wbLog_(env.DB, { event_type: 'wb_api_stock_exception', details_json: JSON.stringify({ error: String(e) }) });
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 5: Reviews loader (overrides CS Stage 1 stub) ─────

async function loadWbReviews_(env, date) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;
  const allFeedbacks = [];
  let skip = 0;
  const TAKE = 1000;

  try {
    while (true) {
      const res = await wbApiGet_(token, WB_API_BASE.FEEDBACKS, '/api/v1/feedbacks', {
        isAnswered: false,
        take: TAKE,
        skip,
        order: 'dateDesc',
      });

      if (!res.ok) break;

      const feedbacks = res.data?.feedbacks || (Array.isArray(res.data) ? res.data : []);
      allFeedbacks.push(...feedbacks);

      if (feedbacks.length < TAKE) break;
      skip += TAKE;
      await wbApiDelay_();
    }

    const data = allFeedbacks.map(f => ({
      id:           String(f.id),
      nm_id:        f.productDetails?.nmId,
      sku_title:    f.productDetails?.productName,
      text:         f.text || '',
      rating:       f.productValuation,
      date:         f.createdDate?.slice(0, 10) || date,
    }));

    return { data, source_status: 'ready' };

  } catch (e) {
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 6: Questions loader (overrides CS Stage 1 stub) ───

async function loadWbQuestions_(env, date) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;
  const allQuestions = [];
  let skip = 0;
  const TAKE = 1000;

  try {
    while (true) {
      const res = await wbApiGet_(token, WB_API_BASE.FEEDBACKS, '/api/v1/questions', {
        isAnswered: false,
        take: TAKE,
        skip,
        order: 'dateDesc',
      });

      if (!res.ok) break;

      const questions = res.data?.questions || (Array.isArray(res.data) ? res.data : []);
      allQuestions.push(...questions);

      if (questions.length < TAKE) break;
      skip += TAKE;
      await wbApiDelay_();
    }

    const data = allQuestions.map(q => ({
      id:        String(q.id),
      nm_id:     q.productDetails?.nmId,
      sku_title: q.productDetails?.productName,
      text:      q.text || '',
      date:      q.createdDate?.slice(0, 10) || date,
    }));

    return { data, source_status: 'ready' };

  } catch (e) {
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 7: Prices & Commissions ──────────────────────────

async function loadWbPricesAndDiscounts_(env, nmIds) {
  if (!env.WB_API_TOKEN || !nmIds?.length) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;
  try {
    const res = await wbApiPost_(token, WB_API_BASE.PRICES, '/api/v2/list/goods/filter', {
      filterNmIds: nmIds.slice(0, 1000),
    });

    if (!res.ok) return { data: [], source_status: 'missing', error: res.error };

    const goods = res.data?.data?.listGoods || [];
    const data = goods.map(g => ({
      nm_id:    g.nmID,
      price:    g.price,
      discount: g.discount,
      price_with_discount: wbRound_(g.price * (1 - (g.discount || 0) / 100), 2),
    }));

    return { data, source_status: 'ready' };
  } catch (e) {
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

async function loadWbCommissions_(env) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;
  try {
    const res = await wbApiGet_(token, WB_API_BASE.MARKETPLACE, '/api/v3/tariffs/commission', {});
    if (!res.ok) return { data: [], source_status: 'missing', error: res.error };

    return { data: res.data?.report || res.data || [], source_status: 'ready' };
  } catch (e) {
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 8: Returns loader (overrides CS Stage 1 stub) ────

async function loadWbReturns_(env, date) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;
  const allReturns = [];
  let pageNum = 1;
  const LIMIT = 50;

  try {
    while (true) {
      const res = await wbApiGet_(token, WB_API_BASE.MARKETPLACE, '/api/v3/returns', {
        dateFrom: date,
        dateTo:   date,
        pageNum,
        limit:    LIMIT,
      });

      if (!res.ok) {
        await wbLog_(env.DB, {
          event_type: 'wb_api_returns_error',
          details_json: JSON.stringify({ error: res.error, status: res.status, page: pageNum }),
        });
        break;
      }

      const returns = Array.isArray(res.data?.returns) ? res.data.returns
                    : (Array.isArray(res.data) ? res.data : []);
      allReturns.push(...returns);

      if (!res.data?.hasNext || returns.length < LIMIT) break;
      pageNum++;
      await wbApiDelay_();
    }

    const data = allReturns.map(r => ({
      order_id:      String(r.orderId || r.id || ''),
      nm_id:         r.nmId || r.nm_id || null,
      vendor_code:   r.vendorCode || r.sa_name || '',
      subject_name:  r.subjectName || r.subject || '',
      barcode:       r.barcode || '',
      warehouse_name: r.warehouseName || '',
      quantity:      r.quantity || 1,
      return_reason: r.returnReason || r.reason || '',
      date:          (r.date || date).slice(0, 10),
    }));

    return { data, source_status: 'ready', returns_count: allReturns.length };

  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'wb_api_returns_exception',
      details_json: JSON.stringify({ error: String(e) }),
    });
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 10: API health check ─────────────────────────────

async function checkWbApiHealth_(env) {
  const token_configured = !!env.WB_API_TOKEN;
  if (!token_configured) {
    return { ok: false, token_configured: false, api_reachable: false, error: 'WB_API_TOKEN not set', latency_ms: 0 };
  }

  const start = Date.now();
  try {
    const yesterday = wbYesterday_();
    const res = await wbApiGet_(env.WB_API_TOKEN, WB_API_BASE.STATISTICS,
      '/api/v5/supplier/reportDetailByPeriod', {
        dateFrom: yesterday, dateTo: yesterday, limit: 1, rrdid: 0,
      });
    const latency_ms = Date.now() - start;

    if (res.status === 401 || res.status === 403) {
      return { ok: false, token_configured: true, api_reachable: true, error: 'auth_failed', latency_ms };
    }

    return {
      ok: res.ok,
      token_configured: true,
      api_reachable: res.status !== 0,
      error: res.error || null,
      latency_ms,
    };
  } catch (e) {
    return { ok: false, token_configured: true, api_reachable: false, error: String(e), latency_ms: Date.now() - start };
  }
}

// ── Section 11: API routes ────────────────────────────────────

async function handleWbApiClientRoutes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith('/agent/wb/api')) return null;

  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  if (path === '/agent/wb/api/health' && request.method === 'GET') {
    const result = await checkWbApiHealth_(env);
    return json(result);
  }

  if (path === '/agent/wb/api/prices' && request.method === 'GET') {
    const raw = url.searchParams.get('nm_ids') || '';
    const nmIds = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    if (!nmIds.length) return json({ ok: false, error: 'nm_ids required' }, 400);
    const result = await loadWbPricesAndDiscounts_(env, nmIds);
    return json({ ok: true, ...result });
  }

  if (path === '/agent/wb/api/commissions' && request.method === 'GET') {
    const result = await loadWbCommissions_(env);
    return json({ ok: true, ...result });
  }

  return null;
}
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
 *   wb_ads_chief_v1.gs    ← Advertising campaign analytics
 *   wb_returns_v1.gs      ← Returns analysis & reason tracking
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
    if (await routeAdsTelegramCommand_(env, msg, chatId, userId))         return jsonResponse({ ok: true });
    if (await routeReturnsTelegramCommand_(env, msg, chatId, userId))     return jsonResponse({ ok: true });
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
          modules: ['stage336_349', 'wb_ops_stage1', 'wb_ops_stage2', 'wb_ops_stage2_patch', 'cs_stage1', 'cs_stage2', 'approval_flow', 'qa_runner', 'design_chief', 'rop_chief', 'fulfillment_chief', 'procurement_chief', 'wb_sync', 'wb_pricing', 'supplier_mgmt', 'bot_setup', 'alerts', 'wb_analytics', 'wb_ads_chief', 'wb_returns', 'wb_api_client'],
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

      // 20. Ads Chief routes
      if (pathname.startsWith('/agent/ads')) {
        const r = await handleAdsChiefRoutes_(env, request);
        if (r) return r;
      }

      // 21. Returns routes
      if (pathname.startsWith('/agent/returns')) {
        const r = await handleReturnsRoutes_(env, request);
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
