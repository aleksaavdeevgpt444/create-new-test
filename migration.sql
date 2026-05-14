-- ============================================================
-- migration.sql — Incremental DB migration
-- Project: ИИ агенты-помощники (ai-agents-worker)
--
-- Use this file when upgrading an EXISTING database.
-- For a fresh database, use schema.sql instead.
--
-- Usage:
--   wrangler d1 execute ai-agents-db --file=migration.sql
--   wrangler d1 execute ai-agents-db --file=migration.sql --env staging
--
-- Safety: all statements use IF NOT EXISTS — safe to re-run.
--
-- Notes on ALTER TABLE:
--   Cloudflare D1 does not support "ADD COLUMN IF NOT EXISTS".
--   New columns on existing tables are added automatically by the
--   Worker on cold start (each ensureXxxSchema_ function does
--   ALTER TABLE inside try/catch, silently ignoring duplicate columns).
--   You do NOT need to run ALTER TABLE statements manually.
--
-- What this file adds vs the original schema:
--   §1  handoff_event                    (new table)
--   §2  scheduler_run_log                (new table)
--   §3  scheduler_config                 (new table + seed rows)
--   §4  approval_digest_log              (new table)
--   §5  wb_report_consistency_check_v2   (new table)
--   §6  cs_appeal_item                   (new table)
--   §7  cs_knowledge_gap                 (new table)
--   §8  design_handoff_item              (new table)
--   §9  design_card_snapshot             (new table)
--   §10 design_content_plan              (new table)
--   §11 rop_kpi_snapshot                 (new table)
--   §12 rop_target                       (new table)
--   §13 rop_insight                      (new table)
--   §14 fulfillment_fbs_snapshot         (new table)
--   §15 fulfillment_tz_item              (new table)
--   §16 fulfillment_schedule             (new table)
--   §17 procurement_order                (new table)
--   §18 procurement_handoff_item         (new table)
--   §19 procurement_price_history        (new table)
-- ============================================================

-- ── §1 Handoff Events ─────────────────────────────────────────

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

-- ── §2–3 Scheduler ────────────────────────────────────────────

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

INSERT OR IGNORE INTO scheduler_config (id, job_name) VALUES
  ('scfg_wb',         'wb_daily_report'),
  ('scfg_ff',         'fulfillment_daily'),
  ('scfg_cs',         'cs_daily_report'),
  ('scfg_rop',        'rop_daily_report'),
  ('scfg_design',     'design_daily_report'),
  ('scfg_proc',       'procurement_daily'),
  ('scfg_proposals',  'proposals_check'),
  ('scfg_insights',   'weekly_insights'),
  ('scfg_qa',         'qa_daily'),
  ('scfg_cleanup',    'proposal_cleanup');

-- ── §4 Approval Flow ──────────────────────────────────────────

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

-- ── §5 WB Report Consistency Check V2 ────────────────────────

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

-- ── §6–7 CS Operations Stage 2 ───────────────────────────────

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
  id                TEXT PRIMARY KEY,
  nm_id             INTEGER,
  sku_title         TEXT,
  topic             TEXT NOT NULL,
  question_pattern  TEXT,
  frequency_count   INTEGER DEFAULT 1,
  source_items_json TEXT DEFAULT '[]',
  status            TEXT DEFAULT 'open',
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(nm_id, topic)
);

-- ── §8–10 Design Chief ────────────────────────────────────────

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

-- ── §11–13 ROP Chief ──────────────────────────────────────────

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
  id                    TEXT PRIMARY KEY,
  period                TEXT NOT NULL,
  period_start          TEXT NOT NULL,
  period_end            TEXT NOT NULL,
  nm_id                 INTEGER,
  vendor_code           TEXT,
  metric                TEXT NOT NULL,
  target_value          REAL NOT NULL,
  current_value         REAL,
  deviation_pct         REAL,
  status                TEXT DEFAULT 'pending',
  confirmation_id       TEXT UNIQUE,
  requires_confirmation INTEGER DEFAULT 1,
  confirmed_by          TEXT,
  confirmed_at          TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
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

-- ── §14–16 Fulfillment Chief ──────────────────────────────────

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

-- ── §17–19 Procurement Chief ──────────────────────────────────

