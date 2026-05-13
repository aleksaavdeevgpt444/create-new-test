// ============================================================
// STAGE 339 — Agent Context Final + Classification Fix
// Build: планнер_этап339_agent-context-classification-final_v1
// Base worker: планнер_этап338_agent-calendar-free-window-fallback_v1
//
// Closes: I1 (Planning context final), I6 (Classification strict),
//         I7 (Task proposal 3 slots), I9 (Meetings conflict fix),
//         I10 (Reminders remind_at fix)
//
// HOW TO APPLY TO MAIN WORKER
// ─────────────────────────────────────────────────────────────
//
// 1. ADD helper functions (isCurrentMinuteInTz_, isSlotInPast_,
//    filterPastSlots_, fetchAgentSlotsWithTodayFallback_) anywhere
//    before handleAgentTaskProposal.
//
// 2. REPLACE normalizeClassificationResult (line ~7176) with the
//    version below.
//
// 3. REPLACE classifyAgentMessage (line ~7099) with the version below.
//
// 4. REPLACE handleAgentTaskProposal (line ~7339) with the version below.
//
// 5. REPLACE handleAgentMeetingProposal (line ~7608) with the version below.
//
// 6. REPLACE handleAgentReminderTimeCallback (line ~7770) with the
//    version below.
//
// ── What changes ─────────────────────────────────────────────
//
// I6 — Classification strict JSON:
//   • normalizeClassificationResult: remaps importance='critical' → 'high'
//     and urgency='someday' → 'next_week'. Neither value should reach
//     downstream logic.
//   • classifyAgentMessage: removes 'critical' and 'someday' from LLM
//     schema enums and system prompt so the model never emits them.
//
// I1 — Agent Planning Context Final:
//   • isSlotInPast_ / filterPastSlots_: slot is past when its end_time
//     is before the current local time on today's date (or the date
//     itself is before today). Past slots are never proposed.
//   • fetchAgentSlotsWithTodayFallback_: when urgency='today'|'now',
//     queries today first; if no usable slots survive the past-time
//     filter (or local time is past 17:00), automatically expands the
//     search to tomorrow and merges results, flagging expanded=true.
//
// I7 — Task proposal 3 slots:
//   • handleAgentTaskProposal now picks up to 3 slots (was 2).
//   • Past slots are removed before building the message.
//
// I9 — Meetings conflict check:
//   • Original code checked context.blocks (day planning blocks) for
//     conflicts — that is wrong: day blocks are not scheduled tasks.
//   • New code checks context.busy_intervals which contains actually
//     scheduled tasks in the requested time window.
//
// I10 — Reminders remind_at:
//   • handleAgentReminderTimeCallback now includes remind_at in the
//     task payload so buildAgentTaskInputFromPayload_ sets due_at=null
//     and remind_at=<chosen ISO time>, matching the data model.
// ============================================================

const APP_BUILD_STAGE_339 = "планнер_этап339_agent-context-classification-final_v1";

// ── I1: Past-time helpers ────────────────────────────────────

/**
 * Return the current local time as total minutes from midnight,
 * using the planner timezone (Europe/Warsaw default).
 */
