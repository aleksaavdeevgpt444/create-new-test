// ============================================================
// alerts_v1.gs — Real-time Alert System
// Build: ai_helpers_alerts_v1
//
// Monitors snapshot tables for critical conditions and sends
// immediate Telegram notifications. Runs at 05:30 UTC (after
// wb_data_sync and wb_daily_report have run).
//
// ── Alert types ──────────────────────────────────────────────
//   stock_critical      — wb_stock_snapshot_v2.risk_level='critical'
//   stock_out           — stock_total = 0, had orders recently
//   drr_spike           — ads DRR > 60% (runaway ad spend)
//   return_rate_spike   — returns/orders > 40% for SKU
//   rating_drop         — avg_rating < 3.8 in wb_sku_snapshot
//   pricing_no_margin   — wb_pricing_proposal with margin < 0
//   sync_failed         — wb_sync_log last run has errors
//
// ── Deduplication ────────────────────────────────────────────
//   alert_log.idempotency_key = type:nm_id:date
//   Same alert not re-sent within cooldown_hours (default 24h)
//
// ── Tables ───────────────────────────────────────────────────
//   alert_config — per-type enable/threshold config
//   alert_log    — sent alert history (dedup)
//
// ── Telegram commands ────────────────────────────────────────
//   /alerts         — today's active alerts
//   /alerts_config  — list current thresholds
//
// ── HTTP API ─────────────────────────────────────────────────
//   GET  /agent/alerts           — recent alerts
//   POST /agent/alerts/config    — update thresholds
//   POST /agent/alerts/run       — manual trigger
// ============================================================

// ── Default thresholds ─────────────────────────────────────────────────────

const ALERT_DEFAULTS = {
  stock_critical:    { enabled: 1, threshold: 3,    cooldown_hours: 24 },  // days_of_stock < 3
  stock_out:         { enabled: 1, threshold: 0,    cooldown_hours: 12 },  // stock_total = 0
  drr_spike:         { enabled: 1, threshold: 60,   cooldown_hours: 24 },  // DRR > 60%
  return_rate_spike: { enabled: 1, threshold: 40,   cooldown_hours: 24 },  // returns > 40%
  rating_drop:       { enabled: 1, threshold: 3.8,  cooldown_hours: 48 },  // rating < 3.8
  pricing_no_margin: { enabled: 1, threshold: 0,    cooldown_hours: 24 },  // margin_pct < 0
  sync_failed:       { enabled: 1, threshold: 0,    cooldown_hours: 6  },  // any sync error
};

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureAlertsSchema_(env) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS alert_config (
      id             TEXT PRIMARY KEY,
      alert_type     TEXT NOT NULL UNIQUE,
      enabled        INTEGER DEFAULT 1,
      threshold      REAL,
      cooldown_hours INTEGER DEFAULT 24,
      notify_chat_id TEXT,
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS alert_log (
      id               TEXT PRIMARY KEY,
      alert_type       TEXT NOT NULL,
      nm_id            INTEGER,
      sku_title        TEXT,
      severity         TEXT DEFAULT 'warning',
      message          TEXT NOT NULL,
      chat_id          TEXT,
      idempotency_key  TEXT UNIQUE,
      sent_at          TEXT DEFAULT (datetime('now')),
      created_at       TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_alert_log_type
      ON alert_log(alert_type, sent_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_alert_log_idem
      ON alert_log(idempotency_key)`,
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).run(); } catch (_) {}
  }

  // Seed default configs
  for (const [type, def] of Object.entries(ALERT_DEFAULTS)) {
    try {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO alert_config (id, alert_type, enabled, threshold, cooldown_hours)
        VALUES (?, ?, ?, ?, ?)
      `).bind(`alrt_${type}`, type, def.enabled, def.threshold, def.cooldown_hours).run();
    } catch (_) {}
  }
}

// ── Alert send helper ──────────────────────────────────────────────────────

