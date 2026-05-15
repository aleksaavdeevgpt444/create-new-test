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
