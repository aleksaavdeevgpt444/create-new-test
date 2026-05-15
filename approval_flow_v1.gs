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
