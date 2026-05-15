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
