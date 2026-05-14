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
// SECTION 1 — Table existence (44 tables, 1 optional)
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
//   hub_records (optional)
//
// SECTION 2 — Schema column presence (13 tables, 37 columns)
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

  if (command === '/qa_check') {
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
