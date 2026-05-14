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