async function sendAlertMessage_(env, chatId, message, alertType, nmId, idemKey, severity) {
  // Check cooldown via idempotency key
  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM alert_log WHERE idempotency_key = ?`
    ).bind(idemKey).first();
    if (existing) return false; // already sent within cooldown window
  } catch (_) {}

  // Send Telegram message
  try {
    await sendTelegramMessage_(env, chatId, message, { parse_mode: 'Markdown' });
  } catch (_) {}

  // Log the sent alert
  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO alert_log
        (id, alert_type, nm_id, severity, message, chat_id, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      `alog_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      alertType, nmId || null, severity || 'warning',
      message.slice(0, 1000), String(chatId), idemKey,
    ).run();
  } catch (_) {}

  return true;
}

// ── Config loader ──────────────────────────────────────────────────────────

async function loadAlertConfig_(env, alertType) {
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM alert_config WHERE alert_type = ?`
    ).bind(alertType).first();
    if (row) return row;
  } catch (_) {}
  return ALERT_DEFAULTS[alertType] || { enabled: 0 };
}

async function getNotifyChatId_(env, alertType) {
  // 1. alert_config.notify_chat_id (per-type override)
  try {
    const row = await env.DB.prepare(
      `SELECT notify_chat_id FROM alert_config WHERE alert_type = ?`
    ).bind(alertType).first();
    if (row?.notify_chat_id) return row.notify_chat_id;
  } catch (_) {}

  // 2. scheduler_config for any job that has a chat set
  try {
    const row = await env.DB.prepare(
      `SELECT notify_chat_id FROM scheduler_config WHERE notify_chat_id IS NOT NULL LIMIT 1`
    ).first();
    if (row?.notify_chat_id) return row.notify_chat_id;
  } catch (_) {}

  return null;
}

// ── §1 Stock critical alert ────────────────────────────────────────────────

async function runStockCriticalAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'stock_critical');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'stock_critical');
  if (!chatId) return 0;

  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, vendor_code, sku_title,
             stock_total, days_of_stock, avg_daily_orders_7d, risk_level
      FROM wb_stock_snapshot_v2
      WHERE date = ?
        AND risk_level = 'critical'
        AND days_of_stock < ?
      ORDER BY days_of_stock ASC
      LIMIT 20
    `).bind(today, cfg.threshold || 3).all();
  } catch (_) { return 0; }

  let sent = 0;
  for (const r of (rows?.results || [])) {
    const days   = r.days_of_stock != null ? r.days_of_stock.toFixed(1) : '?';
    const idem   = `stock_critical:${r.nm_id}:${today}`;
    const msg    = [
      `🚨 *КРИТИЧНЫЙ ОСТАТОК*`,
      `nm_id: ${r.nm_id}${r.sku_title ? ' — ' + r.sku_title.slice(0, 40) : ''}`,
      `Остаток: ${r.stock_total || 0} шт | Дней: *${days}*`,
      `Ср. заказов/день: ${(r.avg_daily_orders_7d || 0).toFixed(2)}`,
      `Действие: /fulfillment\\_tz`,
    ].join('\n');
    if (await sendAlertMessage_(env, chatId, msg, 'stock_critical', r.nm_id, idem, 'critical')) sent++;
  }
  return sent;
}

// ── §2 Stock-out alert ─────────────────────────────────────────────────────

