// ============================================================
// STAGE 336 — Agent Proposal Contract v1
// ============================================================

const APP_BUILD_STAGE = "планнер_этап336-349_agent-pipeline_v1";

// Incoming message types
const AGENT_MESSAGE_TYPES = Object.freeze({
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

// Agent action types (allowed v1)
const AGENT_ACTION_TYPES_ALLOWED = Object.freeze([
  'save_insight',
  'save_idea',
  'save_question',
  'save_resource',
  'create_task',
  'create_meeting',
  'create_reminder',
  'request_clarification',
  'apply_plan'
]);

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
const AGENT_INTAKE_STATUSES = Object.freeze({
  RECEIVED: 'received',
  CLASSIFIED: 'classified',
  WAITING_CONFIRMATION: 'waiting_confirmation',
  APPLIED: 'applied',
  FAILED: 'failed',
  IGNORED: 'ignored'
});

// Proposal expiry: 24 hours
const AGENT_PROPOSAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Generate a stable confirmation_id from user_id + message_id + action_type + payload hash.
 * Same inputs always produce the same ID — guarantees idempotency across retries.
 */
async function generateAgentConfirmationId(userId, messageId, actionType, payload) {
  const raw = [String(userId || ''), String(messageId || ''), String(actionType || ''), JSON.stringify(payload || {})].join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  return `confirm_${String(userId || 'u').slice(0, 6)}_${String(actionType || 'act').replace(/_/g, '')}_${hex}`;
}

/**
 * Generate a proposal_id.
 */
function generateAgentProposalId() {
  return `proposal_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Build the standard Agent Proposal object.
 */
function buildAgentProposalObject({ userId, source, messageId, detectedType, confidence, summary, requiresConfirmation, suggestedActions }) {
  return {
    proposal_id: generateAgentProposalId(),
    user_id: String(userId || ''),
    source: String(source || 'telegram_agent'),
    message_id: String(messageId || ''),
    detected_type: String(detectedType || AGENT_MESSAGE_TYPES.UNKNOWN),
    confidence: typeof confidence === 'number' ? confidence : 0,
    summary: String(summary || ''),
    requires_confirmation: requiresConfirmation !== false,
    suggested_actions: Array.isArray(suggestedActions) ? suggestedActions : [],
    status: AGENT_PROPOSAL_STATUSES.DRAFT,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + AGENT_PROPOSAL_EXPIRY_MS).toISOString()
  };
}

// ============================================================
// END STAGE 336
// ============================================================

// ============================================================
// STAGE 337 — Telegram Bot Intake v1
// ============================================================

async function ensureAgentIntakeSchema(env) {
  if (!env || !env.DB) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS telegram_incoming_messages (
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
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tg_incoming_user ON telegram_incoming_messages(telegram_user_id, received_at DESC)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tg_incoming_update ON telegram_incoming_messages(telegram_update_id)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tg_incoming_planner_user ON telegram_incoming_messages(planner_user_id, received_at DESC)`).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS agent_proposals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'telegram_agent',
      message_id TEXT,
      telegram_update_id INTEGER,
      detected_type TEXT NOT NULL,
      confidence REAL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      classification_json TEXT,
      slots_json TEXT,
      requires_confirmation INTEGER DEFAULT 1,
      selected_slot INTEGER,
      confirmation_id TEXT,
      result_task_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_proposals_user ON agent_proposals(user_id, created_at DESC)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_proposals_status ON agent_proposals(user_id, status, created_at DESC)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_proposals_confirm ON agent_proposals(confirmation_id)`).run();
}

async function findTelegramUpdateAlreadyProcessed(env, updateId) {
  if (!env || !env.DB || !updateId) return null;
  try {
    return await env.DB.prepare(
      `SELECT id, status FROM telegram_incoming_messages WHERE telegram_update_id = ? LIMIT 1`
    ).bind(Number(updateId)).first();
  } catch (_) { return null; }
}

async function insertTelegramIncomingMessage(env, { updateId, telegramUserId, plannerUserId, messageId, chatId, text }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO telegram_incoming_messages (id, telegram_update_id, telegram_user_id, planner_user_id, message_id, chat_id, text, received_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received')
  `).bind(id, updateId ? Number(updateId) : null, String(telegramUserId || ''), plannerUserId ? String(plannerUserId) : null, messageId ? String(messageId) : null, chatId ? String(chatId) : null, text ? String(text).slice(0, 8000) : null, now).run();
  return id;
}

async function updateTelegramIncomingMessageStatus(env, id, status, extra = {}) {
  if (!env || !env.DB || !id) return;
  try {
    const classJson = extra.classification_json != null ? JSON.stringify(extra.classification_json).slice(0, 8000) : null;
    const proposalJson = extra.proposal_json != null ? JSON.stringify(extra.proposal_json).slice(0, 8000) : null;
    const error = extra.error ? String(extra.error).slice(0, 500) : null;
    await env.DB.prepare(`
      UPDATE telegram_incoming_messages SET status=?, classification_json=COALESCE(?,classification_json), proposal_json=COALESCE(?,proposal_json), error=COALESCE(?,error) WHERE id=?
    `).bind(String(status), classJson, proposalJson, error, id).run();
  } catch (_) {}
}

async function upsertAgentProposal(env, proposal) {
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT OR REPLACE INTO agent_proposals
    (id, user_id, source, message_id, telegram_update_id, detected_type, confidence, summary, status,
     classification_json, slots_json, requires_confirmation, selected_slot, confirmation_id, result_task_id, error, created_at, expires_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    String(proposal.id || proposal.proposal_id),
    String(proposal.user_id || ''),
    String(proposal.source || 'telegram_agent'),
    proposal.message_id ? String(proposal.message_id) : null,
    proposal.telegram_update_id ? Number(proposal.telegram_update_id) : null,
    String(proposal.detected_type || 'unknown'),
    typeof proposal.confidence === 'number' ? proposal.confidence : null,
    proposal.summary ? String(proposal.summary).slice(0, 500) : null,
    String(proposal.status || AGENT_PROPOSAL_STATUSES.DRAFT),
    proposal.classification_json != null ? JSON.stringify(proposal.classification_json).slice(0, 8000) : null,
    proposal.slots_json != null ? JSON.stringify(proposal.slots_json).slice(0, 4000) : null,
    proposal.requires_confirmation ? 1 : 0,
    proposal.selected_slot != null ? Number(proposal.selected_slot) : null,
    proposal.confirmation_id ? String(proposal.confirmation_id) : null,
    proposal.result_task_id ? String(proposal.result_task_id) : null,
    proposal.error ? String(proposal.error).slice(0, 500) : null,
    String(proposal.created_at || now),
    String(proposal.expires_at || new Date(Date.now() + AGENT_PROPOSAL_EXPIRY_MS).toISOString()),
    now
  ).run();
}

async function getAgentProposalById(env, proposalId) {
  if (!env || !env.DB || !proposalId) return null;
  try {
    const row = await env.DB.prepare(`SELECT * FROM agent_proposals WHERE id=? LIMIT 1`).bind(String(proposalId)).first();
    if (!row) return null;
    return parseAgentProposalRow(row);
  } catch (_) { return null; }
}

function parseAgentProposalRow(row) {
  if (!row) return null;
  const parsed = { ...row };
  if (parsed.classification_json) { try { parsed.classification = JSON.parse(parsed.classification_json); } catch (_) {} }
  if (parsed.slots_json) { try { parsed.slots = JSON.parse(parsed.slots_json); } catch (_) {} }
  return parsed;
}

function isAgentProposalExpired(proposal) {
  if (!proposal || !proposal.expires_at) return true;
  return new Date(proposal.expires_at).getTime() < Date.now();
}

/**
 * Extended Telegram webhook handler that intercepts non-command text messages
 * and routes them through the agent intake pipeline (stage 337+).
 *
 * Returns null if the message was NOT handled by the agent (caller should proceed
 * with legacy command handling); returns a Response if it was handled.
 */