CREATE TABLE IF NOT EXISTS procurement_order (
  id                    TEXT PRIMARY KEY,
  order_date            TEXT NOT NULL,
  supplier_id           TEXT,
  supplier_name         TEXT,
  nm_id                 INTEGER,
  vendor_code           TEXT,
  sku_title             TEXT,
  qty_requested         INTEGER NOT NULL,
  estimated_unit_cost   REAL,
  estimated_total_cost  REAL,
  currency              TEXT DEFAULT 'RUB',
  urgency               TEXT DEFAULT 'medium',
  rationale             TEXT,
  ai_comment            TEXT,
  status                TEXT DEFAULT 'draft',
  confirmation_id       TEXT UNIQUE,
  requires_confirmation INTEGER DEFAULT 1,
  confirmed_at          TEXT,
  confirmed_by          TEXT,
  sent_at               TEXT,
  source_handoff_id     TEXT,
  created_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proc_order_status
  ON procurement_order(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proc_order_nm
  ON procurement_order(nm_id, status);
CREATE INDEX IF NOT EXISTS idx_proc_order_supplier
  ON procurement_order(supplier_id, status);

CREATE TABLE IF NOT EXISTS procurement_handoff_item (
  id               TEXT PRIMARY KEY,
  handoff_event_id TEXT NOT NULL,
  nm_id            INTEGER,
  vendor_code      TEXT,
  sku_title        TEXT,
  handoff_type     TEXT,
  priority         TEXT DEFAULT 'medium',
  status           TEXT DEFAULT 'pending',
  order_id         TEXT,
  notes            TEXT,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proc_handoff_status
  ON procurement_handoff_item(status, created_at DESC);

CREATE TABLE IF NOT EXISTS procurement_price_history (
  id            TEXT PRIMARY KEY,
  nm_id         INTEGER NOT NULL,
  vendor_code   TEXT,
  supplier_id   TEXT,
  supplier_name TEXT,
  price_date    TEXT NOT NULL,
  unit_cost     REAL NOT NULL,
  currency      TEXT DEFAULT 'RUB',
  min_order_qty INTEGER,
  notes         TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(nm_id, supplier_id, price_date)
);

CREATE INDEX IF NOT EXISTS idx_proc_price_nm
  ON procurement_price_history(nm_id, price_date DESC);

-- ── §20 WB Data Sync ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wb_sync_log (
  id              TEXT PRIMARY KEY,
  sync_date       TEXT NOT NULL,
  sync_type       TEXT NOT NULL,
  status          TEXT DEFAULT 'running',
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  duration_ms     INTEGER,
  records_written INTEGER DEFAULT 0,
  error           TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wb_sync_log_date
  ON wb_sync_log(sync_date, sync_type);

INSERT OR IGNORE INTO scheduler_config (id, job_name) VALUES
  ('scfg_wb_sync', 'wb_data_sync');

-- ── §21–22 WB Pricing Advisor ─────────────────────────────────

CREATE TABLE IF NOT EXISTS wb_pricing_proposal (
  id                    TEXT PRIMARY KEY,
  proposal_date         TEXT NOT NULL,
  nm_id                 INTEGER NOT NULL,
  vendor_code           TEXT,
  sku_title             TEXT,
  proposal_type         TEXT NOT NULL,
  current_price         REAL,
  proposed_price        REAL,
  current_discount_pct  REAL,
  proposed_discount_pct REAL,
  margin_pct_estimated  REAL,
  rationale             TEXT,
  ai_analysis           TEXT,
  priority              TEXT DEFAULT 'medium',
  status                TEXT DEFAULT 'pending',
  confirmation_id       TEXT UNIQUE,
  requires_confirmation INTEGER DEFAULT 1,
  confirmed_at          TEXT,
  confirmed_by          TEXT,
  expires_at            TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wb_pricing_proposal_date
  ON wb_pricing_proposal(proposal_date, status);
CREATE INDEX IF NOT EXISTS idx_wb_pricing_proposal_nm
  ON wb_pricing_proposal(nm_id, status);

CREATE TABLE IF NOT EXISTS wb_pricing_history (
  id           TEXT PRIMARY KEY,
  nm_id        INTEGER NOT NULL,
  vendor_code  TEXT,
  record_date  TEXT NOT NULL,
  price        REAL,
  discount_pct REAL,
  source       TEXT DEFAULT 'sync',
  proposal_id  TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(nm_id, record_date, source)
);

CREATE INDEX IF NOT EXISTS idx_wb_pricing_history_nm
  ON wb_pricing_history(nm_id, record_date DESC);

INSERT OR IGNORE INTO scheduler_config (id, job_name) VALUES
  ('scfg_pricing', 'wb_pricing_daily');

-- ── End of migration.sql ──────────────────────────────────────
-- New tables added: 22 | New indexes: 24
-- ALTER TABLE patches are handled automatically by Worker startup.
