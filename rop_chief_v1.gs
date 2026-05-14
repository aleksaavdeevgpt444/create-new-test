// ============================================================
// ROP Chief — Head of Sales (v1)
// Build: ai_helpers_rop_chief_v1
//
// AI-шеф отдела продаж (Руководитель Отдела Продаж).
// Отслеживает KPI по SKU и магазину, мониторит конверсии,
// принимает handoff-события от WB Operations и CS Chiefs,
// генерирует управленческие отчёты для Telegram.
//
// ── Новые таблицы ────────────────────────────────────────────
//   rop_kpi_snapshot    — дневные KPI-срезы по артикулам
//   rop_target          — цели по периодам / артикулам
//   rop_insight         — инсайты, риски, алерты
//
// ── Sub-agents ───────────────────────────────────────────────
//   runKpiTrackerAgent_       — считывает wb_sku_snapshot / wb_daily_snapshot
//   runSalesFunnelAgent_      — анализирует конверсию vs. рекламу
//   runTargetMonitorAgent_    — сравнивает KPI с целями
//
// ── Telegram-команды ─────────────────────────────────────────
//   /rop | /rop_report   — запустить Chief, показать отчёт
//   /rop_handoffs        — pending handoffs / инсайты
//   /rop_kpi             — KPI-срез за сегодня
//   /rop_targets         — цели и статусы
//
// ── Callback-префиксы ────────────────────────────────────────
//   rop_confirm_target_<id>  — подтвердить цель
//   rop_skip_insight_<id>    — отклонить инсайт
//
// ── API ──────────────────────────────────────────────────────
//   GET  /agent/rop/handoffs
//   GET  /agent/rop/kpi?date=YYYY-MM-DD
//   GET  /agent/rop/targets
//   POST /agent/rop/report/run
//   POST /agent/rop/targets
//
// Правила безопасности:
//   - НИКОГДА не менять цены автоматически
//   - НИКОГДА не запускать/останавливать рекламу
//   - НИКОГДА не создавать задачи во внешних системах
//   - Все рискованные действия: requires_confirmation = 1
//   - AI только для текста сводки; расчёты — код
//   - "нет данных" ≠ 0 — всегда source_status: 'missing'
//
// Dependencies (globally available):
//   wbGenerateId_(), wbLog_(), wbYesterday_(),
//   wbFormatDate_(), wbRound_(),
//   csEscapeMd_(), csSendTelegramMessage_()
// ============================================================

const ROP_BUILD = 'ai_helpers_rop_chief_v1';
const ROP_CHIEF = 'rop_chief';

const ROP_TREND = {
  GROWING:   'growing',
  STABLE:    'stable',
  DECLINING: 'declining',
  CRITICAL:  'critical',
};

const ROP_TARGET_STATUS = {
  PENDING:   'pending',
  ON_TRACK:  'on_track',
  AT_RISK:   'at_risk',
  MISSED:    'missed',
  ACHIEVED:  'achieved',
};

const ROP_INSIGHT_TYPE = {
  SKU_RISK:        'sku_risk',
  REVENUE_DROP:    'revenue_drop',
  RATING_ALERT:    'rating_alert',
  TOP_PERFORMER:   'top_performer',
  WEEKLY_SUMMARY:  'weekly_summary',
};

const ROP_PRIORITY = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low',
};

// ── Section 1: Schema ─────────────────────────────────────────