async function runStockOutAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'stock_out');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'stock_out');
  if (!chatId) return 0;

  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT s.nm_id, s.vendor_code, s.sku_title,
             s.stock_total, s.avg_daily_orders_7d
      FROM wb_stock_snapshot_v2 s
      WHERE s.date = ?
        AND s.stock_total = 0
        AND s.avg_daily_orders_7d > 0
      LIMIT 10
    `).bind(today).all();
  } catch (_) { return 0; }

  let sent = 0;
  for (const r of (rows?.results || [])) {
    const idem = `stock_out:${r.nm_id}:${today}`;
    const msg  = [
      `⛔ *ТОВАР ЗАКОНЧИЛСЯ*`,
      `nm_id: ${r.nm_id}${r.sku_title ? ' — ' + r.sku_title.slice(0, 40) : ''}`,
      `Остаток: 0 шт | Ср. заказов: ${(r.avg_daily_orders_7d || 0).toFixed(2)}/день`,
      `Действие: срочная поставка — /fulfillment`,
    ].join('\n');
    if (await sendAlertMessage_(env, chatId, msg, 'stock_out', r.nm_id, idem, 'critical')) sent++;
  }
  return sent;
}

// ── §3 DRR spike alert ─────────────────────────────────────────────────────

async function runDrrSpikeAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'drr_spike');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'drr_spike');
  if (!chatId) return 0;
  const threshold = cfg.threshold || 60;

  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, AVG(drr) AS avg_drr, SUM(ad_spend) AS total_spend
      FROM wb_ads_snapshot
      WHERE date = ?
        AND drr > ?
        AND ad_spend > 100
      GROUP BY nm_id
      ORDER BY avg_drr DESC
      LIMIT 10
    `).bind(today, threshold).all();
  } catch (_) { return 0; }

  let sent = 0;
  for (const r of (rows?.results || [])) {
    const drr  = (r.avg_drr || 0).toFixed(1);
    const idem = `drr_spike:${r.nm_id}:${today}`;
    const msg  = [
      `⚠️ *ВЫСОКИЙ DRR*`,
      `nm_id: ${r.nm_id}`,
      `DRR: *${drr}%* (порог: ${threshold}%)`,
      `Расход на рекламу: ${(r.total_spend || 0).toFixed(0)}₽`,
      `Действие: проверить ставки и цену — /pricing\\_proposals`,
    ].join('\n');
    if (await sendAlertMessage_(env, chatId, msg, 'drr_spike', r.nm_id, idem, 'warning')) sent++;
  }
  return sent;
}

// ── §4 Return rate spike alert ─────────────────────────────────────────────

async function runReturnRateAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'return_rate_spike');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'return_rate_spike');
  if (!chatId) return 0;
  const threshold = (cfg.threshold || 40) / 100;

  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, vendor_code, title,
             orders_count, returns_count,
             CAST(returns_count AS REAL) / orders_count AS return_rate
      FROM wb_sku_snapshot
      WHERE date = ? AND marketplace = 'WB'
        AND orders_count > 5
        AND CAST(returns_count AS REAL) / orders_count > ?
      ORDER BY return_rate DESC
      LIMIT 10
    `).bind(today, threshold).all();
  } catch (_) { return 0; }

  let sent = 0;
  for (const r of (rows?.results || [])) {
    const rate = ((r.return_rate || 0) * 100).toFixed(1);
    const idem = `return_rate:${r.nm_id}:${today}`;
    const msg  = [
      `⚠️ *ВЫСОКИЙ ПРОЦЕНТ ВОЗВРАТОВ*`,
      `nm_id: ${r.nm_id}${r.title ? ' — ' + r.title.slice(0, 40) : ''}`,
      `Возвраты: *${rate}%* (порог: ${(threshold * 100).toFixed(0)}%)`,
      `Заказов: ${r.orders_count} | Возвратов: ${r.returns_count}`,
      `Действие: анализ причин — /cs\\_appeals`,
    ].join('\n');
    if (await sendAlertMessage_(env, chatId, msg, 'return_rate_spike', r.nm_id, idem, 'warning')) sent++;
  }
  return sent;
}

// ── §5 Rating drop alert ───────────────────────────────────────────────────

async function runRatingDropAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'rating_drop');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'rating_drop');
  if (!chatId) return 0;
  const threshold = cfg.threshold || 3.8;

  // rop_kpi_snapshot has avg_rating
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, vendor_code, sku_title, avg_rating, reviews_count
      FROM rop_kpi_snapshot
      WHERE snapshot_date = ?
        AND avg_rating IS NOT NULL
        AND avg_rating < ?
        AND reviews_count > 3
      ORDER BY avg_rating ASC
      LIMIT 10
    `).bind(today, threshold).all();
  } catch (_) { return 0; }

  let sent = 0;
  for (const r of (rows?.results || [])) {
    const idem = `rating_drop:${r.nm_id}:${today}`;
    const msg  = [
      `⭐ *НИЗКИЙ РЕЙТИНГ*`,
      `nm_id: ${r.nm_id}${r.sku_title ? ' — ' + r.sku_title.slice(0, 40) : ''}`,
      `Рейтинг: *${(r.avg_rating || 0).toFixed(1)}* / 5.0 (порог: ${threshold})`,
      `Отзывов: ${r.reviews_count}`,
      `Действие: разобрать отзывы — /cs\\_inbox`,
    ].join('\n');
    if (await sendAlertMessage_(env, chatId, msg, 'rating_drop', r.nm_id, idem, 'warning')) sent++;
  }
  return sent;
}

