// Stage A2 — Complete D1 Schema for all 29 stages
// All tables use CREATE TABLE IF NOT EXISTS — no DROP TABLE, no destructive migrations.

export const SCHEMA_SQL = `
-- ============================================================
-- STAGE A1/A3: Core Agent Protocol Tables
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_registry (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contour TEXT NOT NULL,
  description TEXT,
  role TEXT,
  allowed_handoffs TEXT DEFAULT '[]',
  guardrails TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_settings (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  setting_value TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_key, setting_key)
);

CREATE TABLE IF NOT EXISTS agent_requests (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  contour TEXT NOT NULL,
  trigger TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  context TEXT DEFAULT '{}',
  status TEXT DEFAULT 'not_assigned',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_responses (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  summary TEXT,
  result TEXT DEFAULT '{}',
  proposals TEXT DEFAULT '[]',
  status TEXT DEFAULT 'success',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_handoffs (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  expected_output TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_actions (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  payload_hash TEXT,
  risk_level TEXT DEFAULT 'low',
  status TEXT DEFAULT 'pending',
  proposal_text TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_approvals (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  approved_by TEXT DEFAULT 'owner',
  decision TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_logs (
  id TEXT PRIMARY KEY,
  agent_key TEXT,
  level TEXT DEFAULT 'info',
  message TEXT NOT NULL,
  context TEXT DEFAULT '{}',
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_traces (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  trigger TEXT,
  status TEXT DEFAULT 'running',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS agent_trace_steps (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  step_type TEXT NOT NULL,
  description TEXT,
  input TEXT DEFAULT '{}',
  output TEXT DEFAULT '{}',
  status TEXT DEFAULT 'completed',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_requests_agent_key ON agent_requests(agent_key);
CREATE INDEX IF NOT EXISTS idx_agent_requests_status ON agent_requests(status);
CREATE INDEX IF NOT EXISTS idx_agent_responses_request_id ON agent_responses(request_id);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_from ON agent_handoffs(from_agent);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_to ON agent_handoffs(to_agent);
CREATE INDEX IF NOT EXISTS idx_agent_actions_status ON agent_actions(status);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_action_id ON agent_approvals(action_id);
CREATE INDEX IF NOT EXISTS idx_agent_logs_agent_key ON agent_logs(agent_key);
CREATE INDEX IF NOT EXISTS idx_agent_logs_created ON agent_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_traces_request_id ON agent_traces(request_id);
CREATE INDEX IF NOT EXISTS idx_agent_trace_steps_trace_id ON agent_trace_steps(trace_id);

-- ============================================================
-- STAGE A18: Tool Registry
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_tool_registry (
  id TEXT PRIMARY KEY,
  tool_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  risk_level TEXT DEFAULT 'low',
  is_enabled INTEGER DEFAULT 1,
  is_dangerous INTEGER DEFAULT 0,
  requires_approval INTEGER DEFAULT 0,
  is_mock INTEGER DEFAULT 0,
  schema TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tool_permissions (
  id TEXT PRIMARY KEY,
  tool_key TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  is_allowed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(tool_key, agent_key)
);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id TEXT PRIMARY KEY,
  tool_key TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  request_id TEXT,
  input TEXT DEFAULT '{}',
  output TEXT DEFAULT '{}',
  status TEXT DEFAULT 'success',
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tool_guardrail_results (
  id TEXT PRIMARY KEY,
  tool_key TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  check_name TEXT NOT NULL,
  passed INTEGER DEFAULT 1,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tool_schemas (
  id TEXT PRIMARY KEY,
  tool_key TEXT NOT NULL UNIQUE,
  input_schema TEXT DEFAULT '{}',
  output_schema TEXT DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tool_permission_groups (
  id TEXT PRIMARY KEY,
  group_name TEXT NOT NULL UNIQUE,
  tool_keys TEXT DEFAULT '[]',
  agent_keys TEXT DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tool_audit_log (
  id TEXT PRIMARY KEY,
  tool_key TEXT NOT NULL,
  agent_key TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_key ON agent_tool_calls(tool_key);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent_key ON agent_tool_calls(agent_key);

-- ============================================================
-- STAGE A19: Integrations Layer
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_integrations (
  id TEXT PRIMARY KEY,
  integration_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  config TEXT DEFAULT '{}',
  health_status TEXT DEFAULT 'unknown',
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_integration_secrets (
  id TEXT PRIMARY KEY,
  integration_key TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  secret_hint TEXT,
  env_var_name TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(integration_key, secret_key)
);

CREATE TABLE IF NOT EXISTS agent_integration_calls (
  id TEXT PRIMARY KEY,
  integration_key TEXT NOT NULL,
  method TEXT,
  endpoint TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  is_mock INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_integration_health (
  id TEXT PRIMARY KEY,
  integration_key TEXT NOT NULL,
  status TEXT DEFAULT 'unknown',
  latency_ms INTEGER,
  error TEXT,
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_integration_rate_limits (
  id TEXT PRIMARY KEY,
  integration_key TEXT NOT NULL,
  calls_per_minute INTEGER DEFAULT 60,
  calls_today INTEGER DEFAULT 0,
  reset_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_integration_jobs (
  id TEXT PRIMARY KEY,
  integration_key TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  payload TEXT DEFAULT '{}',
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_integration_mappings (
  id TEXT PRIMARY KEY,
  integration_key TEXT NOT NULL,
  source_field TEXT NOT NULL,
  target_field TEXT NOT NULL,
  transform TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_integration_audit_log (
  id TEXT PRIMARY KEY,
  integration_key TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

-- ============================================================
-- STAGE A20: Action Executor
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_action_executions (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  result TEXT DEFAULT '{}',
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_action_execution_steps (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  step_name TEXT,
  status TEXT DEFAULT 'pending',
  input TEXT DEFAULT '{}',
  output TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_action_idempotency_keys (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  action_id TEXT NOT NULL,
  execution_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_action_locks (
  id TEXT PRIMARY KEY,
  lock_key TEXT NOT NULL UNIQUE,
  action_id TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_action_retry_queue (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  attempt_number INTEGER DEFAULT 1,
  max_attempts INTEGER DEFAULT 3,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_action_results (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  execution_id TEXT,
  result_type TEXT,
  result TEXT DEFAULT '{}',
  summary TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_action_executor_audit_log (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

-- ============================================================
-- STAGE A21: Project Builder
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_project_build_runs (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  passport TEXT DEFAULT '{}',
  roadmap TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending',
  current_stage TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_project_build_stages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  stage_name TEXT,
  status TEXT DEFAULT 'pending',
  artifacts TEXT DEFAULT '[]',
  checks TEXT DEFAULT '[]',
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_project_build_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  artifact_type TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_project_build_checks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  check_name TEXT NOT NULL,
  passed INTEGER DEFAULT 0,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_project_build_dependencies (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  depends_on_stage_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_project_build_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  level TEXT DEFAULT 'info',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_project_build_deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  delivery_type TEXT DEFAULT 'full',
  package TEXT DEFAULT '{}',
  status TEXT DEFAULT 'ready',
  created_at TEXT NOT NULL
);

-- ============================================================
-- STAGE A22: Knowledge Base
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_knowledge_items (
  id TEXT PRIMARY KEY,
  agent_key TEXT,
  project_key TEXT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  scope TEXT DEFAULT 'local',
  tags TEXT DEFAULT '[]',
  version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_knowledge_versions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  changed_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_knowledge_links (
  id TEXT PRIMARY KEY,
  from_item_id TEXT NOT NULL,
  to_item_id TEXT NOT NULL,
  link_type TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_knowledge_tags (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(item_id, tag)
);

CREATE TABLE IF NOT EXISTS agent_knowledge_retrievals (
  id TEXT PRIMARY KEY,
  agent_key TEXT,
  query TEXT,
  item_ids TEXT DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_knowledge_conflicts (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  conflict_with_id TEXT,
  description TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_knowledge_write_requests (
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  scope TEXT DEFAULT 'local',
  requires_approval INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_knowledge_audit_log (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  agent_key TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_items_category ON agent_knowledge_items(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_status ON agent_knowledge_items(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_items_agent ON agent_knowledge_items(agent_key);

-- ============================================================
-- STAGE A23: QA Layer
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_qa_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT DEFAULT 'quick',
  status TEXT DEFAULT 'running',
  total_checks INTEGER DEFAULT 0,
  passed_checks INTEGER DEFAULT 0,
  failed_checks INTEGER DEFAULT 0,
  warning_checks INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_qa_checks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  check_name TEXT NOT NULL,
  module TEXT,
  status TEXT DEFAULT 'pending',
  result TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_qa_check_results (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL,
  passed INTEGER DEFAULT 0,
  message TEXT,
  detail TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_qa_issues (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  severity TEXT DEFAULT 'warning',
  module TEXT,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_qa_smoke_tests (
  id TEXT PRIMARY KEY,
  test_name TEXT NOT NULL UNIQUE,
  endpoint TEXT,
  expected_status INTEGER,
  is_enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_qa_acceptance_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  overall_status TEXT DEFAULT 'pending',
  criteria TEXT DEFAULT '[]',
  summary TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_qa_audit_log (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

-- ============================================================
-- STAGE A24: Deployments
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_deployments (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  version TEXT,
  status TEXT DEFAULT 'planned',
  plan TEXT DEFAULT '{}',
  deployed_by TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_deployment_steps (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  output TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_deployment_checks (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  check_name TEXT NOT NULL,
  passed INTEGER DEFAULT 0,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_deployment_environments (
  id TEXT PRIMARY KEY,
  env_name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_production INTEGER DEFAULT 0,
  config TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_deployment_audit_log (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

-- ============================================================
-- STAGE A25: Notification Center
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_notifications (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  recipient TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  priority TEXT DEFAULT 'normal',
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_notification_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  source_agent TEXT,
  payload TEXT DEFAULT '{}',
  processed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_notification_rules (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  template_key TEXT,
  priority TEXT DEFAULT 'normal',
  is_enabled INTEGER DEFAULT 1,
  quiet_hours_override INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_notification_deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  attempt_count INTEGER DEFAULT 0,
  last_attempt_at TEXT,
  delivered_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS agent_notification_templates (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  subject_template TEXT,
  body_template TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_notification_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'owner',
  channel TEXT NOT NULL,
  is_enabled INTEGER DEFAULT 1,
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_notification_dedupe_keys (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  notification_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_notification_digests (
  id TEXT PRIMARY KEY,
  digest_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  content TEXT DEFAULT '[]',
  status TEXT DEFAULT 'pending',
  scheduled_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_notification_audit_log (
  id TEXT PRIMARY KEY,
  notification_id TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_status ON agent_notifications(status);
CREATE INDEX IF NOT EXISTS idx_notification_events_type ON agent_notification_events(event_type);

-- ============================================================
-- STAGE A26: Advanced Scheduler
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_schedules (
  id TEXT PRIMARY KEY,
  schedule_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  trigger_payload TEXT DEFAULT '{}',
  schedule_type TEXT DEFAULT 'simple',
  cron_expression TEXT,
  interval_seconds INTEGER,
  timezone TEXT DEFAULT 'UTC',
  is_enabled INTEGER DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS agent_schedule_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_schedule_dependencies (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  depends_on_schedule_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_schedule_locks (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL UNIQUE,
  locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_schedule_retry_queue (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  run_id TEXT,
  attempt_number INTEGER DEFAULT 1,
  max_attempts INTEGER DEFAULT 3,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS agent_schedule_missed_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  expected_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS agent_schedule_health (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  status TEXT DEFAULT 'healthy',
  last_success_at TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_schedule_audit_log (
  id TEXT PRIMARY KEY,
  schedule_id TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON agent_schedules(next_run_at);
CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON agent_schedules(is_enabled);

-- ============================================================
-- STAGE A27: Analytics
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_analytics_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT DEFAULT 'daily',
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT DEFAULT 'running',
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_analytics_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,
  data TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_analytics_agent_daily (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  requests_count INTEGER DEFAULT 0,
  responses_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  avg_duration_ms REAL,
  approval_rate REAL,
  created_at TEXT NOT NULL,
  UNIQUE(date, agent_key)
);

CREATE TABLE IF NOT EXISTS agent_analytics_recommendations (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  agent_key TEXT NOT NULL,
  recommendations_made INTEGER DEFAULT 0,
  approved INTEGER DEFAULT 0,
  rejected INTEGER DEFAULT 0,
  executed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_analytics_approvals (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  total INTEGER DEFAULT 0,
  approved INTEGER DEFAULT 0,
  rejected INTEGER DEFAULT 0,
  expired INTEGER DEFAULT 0,
  avg_time_to_decision_seconds REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_analytics_actions (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  action_type TEXT NOT NULL,
  executed INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_analytics_tools (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  tool_key TEXT NOT NULL,
  call_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  blocked_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_analytics_integrations (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  integration_key TEXT NOT NULL,
  call_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_analytics_schedules (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  runs INTEGER DEFAULT 0,
  success INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_analytics_insights (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  category TEXT NOT NULL,
  insight TEXT NOT NULL,
  severity TEXT DEFAULT 'info',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_analytics_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  report_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_analytics_audit_log (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

-- ============================================================
-- STAGE A28: Security / Roles / Audit
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  is_owner INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_roles (
  id TEXT PRIMARY KEY,
  role_name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role_name TEXT NOT NULL,
  granted_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, role_name)
);

CREATE TABLE IF NOT EXISTS agent_permissions (
  id TEXT PRIMARY KEY,
  permission_key TEXT NOT NULL UNIQUE,
  description TEXT,
  resource TEXT,
  action TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_role_permissions (
  id TEXT PRIMARY KEY,
  role_name TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(role_name, permission_key)
);

CREATE TABLE IF NOT EXISTS agent_security_policies (
  id TEXT PRIMARY KEY,
  policy_key TEXT NOT NULL UNIQUE,
  description TEXT,
  rule TEXT DEFAULT '{}',
  is_enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_security_checks (
  id TEXT PRIMARY KEY,
  check_name TEXT NOT NULL,
  user_id TEXT,
  resource TEXT,
  action TEXT,
  result TEXT DEFAULT 'denied',
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_security_alerts (
  id TEXT PRIMARY KEY,
  severity TEXT DEFAULT 'medium',
  alert_type TEXT NOT NULL,
  description TEXT NOT NULL,
  user_id TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_security_audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  agent_key TEXT,
  event TEXT NOT NULL,
  resource TEXT,
  action TEXT,
  result TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_active_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  name TEXT,
  scopes TEXT DEFAULT '[]',
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_security_checks_user ON agent_security_checks(user_id);
CREATE INDEX IF NOT EXISTS idx_security_alerts_status ON agent_security_alerts(status);

-- ============================================================
-- STAGE A29: Production Hardening
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_hardening_policies (
  id TEXT PRIMARY KEY,
  policy_key TEXT NOT NULL UNIQUE,
  timeout_ms INTEGER DEFAULT 30000,
  max_retries INTEGER DEFAULT 3,
  rate_limit_rpm INTEGER DEFAULT 60,
  circuit_breaker_threshold INTEGER DEFAULT 5,
  is_enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_resilience_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  source TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_dead_letter_queue (
  id TEXT PRIMARY KEY,
  original_type TEXT NOT NULL,
  original_id TEXT,
  payload TEXT DEFAULT '{}',
  error TEXT,
  attempts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_stuck_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL,
  run_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  status TEXT DEFAULT 'detected',
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  status TEXT DEFAULT 'alive',
  last_beat_at TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS agent_circuit_breakers (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL UNIQUE,
  state TEXT DEFAULT 'closed',
  failure_count INTEGER DEFAULT 0,
  last_failure_at TEXT,
  opened_at TEXT,
  reset_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_recovery_actions (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  action_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  initiated_by TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_backups (
  id TEXT PRIMARY KEY,
  backup_type TEXT DEFAULT 'schema',
  status TEXT DEFAULT 'pending',
  size_bytes INTEGER,
  location TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_incidents (
  id TEXT PRIMARY KEY,
  severity TEXT DEFAULT 'medium',
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open',
  affected_components TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_hardening_audit_log (
  id TEXT PRIMARY KEY,
  component TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_status ON agent_dead_letter_queue(status);
CREATE INDEX IF NOT EXISTS idx_heartbeats_component ON agent_heartbeats(component);
CREATE INDEX IF NOT EXISTS idx_circuit_breakers_state ON agent_circuit_breakers(state);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON agent_incidents(status);
`;