async function ensureRopSchema_(db) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS rop_kpi_snapshot (
      id TEXT PRIMARY KEY,
      snapshot_date TEXT NOT NULL,
      nm_id INTEGER NOT NULL,
      vendor_code TEXT,
      sku_title TEXT,
      orders_count INTEGER DEFAULT 0,
      orders_revenue REAL DEFAULT 0,
      returns_count INTEGER DEFAULT 0,
      return_rate REAL DEFAULT 0,
      avg_rating REAL,
      reviews_count INTEGER DEFAULT 0,
      conversion_rate REAL,
      revenue_7d REAL,
      revenue_30d REAL,
      orders_7d INTEGER,
      orders_30d INTEGER,
      trend TEXT DEFAULT 'stable',
      source_status TEXT DEFAULT 'missing',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(snapshot_date, nm_id)
    )`,
    `CREATE TABLE IF NOT EXISTS rop_target (
      id TEXT PRIMARY KEY,
      period TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      nm_id INTEGER,
      vendor_code TEXT,
      metric TEXT NOT NULL,
      target_value REAL NOT NULL,
      current_value REAL,
      deviation_pct REAL,
      status TEXT DEFAULT 'pending',
      confirmation_id TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      confirmed_by TEXT,
      confirmed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS rop_insight (
      id TEXT PRIMARY KEY,
      insight_date TEXT NOT NULL,
      insight_type TEXT NOT NULL,
      nm_id INTEGER,
      vendor_code TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      evidence_json TEXT DEFAULT '[]',
      recommended_action TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'new',
      confirmation_id TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  ];

  for (const sql of tables) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }

  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_rop_kpi_date ON rop_kpi_snapshot(snapshot_date, nm_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rop_target_status ON rop_target(status, period_end)`,
    `CREATE INDEX IF NOT EXISTS idx_rop_insight_date ON rop_insight(insight_date, status)`,
    `CREATE INDEX IF NOT EXISTS idx_rop_insight_nm ON rop_insight(nm_id, status)`,
  ];
  for (const sql of indexes) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
}

// ── Section 2: AI helper ──────────────────────────────────────

async function callRopAi_(env, prompt) {
  // Try Gemini
  if (env.GEMINI_API_KEY) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { text, source: 'gemini' };
      }
    } catch (_) {}
  }

  // Try Groq
  if (env.GROQ_API_KEY) {
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 600,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return { text, source: 'groq' };
      }
    } catch (_) {}
  }

  // Static fallback
  return {
    text: 'AI-анализ недоступен. Данные представлены в табличном формате выше.',
    source: 'fallback',
  };
}

// ── Section 3: KPI Tracker Agent ──────────────────────────────

async function runKpiTrackerAgent_(env, db, date) {
  const snapshots = [];
  let source_status = 'missing';

  let skuRows = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM wb_sku_snapshot WHERE date = ? ORDER BY sales_rub DESC LIMIT 200`
    ).bind(date).all();
    skuRows = res.results || [];
  } catch (_) {}

  if (!skuRows.length) {
    await wbLog_(db, { event_type: 'rop_kpi_no_sku_data', entity_type: 'rop', details_json: JSON.stringify({ date }) });
    return { snapshots: [], source_status: 'missing' };
  }

  source_status = 'partial';

  for (const sku of skuRows) {
    const nmId = parseInt(sku.nm_id, 10);
    if (!nmId) continue;

    // 7d and 30d revenue
    let revenue_7d = null;
    let revenue_30d = null;
    let orders_7d = null;
    let orders_30d = null;

    try {
      const r7 = await db.prepare(
        `SELECT SUM(sales_rub) as rev, SUM(orders_count) as ord FROM wb_sku_snapshot
         WHERE nm_id = ? AND date >= date(?, '-6 days') AND date <= ?`
      ).bind(sku.nm_id, date, date).first();
      revenue_7d = r7?.rev ?? null;
      orders_7d  = r7?.ord ?? null;
    } catch (_) {}

    try {
      const r30 = await db.prepare(
        `SELECT SUM(sales_rub) as rev, SUM(orders_count) as ord FROM wb_sku_snapshot
         WHERE nm_id = ? AND date >= date(?, '-29 days') AND date <= ?`
      ).bind(sku.nm_id, date, date).first();
      revenue_30d = r30?.rev ?? null;
      orders_30d  = r30?.ord ?? null;
    } catch (_) {}

    // Trend classification
    let trend = ROP_TREND.STABLE;
    if (revenue_7d !== null && revenue_30d !== null && revenue_30d > 0) {
      const daily30avg = revenue_30d / 30;
      const daily7avg  = revenue_7d  / 7;
      const ratio      = daily30avg > 0 ? daily7avg / daily30avg : null;
      if (ratio !== null) {
        if (ratio < 0.5)  trend = ROP_TREND.CRITICAL;
        else if (ratio < 0.7) trend = ROP_TREND.DECLINING;
        else if (ratio > 1.2) trend = ROP_TREND.GROWING;
        else                  trend = ROP_TREND.STABLE;
      }
    }

    // Return rate
    const ordersCount  = sku.orders_count || 0;
    const returnsCount = sku.returns_count || 0;
    const return_rate  = ordersCount > 0 ? wbRound_(returnsCount / ordersCount, 4) : 0;

    // Conversion rate (orders / card views) — available only if cr_to_cart present
    const conversion_rate = sku.cr_to_cart ?? null;

    const snap_source = (sku.source_status === 'ready') ? 'ready' : 'partial';

    const id = wbGenerateId_('rkpi');
    const now = new Date().toISOString();

    try {
      await db.prepare(`
        INSERT INTO rop_kpi_snapshot
          (id, snapshot_date, nm_id, vendor_code, sku_title, orders_count, orders_revenue,
           returns_count, return_rate, avg_rating, reviews_count,
           conversion_rate, revenue_7d, revenue_30d, orders_7d, orders_30d,
           trend, source_status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(snapshot_date, nm_id) DO UPDATE SET
          orders_count = excluded.orders_count,
          orders_revenue = excluded.orders_revenue,
          returns_count = excluded.returns_count,
          return_rate = excluded.return_rate,
          avg_rating = excluded.avg_rating,
          reviews_count = excluded.reviews_count,
          conversion_rate = excluded.conversion_rate,
          revenue_7d = excluded.revenue_7d,
          revenue_30d = excluded.revenue_30d,
          orders_7d = excluded.orders_7d,
          orders_30d = excluded.orders_30d,
          trend = excluded.trend,
          source_status = excluded.source_status
      `).bind(
        id, date, nmId, sku.vendor_code || null, sku.title || null,
        ordersCount, sku.sales_rub || 0,
        returnsCount, return_rate,
        null, null,
        conversion_rate, revenue_7d, revenue_30d, orders_7d, orders_30d,
        trend, snap_source, now
      ).run();

      snapshots.push({ nm_id: nmId, vendor_code: sku.vendor_code, sku_title: sku.title, trend, revenue_7d, revenue_30d, source_status: snap_source });
    } catch (e) {
      await wbLog_(db, { event_type: 'rop_kpi_insert_error', entity_type: 'rop', details_json: JSON.stringify({ nm_id: nmId, error: String(e) }) });
    }
  }

  if (snapshots.length === skuRows.length) source_status = 'ready';

  await wbLog_(db, { event_type: 'rop_kpi_tracker_done', entity_type: 'rop', details_json: JSON.stringify({ date, count: snapshots.length, source_status }) });
  return { snapshots, source_status };
}