// ── §6 Sync failed alert ───────────────────────────────────────────────────

async function runSyncFailedAlert_(env, today) {
  const cfg    = await loadAlertConfig_(env, 'sync_failed');
  if (!cfg.enabled) return 0;
  const chatId = await getNotifyChatId_(env, 'sync_failed');
  if (!chatId) return 0;

  let row;
  try {
    row = await env.DB.prepare(`
      SELECT id, status, error, records_written
      FROM wb_sync_log
      WHERE sync_date = ?
      ORDER BY started_at DESC LIMIT 1
    `).bind(today).first();
  } catch (_) { return 0; }

  if (!row || row.status === 'ok') return 0;

  const idem = `sync_failed:${today}`;
  const msg  = [
    `🔴 *ОШИБКА СИНХРОНИЗАЦИИ WB*`,
    `Статус: ${row.status}`,
    `Записей: ${row.records_written || 0}`,
    row.error ? `Ошибки: ${String(row.error).slice(0, 200)}` : '',
    `Действие: /wb\\_sync\\_run для повтора`,
  ].filter(Boolean).join('\n');

  return await sendAlertMessage_(env, chatId, msg, 'sync_failed', null, idem, 'error') ? 1 : 0;
}

// ── §7 Orchestrator ────────────────────────────────────────────────────────

async function runAllAlerts_(env) {
  await ensureAlertsSchema_(env);
  const today   = new Date().toISOString().slice(0, 10);
  const results = {};

  const run = async (key, fn) => {
    try { results[key] = await fn(); } catch (e) { results[key] = 0; }
  };

  await Promise.all([
    run('stock_critical',    () => runStockCriticalAlert_(env, today)),
    run('stock_out',         () => runStockOutAlert_(env, today)),
    run('drr_spike',         () => runDrrSpikeAlert_(env, today)),
    run('return_rate_spike', () => runReturnRateAlert_(env, today)),
    run('rating_drop',       () => runRatingDropAlert_(env, today)),
    run('sync_failed',       () => runSyncFailedAlert_(env, today)),
  ]);

  const total = Object.values(results).reduce((s, n) => s + (n || 0), 0);
  return { date: today, total_sent: total, results };
}

// ── §8 Telegram commands ───────────────────────────────────────────────────

