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

  if (text === '/wb_today')                    { await handleWbTodayCommand_(env, chatId, userId);       return true; }
  if (text === '/wb_run')                      { await handleWbRunCommand_(env, chatId, userId);         return true; }
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