// ── Section 4: Sales Funnel Agent ─────────────────────────────

async function runSalesFunnelAgent_(env, db, date) {
  const funnel_issues = [];

  let kpiRows = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM rop_kpi_snapshot WHERE snapshot_date = ? AND source_status != 'missing'`
    ).bind(date).all();
    kpiRows = res.results || [];
  } catch (_) {}

  if (!kpiRows.length) return { funnel_issues: [], source_status: 'missing' };

  // Join with ads data
  for (const kpi of kpiRows) {
    let adsRow = null;
    try {
      const r = await db.prepare(
        `SELECT SUM(ad_spend) as spend, AVG(cr) as cr, AVG(drr) as drr
         FROM wb_ads_snapshot WHERE nm_id = ? AND date = ?`
      ).bind(String(kpi.nm_id), date).first();
      adsRow = r || null;
    } catch (_) {}

    if (!adsRow || adsRow.spend === null || adsRow.spend === 0) continue;

    const conversionRate = kpi.conversion_rate;
    const adSpend        = adsRow.spend || 0;
    const drr            = adsRow.drr || 0;

    // High ad spend + low conversion = funnel issue
    const isHighSpend      = adSpend > 5000;
    const isLowConversion  = conversionRate !== null && conversionRate < 0.01;
    const isHighDrr        = drr > 0.35;

    if (isHighSpend && (isLowConversion || isHighDrr)) {
      funnel_issues.push({
        nm_id:        kpi.nm_id,
        vendor_code:  kpi.vendor_code,
        sku_title:    kpi.sku_title,
        ad_spend:     wbRound_(adSpend, 0),
        conversion:   conversionRate !== null ? wbRound_(conversionRate * 100, 2) : null,
        drr_pct:      wbRound_(drr * 100, 1),
        issue:        isLowConversion ? 'low_conversion' : 'high_drr',
        trend:        kpi.trend,
      });
    }
  }

  await wbLog_(db, { event_type: 'rop_funnel_done', entity_type: 'rop', details_json: JSON.stringify({ date, issues: funnel_issues.length }) });
  return { funnel_issues, source_status: 'ready' };
}

// ── Section 5: Target Monitor Agent ──────────────────────────

async function runTargetMonitorAgent_(env, db, date) {
  const alerts = [];

  let targets = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM rop_target WHERE status IN ('pending','on_track','at_risk') ORDER BY created_at DESC`
    ).all();
    targets = res.results || [];
  } catch (_) { return { alerts: [], source_status: 'missing' }; }

  const now = new Date().toISOString().slice(0, 10);

  for (const target of targets) {
    // Find current KPI value
    let currentValue = null;
    try {
      if (target.nm_id) {
        const row = await db.prepare(
          `SELECT * FROM rop_kpi_snapshot WHERE nm_id = ? AND snapshot_date = ?`
        ).bind(target.nm_id, date).first();
        if (row) {
          if (target.metric === 'revenue')     currentValue = row.orders_revenue;
          if (target.metric === 'orders')      currentValue = row.orders_count;
          if (target.metric === 'return_rate') currentValue = row.return_rate;
          if (target.metric === 'rating')      currentValue = row.avg_rating;
        }
      } else {
        // Store-wide: aggregate daily snapshot
        const row = await db.prepare(
          `SELECT * FROM wb_daily_snapshot WHERE date = ?`
        ).bind(date).first();
        if (row) {
          if (target.metric === 'revenue') currentValue = row.total_sales_rub;
          if (target.metric === 'orders')  currentValue = row.total_orders;
        }
      }
    } catch (_) {}

    if (currentValue === null) continue;

    const deviation_pct = target.target_value > 0
      ? wbRound_((currentValue - target.target_value) / target.target_value * 100, 1)
      : null;

    let newStatus = target.status;
    const periodEnded = now > target.period_end;

    if (periodEnded) {
      newStatus = currentValue >= target.target_value ? ROP_TARGET_STATUS.ACHIEVED : ROP_TARGET_STATUS.MISSED;
    } else if (deviation_pct !== null) {
      if (deviation_pct >= 0)        newStatus = ROP_TARGET_STATUS.ON_TRACK;
      else if (deviation_pct > -15)  newStatus = ROP_TARGET_STATUS.ON_TRACK;
      else                           newStatus = ROP_TARGET_STATUS.AT_RISK;
    }

    try {
      await db.prepare(
        `UPDATE rop_target SET current_value=?, deviation_pct=?, status=? WHERE id=?`
      ).bind(currentValue, deviation_pct, newStatus, target.id).run();
    } catch (_) {}

    if ([ROP_TARGET_STATUS.AT_RISK, ROP_TARGET_STATUS.MISSED].includes(newStatus)) {
      alerts.push({
        target_id:    target.id,
        metric:       target.metric,
        nm_id:        target.nm_id || null,
        vendor_code:  target.vendor_code || null,
        target_value: target.target_value,
        current_value: currentValue,
        deviation_pct,
        status:       newStatus,
        period:       target.period,
      });
    }
  }

  await wbLog_(db, { event_type: 'rop_target_monitor_done', entity_type: 'rop', details_json: JSON.stringify({ date, alerts: alerts.length }) });
  return { alerts, source_status: 'ready' };
}