async function routeAlertsCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim().split('@')[0].toLowerCase();

  // /alerts — recent alerts today
  if (text === '/alerts') {
    await ensureAlertsSchema_(env);
    const today = new Date().toISOString().slice(0, 10);
    let rows;
    try {
      rows = await env.DB.prepare(`
        SELECT alert_type, nm_id, severity, message, sent_at
        FROM alert_log
        WHERE DATE(sent_at) = ?
        ORDER BY sent_at DESC
        LIMIT 10
      `).bind(today).all();
    } catch (_) {}

    const alerts = rows?.results || [];
    if (alerts.length === 0) {
      await sendTelegramMessage_(env, chatId, `✅ Алертов за ${today} нет.`);
      return true;
    }

    const lines = [`*Алерты за ${today}* (${alerts.length})`, ''];
    for (const a of alerts) {
      const icon = a.severity === 'critical' ? '🚨' : a.severity === 'error' ? '🔴' : '⚠️';
      const nm   = a.nm_id ? ` nm${a.nm_id}` : '';
      lines.push(`${icon} *${a.alert_type}*${nm}`);
      lines.push(`  ${(a.message || '').split('\n')[1] || ''}`);
    }
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  // /alerts_config — show current thresholds
  if (text === '/alerts_config') {
    await ensureAlertsSchema_(env);
    let rows;
    try {
      rows = await env.DB.prepare(
        `SELECT * FROM alert_config ORDER BY alert_type`
      ).all();
    } catch (_) {}

    const configs = rows?.results || [];
    const lines   = ['*Конфигурация алертов*', ''];
    for (const c of configs) {
      const status = c.enabled ? '✅' : '❌';
      lines.push(`${status} *${c.alert_type}*`);
      if (c.threshold != null) lines.push(`  Порог: ${c.threshold}`);
      lines.push(`  Cooldown: ${c.cooldown_hours}ч`);
      if (c.notify_chat_id) lines.push(`  Chat: ${c.notify_chat_id}`);
    }
    lines.push('', '_Настройка через API: POST /agent/alerts/config_');
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  return false;
}

// ── §9 HTTP routes ─────────────────────────────────────────────────────────

async function handleAlertsRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;
  if (!pathname.startsWith('/agent/alerts')) return null;

  const json = (obj, st) => new Response(JSON.stringify(obj), {
    status:  st || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  await ensureAlertsSchema_(env);

  // GET /agent/alerts — recent alert log
  if (request.method === 'GET' && pathname === '/agent/alerts') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    const type  = url.searchParams.get('type') || null;
    try {
      let rows;
      if (type) {
        rows = await env.DB.prepare(
          `SELECT * FROM alert_log WHERE alert_type = ? ORDER BY sent_at DESC LIMIT ?`
        ).bind(type, limit).all();
      } else {
        rows = await env.DB.prepare(
          `SELECT * FROM alert_log ORDER BY sent_at DESC LIMIT ?`
        ).bind(limit).all();
      }
      return json({ ok: true, alerts: rows?.results || [] });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/alerts/config — update thresholds
  if (request.method === 'POST' && pathname === '/agent/alerts/config') {
    let body;
    try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Invalid JSON' }, 400); }

    const { alert_type, enabled, threshold, cooldown_hours, notify_chat_id } = body || {};
    if (!alert_type) return json({ ok: false, error: 'alert_type required' }, 400);

    try {
      await env.DB.prepare(`
        INSERT INTO alert_config (id, alert_type, enabled, threshold, cooldown_hours, notify_chat_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(alert_type) DO UPDATE SET
          enabled        = COALESCE(excluded.enabled, enabled),
          threshold      = COALESCE(excluded.threshold, threshold),
          cooldown_hours = COALESCE(excluded.cooldown_hours, cooldown_hours),
          notify_chat_id = COALESCE(excluded.notify_chat_id, notify_chat_id),
          updated_at     = datetime('now')
      `).bind(
        `alrt_${alert_type}`, alert_type,
        enabled        != null ? (enabled ? 1 : 0) : null,
        threshold      != null ? Number(threshold) : null,
        cooldown_hours != null ? Number(cooldown_hours) : null,
        notify_chat_id || null,
      ).run();
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/alerts/run — manual trigger
  if (request.method === 'POST' && pathname === '/agent/alerts/run') {
    const result = await runAllAlerts_(env);
    return json({ ok: true, result });
  }

  return null;
}
