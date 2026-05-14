-- ============================================================
-- schema.sql — Cloudflare D1 full database schema
-- Project: ИИ агенты-помощники (ai-agents-worker)
--
-- Usage (fresh database):
--   wrangler d1 execute ai-agents-db --file=schema.sql
--   wrangler d1 execute ai-agents-db --file=schema.sql --env staging
--
-- This file is the single source of truth for all table definitions.
-- It merges all CREATE TABLE + ALTER TABLE patches into the final column set.
-- Safe to re-run (all statements use IF NOT EXISTS / IF NOT EXISTS).
--
-- Table count: 40 tables across 12 modules
-- ── Sections ─────────────────────────────────────────────────
-- §1  Agent Extension (stage336_349)         4 tables
-- §2  WB Operations Stage 1                 10 tables
-- §3  WB Operations Stage 2 + Patch          6 tables
-- §4  CS Operations Stage 1                  5 tables
-- §5  CS Operations Stage 2                  2 tables
-- §6  Approval Flow                          1 table
-- §7  Handoff Events                         1 table
-- §8  Scheduler                              2 tables
-- §9  Design Chief                           3 tables
-- §10 ROP Chief                              3 tables
-- §11 Fulfillment Chief                      3 tables
-- ============================================================

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ============================================================
-- §1 — Agent Extension (stage336_349_agent_extension.gs)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_incoming_messages (
  id                  TEXT PRIMARY KEY,
  telegram_update_id  INTEGER UNIQUE,
  telegram_user_id    TEXT NOT NULL,
  planner_user_id     TEXT,
  message_id          TEXT,
  chat_id             TEXT,
  text                TEXT,
  received_at         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'received',
  classification_json TEXT,
  proposal_json       TEXT,
  error               TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_incoming_user
  ON agent_incoming_messages(planner_user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_incoming_update
  ON agent_incoming_messages(telegram_update_id);

CREATE TABLE IF NOT EXISTS agent_proposals (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,
  source                 TEXT NOT NULL DEFAULT 'telegram_agent',
  telegram_message_id    TEXT,
  telegram_chat_id       TEXT,
  incoming_message_id    TEXT,
  detected_type          TEXT,
  confidence             REAL,
  summary                TEXT,
  requires_confirmation  INTEGER DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'draft',
  suggested_actions_json TEXT,
  classification_json    TEXT,
  planning_context_json  TEXT,
  slots_json             TEXT,
  selected_slot          INTEGER,
  confirmation_id        TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  expires_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_proposals_user
  ON agent_proposals(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_proposals_status
  ON agent_proposals(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_settings (
  user_id                        TEXT PRIMARY KEY,
  agent_enabled                  INTEGER DEFAULT 1,
  default_space                  TEXT DEFAULT 'work',
  default_task_duration_min      INTEGER DEFAULT 30,
  confirm_tasks                  INTEGER DEFAULT 1,
  confirm_meetings               INTEGER DEFAULT 1,
  confirm_reminders              INTEGER DEFAULT 1,
  auto_save_insights             INTEGER DEFAULT 1,
  auto_save_ideas                INTEGER DEFAULT 1,
  weekly_insights_enabled        INTEGER DEFAULT 1,
  weekly_insights_day            TEXT DEFAULT 'Thursday',
  weekly_insights_time           TEXT DEFAULT '10:00',
  allowed_task_types             TEXT,
  telegram_notifications_enabled INTEGER DEFAULT 1,
  chat_id                        TEXT,
  updated_at                     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_audit_log (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  telegram_message_id TEXT,
  proposal_id         TEXT,
  confirmation_id     TEXT,
  event_type          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'ok',
  payload_json        TEXT,
  result_json         TEXT,
  error_message       TEXT,
  model               TEXT,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  cost_estimate       REAL,
  latency_ms          INTEGER,
  build               TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_user
  ON agent_audit_log(user_id, created_at DESC);

-- ============================================================
-- §2 — WB Operations Stage 1 (wb_operations_stage1_v1.gs)
-- ============================================================

CREATE TABLE IF NOT EXISTS wb_daily_snapshot (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  date                    TEXT NOT NULL,
  marketplace             TEXT NOT NULL DEFAULT 'WB',
  total_orders            INTEGER,
  total_sales_rub         REAL,
  total_returns           INTEGER,
  total_ad_spend          REAL,
  total_profit_before_ads REAL,
  total_profit_after_ads  REAL,
  sku_count               INTEGER,
  risk_sku_count          INTEGER,
  source_status           TEXT NOT NULL DEFAULT 'missing',
  missing_sources         TEXT,
  created_at              TEXT NOT NULL,
  UNIQUE(date, marketplace)
);

CREATE TABLE IF NOT EXISTS wb_sku_snapshot (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  date                  TEXT NOT NULL,
  marketplace           TEXT NOT NULL DEFAULT 'WB',
  nm_id                 TEXT NOT NULL,
  vendor_code           TEXT,
  title                 TEXT,
  brand                 TEXT,
  subject               TEXT,
  orders_count          INTEGER,
  sales_rub             REAL,
  returns_count         INTEGER,
  stock_total           INTEGER,
  days_of_stock         REAL,
  ad_spend              REAL,
  drr                   REAL,
  ctr                   REAL,
  cpc                   REAL,
  cr_to_cart            REAL,
  profit_before_ads     REAL,
  profit_after_ads      REAL,
  margin_pct_after_ads  REAL,
  sku_status            TEXT NOT NULL DEFAULT 'unknown',
  missing_fields        TEXT,
  source_status         TEXT NOT NULL DEFAULT 'missing',
  updated_at            TEXT NOT NULL,
  UNIQUE(date, marketplace, nm_id)
);

CREATE INDEX IF NOT EXISTS idx_wb_sku_date
  ON wb_sku_snapshot(date, marketplace);

CREATE TABLE IF NOT EXISTS wb_ads_snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT NOT NULL,
  nm_id         TEXT NOT NULL,
  campaign_id   TEXT NOT NULL DEFAULT '',
  campaign_name TEXT,
  ad_spend      REAL,
  ad_orders     INTEGER,
  ad_sales      REAL,
  impressions   INTEGER,
  clicks        INTEGER,
  ctr           REAL,
  cpc           REAL,
  cpm           REAL,
  cr            REAL,
  drr           REAL,
  ads_status    TEXT NOT NULL DEFAULT 'unknown',
  reason        TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE(date, nm_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_wb_ads_date
  ON wb_ads_snapshot(date, nm_id);

CREATE TABLE IF NOT EXISTS wb_finance_snapshot (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  date                  TEXT NOT NULL,
  nm_id                 TEXT NOT NULL,
  actual_order_price    REAL,
  buyer_price           REAL,
  cost_per_unit         REAL,
  commission_rub        REAL,
  logistics_rub         REAL,
  storage_rub           REAL,
  tax_rub               REAL,
  ad_spend_per_order    REAL,
  profit_before_ads     REAL,
  profit_after_ads      REAL,
  margin_pct_before_ads REAL,
  margin_pct_after_ads  REAL,
  finance_status        TEXT NOT NULL DEFAULT 'unknown',
  missing_fields        TEXT,
  updated_at            TEXT NOT NULL,
  UNIQUE(date, nm_id)
);

CREATE INDEX IF NOT EXISTS idx_wb_finance_date
  ON wb_finance_snapshot(date, nm_id);

CREATE TABLE IF NOT EXISTS wb_stock_snapshot (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  date                  TEXT NOT NULL,
  nm_id                 TEXT NOT NULL,
  stock_total           INTEGER,
  avg_daily_orders_7d   REAL,
  avg_daily_orders_14d  REAL,
  days_of_stock         REAL,
  stock_status          TEXT NOT NULL DEFAULT 'unknown',
  recommended_supply_qty INTEGER,
  reason                TEXT,
  updated_at            TEXT NOT NULL,
  UNIQUE(date, nm_id)
);

CREATE INDEX IF NOT EXISTS idx_wb_stock_date
  ON wb_stock_snapshot(date, nm_id);

CREATE TABLE IF NOT EXISTS wb_agent_report (
  id                  TEXT PRIMARY KEY,
  date                TEXT NOT NULL,
  chief               TEXT NOT NULL DEFAULT 'wb_operations_chief',
  summary             TEXT,
  source_status       TEXT NOT NULL DEFAULT 'missing',
  critical_issues     TEXT,
  sku_risks           TEXT,
  ads_risks           TEXT,
  finance_risks       TEXT,
  stock_risks         TEXT,
  recommended_actions TEXT,
  proposals           TEXT,
  needs_rop_attention TEXT,
  missing_sources     TEXT,
  generated_at        TEXT NOT NULL,
  UNIQUE(date, chief)
);

CREATE TABLE IF NOT EXISTS wb_agent_alerts (
  id                 TEXT PRIMARY KEY,
  date               TEXT NOT NULL,
  alert_type         TEXT NOT NULL,
  nm_id              TEXT,
  risk_level         TEXT NOT NULL,
  message            TEXT NOT NULL,
  recommended_action TEXT,
  sent_to_telegram   INTEGER DEFAULT 0,
  idempotency_key    TEXT UNIQUE,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wb_alerts_date
  ON wb_agent_alerts(date, alert_type);

CREATE TABLE IF NOT EXISTS wb_agent_proposals (
  id                    TEXT PRIMARY KEY,
  date                  TEXT NOT NULL,
  source_agent          TEXT NOT NULL DEFAULT 'wb_operations_chief',
  action_type           TEXT NOT NULL,
  title                 TEXT NOT NULL,
  reason                TEXT,
  priority              TEXT NOT NULL DEFAULT 'medium',
  requires_confirmation INTEGER DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'waiting_confirmation',
  confirmation_id       TEXT UNIQUE,
  telegram_chat_id      TEXT,
  telegram_message_id   TEXT,
  payload_json          TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wb_proposals_date
  ON wb_agent_proposals(date, status);

CREATE TABLE IF NOT EXISTS wb_action_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT,
  source_agent TEXT NOT NULL DEFAULT 'wb_operations_chief',
  subagent     TEXT,
  event_type   TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  status       TEXT NOT NULL DEFAULT 'success',
  payload_json TEXT,
  result_json  TEXT,
  error_message TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wb_action_log_date
  ON wb_action_log(created_at DESC);

CREATE TABLE IF NOT EXISTS wb_cost_data (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  nm_id                TEXT NOT NULL,
  effective_date       TEXT NOT NULL,
  cost_per_unit        REAL,
  commission_pct       REAL,
  logistics_rub        REAL,
  storage_per_day_rub  REAL,
  tax_pct              REAL,
  notes                TEXT,
  updated_at           TEXT NOT NULL,
  UNIQUE(nm_id, effective_date)
);

-- ============================================================
-- §3 — WB Operations Stage 2 + Patch
--      (wb_operations_stage2_v1.gs + wb_operations_stage2_patch.gs)
--      Columns from ALTER TABLE patches are pre-merged here.
-- ============================================================

CREATE TABLE IF NOT EXISTS wb_stock_snapshot_v2 (
  id                      TEXT PRIMARY KEY,
  date                    TEXT NOT NULL,
  nm_id                   INTEGER NOT NULL,
  sku_title               TEXT,
  vendor_code             TEXT,                          -- patch
  user_id                 TEXT,
  stock_total             INTEGER DEFAULT 0,
  stock_by_warehouse_json TEXT DEFAULT '{}',
  stock_in_transit        INTEGER DEFAULT 0,
  stock_reserved          INTEGER DEFAULT 0,
  avg_daily_orders_7d     REAL DEFAULT 0,
  avg_daily_orders_14d    REAL DEFAULT 0,                -- patch
  avg_daily_orders_30d    REAL DEFAULT 0,
  days_of_stock           REAL DEFAULT 0,
  target_days_of_stock    INTEGER DEFAULT 30,            -- patch
  safety_days             INTEGER DEFAULT 5,             -- patch
  safety_stock_qty        INTEGER DEFAULT 0,
  recommended_supply_qty  INTEGER DEFAULT 0,
  latest_supply_date      TEXT,
  stock_status            TEXT DEFAULT 'unknown',
  risk_level              TEXT DEFAULT 'unknown',        -- patch
  reason                  TEXT,                          -- patch
  stock_risks_json        TEXT DEFAULT '[]',
  missing_fields_json     TEXT DEFAULT '[]',             -- patch
  source_status           TEXT DEFAULT 'missing',
  payload_json            TEXT DEFAULT '{}',
  created_at              TEXT DEFAULT (datetime('now')),
  updated_at              TEXT DEFAULT (datetime('now')),
  UNIQUE(date, nm_id)
);

CREATE INDEX IF NOT EXISTS idx_wb_stock_v2_date
  ON wb_stock_snapshot_v2(date, nm_id);

CREATE TABLE IF NOT EXISTS wb_procurement_snapshot (
  id                          TEXT PRIMARY KEY,
  date                        TEXT NOT NULL,
  nm_id                       INTEGER NOT NULL,
  sku_title                   TEXT,
  vendor_code                 TEXT,                      -- patch
  user_id                     TEXT,
  avg_daily_orders_30d        REAL DEFAULT 0,
  days_of_stock               REAL DEFAULT 0,
  target_days_of_stock        INTEGER DEFAULT 30,
  safety_days                 INTEGER DEFAULT 5,
  production_days             INTEGER DEFAULT 14,
  delivery_days               INTEGER DEFAULT 7,
  total_lead_days             INTEGER DEFAULT 21,
  fulfillment_preparation_days INTEGER DEFAULT 3,        -- patch
  latest_order_date           TEXT,
  recommended_order_qty       INTEGER DEFAULT 0,
  reserve_qty                 INTEGER DEFAULT 0,         -- patch
  stock_available_for_supply  INTEGER DEFAULT 0,         -- patch
  stock_already_ordered       INTEGER DEFAULT 0,         -- patch
  cost_per_unit               REAL DEFAULT 0,
  estimated_order_cost        REAL DEFAULT 0,
  supplier_id                 TEXT,
  supplier_name               TEXT,
  price_risk                  INTEGER DEFAULT 0,
  procurement_status          TEXT DEFAULT 'unknown',
  procurement_risks_json      TEXT DEFAULT '[]',
  source_status               TEXT DEFAULT 'missing',
  payload_json                TEXT DEFAULT '{}',
  created_at                  TEXT DEFAULT (datetime('now')),
  updated_at                  TEXT DEFAULT (datetime('now')),
  UNIQUE(date, nm_id)
);

CREATE INDEX IF NOT EXISTS idx_wb_procurement_date
  ON wb_procurement_snapshot(date, nm_id);

CREATE TABLE IF NOT EXISTS supplier_directory (
  id                      TEXT PRIMARY KEY,
  supplier_name           TEXT NOT NULL,
  contact_person          TEXT,
  contact_email           TEXT,
  contact_phone           TEXT,
  default_production_days INTEGER DEFAULT 14,
  default_delivery_days   INTEGER DEFAULT 7,
  min_order_qty           INTEGER DEFAULT 1,
  min_order_amount        REAL DEFAULT 0,
  currency                TEXT DEFAULT 'RUB',
  payment_terms           TEXT,
  notes                   TEXT,
  is_active               INTEGER DEFAULT 1,
  created_at              TEXT DEFAULT (datetime('now')),
  updated_at              TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_supplier_directory_name
  ON supplier_directory(supplier_name);

CREATE TABLE IF NOT EXISTS wb_report_consistency_check (
  id           TEXT PRIMARY KEY,
  date         TEXT NOT NULL,
  check_type   TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  status       TEXT DEFAULT 'unknown',
  severity     TEXT DEFAULT 'info',
  details_json TEXT DEFAULT '{}',
  is_blocking  INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(date, check_type, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_wb_consistency_date
  ON wb_report_consistency_check(date, check_type);

-- wb_report_health_summary — patch columns (ready_score, missing_sources_json, recommended_actions_json) pre-merged
CREATE TABLE IF NOT EXISTS wb_report_health_summary (
  id                       TEXT PRIMARY KEY,
  date                     TEXT NOT NULL UNIQUE,
  overall_status           TEXT DEFAULT 'unknown',
  safe_mode                INTEGER DEFAULT 0,
  checks_total             INTEGER DEFAULT 0,
  checks_passed            INTEGER DEFAULT 0,
  checks_warnings          INTEGER DEFAULT 0,
  checks_failed            INTEGER DEFAULT 0,
  ready_score              REAL DEFAULT 0,               -- patch
  blocking_issues_json     TEXT DEFAULT '[]',
  warnings_json            TEXT DEFAULT '[]',
  missing_sources_json     TEXT DEFAULT '[]',            -- patch
  recommended_actions_json TEXT DEFAULT '[]',            -- patch
  summary_text             TEXT DEFAULT '',
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wb_health_summary_date
  ON wb_report_health_summary(date);

-- wb_report_consistency_check_v2 (full version from patch, replaces v1 for new checks)
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
);

CREATE INDEX IF NOT EXISTS idx_wb_consistency_v2_date
  ON wb_report_consistency_check_v2(date, check_type);

-- ============================================================
-- §4 — CS Operations Stage 1 (cs_operations_stage1_v1.gs)
--      Stage 2 ALTER TABLE columns are pre-merged below.
-- ============================================================

-- cs_inbox_item — Stage 2 patch columns pre-merged (marketplace, vendor_code, item_type, customer_name, sentiment, topic, requires_human_review)
CREATE TABLE IF NOT EXISTS cs_inbox_item (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT,
  source               TEXT NOT NULL,
  source_item_id       TEXT,
  nm_id                INTEGER,
  sku_title            TEXT,
  customer_text        TEXT NOT NULL,
  customer_rating      INTEGER,
  item_date            TEXT,
  status               TEXT DEFAULT 'new',
  assigned_to          TEXT,
  priority             TEXT DEFAULT 'normal',
  marketplace          TEXT DEFAULT 'wb',                -- stage2 patch
  vendor_code          TEXT,                             -- stage2 patch
  item_type            TEXT,                             -- stage2 patch
  customer_name        TEXT,                             -- stage2 patch
  sentiment            TEXT DEFAULT 'neutral',           -- stage2 patch
  topic                TEXT,                             -- stage2 patch
  requires_human_review INTEGER DEFAULT 0,               -- stage2 patch
  tags_json            TEXT DEFAULT '[]',
  payload_json         TEXT DEFAULT '{}',
  created_at           TEXT DEFAULT (datetime('now')),
  updated_at           TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cs_inbox_status
  ON cs_inbox_item(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cs_inbox_nm
  ON cs_inbox_item(nm_id, status);

-- cs_draft_response — Stage 2 patch columns pre-merged (source_agent, tone_status, risk_status)
CREATE TABLE IF NOT EXISTS cs_draft_response (
  id               TEXT PRIMARY KEY,
  inbox_item_id    TEXT NOT NULL REFERENCES cs_inbox_item(id),
  user_id          TEXT,
  draft_text       TEXT NOT NULL,
  draft_version    INTEGER DEFAULT 1,
  tone             TEXT DEFAULT 'professional',
  language         TEXT DEFAULT 'ru',
  ai_model_used    TEXT,
  ai_confidence    REAL DEFAULT 0,
  status           TEXT DEFAULT 'pending',
  source_agent     TEXT,                                 -- stage2 patch
  tone_status      TEXT DEFAULT 'pending',               -- stage2 patch
  risk_status      TEXT DEFAULT 'ok',                    -- stage2 patch
  rejection_reason TEXT,
  confirmation_id  TEXT UNIQUE,
  approved_by      TEXT,
  approved_at      TEXT,
  sent_at          TEXT,
  payload_json     TEXT DEFAULT '{}',
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cs_draft_inbox
  ON cs_draft_response(inbox_item_id, status);
CREATE INDEX IF NOT EXISTS idx_cs_draft_status
  ON cs_draft_response(status, created_at DESC);

CREATE TABLE IF NOT EXISTS cs_product_issue (
  id                    TEXT PRIMARY KEY,
  nm_id                 INTEGER NOT NULL,
  sku_title             TEXT,
  user_id               TEXT,
  issue_type            TEXT NOT NULL,
  issue_description     TEXT,
  severity              TEXT DEFAULT 'normal',
  source_inbox_ids_json TEXT DEFAULT '[]',
  occurrence_count      INTEGER DEFAULT 1,
  first_seen_date       TEXT,
  last_seen_date        TEXT,
  status                TEXT DEFAULT 'open',
  resolution_notes      TEXT,
  confirmation_id       TEXT UNIQUE,
  payload_json          TEXT DEFAULT '{}',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(nm_id, issue_type, severity)
);

CREATE TABLE IF NOT EXISTS cs_knowledge_item (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT,
  category              TEXT NOT NULL,
  trigger_keywords_json TEXT DEFAULT '[]',
  template_text         TEXT NOT NULL,
  tone                  TEXT DEFAULT 'professional',
  language              TEXT DEFAULT 'ru',
  usage_count           INTEGER DEFAULT 0,
  last_used_at          TEXT,
  is_active             INTEGER DEFAULT 1,
  tags_json             TEXT DEFAULT '[]',
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cs_feedback_insight (
  id                TEXT PRIMARY KEY,
  date              TEXT NOT NULL,
  nm_id             INTEGER,
  sku_title         TEXT,
  insight_type      TEXT NOT NULL,
  insight_text      TEXT NOT NULL,
  data_points_count INTEGER DEFAULT 0,
  confidence        REAL DEFAULT 0,
  actionable        INTEGER DEFAULT 0,
  suggested_action  TEXT,
  status            TEXT DEFAULT 'new',
  payload_json      TEXT DEFAULT '{}',
  created_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(date, nm_id, insight_type)
);

-- ============================================================
-- §5 — CS Operations Stage 2 (cs_operations_stage2_v1.gs)
-- ============================================================

CREATE TABLE IF NOT EXISTS cs_appeal_item (
  id              TEXT PRIMARY KEY,
  inbox_item_id   TEXT NOT NULL,
  nm_id           INTEGER,
  sku_title       TEXT,
  user_id         TEXT,
  appeal_reason   TEXT NOT NULL,
  appeal_possible INTEGER DEFAULT 0,
  evidence_json   TEXT DEFAULT '[]',
  draft_appeal    TEXT,
  risk_level      TEXT DEFAULT 'low',
  status          TEXT DEFAULT 'draft',
  confirmation_id TEXT UNIQUE,
  submitted_at    TEXT,
  payload_json    TEXT DEFAULT '{}',
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cs_appeal_status
  ON cs_appeal_item(status, created_at DESC);

CREATE TABLE IF NOT EXISTS cs_knowledge_gap (
  id                  TEXT PRIMARY KEY,
  nm_id               INTEGER,
  sku_title           TEXT,
  topic               TEXT NOT NULL,
  question_pattern    TEXT,
  frequency_count     INTEGER DEFAULT 1,
  source_items_json   TEXT DEFAULT '[]',
  status              TEXT DEFAULT 'open',
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now')),
  UNIQUE(nm_id, topic)
);

-- ============================================================
-- §6 — Approval Flow (approval_flow_v1.gs)
-- ============================================================

CREATE TABLE IF NOT EXISTS approval_digest_log (
  id                TEXT PRIMARY KEY,
  user_id           TEXT,
  chat_id           TEXT,
  date              TEXT NOT NULL,
  wb_proposals_sent INTEGER DEFAULT 0,
  cs_drafts_sent    INTEGER DEFAULT 0,
  total_sent        INTEGER DEFAULT 0,
  sent_at           TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(date, chat_id)
);

-- ============================================================
-- §7 — Handoff Events (handoff_events_v1.gs)
-- ============================================================

CREATE TABLE IF NOT EXISTS handoff_event (
  id                    TEXT PRIMARY KEY,
  from_chief            TEXT NOT NULL,
  to_chief              TEXT NOT NULL,
  handoff_type          TEXT NOT NULL,
  priority              TEXT DEFAULT 'medium',
  status                TEXT DEFAULT 'pending',
  nm_id                 INTEGER,
  sku_title             TEXT,
  entity_type           TEXT,
  entity_id             TEXT,
  title                 TEXT NOT NULL,
  summary               TEXT,
  evidence_json         TEXT DEFAULT '[]',
  recommended_action    TEXT,
  payload_json          TEXT DEFAULT '{}',
  requires_confirmation INTEGER DEFAULT 0,
  confirmation_id       TEXT UNIQUE,
  acknowledged_at       TEXT,
  acknowledged_by       TEXT,
  resolved_at           TEXT,
  expires_at            TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_handoff_to_chief
  ON handoff_event(to_chief, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoff_from_chief
  ON handoff_event(from_chief, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoff_nm_id
  ON handoff_event(nm_id, status);

-- ============================================================
-- §8 — Scheduler (scheduler_v1.gs)
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduler_run_log (
  id          TEXT PRIMARY KEY,
  job_name    TEXT NOT NULL,
  cron_expr   TEXT,
  status      TEXT DEFAULT 'running',
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  result_json TEXT DEFAULT '{}',
  error       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduler_run_log_job
  ON scheduler_run_log(job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS scheduler_config (
  id                TEXT PRIMARY KEY,
  job_name          TEXT NOT NULL UNIQUE,
  enabled           INTEGER DEFAULT 1,
  notify_chat_id    TEXT,
  notify_on_error   INTEGER DEFAULT 1,
  notify_on_success INTEGER DEFAULT 0,
  last_run_at       TEXT,
  last_status       TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

-- Seed scheduler_config with known job names
INSERT OR IGNORE INTO scheduler_config (id, job_name) VALUES
  ('scfg_wb',         'wb_daily_report'),
  ('scfg_ff',         'fulfillment_daily'),
  ('scfg_cs',         'cs_daily_report'),
  ('scfg_rop',        'rop_daily_report'),
  ('scfg_design',     'design_daily_report'),
  ('scfg_proposals',  'proposals_check'),
  ('scfg_insights',   'weekly_insights'),
  ('scfg_qa',         'qa_daily'),
  ('scfg_cleanup',    'proposal_cleanup');

-- ============================================================
-- §9 — Design Chief (design_chief_v1.gs)
-- ============================================================

CREATE TABLE IF NOT EXISTS design_handoff_item (
  id                    TEXT PRIMARY KEY,
  handoff_event_id      TEXT,
  nm_id                 INTEGER,
  vendor_code           TEXT,
  sku_title             TEXT,
  issue_type            TEXT,
  priority              TEXT DEFAULT 'medium',
  status                TEXT DEFAULT 'pending',
  evidence_json         TEXT DEFAULT '[]',
  proposed_changes_json TEXT DEFAULT '{}',
  confirmation_id       TEXT UNIQUE,
  requires_confirmation INTEGER DEFAULT 1,
  confirmed_at          TEXT,
  confirmed_by          TEXT,
  notes                 TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_design_handoff_status
  ON design_handoff_item(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_design_handoff_nm
  ON design_handoff_item(nm_id, status);

CREATE TABLE IF NOT EXISTS design_card_snapshot (
  id                    TEXT PRIMARY KEY,
  snapshot_date         TEXT NOT NULL,
  nm_id                 INTEGER NOT NULL,
  vendor_code           TEXT,
  sku_title             TEXT,
  title_length          INTEGER DEFAULT 0,
  description_length    INTEGER DEFAULT 0,
  photos_count          INTEGER DEFAULT 0,
  characteristics_count INTEGER DEFAULT 0,
  has_video             INTEGER DEFAULT 0,
  title_keywords_json   TEXT DEFAULT '[]',
  issues_found_json     TEXT DEFAULT '[]',
  overall_score         INTEGER DEFAULT 0,
  source_status         TEXT DEFAULT 'missing',
  created_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(snapshot_date, nm_id)
);

CREATE INDEX IF NOT EXISTS idx_design_snapshot_date
  ON design_card_snapshot(snapshot_date, nm_id);

CREATE TABLE IF NOT EXISTS design_content_plan (
  id                    TEXT PRIMARY KEY,
  plan_date             TEXT NOT NULL,
  nm_id                 INTEGER NOT NULL,
  vendor_code           TEXT,
  sku_title             TEXT,
  priority              TEXT DEFAULT 'medium',
  issue_type            TEXT,
  current_state_json    TEXT DEFAULT '{}',
  proposed_action       TEXT,
  ai_draft              TEXT,
  status                TEXT DEFAULT 'pending',
  confirmation_id       TEXT UNIQUE,
  requires_confirmation INTEGER DEFAULT 1,
  confirmed_at          TEXT,
  expires_at            TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_design_plan_status
  ON design_content_plan(status, plan_date DESC);

-- ============================================================
-- §10 — ROP Chief (rop_chief_v1.gs)
-- ============================================================

CREATE TABLE IF NOT EXISTS rop_kpi_snapshot (
  id              TEXT PRIMARY KEY,
  snapshot_date   TEXT NOT NULL,
  nm_id           INTEGER NOT NULL,
  vendor_code     TEXT,
  sku_title       TEXT,
  orders_count    INTEGER DEFAULT 0,
  orders_revenue  REAL DEFAULT 0,
  returns_count   INTEGER DEFAULT 0,
  return_rate     REAL DEFAULT 0,
  avg_rating      REAL,
  reviews_count   INTEGER DEFAULT 0,
  conversion_rate REAL,
  revenue_7d      REAL,
  revenue_30d     REAL,
  orders_7d       INTEGER,
  orders_30d      INTEGER,
  trend           TEXT DEFAULT 'stable',
  source_status   TEXT DEFAULT 'missing',
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(snapshot_date, nm_id)
);

CREATE INDEX IF NOT EXISTS idx_rop_kpi_date
  ON rop_kpi_snapshot(snapshot_date, nm_id);

CREATE TABLE IF NOT EXISTS rop_target (
  id              TEXT PRIMARY KEY,
  period          TEXT NOT NULL,
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  nm_id           INTEGER,
  vendor_code     TEXT,
  metric          TEXT NOT NULL,
  target_value    REAL NOT NULL,
  current_value   REAL,
  deviation_pct   REAL,
  status          TEXT DEFAULT 'pending',
  confirmation_id TEXT UNIQUE,
  requires_confirmation INTEGER DEFAULT 1,
  confirmed_by    TEXT,
  confirmed_at    TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rop_target_status
  ON rop_target(status, period_end);

CREATE TABLE IF NOT EXISTS rop_insight (
  id                    TEXT PRIMARY KEY,
  insight_date          TEXT NOT NULL,
  insight_type          TEXT NOT NULL,
  nm_id                 INTEGER,
  vendor_code           TEXT,
  title                 TEXT NOT NULL,
  summary               TEXT,
  evidence_json         TEXT DEFAULT '[]',
  recommended_action    TEXT,
  priority              TEXT DEFAULT 'medium',
  status                TEXT DEFAULT 'new',
  confirmation_id       TEXT UNIQUE,
  requires_confirmation INTEGER DEFAULT 1,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rop_insight_date
  ON rop_insight(insight_date, status);
CREATE INDEX IF NOT EXISTS idx_rop_insight_nm
  ON rop_insight(nm_id, status);

-- ============================================================
-- §11 — Fulfillment Chief (fulfillment_chief_v1.gs)
-- ============================================================

CREATE TABLE IF NOT EXISTS fulfillment_fbs_snapshot (
  id                    TEXT PRIMARY KEY,
  snapshot_date         TEXT NOT NULL,
  nm_id                 INTEGER NOT NULL,
  vendor_code           TEXT,
  sku_title             TEXT,
  barcode               TEXT,
  stock_wb_total        INTEGER DEFAULT 0,
  stock_wb_available    INTEGER DEFAULT 0,
  stock_wb_in_transit   INTEGER DEFAULT 0,
  stock_wb_reserved     INTEGER DEFAULT 0,
  stock_seller          INTEGER,
  avg_daily_orders_7d   REAL DEFAULT 0,
  days_of_stock_wb      REAL,
  replenishment_needed  INTEGER DEFAULT 0,
  replenishment_qty     INTEGER DEFAULT 0,
  urgency               TEXT DEFAULT 'none',
  source_status         TEXT DEFAULT 'missing',
  created_at            TEXT DEFAULT (datetime('now')),
  UNIQUE(snapshot_date, nm_id)
);

CREATE INDEX IF NOT EXISTS idx_fbs_snap_date
  ON fulfillment_fbs_snapshot(snapshot_date, urgency);
CREATE INDEX IF NOT EXISTS idx_fbs_snap_nm
  ON fulfillment_fbs_snapshot(nm_id, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS fulfillment_tz_item (
  id                    TEXT PRIMARY KEY,
  tz_date               TEXT NOT NULL,
  nm_id                 INTEGER NOT NULL,
  vendor_code           TEXT,
  sku_title             TEXT,
  barcode               TEXT,
  warehouse_target      TEXT,
  qty_to_send           INTEGER NOT NULL,
  urgency               TEXT DEFAULT 'medium',
  rationale             TEXT,
  ai_comment            TEXT,
  status                TEXT DEFAULT 'draft',
  confirmation_id       TEXT UNIQUE,
  requires_confirmation INTEGER DEFAULT 1,
  confirmed_at          TEXT,
  confirmed_by          TEXT,
  sent_at               TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tz_status
  ON fulfillment_tz_item(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tz_nm
  ON fulfillment_tz_item(nm_id, status);

CREATE TABLE IF NOT EXISTS fulfillment_schedule (
  id                    TEXT PRIMARY KEY,
  schedule_date         TEXT NOT NULL,
  warehouse_name        TEXT,
  items_json            TEXT DEFAULT '[]',
  total_items           INTEGER DEFAULT 0,
  status                TEXT DEFAULT 'planned',
  confirmation_id       TEXT UNIQUE,
  requires_confirmation INTEGER DEFAULT 1,
  confirmed_at          TEXT,
  confirmed_by          TEXT,
  notes                 TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schedule_status
  ON fulfillment_schedule(status, schedule_date);

-- ============================================================
-- End of schema.sql
-- Tables: 40 | Indexes: 31
-- Generated for: ai-agents-worker
-- ============================================================