async function handleTelegramAgentIntake(env, update) {
  try {
    const message = update && (update.message || update.edited_message);
    if (!message) return null;
    const text = String(message.text || '').trim();
    // Only handle non-empty text that is not a command (commands handled elsewhere)
    if (!text || text.startsWith('/')) return null;

    const updateId = update.update_id;
    const telegramUserId = String(message.from && message.from.id || '');
    const messageId = String(message.message_id || '');
    const chatId = String(message.chat && message.chat.id || '');

    await ensureAgentIntakeSchema(env);

    // Deduplication: if this update already processed, skip
    const existing = await findTelegramUpdateAlreadyProcessed(env, updateId);
    if (existing) return jsonResponse({ ok: true, note: 'duplicate_update', status: existing.status });

    // Resolve planner user_id from telegram user_id
    const plannerUserId = telegramUserId; // 1:1 mapping (telegram_user_id === planner user_id)

    // Persist incoming message
    const intakeId = await insertTelegramIncomingMessage(env, { updateId, telegramUserId, plannerUserId, messageId, chatId, text });

    // Text too long → save as note, ask to clarify
    if (text.length > 3000) {
      await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.IGNORED, { error: 'text_too_long' });
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Сообщение слишком длинное. Пожалуйста, уточни — это задача, встреча, напоминание или инсайт?',
        reply_to_message_id: Number(messageId)
      });
      return jsonResponse({ ok: true });
    }

    // Classify the message
    let classification;
    try {
      classification = await classifyAgentMessage(env, text, { userId: plannerUserId });
    } catch (classError) {
      // Fallback: ask user to clarify manually
      await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.FAILED, { error: String(classError) });
      await sendAgentClassificationFallbackMessage(env, chatId, messageId);
      return jsonResponse({ ok: true });
    }

    await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.CLASSIFIED, { classification_json: classification });

    // Log audit event
    await logAgentAuditEvent(env, {
      user_id: plannerUserId,
      telegram_message_id: messageId,
      event_type: 'message_classified',
      status: 'success',
      payload_json: { text: text.slice(0, 500), classification }
    });

    // Route by detected type
    const detectedType = classification.detected_type || AGENT_MESSAGE_TYPES.UNKNOWN;

    if (detectedType === AGENT_MESSAGE_TYPES.INSIGHT || detectedType === AGENT_MESSAGE_TYPES.IDEA || detectedType === AGENT_MESSAGE_TYPES.QUESTION) {
      // Auto-save insights/ideas/questions immediately
      await handleAgentAutoSaveHubRecord(env, { userId: plannerUserId, chatId, messageId, text, classification, intakeId });
      return jsonResponse({ ok: true });
    }

    if (detectedType === AGENT_MESSAGE_TYPES.RESOURCE) {
      await handleAgentResourceIntake(env, { userId: plannerUserId, chatId, messageId, text, classification, intakeId });
      return jsonResponse({ ok: true });
    }

    if (detectedType === AGENT_MESSAGE_TYPES.TASK) {
      await handleAgentTaskProposal(env, { userId: plannerUserId, chatId, messageId, text, classification, intakeId, updateId });
      return jsonResponse({ ok: true });
    }

    if (detectedType === AGENT_MESSAGE_TYPES.MEETING) {
      await handleAgentMeetingProposal(env, { userId: plannerUserId, chatId, messageId, text, classification, intakeId, updateId });
      return jsonResponse({ ok: true });
    }

    if (detectedType === AGENT_MESSAGE_TYPES.REMINDER) {
      await handleAgentReminderProposal(env, { userId: plannerUserId, chatId, messageId, text, classification, intakeId, updateId });
      return jsonResponse({ ok: true });
    }

    // Unknown — ask clarification
    if (classification.needs_clarification && classification.clarification_question) {
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: classification.clarification_question, reply_to_message_id: Number(messageId) });
    } else {
      await sendAgentClassificationFallbackMessage(env, chatId, messageId);
    }
    return jsonResponse({ ok: true });

  } catch (error) {
    console.error('[handleTelegramAgentIntake]', String(error));
    return null; // let caller handle
  }
}

async function sendAgentClassificationFallbackMessage(env, chatId, messageId) {
  await telegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text: 'Не смог разобрать сообщение. Это:\n1. Задача\n2. Встреча\n3. Инсайт / идея\n4. Напоминание',
    reply_to_message_id: Number(messageId),
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Задача', callback_data: 'agent_manual_task' },
        { text: '📅 Встреча', callback_data: 'agent_manual_meeting' }
      ], [
        { text: '💡 Инсайт', callback_data: 'agent_manual_insight' },
        { text: '🔔 Напоминание', callback_data: 'agent_manual_reminder' }
      ]]
    }
  });
}

// ============================================================
// END STAGE 337
// ============================================================

// ============================================================
// STAGE 338 — Message Classification v1
// ============================================================

/**
 * Classify a Telegram message using LLM (with local fallback).
 * Returns strict JSON matching the classification schema.
 */
async function classifyAgentMessage(env, text, options = {}) {
  const safeText = String(text || '').trim().slice(0, 2000);
  if (!safeText) throw new Error('text is required for classification');

  const schema = {
    type: 'object',
    properties: {
      detected_type: { type: 'string', enum: ['task', 'meeting', 'insight', 'idea', 'question', 'reminder', 'resource', 'project_context', 'unknown'] },
      confidence: { type: 'number' },
      summary: { type: 'string' },
      project: { type: 'string' },
      task_type: { type: 'string' },
      importance: { type: 'string', enum: ['low', 'medium', 'high', 'critical', ''] },
      urgency: { type: 'string', enum: ['now', 'today', 'next_2_days', 'this_week', 'next_week', 'someday', ''] },
      estimated_duration_min: { type: 'number' },
      date: { type: 'string' },
      time: { type: 'string' },
      needs_clarification: { type: 'boolean' },
      clarification_question: { type: 'string' },
      suggested_next_action: { type: 'string' }
    },
    required: ['detected_type', 'confidence', 'summary', 'needs_clarification']
  };

  const systemPrompt = `Ты классификатор сообщений для персонального планировщика.
Твоя задача — определить тип сообщения и вернуть ТОЛЬКО JSON.

Типы сообщений:
- task: нужно сделать, проверить, подготовить, разобрать, написать, создать, позвонить, отправить
- meeting: созвон, встреча, обсудить с командой, в N часов, запланировать встречу
- insight: понял, кажется, важная мысль, наблюдение, можно сделать лучше
- idea: добавить, придумал, хочу реализовать, можно сделать
- question: вопрос, не понимаю, как работает, узнать
- reminder: напомни, не забыть, вернуться, пингни
- resource: ссылка, статья, видео, документ, изучить, посмотреть
- project_context: контекст проекта, статус проекта
- unknown: не удалось определить

Для задачи определи: project, task_type, importance (low/medium/high/critical), urgency (now/today/next_2_days/this_week/next_week/someday), estimated_duration_min.
Для встречи определи: date, time, estimated_duration_min.
Если нужна уточняющая информация — установи needs_clarification=true и задай вопрос в clarification_question.

Верни ТОЛЬКО валидный JSON без markdown-блоков.`;

  let result = null;
  let lastError = null;

  // Try LLM twice (retry once on failure)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await callPlannerJsonWithSchema(env, {
        operation: 'agent-classify',
        user_id: options.userId || null,
        prompt: `${systemPrompt}\n\nСообщение пользователя:\n${safeText}`,
        schema,
        temperature: 0.1
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep_(500);
    }
  }

  if (!result) {
    // Try JSON repair if LLM returned something malformed (best-effort)
    if (lastError && lastError.raw_text) {
      const repaired = tryRepairAgentJson(lastError.raw_text);
      if (repaired && repaired.detected_type) return normalizeClassificationResult(repaired);
    }
    // Full fallback: local heuristic classifier
    return classifyAgentMessageLocal(safeText);
  }

  return normalizeClassificationResult(result);
}

function normalizeClassificationResult(raw) {
  return {
    detected_type: String(raw.detected_type || 'unknown'),
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
    summary: String(raw.summary || '').slice(0, 500),
    project: String(raw.project || ''),
    task_type: String(raw.task_type || ''),
    importance: String(raw.importance || 'medium'),
    urgency: String(raw.urgency || 'this_week'),
    estimated_duration_min: typeof raw.estimated_duration_min === 'number' ? raw.estimated_duration_min : 30,
    date: raw.date ? String(raw.date) : null,
    time: raw.time ? String(raw.time) : null,
    needs_clarification: !!raw.needs_clarification,
    clarification_question: raw.clarification_question ? String(raw.clarification_question) : null,
    suggested_next_action: String(raw.suggested_next_action || 'request_clarification')
  };
}

/**
 * Local heuristic fallback classifier — no LLM required.
 */
