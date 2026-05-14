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