// ── Section 6: Handoff Processing ─────────────────────────────

async function processRopHandoffs_(db) {
  let handoffs = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM handoff_event WHERE to_chief = ? AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY created_at DESC LIMIT 50`
    ).bind(ROP_CHIEF).all();
    handoffs = res.results || [];
  } catch (_) { return { processed: 0 }; }

  let processed = 0;
  const date = new Date().toISOString().slice(0, 10);

  for (const h of handoffs) {
    const insightType = (h.handoff_type === 'rating_drop' || h.handoff_type === 'product_quality_risk')
      ? ROP_INSIGHT_TYPE.RATING_ALERT
      : ROP_INSIGHT_TYPE.SKU_RISK;

    const priority = h.priority === 'critical' ? ROP_PRIORITY.CRITICAL
      : h.priority === 'high' ? ROP_PRIORITY.HIGH
      : ROP_PRIORITY.MEDIUM;

    const insightId = wbGenerateId_('rins');
    const confirmId = `rop_insight_${h.nm_id || 'store'}_${Date.now().toString(36)}`;
    const evidence  = (() => { try { return JSON.parse(h.evidence_json || '[]'); } catch (_) { return []; } })();

    try {
      await db.prepare(`
        INSERT INTO rop_insight
          (id, insight_date, insight_type, nm_id, vendor_code, title, summary,
           evidence_json, recommended_action, priority, status,
           confirmation_id, requires_confirmation, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        insightId, date, insightType,
        h.nm_id || null, h.sku_title || null,
        h.title, h.summary || null,
        JSON.stringify(evidence),
        h.recommended_action || 'Требуется управленческое решение',
        priority, 'new',
        confirmId, 1,
        new Date().toISOString()
      ).run();

      // Mark handoff acknowledged
      await db.prepare(
        `UPDATE handoff_event SET status='acknowledged', acknowledged_at=datetime('now'),
         acknowledged_by=? WHERE id=?`
      ).bind(ROP_CHIEF, h.id).run();

      processed++;
    } catch (e) {
      await wbLog_(db, { event_type: 'rop_handoff_process_error', entity_type: 'rop', details_json: JSON.stringify({ handoff_id: h.id, error: String(e) }) });
    }
  }

  await wbLog_(db, { event_type: 'rop_handoffs_processed', entity_type: 'rop', details_json: JSON.stringify({ processed }) });
  return { processed };
}

// ── Section 7: Proposals ──────────────────────────────────────