function classifyAgentMessageLocal(text) {
  const t = text.toLowerCase();

  const taskKeywords = ['нужно', 'сделать', 'проверить', 'подготовить', 'разобрать', 'написать', 'создать', 'позвонить', 'отправить', 'купить', 'оплатить'];
  const meetingKeywords = ['созвон', 'встреча', 'обсудить', 'встречу', 'запланировать', 'в четверг', 'в пятницу', 'в понедельник', 'в среду', 'завтра в ', 'в ', ' часов', ' в '];
  const insightKeywords = ['понял', 'кажется', 'важная мысль', 'наблюдение', 'заметил', 'можно лучше'];
  const ideaKeywords = ['идея', 'придумал', 'хочу реализовать', 'добавить функцию', 'можно сделать'];
  const reminderKeywords = ['напомни', 'не забыть', 'вернуться', 'пингни', 'напоминание'];
  const resourceKeywords = ['http', 'https', 'статья', 'видео', 'документ', 'ссылка', 'посмотреть', 'изучить'];

  const scoreOf = (keywords) => keywords.filter(k => t.includes(k)).length;

  const scores = {
    task: scoreOf(taskKeywords),
    meeting: scoreOf(meetingKeywords),
    insight: scoreOf(insightKeywords),
    idea: scoreOf(ideaKeywords),
    reminder: scoreOf(reminderKeywords),
    resource: scoreOf(resourceKeywords)
  };

  let best = 'unknown';
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; best = type; }
  }

  return {
    detected_type: best,
    confidence: bestScore > 0 ? Math.min(0.5 + bestScore * 0.1, 0.85) : 0.2,
    summary: text.slice(0, 200),
    project: '',
    task_type: best === 'task' ? 'general' : (best === 'meeting' ? 'meeting' : ''),
    importance: 'medium',
    urgency: 'this_week',
    estimated_duration_min: 30,
    date: null,
    time: null,
    needs_clarification: best === 'unknown',
    clarification_question: best === 'unknown' ? 'Это задача, встреча, инсайт или напоминание?' : null,
    suggested_next_action: best === 'unknown' ? 'request_clarification' : ('create_' + (best === 'task' || best === 'meeting' || best === 'reminder' ? best : 'task'))
  };
}

function tryRepairAgentJson(rawText) {
  if (!rawText) return null;
  try {
    // Strip markdown code blocks
    let clean = String(rawText).replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    // Try to find the first { ... } block
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) clean = clean.slice(start, end + 1);
    return JSON.parse(clean);
  } catch (_) { return null; }
}

function sleep_(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// END STAGE 338
// ============================================================

// ============================================================
// STAGE 339 — Task Proposal v1
// ============================================================

/**
 * Build urgency date range for planning-context request.
 */
function buildUrgencyDateRange(urgency, todayYmd) {
  const today = todayYmd || new Date().toISOString().slice(0, 10);
  const addDays = (ymd, n) => {
    const d = new Date(ymd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const dow = new Date(today + 'T00:00:00Z').getUTCDay(); // 0=Sun
  const daysToEndOfWeek = dow === 0 ? 0 : (7 - dow);
  const daysToStartOfNextWeek = dow === 0 ? 1 : (8 - dow);

  switch (urgency) {
    case 'now':
    case 'today':
      return { from: today, to: today };
    case 'next_2_days':
      return { from: today, to: addDays(today, 2) };
    case 'this_week':
      return { from: today, to: addDays(today, daysToEndOfWeek) };
    case 'next_week': {
      const start = addDays(today, daysToStartOfNextWeek);
      return { from: start, to: addDays(start, 6) };
    }
    default:
      return { from: today, to: addDays(today, 7) };
  }
}

/**
 * Fetch planning context from the planner API internally.
 */
async function fetchAgentPlanningContextInternal(env, { userId, urgency, taskType, durationMin, importance, todayYmd }) {
  const { from, to } = buildUrgencyDateRange(urgency, todayYmd);
  try {
    const context = await getAgentPlanningContext_(env, {
      user_id: String(userId),
      from,
      to,
      task_type: taskType || '',
      duration_min: String(durationMin || 30),
      importance: importance || 'medium',
      urgency: urgency || 'this_week'
    });
    return context;
  } catch (error) {
    console.error('[fetchAgentPlanningContextInternal]', String(error));
    return null;
  }
}

/**
 * Build slot option text for Telegram message.
 */
function formatSlotOption(slot, index, classification) {
  if (!slot) return `Вариант ${index + 1}`;
  const dateStr = slot.date || '';
  const startStr = slot.start_time || slot.time || '';
  const endStr = slot.end_time || '';
  const label = slot.label || slot.block_label || '';
  const hasReschedule = slot.reschedule_task_id || slot.reschedule_candidate;
  const timeRange = startStr && endStr ? `${startStr}–${endStr}` : (startStr || '');
  const datePart = dateStr ? `${dateStr} ` : '';
  const labelPart = label ? ` — ${label}` : '';
  const reschedulePart = hasReschedule ? ` (нужно сдвинуть задачу низкой важности)` : '';
  return `${datePart}${timeRange}${labelPart}${reschedulePart}`;
}

/**
 * Send task proposal message to Telegram with slot options and inline buttons.
 */
async function handleAgentTaskProposal(env, { userId, chatId, messageId, text, classification, intakeId, updateId }) {
  try {
    const todayYmd = new Date().toISOString().slice(0, 10);
    const context = await fetchAgentPlanningContextInternal(env, {
      userId,
      urgency: classification.urgency || 'this_week',
      taskType: classification.task_type || '',
      durationMin: classification.estimated_duration_min || 30,
      importance: classification.importance || 'medium',
      todayYmd
    });

    const bestSlots = (context && context.best_slots) || [];
    const fallbackSlots = (context && context.fallback_slots) || [];
    const reschedCandidates = (context && context.reschedule_candidates) || [];
    const allSlots = [...bestSlots, ...fallbackSlots].slice(0, 2);
    if (reschedCandidates.length > 0 && allSlots.length < 3) {
      const reschedCandidate = reschedCandidates[0];
      allSlots.push({ ...reschedCandidate, reschedule_candidate: true });
    }

    const importanceLabel = { low: 'низкая', medium: 'средняя', high: 'высокая', critical: 'критическая' }[classification.importance] || 'средняя';
    const urgencyLabel = { now: 'сейчас', today: 'сегодня', next_2_days: '2 дня', this_week: 'эта неделя', next_week: 'следующая неделя', someday: 'когда-нибудь' }[classification.urgency] || 'эта неделя';

    // Build proposal and save it
    const proposal = buildAgentProposalObject({
      userId,
      source: 'telegram_agent',
      messageId,
      detectedType: AGENT_MESSAGE_TYPES.TASK,
      confidence: classification.confidence,
      summary: classification.summary || text.slice(0, 200),
      requiresConfirmation: true,
      suggestedActions: ['create_task']
    });
    proposal.telegram_update_id = updateId ? Number(updateId) : null;
    proposal.classification_json = classification;
    proposal.slots_json = allSlots;
    proposal.status = AGENT_PROPOSAL_STATUSES.WAITING_CONFIRMATION;

    await ensureAgentIntakeSchema(env);
    await upsertAgentProposal(env, proposal);
    await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.WAITING_CONFIRMATION, { proposal_json: proposal });

    // Build message text
    let msg = `Похоже, это задача.\n\n`;
    msg += `📝 *${escapeMarkdown(classification.summary || text.slice(0, 200))}*\n`;
    if (classification.project) msg += `Проект: ${escapeMarkdown(classification.project)}\n`;
    if (classification.task_type) msg += `Тип: ${escapeMarkdown(classification.task_type)}\n`;
    msg += `Важность: ${importanceLabel}\n`;
    msg += `Срочность: ${urgencyLabel}\n`;
    msg += `Длительность: ${classification.estimated_duration_min || 30} мин\n`;

    if (allSlots.length > 0) {
      msg += `\nПредлагаю варианты:\n`;
      allSlots.forEach((slot, i) => {
        msg += `${i + 1}. ${formatSlotOption(slot, i, classification)}\n`;
      });
    } else {
      msg += `\nСвободных слотов не найдено — создать задачу в Inbox?\n`;
    }

    // Build inline buttons
    const buttons = [];
    const slotButtons = [];
    allSlots.forEach((_, i) => {
      slotButtons.push({ text: `Вариант ${i + 1}`, callback_data: `agent_confirm_slot:${proposal.id}:${i}` });
    });
    if (slotButtons.length === 0) {
      slotButtons.push({ text: '✅ Создать', callback_data: `agent_confirm_slot:${proposal.id}:0` });
    }
    buttons.push(slotButtons);
    buttons.push([
      { text: '✏️ Изменить', callback_data: `agent_edit:${proposal.id}` },
      { text: '❌ Отмена', callback_data: `agent_cancel:${proposal.id}` }
    ]);

    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: msg,
      parse_mode: 'Markdown',
      reply_to_message_id: Number(messageId),
      reply_markup: { inline_keyboard: buttons }
    });

    await logAgentAuditEvent(env, {
      user_id: userId,
      telegram_message_id: messageId,
      proposal_id: proposal.id,
      event_type: 'proposal_created',
      status: 'success',
      payload_json: { proposal_id: proposal.id, detected_type: AGENT_MESSAGE_TYPES.TASK, slots: allSlots.length }
    });

  } catch (error) {
    console.error('[handleAgentTaskProposal]', String(error));
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Не удалось подготовить предложение. Попробуй ещё раз.', reply_to_message_id: Number(messageId) });
  }
}