function isCurrentMinuteInTz_(env) {
  const tz = (env && getPlannerTimezone_(env)) || 'Europe/Warsaw';
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz,
    }).formatToParts(now);
    const h = Number((parts.find(p => p.type === 'hour') || {}).value || 0);
    const m = Number((parts.find(p => p.type === 'minute') || {}).value || 0);
    return h * 60 + m;
  } catch (_) {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/**
 * Return true if the slot has already ended relative to the current
 * local time. Slots on future dates are never past; slots on past
 * dates are always past.
 *
 * @param {{ date: string, end_time?: string, start_time?: string }} slot
 * @param {*} env
 * @param {string} todayYmd  e.g. '2025-05-13'
 */
function isSlotInPast_(slot, env, todayYmd) {
  if (!slot || !slot.date) return false;
  if (slot.date > todayYmd) return false;
  if (slot.date < todayYmd) return true;
  // Same day — compare current minute with slot end
  const endMin = agentClockToMinutes_(slot.end_time || slot.start_time || '00:00');
  if (!Number.isFinite(endMin)) return false;
  return isCurrentMinuteInTz_(env) >= endMin;
}

/**
 * Remove slots that lie in the past.
 */
function filterPastSlots_(slots, env, todayYmd) {
  if (!Array.isArray(slots)) return [];
  return slots.filter(s => !isSlotInPast_(s, env, todayYmd));
}

/**
 * I1 core: fetch planning context for the given urgency, filter past
 * slots, and — when urgency is 'today' or 'now' and no usable slots
 * survive (or local time is past 17:00) — expand to tomorrow.
 *
 * Returns the context enriched with:
 *   expanded_to_tomorrow: boolean
 *   past_slots_removed:   number
 */
async function fetchAgentSlotsWithTodayFallback_(env, {
  userId,
  urgency,
  taskType,
  durationMin,
  importance,
  todayYmd,
}) {
  const today = todayYmd || getTelegramTodayYmd(getPlannerTimezone_(env));

  // Fetch the base context via the existing internal function
  const base = await fetchAgentPlanningContextInternal(env, {
    userId, urgency, taskType, durationMin, importance, todayYmd: today,
  });

  // Filter past slots
  const bestRaw = (base && base.best_slots) || [];
  const fallbackRaw = (base && base.fallback_slots) || [];
  const best = filterPastSlots_(bestRaw, env, today);
  const fallback = filterPastSlots_(fallbackRaw, env, today);
  const pastRemoved = (bestRaw.length - best.length) + (fallbackRaw.length - fallback.length);

  // Decide whether to expand to tomorrow
  const noUsableSlots = best.length === 0 && fallback.length === 0;
  const lateInWorkday = isCurrentMinuteInTz_(env) >= 17 * 60; // after 17:00 local
  const shouldExpand = (urgency === 'today' || urgency === 'now') && (noUsableSlots || lateInWorkday);

  if (shouldExpand) {
    const tomorrow = addDaysToServerYmd(today, 1);
    const ext = await fetchAgentPlanningContextInternal(env, {
      userId, urgency: 'next_2_days', taskType, durationMin, importance, todayYmd: today,
    });
    // Prefer tomorrow slots (they are already future, no past-filter needed)
    const extBest = filterPastSlots_((ext && ext.best_slots) || [], env, today);
    const extFallback = filterPastSlots_((ext && ext.fallback_slots) || [], env, today);
    // Merge: today's surviving + tomorrow's slots, deduped by date+start
    const seen = new Set();
    const mergedBest = [...best, ...extBest].filter(s => {
      const k = s.date + '|' + s.start_time;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const seenFb = new Set(mergedBest.map(s => s.date + '|' + s.start_time));
    const mergedFallback = [...fallback, ...extFallback].filter(s => {
      const k = s.date + '|' + s.start_time;
      if (seenFb.has(k)) return false;
      seenFb.add(k);
      return true;
    });
    return {
      ...(ext || base || {}),
      best_slots: mergedBest,
      fallback_slots: mergedFallback,
      expanded_to_tomorrow: true,
      expanded_reason: noUsableSlots ? 'no_slots_today' : 'late_in_workday',
      past_slots_removed: pastRemoved,
    };
  }

  return {
    ...(base || {}),
    best_slots: best,
    fallback_slots: fallback,
    expanded_to_tomorrow: false,
    past_slots_removed: pastRemoved,
  };
}

// ── I6: Patched normalizeClassificationResult ─────────────────
//
// Replace the original at line ~7176.
// Remaps forbidden values that must not reach downstream logic:
//   importance='critical' → 'high'
//   urgency='someday'     → 'next_week'

function normalizeClassificationResult(raw) {
  const importanceRaw = String(raw.importance || 'medium');
  const urgencyRaw = String(raw.urgency || 'this_week');

  // Strip forbidden values
  const importance = importanceRaw === 'critical' ? 'high' : importanceRaw;
  const urgency = urgencyRaw === 'someday' ? 'next_week' : urgencyRaw;

  return {
    detected_type: String(raw.detected_type || 'unknown'),
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
    summary: String(raw.summary || '').slice(0, 500),
    project: String(raw.project || ''),
    task_type: String(raw.task_type || ''),
    importance,
    urgency,
    estimated_duration_min: typeof raw.estimated_duration_min === 'number' ? raw.estimated_duration_min : 30,
    date: raw.date ? String(raw.date) : null,
    time: raw.time ? String(raw.time) : null,
    needs_clarification: !!raw.needs_clarification,
    clarification_question: raw.clarification_question ? String(raw.clarification_question) : null,
    suggested_next_action: String(raw.suggested_next_action || 'request_clarification'),
  };
}

// ── I6: Patched classifyAgentMessage ─────────────────────────
//
// Replace the original at line ~7099.
// Changes:
//   • importance enum: removed 'critical'
//   • urgency enum: removed 'someday'
//   • System prompt: removed 'critical' and 'someday' from examples

async function classifyAgentMessage(env, text, options = {}) {
  const safeText = String(text || '').trim().slice(0, 2000);
  if (!safeText) throw new Error('text is required for classification');

  const schema = {
    type: 'object',
    properties: {
      detected_type: {
        type: 'string',
        enum: ['task', 'meeting', 'insight', 'idea', 'question', 'reminder', 'resource', 'project_context', 'unknown'],
      },
      confidence: { type: 'number' },
      summary: { type: 'string' },
      project: { type: 'string' },
      task_type: { type: 'string' },
      importance: {
        type: 'string',
        // 'critical' removed — always use 'high' for urgent/critical work
        enum: ['low', 'medium', 'high', ''],
      },
      urgency: {
        type: 'string',
        // 'someday' removed — use 'next_week' for indefinite future
        enum: ['now', 'today', 'next_2_days', 'this_week', 'next_week', ''],
      },
      estimated_duration_min: { type: 'number' },
      date: { type: 'string' },
      time: { type: 'string' },
      needs_clarification: { type: 'boolean' },
      clarification_question: { type: 'string' },
      suggested_next_action: { type: 'string' },
    },
    required: ['detected_type', 'confidence', 'summary', 'needs_clarification'],
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

Для задачи определи:
  project, task_type,
  importance: low | medium | high  (не используй critical — любая срочная работа это high),
  urgency: now | today | next_2_days | this_week | next_week  (не используй someday),
  estimated_duration_min.
Для встречи определи: date (YYYY-MM-DD), time (HH:MM), estimated_duration_min.
Если нужна уточняющая информация — установи needs_clarification=true и задай вопрос в clarification_question.

Верни ТОЛЬКО валидный JSON без markdown-блоков.`;

  let result = null;
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await callPlannerJsonWithSchema(env, {
        operation: 'agent-classify',
        user_id: options.userId || null,
        prompt: `${systemPrompt}\n\nСообщение пользователя:\n${safeText}`,
        schema,
        temperature: 0.1,
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep_(500);
    }
  }

  if (!result) {
    if (lastError && lastError.raw_text) {
      const repaired = tryRepairAgentJson(lastError.raw_text);
      if (repaired && repaired.detected_type) return normalizeClassificationResult(repaired);
    }
    return classifyAgentMessageLocal(safeText);
  }

  return normalizeClassificationResult(result);
}

// ── I7: Patched handleAgentTaskProposal ──────────────────────
//
// Replace the original at line ~7339.
// Changes:
//   • Uses fetchAgentSlotsWithTodayFallback_ instead of
//     fetchAgentPlanningContextInternal — adds past-time filter and
//     today→tomorrow expansion for urgency=today|now.
//   • Picks up to 3 slots (was 2).
//   • Removes 'critical' from importanceLabel map.
//   • Shows 'расширено на завтра' notice when expanded=true.

async function handleAgentTaskProposal(env, { userId, chatId, messageId, text, classification, intakeId, updateId }) {
  try {
    const todayYmd = getTelegramTodayYmd(getPlannerTimezone_(env));

    const context = await fetchAgentSlotsWithTodayFallback_(env, {
      userId,
      urgency: classification.urgency || 'this_week',
      taskType: classification.task_type || '',
      durationMin: classification.estimated_duration_min || 30,
      importance: classification.importance || 'medium',
      todayYmd,
    });

    const bestSlots = (context && context.best_slots) || [];
    const fallbackSlots = (context && context.fallback_slots) || [];
    const reschedCandidates = (context && context.reschedule_candidates) || [];

    // Collect up to 3 confirmed slots
    const allSlots = [...bestSlots, ...fallbackSlots].slice(0, 3);
    if (reschedCandidates.length > 0 && allSlots.length < 3) {
      allSlots.push({ ...reschedCandidates[0], reschedule_candidate: true });
    }

    const importanceLabel = {
      low: 'низкая',
      medium: 'средняя',
      high: 'высокая',
    }[classification.importance] || 'средняя';

    const urgencyLabel = {
      now: 'сейчас',
      today: 'сегодня',
      next_2_days: '2 дня',
      this_week: 'эта неделя',
      next_week: 'следующая неделя',
    }[classification.urgency] || 'эта неделя';

    const proposal = buildAgentProposalObject({
      userId,
      source: 'telegram_agent',
      messageId,
      detectedType: AGENT_MESSAGE_TYPES.TASK,
      confidence: classification.confidence,
      summary: classification.summary || text.slice(0, 200),
      requiresConfirmation: true,
      suggestedActions: ['create_task'],
    });
    proposal.telegram_update_id = updateId ? Number(updateId) : null;
    proposal.classification_json = classification;
    proposal.slots_json = allSlots;
    proposal.status = AGENT_PROPOSAL_STATUSES.WAITING_CONFIRMATION;

    await ensureAgentIntakeSchema(env);
    await upsertAgentProposal(env, proposal);
    await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.WAITING_CONFIRMATION, { proposal_json: proposal });

    let msg = `Похоже, это задача.\n\n`;
    msg += `📝 *${escapeMarkdown(classification.summary || text.slice(0, 200))}*\n`;
    if (classification.project) msg += `Проект: ${escapeMarkdown(classification.project)}\n`;
    if (classification.task_type) msg += `Тип: ${escapeMarkdown(classification.task_type)}\n`;
    msg += `Важность: ${importanceLabel}\n`;
    msg += `Срочность: ${urgencyLabel}\n`;
    msg += `Длительность: ${classification.estimated_duration_min || 30} мин\n`;

    if (context && context.expanded_to_tomorrow) {
      msg += `\n_(На сегодня слотов нет — показываю варианты на завтра)_\n`;
    }

    if (allSlots.length > 0) {
      msg += `\nПредлагаю варианты:\n`;
      allSlots.forEach((slot, i) => {
        msg += `${i + 1}. ${formatSlotOption(slot, i, classification)}\n`;
      });
    } else {
      msg += `\nСвободных слотов не найдено — создать задачу в Inbox?\n`;
    }

    const slotButtons = allSlots.map((_, i) => ({
      text: `Вариант ${i + 1}`,
      callback_data: `agent_confirm_slot:${proposal.id}:${i}`,
    }));
    if (slotButtons.length === 0) {
      slotButtons.push({ text: '✅ Создать', callback_data: `agent_confirm_slot:${proposal.id}:0` });
    }

    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: msg,
      parse_mode: 'Markdown',
      reply_to_message_id: Number(messageId),
      reply_markup: {
        inline_keyboard: [
          slotButtons,
          [
            { text: '✏️ Изменить', callback_data: `agent_edit:${proposal.id}` },
            { text: '❌ Отмена', callback_data: `agent_cancel:${proposal.id}` },
          ],
        ],
      },
    });

    await logAgentAuditEvent(env, {
      user_id: userId,
      telegram_message_id: messageId,
      proposal_id: proposal.id,
      event_type: 'proposal_created',
      status: 'success',
      payload_json: {
        proposal_id: proposal.id,
        detected_type: AGENT_MESSAGE_TYPES.TASK,
        slots: allSlots.length,
        expanded_to_tomorrow: !!(context && context.expanded_to_tomorrow),
        past_slots_removed: (context && context.past_slots_removed) || 0,
      },
    });

  } catch (error) {
    console.error('[handleAgentTaskProposal]', String(error));
    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Не удалось подготовить предложение. Попробуй ещё раз.',
      reply_to_message_id: Number(messageId),
    });
  }
}

// ── I9: Patched handleAgentMeetingProposal ───────────────────
//
// Replace the original at line ~7608.
// Bug fixed: original checked context.blocks (day planning blocks)
// for conflict detection. Correct check is against context.busy_intervals
// which holds actually scheduled tasks in the requested window.

async function handleAgentMeetingProposal(env, { userId, chatId, messageId, text, classification, intakeId, updateId }) {
  try {
    const missingFields = [];
    if (!classification.date) missingFields.push('дата');
    if (!classification.time) missingFields.push('время');

    if (missingFields.length > 0) {
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: `Понял — встреча. Уточни: ${missingFields.join(' и ')}?`,
        reply_to_message_id: Number(messageId),
      });
      await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.WAITING_CONFIRMATION, { classification_json: classification });
      return;
    }

    const durationMin = classification.estimated_duration_min || 30;
    const meetingDate = classification.date;
    const meetingTime = classification.time;

    // Fetch context to check for conflicts via busy_intervals (not day blocks)
    const context = await fetchAgentPlanningContextInternal(env, {
      userId,
      urgency: 'today',
      taskType: 'meeting',
      durationMin,
      importance: classification.importance || 'medium',
      todayYmd: meetingDate,
    });

    // I9 fix: check busy_intervals (scheduled tasks) not blocks (day blocks)
    const busyIntervals = (context && context.busy_intervals) || [];
    const reqStartMin = agentClockToMinutes_(meetingTime);
    const reqEndMin = reqStartMin + durationMin;
    const hasConflict = busyIntervals.some(b => {
      if (!b.date || b.date !== meetingDate) return false;
      const bStart = typeof b.start_min === 'number' ? b.start_min : agentClockToMinutes_(b.start_time);
      const bEnd = typeof b.end_min === 'number' ? b.end_min : agentClockToMinutes_(b.end_time || b.start_time);
      return reqStartMin < bEnd && reqEndMin > bStart;
    });

    const proposal = buildAgentProposalObject({
      userId,
      source: 'telegram_agent',
      messageId,
      detectedType: AGENT_MESSAGE_TYPES.MEETING,
      confidence: classification.confidence,
      summary: classification.summary || text.slice(0, 200),
      requiresConfirmation: true,
      suggestedActions: ['create_meeting'],
    });
    proposal.telegram_update_id = updateId ? Number(updateId) : null;
    proposal.classification_json = classification;
    proposal.status = AGENT_PROPOSAL_STATUSES.WAITING_CONFIRMATION;

    await ensureAgentIntakeSchema(env);
    await upsertAgentProposal(env, proposal);
    await updateTelegramIncomingMessageStatus(env, intakeId, AGENT_INTAKE_STATUSES.WAITING_CONFIRMATION, { proposal_json: proposal });

    let msg = `📅 Встреча\n\n*${escapeMarkdown(classification.summary || text.slice(0, 200))}*\n`;
    msg += `Дата: ${meetingDate}\nВремя: ${meetingTime}\nДлительность: ${durationMin} мин\n`;
    if (hasConflict) {
      const conflictingTask = busyIntervals.find(b => b.date === meetingDate);
      const conflictTitle = conflictingTask ? ` ("${escapeMarkdown(String(conflictingTask.title || conflictingTask.busy_title || 'другое событие'))}")` : '';
      msg += `\n⚠️ В это время уже есть задача${conflictTitle}. Всё равно создать?\n`;
    } else {
      msg += `\nСоздать встречу?\n`;
    }

    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: msg,
      parse_mode: 'Markdown',
      reply_to_message_id: Number(messageId),
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Создать', callback_data: `agent_confirm_slot:${proposal.id}:0` },
          { text: '❌ Отмена', callback_data: `agent_cancel:${proposal.id}` },
        ]],
      },
    });
  } catch (error) {
    console.error('[handleAgentMeetingProposal]', String(error));
    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Не удалось обработать встречу.',
      reply_to_message_id: Number(messageId),
    });
  }
}

// ── I10: Patched handleAgentReminderTimeCallback ──────────────
//
// Replace the original at line ~7770.
// Fix: adds remind_at to the task payload so that
// buildAgentTaskInputFromPayload_ sets due_at=null and
// remind_at=<chosen ISO datetime>, matching the task data model.

async function handleAgentReminderTimeCallback(env, callbackQuery, data, chatId, fromId) {
  // data format: agent_confirm_reminder:<proposal_id>:<date>:<HH>:<MM>
  const parts = data.split(':');
  const proposalId = parts[1];
  const date = parts[2];
  // Reassemble time from parts[3] and parts[4]
  const time = (parts[3] || '09') + ':' + (parts[4] || '00');

  const proposal = await getAgentProposalById(env, proposalId);
  if (!proposal) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Предложение не найдено.' });
    return;
  }
  if (isAgentProposalExpired(proposal)) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Предложение устарело. Отправь сообщение заново.' });
    return;
  }

  const classification = proposal.classification || {};
  const confirmationId = await generateAgentConfirmationId(
    fromId,
    proposal.message_id || proposalId,
    'create_reminder',
    { proposal_id: proposalId, date, time },
  );

  // I10 fix: pass remind_at so buildAgentTaskInputFromPayload_ sets
  // due_at=null and remind_at=<ISO> (per task data model for reminders)
  const remindAtIso = date + 'T' + time + ':00';

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
      remind_at: remindAtIso,
      duration_min: 10,
    },
  };

  try {
    const fakeRequest = new Request('https://internal/agent/reminders/create-confirmed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reminderPayload),
    });
    const response = await handleAgentReminderCreateConfirmedApi(fakeRequest, env);
    const result = await response.json();

    if (result.ok) {
      await env.DB.prepare(`UPDATE agent_proposals SET status=?, updated_at=? WHERE id=?`)
        .bind(AGENT_PROPOSAL_STATUSES.APPLIED, new Date().toISOString(), proposalId).run();
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: `✅ Напоминание создано на ${date} в ${time}.`,
      });
    } else {
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: `❌ Ошибка: ${result.error || 'неизвестная ошибка'}.`,
      });
    }
  } catch (error) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '❌ Не удалось создать напоминание.' });
    console.error('[handleAgentReminderTimeCallback]', String(error));
  }
}

// ============================================================
// END STAGE 339
// ============================================================
