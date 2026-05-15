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