function escapeMarkdown(text) {
  return String(text || '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, c => '\\' + c);
}

// ============================================================
// END STAGE 339
// ============================================================

// ============================================================
// STAGE 340 — Confirmed Task Creation v1 (Callback Handler)
// ============================================================

/**
 * Handle Telegram inline button callbacks for agent proposals.
 * Returns true if handled, false if unrecognized.
 */
async function handleAgentProposalCallback(env, callbackQuery) {
  const data = String(callbackQuery && callbackQuery.data || '');
  const chatId = String(callbackQuery && callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id || '');
  const callbackQueryId = String(callbackQuery && callbackQuery.id || '');
  const fromId = String(callbackQuery && callbackQuery.from && callbackQuery.from.id || '');

  if (!data.startsWith('agent_')) return false;

  await ensureAgentIntakeSchema(env);

  // Acknowledge callback immediately
  try { await telegramApi(env, 'answerCallbackQuery', { callback_query_id: callbackQueryId }); } catch (_) {}

  if (data.startsWith('agent_confirm_slot:')) {
    const parts = data.split(':');
    const proposalId = parts[1];
    const slotIndex = Number(parts[2] || 0);
    await handleAgentConfirmSlotCallback(env, { proposalId, slotIndex, userId: fromId, chatId, callbackQuery });
    return true;
  }

  if (data.startsWith('agent_cancel:')) {
    const proposalId = data.split(':')[1];
    await handleAgentCancelCallback(env, { proposalId, userId: fromId, chatId });
    return true;
  }

  if (data.startsWith('agent_edit:')) {
    const proposalId = data.split(':')[1];
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Отправь уточнённое сообщение, и я создам задачу заново.' });
    return true;
  }

  return false;
}

async function handleAgentConfirmSlotCallback(env, { proposalId, slotIndex, userId, chatId, callbackQuery }) {
  const proposal = await getAgentProposalById(env, proposalId);

  if (!proposal) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Предложение не найдено. Попробуй отправить задачу заново.' });
    return;
  }

  if (proposal.status === AGENT_PROPOSAL_STATUSES.APPLIED) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: `✅ Задача уже была создана ранее.` });
    return;
  }

  if (proposal.status === AGENT_PROPOSAL_STATUSES.CANCELLED) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Предложение было отменено.' });
    return;
  }

  if (isAgentProposalExpired(proposal)) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Предложение устарело (>24ч). Отправь сообщение заново.' });
    await env.DB.prepare(`UPDATE agent_proposals SET status=?, updated_at=? WHERE id=?`).bind(AGENT_PROPOSAL_STATUSES.EXPIRED, new Date().toISOString(), proposalId).run();
    return;
  }

  const classification = proposal.classification || {};
  const slots = proposal.slots || [];
  const chosenSlot = slots[slotIndex] || slots[0] || null;

  // Build confirmation_id (stable, idempotent)
  const confirmationId = await generateAgentConfirmationId(
    userId,
    proposal.message_id || proposalId,
    'create_task',
    { proposal_id: proposalId, slot: slotIndex }
  );

  // Build task payload
  const taskPayload = {
    user_id: String(proposal.user_id || userId),
    source: 'telegram_agent',
    confirmation_id: confirmationId,
    task: {
      title: classification.summary || proposal.summary || 'Задача из Telegram',
      project: classification.project || '',
      task_type: classification.task_type || 'general',
      importance: classification.importance || 'medium',
      urgency: classification.urgency || 'this_week',
      date: chosenSlot ? (chosenSlot.date || new Date().toISOString().slice(0, 10)) : new Date().toISOString().slice(0, 10),
      start_time: chosenSlot ? (chosenSlot.start_time || chosenSlot.time || '09:00') : '09:00',
      duration_min: classification.estimated_duration_min || 30
    }
  };

  try {
    // Mark proposal as confirmed before calling the endpoint (pessimistic lock)
    await env.DB.prepare(`UPDATE agent_proposals SET status=?, selected_slot=?, confirmation_id=?, updated_at=? WHERE id=?`)
      .bind(AGENT_PROPOSAL_STATUSES.CONFIRMED, slotIndex, confirmationId, new Date().toISOString(), proposalId).run();

    // Call the create-confirmed handler directly (internal)
    const fakeRequest = new Request('https://internal/agent/tasks/create-confirmed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(taskPayload)
    });
    const response = await handleAgentTaskCreateConfirmedApi(fakeRequest, env);
    const result = await response.json();

    if (result.ok) {
      const alreadyApplied = result.already_applied;
      const taskId = result.task_id;

      await env.DB.prepare(`UPDATE agent_proposals SET status=?, result_task_id=?, updated_at=? WHERE id=?`)
        .bind(AGENT_PROPOSAL_STATUSES.APPLIED, taskId || null, new Date().toISOString(), proposalId).run();

      const msg = alreadyApplied
        ? `✅ Задача уже создана ранее.`
        : `✅ Задача создана!\n\n*${escapeMarkdown(taskPayload.task.title)}*`;

      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: msg, parse_mode: 'Markdown' });

      await logAgentAuditEvent(env, {
        user_id: userId,
        proposal_id: proposalId,
        confirmation_id: confirmationId,
        event_type: 'planner_action_applied',
        status: 'success',
        result_json: { task_id: taskId, already_applied: alreadyApplied }
      });
    } else {
      await env.DB.prepare(`UPDATE agent_proposals SET status=?, error=?, updated_at=? WHERE id=?`)
        .bind(AGENT_PROPOSAL_STATUSES.FAILED, String(result.error || 'unknown').slice(0, 300), new Date().toISOString(), proposalId).run();
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: `❌ Не удалось создать задачу: ${result.error || 'неизвестная ошибка'}.\nПопробуй ещё раз.` });
    }
  } catch (error) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: `❌ Ошибка при создании задачи. Попробуй ещё раз.` });
    console.error('[handleAgentConfirmSlotCallback]', String(error));
  }
}

async function handleAgentCancelCallback(env, { proposalId, userId, chatId }) {
  try {
    if (proposalId && env && env.DB) {
      await env.DB.prepare(`UPDATE agent_proposals SET status=?, updated_at=? WHERE id=?`)
        .bind(AGENT_PROPOSAL_STATUSES.CANCELLED, new Date().toISOString(), proposalId).run();
    }
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Отменено.' });
  } catch (_) {}
}

// ============================================================
// END STAGE 340
// ============================================================

// ============================================================
// STAGE 341 — Meetings v1
// ============================================================

async function handleAgentMeetingProposal(env, { userId, chatId, messageId, text, classification, intakeId, updateId }) {
  try {
    // Check for required fields
    const missingFields = [];
    if (!classification.date) missingFields.push('дата');
    if (!classification.time) missingFields.push('время');

    if (missingFields.length > 0) {
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: `Понял — встреча. Уточни: ${missingFields.join(' и ')}?`,
        reply_to_message_id: Number(messageId)
      });
      await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.WAITING_CONFIRMATION, { classification_json: classification });
      return;
    }

    const durationMin = classification.estimated_duration_min || 30;

    // Check for conflicts via planning context
    const context = await fetchAgentPlanningContextInternal(env, {
      userId,
      urgency: 'today',
      taskType: 'meeting',
      durationMin,
      importance: classification.importance || 'medium',
      todayYmd: classification.date || new Date().toISOString().slice(0, 10)
    });

    const hasConflict = context && context.blocks && context.blocks.some(b => {
      if (!b.start_time || !classification.time) return false;
      const reqStart = agentClockToMinutes_(classification.time);
      const reqEnd = reqStart + durationMin;
      const blkStart = agentClockToMinutes_(b.start_time);
      const blkEnd = agentClockToMinutes_(b.end_time || b.start_time);
      return reqStart < blkEnd && reqEnd > blkStart;
    });

    const proposal = buildAgentProposalObject({
      userId,
      source: 'telegram_agent',
      messageId,
      detectedType: AGENT_MESSAGE_TYPES.MEETING,
      confidence: classification.confidence,
      summary: classification.summary || text.slice(0, 200),
      requiresConfirmation: true,
      suggestedActions: ['create_meeting']
    });
    proposal.telegram_update_id = updateId ? Number(updateId) : null;
    proposal.classification_json = classification;
    proposal.status = AGENT_PROPOSAL_STATUSES.WAITING_CONFIRMATION;

    await ensureAgentIntakeSchema(env);
    await upsertAgentProposal(env, proposal);
    await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.WAITING_CONFIRMATION, { proposal_json: proposal });

    let msg = `📅 Встреча\n\n*${escapeMarkdown(classification.summary || text.slice(0, 200))}*\n`;
    msg += `Дата: ${classification.date}\nВремя: ${classification.time}\nДлительность: ${durationMin} мин\n`;
    if (hasConflict) msg += `\n⚠️ В это время уже есть другое событие. Всё равно создать?\n`;
    else msg += `\nСоздать встречу?\n`;

    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: msg,
      parse_mode: 'Markdown',
      reply_to_message_id: Number(messageId),
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Создать', callback_data: `agent_confirm_slot:${proposal.id}:0` },
          { text: '❌ Отмена', callback_data: `agent_cancel:${proposal.id}` }
        ]]
      }
    });
  } catch (error) {
    console.error('[handleAgentMeetingProposal]', String(error));
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Не удалось обработать встречу.', reply_to_message_id: Number(messageId) });
  }
}