async function buildRopProposals_(db, date, insights) {
  const created = [];

  const criticalInsights = insights.filter(i => i.priority === ROP_PRIORITY.CRITICAL || i.priority === ROP_PRIORITY.HIGH);

  for (const ins of criticalInsights.slice(0, 10)) {
    const confirmId = `rop_action_${ins.nm_id || 'store'}_${Date.now().toString(36)}`;
    const id = wbGenerateId_('rprop');

    const action = ins.nm_id
      ? `Проверьте ценообразование и рекламу для SKU ${ins.vendor_code || ins.nm_id}`
      : 'Проверьте общую стратегию продаж';

    try {
      await db.prepare(`
        INSERT INTO rop_insight
          (id, insight_date, insight_type, nm_id, vendor_code, title, summary,
           evidence_json, recommended_action, priority, status,
           confirmation_id, requires_confirmation, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        id, date, ins.insight_type || ROP_INSIGHT_TYPE.SKU_RISK,
        ins.nm_id || null, ins.vendor_code || null,
        `[Предложение] ${ins.title}`,
        ins.summary || null,
        ins.evidence_json || '[]',
        action,
        ins.priority, 'new',
        confirmId, 1,
        new Date().toISOString()
      ).run();
      created.push({ id, confirmation_id: confirmId });
    } catch (_) {}
  }

  return created;
}

// ── Section 8: Report Builder ─────────────────────────────────

async function buildRopWeeklyReport_(db, date, kpiResult, funnelResult, targetResult) {
  const lines = [];
  const esc = csEscapeMd_;

  lines.push(`*РОП — Еженедельный отчёт*`);
  lines.push(`Дата: ${esc(date)}\n`);

  // Top 5 by revenue
  lines.push(`*ТОП\\-5 SKU по выручке:*`);
  let topSkus = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM rop_kpi_snapshot WHERE snapshot_date = ? ORDER BY orders_revenue DESC LIMIT 5`
    ).bind(date).all();
    topSkus = res.results || [];
  } catch (_) {}

  if (topSkus.length) {
    for (const s of topSkus) {
      const trend_icon = { growing: '📈', stable: '➡️', declining: '📉', critical: '🔻' }[s.trend] || '➡️';
      lines.push(`${trend_icon} ${esc(s.sku_title || String(s.nm_id))} — ${esc(wbRound_(s.orders_revenue, 0) + ' ₽')}`);
    }
  } else {
    lines.push(`_Нет данных \\(source\\_status: missing\\)_`);
  }
  lines.push('');

  // Top 3 declining
  const declining = (kpiResult?.snapshots || [])
    .filter(s => s.trend === ROP_TREND.DECLINING || s.trend === ROP_TREND.CRITICAL)
    .slice(0, 3);
  lines.push(`*Снижающиеся SKU \\(${declining.length}\\):*`);
  if (declining.length) {
    for (const s of declining) {
      const label = s.trend === ROP_TREND.CRITICAL ? '🔻 Критично' : '📉 Снижение';
      lines.push(`${label}: ${esc(s.sku_title || String(s.nm_id))}`);
      if (s.revenue_7d !== null && s.revenue_30d !== null) {
        lines.push(`  7д: ${esc(wbRound_(s.revenue_7d, 0) + ' ₽')} | 30д: ${esc(wbRound_(s.revenue_30d, 0) + ' ₽')}`);
      }
    }
  } else {
    lines.push(`_Снижающихся нет_`);
  }
  lines.push('');

  // Funnel issues
  const funnelIssues = funnelResult?.funnel_issues || [];
  lines.push(`*Проблемы воронки \\(${funnelIssues.length}\\):*`);
  if (funnelIssues.length) {
    for (const f of funnelIssues.slice(0, 5)) {
      lines.push(`⚠️ ${esc(f.sku_title || String(f.nm_id))} — расход ${esc(String(f.ad_spend))} ₽, конверсия ${f.conversion !== null ? esc(String(f.conversion) + '%') : esc('н/д')}`);
    }
  } else {
    lines.push(`_Воронка в норме_`);
  }
  lines.push('');

  // Target status
  const targetAlerts = targetResult?.alerts || [];
  lines.push(`*Цели — алерты \\(${targetAlerts.length}\\):*`);
  if (targetAlerts.length) {
    for (const a of targetAlerts) {
      const icon = a.status === ROP_TARGET_STATUS.MISSED ? '❌' : '⚠️';
      const devStr = a.deviation_pct !== null ? ` \\(${esc(String(a.deviation_pct))}%\\)` : '';
      lines.push(`${icon} ${esc(a.metric)}${a.vendor_code ? ' ' + esc(a.vendor_code) : ''}: ${esc(String(a.status))}${devStr}`);
    }
  } else {
    lines.push(`_Все цели в норме_`);
  }
  lines.push('');

  // Pending insights from handoffs
  let pendingInsights = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM rop_insight WHERE status='new' ORDER BY created_at DESC LIMIT 10`
    ).all();
    pendingInsights = res.results || [];
  } catch (_) {}

  lines.push(`*Активные риски \\(${pendingInsights.length}\\):*`);
  if (pendingInsights.length) {
    for (const ins of pendingInsights.slice(0, 5)) {
      const pIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[ins.priority] || '⚪';
      lines.push(`${pIcon} ${esc(ins.title)}`);
      if (ins.recommended_action) lines.push(`  → ${esc(ins.recommended_action)}`);
    }
    if (pendingInsights.length > 5) lines.push(`_...и ещё ${pendingInsights.length - 5}_`);
  } else {
    lines.push(`_Новых рисков нет_`);
  }

  return lines.join('\n');
}

// ── Section 9: Chief Orchestrator ────────────────────────────

async function runRopChief_(env) {
  const db = env.DB;
  const date = new Date().toISOString().slice(0, 10);

  await ensureRopSchema_(db);

  const kpiResult    = await runKpiTrackerAgent_(env, db, date);
  const funnelResult = await runSalesFunnelAgent_(env, db, date);
  const targetResult = await runTargetMonitorAgent_(env, db, date);
  const handoffResult = await processRopHandoffs_(db);

  // Collect new critical insights for proposals
  let newInsights = [];
  try {
    const res = await db.prepare(
      `SELECT * FROM rop_insight WHERE insight_date = ? AND status = 'new'
       AND priority IN ('critical','high')`
    ).bind(date).all();
    newInsights = res.results || [];
  } catch (_) {}

  const proposalsCreated = await buildRopProposals_(db, date, newInsights);

  const reportText = await buildRopWeeklyReport_(db, date, kpiResult, funnelResult, targetResult);

  // AI summary for the insight section
  if (newInsights.length > 0) {
    const insightSummary = newInsights.slice(0, 5).map(i => `- ${i.title}: ${i.recommended_action || ''}`).join('\n');
    const prompt = `Ты РОП (руководитель отдела продаж) маркетплейса Wildberries. Сделай краткий вывод (2–3 предложения) по следующим рискам:\n${insightSummary}\nНе давай рекомендаций по ценам или рекламе — только управленческое резюме.`;
    const aiResult = await callRopAi_(env, prompt);
    if (aiResult.source !== 'fallback') {
      await wbLog_(db, { event_type: 'rop_ai_summary_ok', entity_type: 'rop', details_json: JSON.stringify({ source: aiResult.source }) });
    }
  }

  // Send Telegram report
  const chatId = env.TELEGRAM_CHAT_ID || env.TELEGRAM_ADMIN_CHAT_ID;
  if (chatId && env.TELEGRAM_BOT_TOKEN) {
    await ropSendSplitMessage_(env.TELEGRAM_BOT_TOKEN, chatId, reportText);
  }

  await wbLog_(db, {
    event_type: 'rop_chief_run_done',
    entity_type: 'rop',
    details_json: JSON.stringify({
      date,
      kpi_count: kpiResult.snapshots.length,
      funnel_issues: funnelResult.funnel_issues.length,
      target_alerts: targetResult.alerts.length,
      handoffs_processed: handoffResult.processed,
      proposals_created: proposalsCreated.length,
    }),
  });

  return {
    date,
    kpi: kpiResult,
    funnel: funnelResult,
    targets: targetResult,
    handoffs: handoffResult,
    proposals: proposalsCreated,
    report_length: reportText.length,
  };
}

// ── Section 10: Telegram helpers ─────────────────────────────

async function ropSendSplitMessage_(token, chatId, text) {
  const MAX = 3800;
  if (text.length <= MAX) {
    await csSendTelegramMessage_(token, chatId, text);
    return;
  }
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = remaining.slice(0, MAX);
    const lastNl = cut.lastIndexOf('\n');
    if (lastNl > 0) cut = cut.slice(0, lastNl);
    chunks.push(cut);
    remaining = remaining.slice(cut.length).replace(/^\n/, '');
  }
  for (const chunk of chunks) {
    await csSendTelegramMessage_(token, chatId, chunk);
  }
}

async function ropSendWithButtons_(token, chatId, text, buttons) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: buttons },
      }),
    });
  } catch (_) {}
}

async function ropAnswerCallback_(token, callbackQueryId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || '', show_alert: false }),
    });
  } catch (_) {}
}

// ── Section 11: Telegram Command Router ──────────────────────

async function routeRopTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim().split(' ')[0].toLowerCase();
  const token = env.TELEGRAM_BOT_TOKEN;
  const db = env.DB;
  const esc = csEscapeMd_;

  if (!text.startsWith('/rop')) return false;

  try {
    await ensureRopSchema_(db);

    if (text === '/rop' || text === '/rop_report') {
      await csSendTelegramMessage_(token, chatId, '⏳ Запускаю РОП\\-отчёт\\.\\.\\.');
      const result = await runRopChief_(env);
      await csSendTelegramMessage_(token, chatId, esc(`Отчёт сформирован. KPI: ${result.kpi.snapshots.length} SKU, предложений: ${result.proposals.length}`));
      return true;
    }

    if (text === '/rop_handoffs') {
      let insights = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM rop_insight WHERE status='new' ORDER BY created_at DESC LIMIT 20`
        ).all();
        insights = res.results || [];
      } catch (_) {}

      if (!insights.length) {
        await csSendTelegramMessage_(token, chatId, '✅ Нет новых инсайтов и handoff\\-событий для РОП\\.');
        return true;
      }

      const lines = [`*Pending РОП инсайты \\(${insights.length}\\)*\n`];
      for (const ins of insights) {
        const pIcon = { critical: '🔴', high: '🟠', medium: '🟡', low: '⚪' }[ins.priority] || '⚪';
        lines.push(`${pIcon} ${esc(ins.title)}`);
        if (ins.recommended_action) lines.push(`  → _${esc(ins.recommended_action)}_`);
        lines.push('');
      }
      await ropSendSplitMessage_(token, chatId, lines.join('\n'));

      // Buttons for critical/high
      for (const ins of insights.filter(i => ['critical', 'high'].includes(i.priority)).slice(0, 5)) {
        await ropSendWithButtons_(token, chatId, esc(ins.title), [[
          { text: '✅ Принять', callback_data: `rop_confirm_target_${ins.id}` },
          { text: '❌ Пропустить', callback_data: `rop_skip_insight_${ins.id}` },
        ]]);
      }
      return true;
    }

    if (text === '/rop_kpi') {
      const date = new Date().toISOString().slice(0, 10);
      let rows = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM rop_kpi_snapshot WHERE snapshot_date = ? ORDER BY orders_revenue DESC LIMIT 20`
        ).bind(date).all();
        rows = res.results || [];
      } catch (_) {}

      if (!rows.length) {
        await csSendTelegramMessage_(token, chatId, `_KPI за ${esc(date)} не найдены\\. source\\_status: missing_`);
        return true;
      }

      const lines = [`*KPI за ${esc(date)}*\n`];
      for (const r of rows) {
        const tIcon = { growing: '📈', stable: '➡️', declining: '📉', critical: '🔻' }[r.trend] || '➡️';
        lines.push(`${tIcon} *${esc(r.sku_title || String(r.nm_id))}*`);
        lines.push(`  Выручка: ${esc(String(wbRound_(r.orders_revenue || 0, 0)))} ₽ | Заказов: ${esc(String(r.orders_count || 0))}`);
        if (r.return_rate) lines.push(`  Возврат: ${esc(String(wbRound_(r.return_rate * 100, 1)))}%`);
        lines.push('');
      }
      await ropSendSplitMessage_(token, chatId, lines.join('\n'));
      return true;
    }

    if (text === '/rop_targets') {
      let targets = [];
      try {
        const res = await db.prepare(
          `SELECT * FROM rop_target WHERE status NOT IN ('achieved','missed') ORDER BY period_end ASC LIMIT 20`
        ).all();
        targets = res.results || [];
      } catch (_) {}

      if (!targets.length) {
        await csSendTelegramMessage_(token, chatId, '📋 Активных целей нет\\.');
        return true;
      }

      const lines = [`*Активные цели РОП \\(${targets.length}\\)*\n`];
      for (const t of targets) {
        const sIcon = { pending: '⏳', on_track: '✅', at_risk: '⚠️', missed: '❌', achieved: '🏆' }[t.status] || '⏳';
        const skuLabel = t.vendor_code ? ` \\[${esc(t.vendor_code)}\\]` : ' \\[магазин\\]';
        lines.push(`${sIcon} ${esc(t.metric)}${skuLabel} — цель: ${esc(String(t.target_value))}`);
        if (t.current_value !== null) {
          lines.push(`  Текущее: ${esc(String(wbRound_(t.current_value, 1)))} | Откл: ${t.deviation_pct !== null ? esc(String(t.deviation_pct) + '%') : esc('н/д')}`);
        }
        lines.push(`  Период: ${esc(t.period_start)} — ${esc(t.period_end)}`);
        lines.push('');
      }
      await ropSendSplitMessage_(token, chatId, lines.join('\n'));
      return true;
    }

  } catch (e) {
    await wbLog_(db, { event_type: 'rop_tg_command_error', entity_type: 'rop', details_json: JSON.stringify({ text, error: String(e) }) });
    await csSendTelegramMessage_(token, chatId, `❌ Ошибка РОП: ${esc(String(e).slice(0, 200))}`);
    return true;
  }

  return false;
}

// ── Section 12: Callback Router ───────────────────────────────

async function routeRopCallbackQuery_(env, cq) {
  const data = cq?.data || '';
  if (!data.startsWith('rop_')) return false;

  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const userId = String(cq?.from?.id || '');
  const callbackId = cq.id;

  const answer = (text) => ropAnswerCallback_(token, callbackId, text);

  try {
    if (data.startsWith('rop_confirm_target_')) {
      const id = data.replace('rop_confirm_target_', '');
      const row = await db.prepare(`SELECT * FROM rop_insight WHERE id=?`).bind(id).first().catch(() => null);
      if (!row) { await answer('Не найдено'); return true; }
      if (row.status !== 'new') { await answer('Уже обработано'); return true; }

      await db.prepare(
        `UPDATE rop_insight SET status='acknowledged' WHERE id=?`
      ).bind(id).run();
      await wbLog_(db, { event_type: 'rop_insight_confirmed', entity_type: 'rop', details_json: JSON.stringify({ id, user: userId }) });
      await answer('✅ Инсайт принят в работу');
      return true;
    }

    if (data.startsWith('rop_skip_insight_')) {
      const id = data.replace('rop_skip_insight_', '');
      const row = await db.prepare(`SELECT * FROM rop_insight WHERE id=?`).bind(id).first().catch(() => null);
      if (!row) { await answer('Не найдено'); return true; }
      if (row.status !== 'new') { await answer('Уже обработано'); return true; }

      await db.prepare(
        `UPDATE rop_insight SET status='dismissed' WHERE id=?`
      ).bind(id).run();
      await wbLog_(db, { event_type: 'rop_insight_dismissed', entity_type: 'rop', details_json: JSON.stringify({ id, user: userId }) });
      await answer('❌ Инсайт отклонён');
      return true;
    }

    if (data.startsWith('rop_confirm_target_')) {
      const id = data.replace('rop_confirm_target_', '');
      const target = await db.prepare(`SELECT * FROM rop_target WHERE id=?`).bind(id).first().catch(() => null);
      if (!target) { await answer('Не найдено'); return true; }
      if (target.confirmed_at) { await answer('Уже подтверждено'); return true; }

      await db.prepare(
        `UPDATE rop_target SET confirmed_by=?, confirmed_at=datetime('now'), requires_confirmation=0 WHERE id=?`
      ).bind(userId, id).run();
      await wbLog_(db, { event_type: 'rop_target_confirmed', entity_type: 'rop', details_json: JSON.stringify({ id, user: userId }) });
      await answer('✅ Цель подтверждена');
      return true;
    }
  } catch (e) {
    await wbLog_(db, { event_type: 'rop_callback_error', entity_type: 'rop', details_json: JSON.stringify({ data, error: String(e) }) });
    await answer('Ошибка');
  }

  return false;
}

// ── Section 13: API Routes ────────────────────────────────────

async function handleRopRoutes_(env, request) {
  const url  = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;

  if (!path.startsWith('/agent/rop')) return null;

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  try {
    await ensureRopSchema_(db);

    // GET /agent/rop/handoffs — pending insights
    if (path === '/agent/rop/handoffs' && method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const status = url.searchParams.get('status') || 'new';
      const res = await db.prepare(
        `SELECT * FROM rop_insight WHERE status=? ORDER BY created_at DESC LIMIT ?`
      ).bind(status, limit).all();
      const insights = res.results || [];
      return json({ ok: true, insights, count: insights.length });
    }

    // GET /agent/rop/kpi?date=YYYY-MM-DD
    if (path === '/agent/rop/kpi' && method === 'GET') {
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const res = await db.prepare(
        `SELECT * FROM rop_kpi_snapshot WHERE snapshot_date=? ORDER BY orders_revenue DESC`
      ).bind(date).all();
      const snapshots = res.results || [];
      return json({ ok: true, date, snapshots, count: snapshots.length });
    }

    // GET /agent/rop/targets
    if (path === '/agent/rop/targets' && method === 'GET') {
      const status = url.searchParams.get('status') || null;
      let q = `SELECT * FROM rop_target WHERE 1=1`;
      const params = [];
      if (status) { q += ` AND status=?`; params.push(status); }
      q += ` ORDER BY period_end ASC LIMIT 100`;
      const res = await db.prepare(q).bind(...params).all();
      const targets = res.results || [];
      return json({ ok: true, targets, count: targets.length });
    }

    // POST /agent/rop/report/run
    if (path === '/agent/rop/report/run' && method === 'POST') {
      const result = await runRopChief_(env);
      return json({ ok: true, ...result });
    }

    // POST /agent/rop/targets — create new target
    if (path === '/agent/rop/targets' && method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch (_) {}

      const { period, nm_id, vendor_code, metric, target_value, period_start, period_end } = body;
      if (!period || !metric || target_value === undefined || target_value === null) {
        return json({ ok: false, error: 'period, metric, target_value required' }, 400);
      }

      const id = wbGenerateId_('rtar');
      const now = new Date().toISOString().slice(0, 10);
      const pStart = period_start || now;
      const pEnd   = period_end || (period === 'weekly'
        ? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
        : new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
      const confirmId = `rop_target_${nm_id || 'store'}_${Date.now().toString(36)}`;

      await db.prepare(`
        INSERT INTO rop_target
          (id, period, period_start, period_end, nm_id, vendor_code, metric,
           target_value, status, confirmation_id, requires_confirmation, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        id, period, pStart, pEnd,
        nm_id ? parseInt(nm_id, 10) : null,
        vendor_code || null, metric,
        parseFloat(target_value),
        ROP_TARGET_STATUS.PENDING,
        confirmId, 1,
        new Date().toISOString()
      ).run();

      await wbLog_(db, { event_type: 'rop_target_created', entity_type: 'rop', details_json: JSON.stringify({ id, metric, period }) });
      return json({ ok: true, id, confirmation_id: confirmId, requires_confirmation: true });
    }

  } catch (e) {
    await wbLog_(db, { event_type: 'rop_api_error', entity_type: 'rop', details_json: JSON.stringify({ path, method, error: String(e) }) });
    return json({ ok: false, error: String(e) }, 500);
  }

  return null;
}