export const SEED_AGENTS_SQL = `
INSERT OR IGNORE INTO agent_registry (id, agent_key, name, contour, description, role, allowed_handoffs, status, created_at, updated_at)
VALUES
  ('reg-001', 'chief_ai_coordinator', 'Chief AI Coordinator', 'system', 'Main routing and coordination agent', 'coordinator', '["business_operations_ai_chief","personal_operations_ai_chief"]', 'active', datetime('now'), datetime('now')),
  ('reg-002', 'business_operations_ai_chief', 'Business Operations AI Chief', 'business', 'Coordinates all business/marketplace agents', 'business_chief', '["fulfillment_agent","procurement_agent","ads_agent","reports_agent","new_products_agent","finance_analyst_agent"]', 'active', datetime('now'), datetime('now')),
  ('reg-003', 'personal_operations_ai_chief', 'Personal Operations AI Chief', 'personal', 'Coordinates all personal agents', 'personal_chief', '["personal_assistant_agent","personal_pm_agent","project_builder_agent"]', 'active', datetime('now'), datetime('now')),
  ('reg-004', 'personal_assistant_agent', 'Personal Assistant Agent', 'personal', 'Handles inbox, tasks, reminders, planner', 'assistant', '[]', 'active', datetime('now'), datetime('now')),
  ('reg-005', 'personal_pm_agent', 'Personal PM Agent', 'personal', 'Personal project manager: roadmap, tasks, progress', 'pm', '["project_builder_agent"]', 'active', datetime('now'), datetime('now')),
  ('reg-006', 'project_builder_agent', 'Project Builder Agent', 'personal', 'Executes project stages, generates artifacts', 'builder', '[]', 'active', datetime('now'), datetime('now')),
  ('reg-007', 'reports_agent', 'Reports Agent', 'business', 'Daily/weekly reports, analysis, hypotheses', 'reporter', '[]', 'active', datetime('now'), datetime('now')),
  ('reg-008', 'finance_analyst_agent', 'Finance Analyst Agent', 'business', 'Financial analysis, margin, risks, recommendations', 'analyst', '[]', 'active', datetime('now'), datetime('now')),
  ('reg-009', 'ads_agent', 'Ads Agent', 'business', 'WB Ads analysis and recommendations', 'ads', '[]', 'active', datetime('now'), datetime('now')),
  ('reg-010', 'fulfillment_agent', 'Fulfillment Agent', 'business', 'Supply calculations, shipment coordination', 'fulfillment', '[]', 'active', datetime('now'), datetime('now')),
  ('reg-011', 'procurement_agent', 'Procurement Agent', 'business', 'Procurement calculation, supplier coordination', 'procurement', '[]', 'active', datetime('now'), datetime('now')),
  ('reg-012', 'new_products_agent', 'New Products Agent', 'business', 'Niche analysis, unit economics, supplier research', 'new_products', '[]', 'active', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO agent_deployment_environments (id, env_name, description, is_production, created_at)
VALUES
  ('env-001', 'development', 'Local development environment', 0, datetime('now')),
  ('env-002', 'staging', 'Staging environment for testing', 0, datetime('now')),
  ('env-003', 'production', 'Production environment', 1, datetime('now'));

INSERT OR IGNORE INTO agent_roles (id, role_name, description, created_at)
VALUES
  ('role-001', 'owner', 'System owner with full access', datetime('now')),
  ('role-002', 'admin', 'Administrator with management access', datetime('now')),
  ('role-003', 'operator', 'Operator with execution access', datetime('now')),
  ('role-004', 'viewer', 'Read-only access', datetime('now')),
  ('role-005', 'system', 'Internal system role for agents', datetime('now'));
`;