// ============================================================
// END STAGE 341
// ============================================================

// ============================================================
// STAGE 342 — Reminders v1
// ============================================================

async function handleAgentReminderProposal(env, { userId, chatId, messageId, text, classification, intakeId, updateId }) {
  try {
    // If no time/date — ask when
    if (!classification.date && !classification.time) {
      const proposal = buildAgentProposalObject({
        userId, source: 'telegram_agent', messageId,
        detectedType: AGENT_MESSAGE_TYPES.REMINDER,
        confidence: classification.confidence,
        summary: classification.summary || text.slice(0, 200),
        requiresConfirmation: true,
        suggestedActions: ['create_reminder']
      });
      proposal.telegram_update_id = updateId ? Number(updateId) : null;
      proposal.classification_json = classification;
      proposal.status = AGENT_PROPOSAL_STATUSES.WAITING_CONFIRMATION;

      await ensureAgentIntakeSchema(env);
      await upsertAgentProposal(env, proposal);
      await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.WAITING_CONFIRMATION, { proposal_json: proposal });

      const todayYmd = new Date().toISOString().slice(0, 10);
      const tomorrowYmd = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();

      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: `🔔 Напоминание: *${escapeMarkdown(classification.summary || text.slice(0, 200))}*\n\nКогда напомнить?`,
        parse_mode: 'Markdown',
        reply_to_message_id: Number(messageId),
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Сегодня вечером', callback_data: `agent_confirm_reminder:${proposal.id}:${todayYmd}:20:00` },
              { text: 'Завтра утром', callback_data: `agent_confirm_reminder:${proposal.id}:${tomorrowYmd}:09:00` }
            ]
          ]
        }
      });
      return;
    }

    // Has date/time — show confirmation
    const proposal = buildAgentProposalObject({
      userId, source: 'telegram_agent', messageId,
      detectedType: AGENT_MESSAGE_TYPES.REMINDER,
      confidence: classification.confidence,
      summary: classification.summary || text.slice(0, 200),
      requiresConfirmation: true,
      suggestedActions: ['create_reminder']
    });
    proposal.telegram_update_id = updateId ? Number(updateId) : null;
    proposal.classification_json = classification;
    proposal.status = AGENT_PROPOSAL_STATUSES.WAITING_CONFIRMATION;

    await ensureAgentIntakeSchema(env);
    await upsertAgentProposal(env, proposal);
    await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.WAITING_CONFIRMATION, { proposal_json: proposal });

    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: `🔔 Напоминание: *${escapeMarkdown(classification.summary || text.slice(0, 200))}*\nКогда: ${classification.date || ''} ${classification.time || ''}\n\nСоздать?`,
      parse_mode: 'Markdown',
      reply_to_message_id: Number(messageId),
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Создать', callback_data: `agent_confirm_slot:${proposal.id}:0` },
          { text: '❌ Отмена', callback_data: `agent_cancel:${proposal.id}` }
        ]]
      }
    });
  } catch (error) {
    console.error('[handleAgentReminderProposal]', String(error));
  }
}

// Handle reminder time selection callback
async function handleAgentReminderTimeCallback(env, callbackQuery, data, chatId, fromId) {
  // data format: agent_confirm_reminder:<proposal_id>:<date>:<time>
  const parts = data.split(':');
  const proposalId = parts[1];
  const date = parts[2];
  const time = (parts[3] || '') + ':' + (parts[4] || '00');

  const proposal = await getAgentProposalById(env, proposalId);
  if (!proposal) { await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Предложение не найдено.' }); return; }
  if (isAgentProposalExpired(proposal)) { await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Предложение устарело.' }); return; }

  const classification = proposal.classification || {};
  const confirmationId = await generateAgentConfirmationId(fromId, proposal.message_id || proposalId, 'create_reminder', { proposal_id: proposalId, date, time });

  const reminderPayload = {
    user_id: String(proposal.user_id || fromId),
    source: 'telegram_agent',
    confirmation_id: confirmationId,
    task: {
      title: classification.summary || proposal.summary || 'Напоминание из Telegram',
      task_type: 'reminder',
      importance: classification.importance || 'medium',
      urgency: 'today',
      date,
      start_time: time,
      duration_min: 10
    }
  };

  try {
    const fakeRequest = new Request('https://internal/agent/reminders/create-confirmed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reminderPayload)
    });
    const response = await handleAgentReminderCreateConfirmedApi(fakeRequest, env);
    const result = await response.json();
    if (result.ok) {
      await env.DB.prepare(`UPDATE agent_proposals SET status=?, updated_at=? WHERE id=?`).bind(AGENT_PROPOSAL_STATUSES.APPLIED, new Date().toISOString(), proposalId).run();
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: `✅ Напоминание создано на ${date} ${time}.` });
    } else {
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: `❌ Ошибка: ${result.error || 'неизвестная'}` });
    }
  } catch (error) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '❌ Не удалось создать напоминание.' });
  }
}

// ============================================================
// END STAGE 342
// ============================================================

// ============================================================
// STAGE 343 — Inbox Hub Insights v1
// ============================================================

async function ensureHubRecordsSchema(env) {
  if (!env || !env.DB) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS hub_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'telegram_agent',
      record_type TEXT NOT NULL,
      text TEXT,
      project TEXT,
      importance TEXT DEFAULT 'medium',
      tags_json TEXT,
      include_in_weekly_review INTEGER DEFAULT 0,
      linked_task_id TEXT,
      linked_resource_url TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_hub_records_user_type ON hub_records(user_id, record_type, created_at DESC)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_hub_records_weekly ON hub_records(user_id, include_in_weekly_review, created_at DESC)`).run();
}

async function createHubRecord(env, { userId, source, recordType, text, project, importance, tags, includeInWeeklyReview, linkedTaskId, linkedResourceUrl }) {
  await ensureHubRecordsSchema(env);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : null;
  await env.DB.prepare(`
    INSERT INTO hub_records (id, user_id, source, record_type, text, project, importance, tags_json, include_in_weekly_review, linked_task_id, linked_resource_url, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?)
  `).bind(id, String(userId), String(source || 'telegram_agent'), String(recordType), text ? String(text).slice(0, 5000) : null, project ? String(project) : null, String(importance || 'medium'), tagsJson, includeInWeeklyReview ? 1 : 0, linkedTaskId ? String(linkedTaskId) : null, linkedResourceUrl ? String(linkedResourceUrl) : null, now, now).run();
  return id;
}

async function handleAgentAutoSaveHubRecord(env, { userId, chatId, messageId, text, classification, intakeId }) {
  try {
    const recordType = classification.detected_type || 'insight';
    const includeInWeekly = recordType === 'insight';
    const tags = ['telegram'];
    if (includeInWeekly) tags.push('weekly_review');

    const recordId = await createHubRecord(env, {
      userId,
      source: 'telegram_agent',
      recordType,
      text: classification.summary || text,
      project: classification.project || null,
      importance: classification.importance || 'medium',
      tags,
      includeInWeeklyReview: includeInWeekly
    });

    await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.APPLIED);

    await logAgentAuditEvent(env, {
      user_id: userId,
      telegram_message_id: messageId,
      event_type: 'hub_record_created',
      status: 'success',
      result_json: { record_id: recordId, record_type: recordType }
    });

    const typeLabel = { insight: '💡 Инсайт', idea: '🌱 Идея', question: '❓ Вопрос' }[recordType] || '📝 Запись';
    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: `${typeLabel} сохранён${includeInWeekly ? ' (войдёт в еженедельный обзор)' : ''}.`,
      reply_to_message_id: Number(messageId)
    });
  } catch (error) {
    console.error('[handleAgentAutoSaveHubRecord]', String(error));
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Не удалось сохранить запись.', reply_to_message_id: Number(messageId) });
  }
}

/**
 * POST /agent/hub/records/create
 */
async function handleAgentHubRecordCreateApi(request, env) {
  if (String(request.method || 'POST').toUpperCase() !== 'POST') return textResponse('Method Not Allowed', 405);
  const body = await readJsonBodySafe(request);
  const url = new URL(request.url);
  const userId = readRequestUserIdFromUrlBodyOrHeader(url, body, request);
  if (!userId) return buildMissingUserIdJsonResponse('/agent/hub/records/create');

  const recordType = String(body.record_type || body.type || 'insight').trim();
  const allowedTypes = ['insight', 'idea', 'question', 'resource', 'note'];
  if (!allowedTypes.includes(recordType)) {
    return jsonResponse({ ok: false, error: 'Invalid record_type. Allowed: ' + allowedTypes.join(', ') }, { status: 400 });
  }

  const text = String(body.text || body.content || '').trim();
  if (!text) return jsonResponse({ ok: false, error: 'text is required' }, { status: 400 });

  try {
    const tags = Array.isArray(body.tags) ? body.tags : [];
    const recordId = await createHubRecord(env, {
      userId: String(userId),
      source: String(body.source || 'api'),
      recordType,
      text,
      project: body.project || null,
      importance: body.importance || 'medium',
      tags,
      includeInWeeklyReview: !!body.include_in_weekly_review,
      linkedTaskId: body.linked_task_id || null,
      linkedResourceUrl: body.linked_resource_url || null
    });
    return jsonResponse({ ok: true, record_id: recordId, record_type: recordType, build: getClientAppBuildLabel() });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error), build: getClientAppBuildLabel() }, { status: 500 });
  }
}

// ============================================================
// END STAGE 343
// ============================================================

// ============================================================
// STAGE 344 — Weekly Insights Review v1
// ============================================================

/**
 * Collect weekly insights and send to Telegram.
 * Triggered by scheduled Cloudflare Worker CRON (Thursday 10:00).
 */
async function runWeeklyInsightsReview(env, userId) {
  if (!env || !env.DB) return;
  await ensureHubRecordsSchema(env);
  await ensureAgentSettingsSchema(env);

  const settings = await getAgentSettings(env, userId);
  if (!settings.weekly_insights_enabled) return;

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(`
    SELECT id, text, project, importance, tags_json, created_at
    FROM hub_records
    WHERE user_id=? AND record_type='insight' AND include_in_weekly_review=1 AND created_at>=? AND status='active'
    ORDER BY created_at DESC
    LIMIT 30
  `).bind(String(userId), weekAgo).all();

  const insights = (rows.results || []);
  if (insights.length === 0) return;

  // Use LLM to select top insights
  let topInsights = [];
  try {
    const insightTexts = insights.map((r, i) => `${i + 1}. ${String(r.text || '').slice(0, 300)}`).join('\n');
    const schema = {
      type: 'object',
      properties: {
        top_insights: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              index: { type: 'number' },
              title: { type: 'string' },
              why_selected: { type: 'string' },
              discussion_question: { type: 'string' },
              related_project: { type: 'string' }
            },
            required: ['index', 'title', 'why_selected', 'discussion_question']
          }
        }
      },
      required: ['top_insights']
    };
    const result = await callPlannerJsonWithSchema(env, {
      operation: 'weekly-insights',
      user_id: String(userId),
      prompt: `Выбери 2–3 самых важных инсайта из списка ниже для еженедельного обзора с командой. Для каждого: краткий заголовок, почему важен, вопрос для обсуждения.\n\nИнсайты:\n${insightTexts}`,
      schema,
      temperature: 0.3
    });
    topInsights = (result && result.top_insights) ? result.top_insights.slice(0, 3) : [];
  } catch (_) {
    // Fallback: take first 3 insights
    topInsights = insights.slice(0, 3).map((r, i) => ({
      index: i,
      title: String(r.text || '').slice(0, 100),
      why_selected: 'Отобран автоматически',
      discussion_question: 'Как это влияет на текущие проекты?',
      related_project: r.project || ''
    }));
  }

  if (topInsights.length === 0) return;

  let msg = `На этой неделе я выбрал ${topInsights.length} инсайта для обзора:\n\n`;
  topInsights.forEach((ins, i) => {
    msg += `*${i + 1}. ${escapeMarkdown(String(ins.title || '').slice(0, 150))}*\n`;
    if (ins.why_selected) msg += `Почему важно: ${escapeMarkdown(String(ins.why_selected).slice(0, 200))}\n`;
    if (ins.discussion_question) msg += `Вопрос: ${escapeMarkdown(String(ins.discussion_question).slice(0, 200))}\n`;
    if (ins.related_project) msg += `Проект: ${escapeMarkdown(ins.related_project)}\n`;
    msg += '\n';
  });

  const telegramUserId = String(userId);
  await telegramApi(env, 'sendMessage', {
    chat_id: telegramUserId,
    text: msg,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '📋 В координацию', callback_data: 'weekly_add_to_coordination' },
        { text: '✅ Сохранить', callback_data: 'weekly_save' },
        { text: '⏭️ Пропустить', callback_data: 'weekly_skip' }
      ]]
    }
  });

  await logAgentAuditEvent(env, {
    user_id: userId,
    event_type: 'weekly_insights_generated',
    status: 'success',
    payload_json: { insights_count: insights.length, top_count: topInsights.length }
  });
}

/**
 * POST /agent/weekly-insights/run — trigger weekly review manually (admin/cron).
 */
async function handleAgentWeeklyInsightsRunApi(request, env) {
  const authFailure = requireAdminRouteAuth(request, env, '/agent/weekly-insights/run');
  if (authFailure) return authFailure;
  const url = new URL(request.url);
  const body = await readJsonBodySafe(request);
  const userId = readRequestUserIdFromUrlBodyOrHeader(url, body, request);
  if (!userId) return buildMissingUserIdJsonResponse('/agent/weekly-insights/run');
  try {
    await runWeeklyInsightsReview(env, String(userId));
    return jsonResponse({ ok: true, message: 'Weekly insights review triggered', build: getClientAppBuildLabel() });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error), build: getClientAppBuildLabel() }, { status: 500 });
  }
}

// ============================================================
// END STAGE 344
// ============================================================

// ============================================================
// STAGE 345 — Resource Handling v1
// ============================================================

const URL_REGEX = /https?:\/\/[^\s"'<>]+/gi;

function extractUrlsFromText(text) {
  const matches = String(text || '').match(URL_REGEX);
  return matches ? [...new Set(matches)] : [];
}

async function handleAgentResourceIntake(env, { userId, chatId, messageId, text, classification, intakeId }) {
  try {
    const urls = extractUrlsFromText(text);
    const mainUrl = urls[0] || null;

    await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.WAITING_CONFIRMATION, { classification_json: classification });

    let msg = `🔗 Ресурс\n\n`;
    if (mainUrl) msg += `${mainUrl}\n\n`;
    msg += `Что с ним сделать?`;

    const intakeIdEncoded = intakeId.replace(/:/g, '_').slice(0, 40);
    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: msg,
      reply_to_message_id: Number(messageId),
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Создать задачу', callback_data: `agent_resource_task:${intakeIdEncoded}` },
          { text: '🔔 Напоминание', callback_data: `agent_resource_reminder:${intakeIdEncoded}` },
          { text: '📥 Сохранить', callback_data: `agent_resource_save:${intakeIdEncoded}` }
        ]]
      }
    });
  } catch (error) {
    console.error('[handleAgentResourceIntake]', String(error));
  }
}

async function handleAgentResourceCallbackAction(env, action, intakeId, userId, chatId) {
  if (!env || !env.DB) return;
  await ensureAgentIntakeSchema(env);
  await ensureHubRecordsSchema(env);

  // Load original intake message
  let text = '';
  let mainUrl = null;
  try {
    const intakeRow = await env.DB.prepare(`SELECT text, classification_json FROM telegram_incoming_messages WHERE id=? LIMIT 1`).bind(intakeId).first();
    if (intakeRow) {
      text = String(intakeRow.text || '');
      const urls = extractUrlsFromText(text);
      mainUrl = urls[0] || null;
    }
  } catch (_) {}

  // Save as hub resource always
  const recordId = await createHubRecord(env, {
    userId, source: 'telegram_agent', recordType: 'resource',
    text: text.slice(0, 1000),
    linkedResourceUrl: mainUrl,
    importance: 'medium',
    tags: ['telegram', 'resource'],
    includeInWeeklyReview: false
  });

  if (action === 'save') {
    await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.APPLIED);
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '📥 Ресурс сохранён.' });
    return;
  }

  if (action === 'task') {
    // Treat as task proposal
    const fakeClassification = {
      detected_type: 'task', confidence: 0.7,
      summary: text.slice(0, 200),
      importance: 'medium', urgency: 'this_week',
      estimated_duration_min: 30,
      needs_clarification: false,
      suggested_next_action: 'create_task'
    };
    await handleAgentTaskProposal(env, { userId, chatId, messageId: '0', text, classification: fakeClassification, intakeId, updateId: null });
    return;
  }

  if (action === 'reminder') {
    const fakeClassification = {
      detected_type: 'reminder', confidence: 0.7,
      summary: text.slice(0, 200),
      importance: 'medium', urgency: 'this_week',
      estimated_duration_min: 10,
      needs_clarification: false,
      suggested_next_action: 'create_reminder'
    };
    await handleAgentReminderProposal(env, { userId, chatId, messageId: '0', text, classification: fakeClassification, intakeId, updateId: null });
    return;
  }
}

// ============================================================
// END STAGE 345
// ============================================================

// ============================================================
// STAGE 346 — Reschedule Proposal v1
// ============================================================

/**
 * Build a reschedule proposal message when there is no free slot.
 * Returns the proposal object or null if no candidates.
 */
async function buildRescheduleProposal(env, { userId, chatId, messageId, classification, intakeId, updateId, rescheduleCandidates }) {
  if (!rescheduleCandidates || rescheduleCandidates.length === 0) return null;

  try {
    const candidate = rescheduleCandidates[0];
    const newTitle = classification.summary || 'новая задача';
    const candidateTitle = candidate.title || candidate.task_title || 'задача';
    const candidateDate = candidate.date || '';
    const candidateStart = candidate.start_time || '';
    const candidateNewDate = candidate.new_date || candidateDate;
    const candidateNewStart = candidate.new_start_time || '11:00';

    const proposal = buildAgentProposalObject({
      userId, source: 'telegram_agent', messageId,
      detectedType: AGENT_MESSAGE_TYPES.TASK,
      confidence: classification.confidence || 0.7,
      summary: newTitle,
      requiresConfirmation: true,
      suggestedActions: ['apply_plan']
    });
    proposal.telegram_update_id = updateId ? Number(updateId) : null;
    proposal.classification_json = classification;
    proposal.slots_json = [{ reschedule_candidate: true, candidate }];
    proposal.status = AGENT_PROPOSAL_STATUSES.WAITING_CONFIRMATION;

    await ensureAgentIntakeSchema(env);
    await upsertAgentProposal(env, proposal);
    await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.WAITING_CONFIRMATION, { proposal_json: proposal });

    const msg = [
      `Свободного слота на ${classification.estimated_duration_min || 30} минут нет.\n`,
      `Можно освободить место:`,
      `— Сдвинуть задачу *${escapeMarkdown(candidateTitle)}* с ${candidateDate} ${candidateStart} на ${candidateNewDate} ${candidateNewStart}`,
      `— Поставить новую задачу *${escapeMarkdown(newTitle)}* на это место.\n`,
      `Новая задача важнее, старая — низкоприоритетная.`
    ].join('\n');

    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: msg,
      parse_mode: 'Markdown',
      reply_to_message_id: Number(messageId),
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Сдвинуть и создать', callback_data: `agent_reschedule_confirm:${proposal.id}` },
          { text: '❌ Отмена', callback_data: `agent_cancel:${proposal.id}` }
        ]]
      }
    });

    return proposal;
  } catch (error) {
    console.error('[buildRescheduleProposal]', String(error));
    return null;
  }
}

async function handleAgentRescheduleConfirmCallback(env, proposalId, userId, chatId) {
  const proposal = await getAgentProposalById(env, proposalId);
  if (!proposal) { await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Предложение не найдено.' }); return; }
  if (isAgentProposalExpired(proposal)) { await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Предложение устарело.' }); return; }
  if (proposal.status === AGENT_PROPOSAL_STATUSES.APPLIED) { await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '✅ Уже применено.' }); return; }

  const classification = proposal.classification || {};
  const slots = proposal.slots || [];
  const slotInfo = slots[0] || {};
  const candidate = slotInfo.candidate || {};

  const confirmationId = await generateAgentConfirmationId(userId, proposal.message_id || proposalId, 'apply_plan', { proposal_id: proposalId });

  const actions = [];
  if (candidate.task_id || candidate.id) {
    actions.push({
      type: 'reschedule_task',
      task_id: String(candidate.task_id || candidate.id),
      new_date: candidate.new_date || candidate.date,
      new_start_time: candidate.new_start_time || '11:00',
      reason: 'Освобождение слота для более важной задачи'
    });
  }
  actions.push({
    type: 'create_task',
    task: {
      title: classification.summary || proposal.summary || 'Новая задача',
      project: classification.project || '',
      task_type: classification.task_type || 'general',
      importance: classification.importance || 'high',
      urgency: classification.urgency || 'today',
      date: candidate.date || new Date().toISOString().slice(0, 10),
      start_time: candidate.start_time || '09:00',
      duration_min: classification.estimated_duration_min || 30
    }
  });

  const planPayload = {
    user_id: String(proposal.user_id || userId),
    source: 'telegram_agent',
    confirmation_id: confirmationId,
    actions
  };

  try {
    await env.DB.prepare(`UPDATE agent_proposals SET status=?, confirmation_id=?, updated_at=? WHERE id=?`)
      .bind(AGENT_PROPOSAL_STATUSES.CONFIRMED, confirmationId, new Date().toISOString(), proposalId).run();

    const fakeRequest = new Request('https://internal/agent/tasks/apply-plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(planPayload)
    });
    const response = await handleAgentTasksApplyPlanApi(fakeRequest, env);
    const result = await response.json();

    if (result.ok) {
      await env.DB.prepare(`UPDATE agent_proposals SET status=?, updated_at=? WHERE id=?`).bind(AGENT_PROPOSAL_STATUSES.APPLIED, new Date().toISOString(), proposalId).run();
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '✅ Задача создана, старая задача сдвинута.' });
    } else {
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: `❌ Ошибка: ${result.error || 'неизвестная'}` });
    }
  } catch (error) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '❌ Не удалось применить план.' });
    console.error('[handleAgentRescheduleConfirmCallback]', String(error));
  }
}

// ============================================================
// END STAGE 346
// ============================================================

// ============================================================
// STAGE 347 — Agent Audit / Logs v1
// ============================================================

async function ensureAgentAuditSchema(env) {
  if (!env || !env.DB) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS agent_audit_log (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      user_id TEXT NOT NULL,
      telegram_message_id TEXT,
      proposal_id TEXT,
      confirmation_id TEXT,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      payload_json TEXT,
      result_json TEXT,
      error_message TEXT,
      build TEXT
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_audit_user_time ON agent_audit_log(user_id, created_at DESC)`).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_agent_audit_proposal ON agent_audit_log(proposal_id, created_at DESC)`).run();
}

const AGENT_AUDIT_EVENT_TYPES = Object.freeze([
  'incoming_message_received',
  'message_classified',
  'proposal_created',
  'planning_context_requested',
  'user_confirmed_action',
  'planner_action_applied',
  'hub_record_created',
  'weekly_insights_generated',
  'error'
]);

async function logAgentAuditEvent(env, { user_id, telegram_message_id, proposal_id, confirmation_id, event_type, status, payload_json, result_json, error_message }) {
  try {
    if (!env || !env.DB || !user_id) return;
    await ensureAgentAuditSchema(env);
    const payloadText = payload_json != null ? (() => { try { return JSON.stringify(payload_json).slice(0, 6000); } catch (_) { return null; } })() : null;
    const resultText = result_json != null ? (() => { try { return JSON.stringify(result_json).slice(0, 4000); } catch (_) { return null; } })() : null;
    await env.DB.prepare(`
      INSERT INTO agent_audit_log (id, created_at, user_id, telegram_message_id, proposal_id, confirmation_id, event_type, status, payload_json, result_json, error_message, build)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      String(user_id),
      telegram_message_id ? String(telegram_message_id) : null,
      proposal_id ? String(proposal_id) : null,
      confirmation_id ? String(confirmation_id) : null,
      String(event_type || 'unknown'),
      String(status || 'success'),
      payloadText,
      resultText,
      error_message ? String(error_message).slice(0, 500) : null,
      getClientAppBuildLabel()
    ).run();
  } catch (error) {
    console.error('[logAgentAuditEvent]', String(error));
  }
}

/**
 * GET /agent/audit-log — list recent audit events for a user.
 */
async function handleAgentAuditLogApi(request, env) {
  const url = new URL(request.url);
  const body = await readJsonBodySafe(request);
  const userId = readRequestUserIdFromUrlBodyOrHeader(url, body, request);
  if (!userId) return buildMissingUserIdJsonResponse('/agent/audit-log');
  const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
  try {
    await ensureAgentAuditSchema(env);
    const rows = await env.DB.prepare(`
      SELECT id, created_at, user_id, telegram_message_id, proposal_id, confirmation_id, event_type, status, error_message, build
      FROM agent_audit_log
      WHERE user_id=?
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(String(userId), limit).all();
    return jsonResponse({ ok: true, items: rows.results || [], build: getClientAppBuildLabel() });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error), build: getClientAppBuildLabel() }, { status: 500 });
  }
}

// ============================================================
// END STAGE 347
// ============================================================

// ============================================================
// STAGE 348 — Agent Settings v1
// ============================================================

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
  allowed_task_types: [],
  telegram_notifications_enabled: true
});

async function ensureAgentSettingsSchema(env) {
  if (!env || !env.DB) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      user_id TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
}

async function getAgentSettings(env, userId) {
  await ensureAgentSettingsSchema(env);
  try {
    const row = await env.DB.prepare(`SELECT settings_json FROM agent_settings WHERE user_id=? LIMIT 1`).bind(String(userId)).first();
    if (!row || !row.settings_json) return { ...AGENT_SETTINGS_DEFAULTS };
    const parsed = JSON.parse(row.settings_json);
    return { ...AGENT_SETTINGS_DEFAULTS, ...parsed };
  } catch (_) {
    return { ...AGENT_SETTINGS_DEFAULTS };
  }
}

async function upsertAgentSettings(env, userId, partial) {
  await ensureAgentSettingsSchema(env);
  const current = await getAgentSettings(env, userId);
  const merged = { ...current };
  for (const [key, value] of Object.entries(partial || {})) {
    if (key in AGENT_SETTINGS_DEFAULTS) merged[key] = value;
  }
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT OR REPLACE INTO agent_settings (user_id, settings_json, updated_at) VALUES (?,?,?)
  `).bind(String(userId), JSON.stringify(merged), now).run();
  return merged;
}

/**
 * GET /agent/settings — read agent settings for a user.
 * PUT /agent/settings — update agent settings (partial merge).
 */
async function handleAgentSettingsApi(request, env) {
  const url = new URL(request.url);
  const method = String(request.method || 'GET').toUpperCase();
  const body = method === 'PUT' || method === 'POST' ? await readJsonBodySafe(request) : {};
  const userId = readRequestUserIdFromUrlBodyOrHeader(url, body, request);
  if (!userId) return buildMissingUserIdJsonResponse('/agent/settings');

  if (method === 'GET') {
    try {
      const settings = await getAgentSettings(env, String(userId));
      return jsonResponse({ ok: true, user_id: String(userId), settings, build: getClientAppBuildLabel() });
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error), build: getClientAppBuildLabel() }, { status: 500 });
    }
  }

  if (method === 'PUT' || method === 'POST') {
    try {
      const updates = body.settings || body;
      const merged = await upsertAgentSettings(env, String(userId), updates);
      return jsonResponse({ ok: true, user_id: String(userId), settings: merged, build: getClientAppBuildLabel() });
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error), build: getClientAppBuildLabel() }, { status: 500 });
    }
  }

  return textResponse('Method Not Allowed', 405);
}

// ============================================================
// END STAGE 348
// ============================================================

// ============================================================
// STAGE 349 — Stabilization / Fallbacks / QA
// ============================================================

/**
 * Validate that an agent action has all required non-empty fields.
 * Throws a descriptive error if validation fails.
 */
function validateAgentActionFields(action) {
  if (!action) throw new Error('action is required');
  const type = String(action.type || '').trim();
  if (!type) throw new Error('action.type is required');

  if (type === 'create_task' || type === 'create_meeting' || type === 'create_reminder') {
    const task = action.task || action.meeting || action.reminder || action;
    const title = String(task && task.title || '').trim();
    if (!title) throw new Error('task.title is required for ' + type);
  }

  if (type === 'reschedule_task') {
    const taskId = String(action.task_id || '').trim();
    if (!taskId) throw new Error('task_id is required for reschedule_task');
    const newDate = String(action.new_date || action.date || '').trim();
    if (!newDate) throw new Error('new_date is required for reschedule_task');
  }
}

/**
 * Cost / token logging for LLM calls.
 */
async function logAgentLlmCost(env, { userId, operation, model, tokensIn, tokensOut, latencyMs, costEstimate }) {
  try {
    if (!env || !env.DB) return;
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS agent_llm_cost_log (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        operation TEXT,
        model TEXT,
        tokens_in INTEGER,
        tokens_out INTEGER,
        cost_estimate REAL,
        latency_ms INTEGER,
        created_at TEXT NOT NULL
      )
    `).run();
    await env.DB.prepare(`
      INSERT INTO agent_llm_cost_log (id, user_id, operation, model, tokens_in, tokens_out, cost_estimate, latency_ms, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(
      crypto.randomUUID(),
      userId ? String(userId) : null,
      operation ? String(operation) : null,
      model ? String(model) : null,
      tokensIn != null ? Number(tokensIn) : null,
      tokensOut != null ? Number(tokensOut) : null,
      costEstimate != null ? Number(costEstimate) : null,
      latencyMs != null ? Number(latencyMs) : null,
      new Date().toISOString()
    ).run();
  } catch (_) {}
}

/**
 * Extended Telegram webhook callback handler that integrates agent proposal callbacks.
 * Inject into handleTelegramWebhook BEFORE the legacy command handler.
 */
async function handleTelegramWebhookAgentCallbacks(env, callbackQuery) {
  const data = String(callbackQuery && callbackQuery.data || '');
  const chatId = String(callbackQuery && callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id || '');
  const fromId = String(callbackQuery && callbackQuery.from && callbackQuery.from.id || '');
  const callbackQueryId = String(callbackQuery && callbackQuery.id || '');

  if (!data) return false;

  // Agent proposal callbacks
  if (data.startsWith('agent_')) {
    if (data.startsWith('agent_confirm_reminder:')) {
      try { await telegramApi(env, 'answerCallbackQuery', { callback_query_id: callbackQueryId }); } catch (_) {}
      await handleAgentReminderTimeCallback(env, callbackQuery, data, chatId, fromId);
      return true;
    }
    if (data.startsWith('agent_reschedule_confirm:')) {
      try { await telegramApi(env, 'answerCallbackQuery', { callback_query_id: callbackQueryId }); } catch (_) {}
      const proposalId = data.split(':')[1];
      await handleAgentRescheduleConfirmCallback(env, proposalId, fromId, chatId);
      return true;
    }
    if (data.startsWith('agent_resource_')) {
      try { await telegramApi(env, 'answerCallbackQuery', { callback_query_id: callbackQueryId }); } catch (_) {}
      const parts = data.split(':');
      const actionPart = parts[0].replace('agent_resource_', '');
      const intakeId = parts[1] || '';
      await handleAgentResourceCallbackAction(env, actionPart, intakeId, fromId, chatId);
      return true;
    }
    return await handleAgentProposalCallback(env, callbackQuery);
  }

  return false;
}

/**
 * GET /agent/proposals — list proposals for a user.
 */
async function handleAgentProposalsListApi(request, env) {
  const url = new URL(request.url);
  const body = await readJsonBodySafe(request);
  const userId = readRequestUserIdFromUrlBodyOrHeader(url, body, request);
  if (!userId) return buildMissingUserIdJsonResponse('/agent/proposals');
  const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
  const status = url.searchParams.get('status') || null;
  try {
    await ensureAgentIntakeSchema(env);
    const query = status
      ? `SELECT * FROM agent_proposals WHERE user_id=? AND status=? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM agent_proposals WHERE user_id=? ORDER BY created_at DESC LIMIT ?`;
    const rows = status
      ? await env.DB.prepare(query).bind(String(userId), status, limit).all()
      : await env.DB.prepare(query).bind(String(userId), limit).all();
    return jsonResponse({ ok: true, items: (rows.results || []).map(parseAgentProposalRow), build: getClientAppBuildLabel() });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error), build: getClientAppBuildLabel() }, { status: 500 });
  }
}

/**
 * Schema migration entry point for all new stage tables.
 * Called from ensureTasksSchema (or independently).
 */
async function ensureAgentPipelineSchema(env) {
  await ensureAgentIntakeSchema(env);
  await ensureHubRecordsSchema(env);
  await ensureAgentAuditSchema(env);
  await ensureAgentSettingsSchema(env);
}

// ============================================================
// END STAGE 349
// ============================================================
