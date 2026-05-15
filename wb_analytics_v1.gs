// ============================================================
// WB Analytics — Cross-Period Business Analytics  v1
// Build: ai_helpers_wb_analytics_v1
//
// Reads existing D1 snapshots (populated by wb_sync_v1.gs) and
// computes week-over-week business trends. No extra WB API calls.
//
// ── Reads from ───────────────────────────────────────────────
//   wb_sku_snapshot      — orders, revenue, returns per SKU per day
//   wb_finance_snapshot  — margin, profit, finance_status per SKU
//   wb_ads_snapshot      — ad spend, DRR per campaign per day
//   wb_stock_snapshot_v2 — stock levels
//
// ── New table ────────────────────────────────────────────────
//   wb_analytics_run     — cached weekly/period analytics results
//
// ── Telegram commands ────────────────────────────────────────
//   /analytics        — current week vs previous week summary
//   /week_summary     — same as /analytics (alias)
//   /trends           — top growing and declining SKUs
//   /analytics_sku <nm_id> — 14-day per-SKU trend
//
// ── REST API ─────────────────────────────────────────────────
//   GET /agent/analytics/week         — current week aggregate
//   GET /agent/analytics/trends       — SKU movers
//   GET /agent/analytics/sku/:nm_id   — per-SKU 14-day history
//   POST /agent/analytics/run         — trigger manual run
//
// ── Cron ─────────────────────────────────────────────────────
//   Triggered from runWeeklyInsightsJob_ in scheduler_v1.gs
//   (30 6 * * 1 — every Monday)
// ============================================================

const WB_ANALYTICS_BUILD = 'ai_helpers_wb_analytics_v1';

// Minimum days of data required to compute a meaningful comparison
const WB_ANALYTICS_MIN_DAYS = 3;
// Period length in days for the two comparison windows
const WB_ANALYTICS_PERIOD_DAYS = 7;

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureWbAnalyticsSchema_(env) {
  const db = env.DB;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS wb_analytics_run (
        id                TEXT PRIMARY KEY,
        period_start      TEXT NOT NULL,
        period_end        TEXT NOT NULL,
        period_type       TEXT NOT NULL DEFAULT 'week',
        revenue_cur       REAL,
        revenue_prev      REAL,
        orders_cur        INTEGER,
        orders_prev       INTEGER,
        returns_cur       INTEGER,
        returns_prev      INTEGER,
        ad_spend_cur      REAL,
        ad_spend_prev     REAL,
        avg_margin_cur    REAL,
        avg_margin_prev   REAL,
        net_profit_cur    REAL,
        net_profit_prev   REAL,
        skus_count_cur    INTEGER,
        top_signals_json  TEXT,
        top_growth_json   TEXT,
        top_decline_json  TEXT,
        ai_commentary     TEXT,
        status            TEXT NOT NULL DEFAULT 'ok',
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(period_start, period_end, period_type)
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_wb_analytics_run_period
        ON wb_analytics_run(period_start, period_type)
    `).run();
  } catch (_) {}
}

// ── Date helpers ───────────────────────────────────────────────────────────

function analyticsDateRange_(endDaysAgo, lengthDays) {
  const end   = new Date();
  end.setDate(end.getDate() - endDaysAgo);
  const start = new Date(end);
  start.setDate(start.getDate() - (lengthDays - 1));
  const fmt = d => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// ── Aggregation queries ────────────────────────────────────────────────────

async function aggregatePeriodRevenue_(db, start, end) {
  try {
    const row = await db.prepare(`
      SELECT
        COALESCE(SUM(orders_revenue), 0) AS revenue,
        COALESCE(SUM(orders_count),   0) AS orders,
        COALESCE(SUM(returns_count),  0) AS returns,
        COUNT(DISTINCT nm_id)            AS skus_count,
        COUNT(DISTINCT date)             AS days_with_data
      FROM wb_sku_snapshot
      WHERE date BETWEEN ? AND ?
    `).bind(start, end).first();
    return row || { revenue: 0, orders: 0, returns: 0, skus_count: 0, days_with_data: 0 };
  } catch (_) {
    return { revenue: 0, orders: 0, returns: 0, skus_count: 0, days_with_data: 0 };
  }
}

async function aggregatePeriodFinance_(db, start, end) {
  try {
    const row = await db.prepare(`
      SELECT
        AVG(margin_pct_after_ads)                                    AS avg_margin,
        COALESCE(SUM(profit_after_ads), 0)                          AS net_profit,
        COUNT(CASE WHEN finance_status IN ('loss','critical_loss') THEN 1 END) AS loss_skus,
        COUNT(CASE WHEN finance_status = 'good' THEN 1 END)         AS good_skus
      FROM wb_finance_snapshot
      WHERE date BETWEEN ? AND ?
    `).bind(start, end).first();
    return row || { avg_margin: null, net_profit: 0, loss_skus: 0, good_skus: 0 };
  } catch (_) {
    return { avg_margin: null, net_profit: 0, loss_skus: 0, good_skus: 0 };
  }
}

async function aggregatePeriodAds_(db, start, end) {
  try {
    const row = await db.prepare(`
      SELECT
        COALESCE(SUM(ad_spend),  0) AS total_spend,
        COALESCE(SUM(ad_orders), 0) AS ad_orders,
        COALESCE(SUM(ad_views),  0) AS total_views,
        COUNT(DISTINCT campaign_id) AS campaigns_count
      FROM wb_ads_snapshot
      WHERE date BETWEEN ? AND ?
    `).bind(start, end).first();
    return row || { total_spend: 0, ad_orders: 0, total_views: 0, campaigns_count: 0 };
  } catch (_) {
    return { total_spend: 0, ad_orders: 0, total_views: 0, campaigns_count: 0 };
  }
}

async function getTopSkusByCurrent_(db, start, end, limit) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT nm_id, SUM(orders_revenue) AS revenue, SUM(orders_count) AS orders
      FROM wb_sku_snapshot
      WHERE date BETWEEN ? AND ?
      GROUP BY nm_id
      ORDER BY revenue DESC
      LIMIT ?
    `).bind(start, end, limit).all();
    return results;
  } catch (_) { return []; }
}

async function getSkuRevenueByPeriod_(db, start, end) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT nm_id, SUM(orders_revenue) AS revenue, SUM(orders_count) AS orders
      FROM wb_sku_snapshot
      WHERE date BETWEEN ? AND ?
      GROUP BY nm_id
    `).bind(start, end).all();
    const map = {};
    for (const r of results) map[r.nm_id] = r;
    return map;
  } catch (_) { return {}; }
}

async function computeTopMovers_(db, curStart, curEnd, prevStart, prevEnd) {
  const [curMap, prevMap] = await Promise.all([
    getSkuRevenueByPeriod_(db, curStart, curEnd),
    getSkuRevenueByPeriod_(db, prevStart, prevEnd),
  ]);

  const allNmIds = new Set([...Object.keys(curMap), ...Object.keys(prevMap)]);
  const movers = [];

  for (const nmId of allNmIds) {
    const cur  = curMap[nmId]?.revenue  || 0;
    const prev = prevMap[nmId]?.revenue || 0;
    const delta = cur - prev;
    const deltaPct = prev > 0 ? (delta / prev) * 100 : (cur > 0 ? 100 : 0);
    movers.push({ nm_id: nmId, revenue_cur: cur, revenue_prev: prev, delta, delta_pct: wbRound_(deltaPct, 1) });
  }

  movers.sort((a, b) => b.delta - a.delta);

  const top_growth  = movers.filter(m => m.delta > 0).slice(0, 5);
  const top_decline = movers.filter(m => m.delta < 0).reverse().slice(0, 5);

  return { top_growth, top_decline };
}

// ── Trend signal detection ─────────────────────────────────────────────────

function buildTrendSignals_(cur, prev) {
  const signals = [];

  const revDelta    = prev.revenue.revenue > 0 ? ((cur.revenue.revenue - prev.revenue.revenue) / prev.revenue.revenue) * 100 : null;
  const ordersDelta = prev.revenue.orders  > 0 ? ((cur.revenue.orders  - prev.revenue.orders)  / prev.revenue.orders)  * 100 : null;
  const marginDelta = (cur.finance.avg_margin != null && prev.finance.avg_margin != null)
    ? cur.finance.avg_margin - prev.finance.avg_margin : null;
  const adSpendDelta = prev.ads.total_spend > 0
    ? ((cur.ads.total_spend - prev.ads.total_spend) / prev.ads.total_spend) * 100 : null;
  const returnDelta  = prev.revenue.returns > 0
    ? ((cur.revenue.returns - prev.revenue.returns) / prev.revenue.returns) * 100 : null;

  // Revenue signals
  if (revDelta !== null) {
    if (revDelta >= 15)       signals.push({ type: 'revenue_up',     severity: 'positive', text: `Выручка +${wbRound_(revDelta, 1)}% к прошлой неделе` });
    else if (revDelta <= -15) signals.push({ type: 'revenue_down',   severity: 'negative', text: `Выручка ${wbRound_(revDelta, 1)}% к прошлой неделе` });
    else if (revDelta >= 5)   signals.push({ type: 'revenue_slight_up',  severity: 'positive', text: `Выручка +${wbRound_(revDelta, 1)}%` });
    else if (revDelta <= -5)  signals.push({ type: 'revenue_slight_down', severity: 'warning', text: `Выручка ${wbRound_(revDelta, 1)}%` });
  }

  // Margin signals
  if (marginDelta !== null) {
    if (marginDelta >= 3)      signals.push({ type: 'margin_up',   severity: 'positive', text: `Маржа +${wbRound_(marginDelta, 1)} п.п.` });
    else if (marginDelta <= -3) signals.push({ type: 'margin_down', severity: 'negative', text: `Маржа ${wbRound_(marginDelta, 1)} п.п.` });
  }

  // Ad spend efficiency
  if (adSpendDelta !== null && cur.revenue.revenue > 0 && prev.revenue.revenue > 0) {
    const curDrr  = cur.revenue.revenue  > 0 ? (cur.ads.total_spend  / cur.revenue.revenue)  * 100 : null;
    const prevDrr = prev.revenue.revenue > 0 ? (prev.ads.total_spend / prev.revenue.revenue) * 100 : null;
    if (curDrr !== null && prevDrr !== null) {
      const drrDelta = curDrr - prevDrr;
      if (drrDelta >= 5)       signals.push({ type: 'drr_up',   severity: 'warning',  text: `ДРР вырос до ${wbRound_(curDrr, 1)}% (было ${wbRound_(prevDrr, 1)}%)` });
      else if (drrDelta <= -5) signals.push({ type: 'drr_down', severity: 'positive', text: `ДРР снизился до ${wbRound_(curDrr, 1)}% (было ${wbRound_(prevDrr, 1)}%)` });
    }
  }

  // Returns
  if (returnDelta !== null && cur.revenue.returns > 0) {
    if (returnDelta >= 20) signals.push({ type: 'returns_spike', severity: 'negative', text: `Возвраты +${wbRound_(returnDelta, 1)}%` });
  }

  // Loss SKUs
  if (cur.finance.loss_skus > 0) {
    const prevLoss = prev.finance.loss_skus || 0;
    if (cur.finance.loss_skus > prevLoss + 2) {
      signals.push({ type: 'loss_skus_up', severity: 'negative', text: `Убыточных SKU: ${cur.finance.loss_skus} (было ${prevLoss})` });
    }
  }

  // Orders conversion
  if (ordersDelta !== null && revDelta !== null && ordersDelta < revDelta - 10) {
    signals.push({ type: 'aov_up', severity: 'positive', text: 'Средний чек вырос (заказов меньше, выручка выше)' });
  }

  return {
    revenue_delta_pct: revDelta,
    orders_delta_pct: ordersDelta,
    margin_delta_pts: marginDelta,
    ad_spend_delta_pct: adSpendDelta,
    returns_delta_pct: returnDelta,
    signals,
  };
}

// ── AI enrichment ──────────────────────────────────────────────────────────

async function enrichAnalyticsWithAi_(env, analyticsData) {
  const prompt = `Ты — аналитик WB бизнеса. Проанализируй данные за неделю и дай короткий (3-5 предложений) бизнес-вывод.

Текущая неделя:
- Выручка: ${wbRound_(analyticsData.revenue_cur, 0)} руб. (${analyticsData.revenue_delta_pct !== null ? (analyticsData.revenue_delta_pct >= 0 ? '+' : '') + wbRound_(analyticsData.revenue_delta_pct, 1) + '% к прошлой неделе' : 'нет сравнения'})
- Заказы: ${analyticsData.orders_cur} шт. (${analyticsData.orders_delta_pct !== null ? (analyticsData.orders_delta_pct >= 0 ? '+' : '') + wbRound_(analyticsData.orders_delta_pct, 1) + '%' : '—'})
- Средняя маржа: ${analyticsData.avg_margin_cur !== null ? wbRound_(analyticsData.avg_margin_cur, 1) + '%' : 'нет данных'}
- Расход на рекламу: ${wbRound_(analyticsData.ad_spend_cur, 0)} руб.
- Убыточных SKU: ${analyticsData.loss_skus_cur || 0}

Сигналы: ${(analyticsData.signals || []).map(s => s.text).join('; ') || 'нет существенных отклонений'}

Дай краткий вывод: что произошло, на что обратить внимание, 1 конкретная рекомендация.`;

  // Try Gemini first
  if (env.GEMINI_API_KEY) {
    try {
      const model = env.GEMINI_CLASSIFICATION_MODEL || 'gemini-1.5-flash-latest';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 300, temperature: 0.3 },
          }),
          signal: AbortSignal.timeout(15000),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text.trim();
      }
    } catch (_) {}
  }

  // Fallback: Groq
  if (env.GROQ_API_KEY) {
    try {
      const base = env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
      const model = env.GROQ_MODEL || 'llama3-8b-8192';
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return text.trim();
      }
    } catch (_) {}
  }

  // Static fallback
  const rev = analyticsData.revenue_delta_pct;
  if (rev === null) return 'Данных за прошлую неделю недостаточно для сравнения.';
  if (rev >= 15) return `Сильный рост выручки (+${wbRound_(rev, 1)}%). Продолжайте текущую стратегию.`;
  if (rev <= -15) return `Выручка снизилась на ${wbRound_(Math.abs(rev), 1)}%. Проверьте остатки и рекламные кампании.`;
  return `Стабильная неделя, изменение выручки ${rev >= 0 ? '+' : ''}${wbRound_(rev, 1)}%. Следите за маржой и возвратами.`;
}

// ── Main orchestrator ──────────────────────────────────────────────────────

async function runWbWeeklyAnalytics_(env) {
  await ensureWbAnalyticsSchema_(env);
  const db = env.DB;

  // Current = last 7 days (yesterday inclusive)
  const cur  = analyticsDateRange_(1, WB_ANALYTICS_PERIOD_DAYS);
  // Previous = 7 days before that
  const prev = analyticsDateRange_(1 + WB_ANALYTICS_PERIOD_DAYS, WB_ANALYTICS_PERIOD_DAYS);

  // Parallel queries
  const [
    revCur, revPrev,
    finCur, finPrev,
    adsCur, adsPrev,
    movers,
  ] = await Promise.all([
    aggregatePeriodRevenue_(db, cur.start, cur.end),
    aggregatePeriodRevenue_(db, prev.start, prev.end),
    aggregatePeriodFinance_(db, cur.start, cur.end),
    aggregatePeriodFinance_(db, prev.start, prev.end),
    aggregatePeriodAds_(db, cur.start, cur.end),
    aggregatePeriodAds_(db, prev.start, prev.end),
    computeTopMovers_(db, cur.start, cur.end, prev.start, prev.end),
  ]);

  const hasEnoughData = revCur.days_with_data >= WB_ANALYTICS_MIN_DAYS;

  const trendData = buildTrendSignals_(
    { revenue: revCur, finance: finCur, ads: adsCur },
    { revenue: revPrev, finance: finPrev, ads: adsPrev }
  );

  const analyticsPayload = {
    revenue_cur:       wbRound_(revCur.revenue, 2),
    revenue_prev:      wbRound_(revPrev.revenue, 2),
    orders_cur:        revCur.orders,
    orders_prev:       revPrev.orders,
    returns_cur:       revCur.returns,
    returns_prev:      revPrev.returns,
    ad_spend_cur:      wbRound_(adsCur.total_spend, 2),
    ad_spend_prev:     wbRound_(adsPrev.total_spend, 2),
    avg_margin_cur:    finCur.avg_margin != null ? wbRound_(finCur.avg_margin, 2) : null,
    avg_margin_prev:   finPrev.avg_margin != null ? wbRound_(finPrev.avg_margin, 2) : null,
    net_profit_cur:    wbRound_(finCur.net_profit, 2),
    net_profit_prev:   wbRound_(finPrev.net_profit, 2),
    loss_skus_cur:     finCur.loss_skus,
    skus_count_cur:    revCur.skus_count,
    ...trendData,
  };

  let ai_commentary = null;
  if (hasEnoughData) {
    try {
      ai_commentary = await enrichAnalyticsWithAi_(env, analyticsPayload);
    } catch (_) {}
  }

  const runId = `ana_${Date.now().toString(36)}`;
  try {
    await db.prepare(`
      INSERT INTO wb_analytics_run
        (id, period_start, period_end, period_type,
         revenue_cur, revenue_prev, orders_cur, orders_prev,
         returns_cur, returns_prev, ad_spend_cur, ad_spend_prev,
         avg_margin_cur, avg_margin_prev, net_profit_cur, net_profit_prev,
         skus_count_cur, top_signals_json, top_growth_json, top_decline_json,
         ai_commentary, status, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(period_start, period_end, period_type) DO UPDATE SET
        revenue_cur = excluded.revenue_cur,
        orders_cur  = excluded.orders_cur,
        top_signals_json = excluded.top_signals_json,
        ai_commentary    = excluded.ai_commentary,
        status           = excluded.status
    `).bind(
      runId, cur.start, cur.end, 'week',
      analyticsPayload.revenue_cur,   analyticsPayload.revenue_prev,
      analyticsPayload.orders_cur,    analyticsPayload.orders_prev,
      analyticsPayload.returns_cur,   analyticsPayload.returns_prev,
      analyticsPayload.ad_spend_cur,  analyticsPayload.ad_spend_prev,
      analyticsPayload.avg_margin_cur, analyticsPayload.avg_margin_prev,
      analyticsPayload.net_profit_cur, analyticsPayload.net_profit_prev,
      analyticsPayload.skus_count_cur,
      JSON.stringify(trendData.signals),
      JSON.stringify(movers.top_growth),
      JSON.stringify(movers.top_decline),
      ai_commentary || null,
      hasEnoughData ? 'ok' : 'insufficient_data',
    ).run();
  } catch (e) {
    try {
      await wbLog_(db, {
        source_agent: WB_ANALYTICS_BUILD,
        event_type: 'analytics_save_error',
        details_json: JSON.stringify({ error: String(e) }),
      });
    } catch (_) {}
  }

  return {
    run_id: runId,
    period: cur,
    prev_period: prev,
    has_enough_data: hasEnoughData,
    ...analyticsPayload,
    movers,
    ai_commentary,
  };
}

// ── Per-SKU history ────────────────────────────────────────────────────────

async function getSkuAnalyticsHistory_(db, nmId, days) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        s.date,
        s.orders_count,
        s.orders_revenue,
        s.returns_count,
        f.margin_pct_after_ads AS margin_pct,
        f.profit_after_ads     AS profit,
        f.finance_status
      FROM wb_sku_snapshot s
      LEFT JOIN wb_finance_snapshot f ON f.date = s.date AND f.nm_id = s.nm_id
      WHERE s.nm_id = ?
      ORDER BY s.date DESC
      LIMIT ?
    `).bind(String(nmId), days).all();
    return results;
  } catch (_) { return []; }
}

// ── Telegram formatting ────────────────────────────────────────────────────

function formatDelta_(delta, unit) {
  if (delta === null || delta === undefined) return '—';
  const sign = delta >= 0 ? '▲' : '▼';
  const abs  = Math.abs(wbRound_(delta, 1));
  return `${sign} ${abs}${unit}`;
}

function formatAnalyticsForTelegram_(data) {
  const { revenue_cur, revenue_prev, orders_cur, orders_prev,
    ad_spend_cur, avg_margin_cur, net_profit_cur,
    revenue_delta_pct, orders_delta_pct, margin_delta_pts,
    loss_skus_cur, skus_count_cur, signals, ai_commentary, period } = data;

  const lines = [
    `📊 *Аналитика недели ${period.start} — ${period.end}*`,
    '',
    `💰 Выручка: *${(revenue_cur || 0).toLocaleString('ru-RU')} ₽*  ${formatDelta_(revenue_delta_pct, '%')}`,
    `📦 Заказы: *${orders_cur || 0}*  ${formatDelta_(orders_delta_pct, '%')}`,
    `📈 Маржа: *${avg_margin_cur != null ? avg_margin_cur + '%' : 'нет данных'}*  ${formatDelta_(margin_delta_pts, ' п.п.')}`,
    `📣 Реклама: *${(ad_spend_cur || 0).toLocaleString('ru-RU')} ₽*`,
    `💵 Прибыль (оценка): *${(net_profit_cur || 0).toLocaleString('ru-RU')} ₽*`,
  ];

  if ((loss_skus_cur || 0) > 0) {
    lines.push(`⚠️ Убыточных SKU: *${loss_skus_cur}* из ${skus_count_cur || 0}`);
  }

  if (signals && signals.length > 0) {
    lines.push('', '*Сигналы:*');
    for (const s of signals.slice(0, 5)) {
      const icon = s.severity === 'positive' ? '✅' : s.severity === 'negative' ? '❌' : '⚠️';
      lines.push(`${icon} ${s.text}`);
    }
  }

  if (ai_commentary) {
    lines.push('', '*Вывод AI:*', ai_commentary);
  }

  return lines.join('\n');
}

function formatTopMoversForTelegram_(movers, period) {
  const { top_growth = [], top_decline = [] } = movers;

  const lines = [`🔍 *Топ изменений SKU (${period.start} — ${period.end})*`];

  if (top_growth.length > 0) {
    lines.push('', '📈 *Рост выручки:*');
    for (const s of top_growth) {
      const delta = s.revenue_prev > 0
        ? ` (+${wbRound_((s.delta / s.revenue_prev) * 100, 0)}%)`
        : ' (новый)';
      lines.push(`▸ SKU ${s.nm_id}: ${(s.revenue_cur).toLocaleString('ru-RU')} ₽${delta}`);
    }
  }

  if (top_decline.length > 0) {
    lines.push('', '📉 *Снижение выручки:*');
    for (const s of top_decline) {
      const pct = s.revenue_prev > 0 ? ` (${wbRound_((s.delta / s.revenue_prev) * 100, 0)}%)` : '';
      lines.push(`▸ SKU ${s.nm_id}: ${(s.revenue_cur).toLocaleString('ru-RU')} ₽${pct}`);
    }
  }

  if (top_growth.length === 0 && top_decline.length === 0) {
    lines.push('', '_Недостаточно данных для сравнения_');
  }

  return lines.join('\n');
}

// ── Telegram command router ────────────────────────────────────────────────

async function routeAnalyticsTelegramCommand_(env, msg, chatId, userId) {
  const text    = (msg.text || '').trim().split('@')[0];
  const parts   = text.split(/\s+/);
  const command = parts[0].toLowerCase();

  const sendMsg = (t) => sendTelegramMessage_(env, chatId, t, { parse_mode: 'Markdown' });

  if (command === '/analytics' || command === '/week_summary') {
    await sendMsg('⏳ Вычисляю аналитику недели...');
    try {
      const result = await runWbWeeklyAnalytics_(env);
      if (!result.has_enough_data) {
        await sendMsg('⚠️ Данных меньше 3 дней — сравнение неполное.\n\n' + formatAnalyticsForTelegram_(result));
      } else {
        await sendMsg(formatAnalyticsForTelegram_(result));
      }
    } catch (e) {
      await sendMsg(`❌ Ошибка аналитики: ${e.message}`);
    }
    return true;
  }

  if (command === '/trends') {
    await sendMsg('⏳ Анализирую движение SKU...');
    try {
      const cur  = analyticsDateRange_(1, WB_ANALYTICS_PERIOD_DAYS);
      const prev = analyticsDateRange_(1 + WB_ANALYTICS_PERIOD_DAYS, WB_ANALYTICS_PERIOD_DAYS);
      const movers = await computeTopMovers_(env.DB, cur.start, cur.end, prev.start, prev.end);
      await sendMsg(formatTopMoversForTelegram_(movers, cur));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/analytics_sku') {
    const nmId = parts[1];
    if (!nmId) {
      await sendMsg('Использование: `/analytics_sku <nm_id>`');
      return true;
    }
    try {
      const rows = await getSkuAnalyticsHistory_(env.DB, nmId, 14);
      if (!rows.length) {
        await sendMsg(`SKU ${nmId}: данных в снапшотах нет.`);
        return true;
      }
      const lines = [`📦 *SKU ${nmId} — последние ${rows.length} дней*`, ''];
      for (const r of rows) {
        const margin = r.margin_pct != null ? `${wbRound_(r.margin_pct, 1)}%` : '—';
        const statusIcon = r.finance_status === 'good' ? '✅' : r.finance_status === 'loss' ? '❌' : r.finance_status === 'critical_loss' ? '🔴' : '⚪';
        lines.push(`${r.date}: ${r.orders_count} зак. / ${(r.orders_revenue || 0).toLocaleString('ru-RU')} ₽ / маржа ${margin} ${statusIcon}`);
      }
      await sendMsg(lines.join('\n'));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  return false;
}

// ── HTTP API routes ────────────────────────────────────────────────────────

async function handleAnalyticsRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;

  if (!pathname.startsWith('/agent/analytics')) return null;

  const json = (obj, st) => new Response(JSON.stringify(obj, null, 2), {
    status: st || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

  // GET /agent/analytics/week — current week vs previous week
  if (request.method === 'GET' && pathname === '/agent/analytics/week') {
    try {
      await ensureWbAnalyticsSchema_(env);
      const cur  = analyticsDateRange_(1, WB_ANALYTICS_PERIOD_DAYS);
      const prev = analyticsDateRange_(1 + WB_ANALYTICS_PERIOD_DAYS, WB_ANALYTICS_PERIOD_DAYS);

      // Try to serve cached result first (< 2h old)
      const cached = await env.DB.prepare(`
        SELECT * FROM wb_analytics_run
        WHERE period_start = ? AND period_end = ? AND period_type = 'week'
        AND created_at > datetime('now', '-2 hours')
        ORDER BY created_at DESC LIMIT 1
      `).bind(cur.start, cur.end).first();

      if (cached) {
        return json({ ok: true, cached: true, data: cached });
      }

      const result = await runWbWeeklyAnalytics_(env);
      return json({ ok: true, cached: false, data: result });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/analytics/trends — SKU movers
  if (request.method === 'GET' && pathname === '/agent/analytics/trends') {
    try {
      const cur  = analyticsDateRange_(1, WB_ANALYTICS_PERIOD_DAYS);
      const prev = analyticsDateRange_(1 + WB_ANALYTICS_PERIOD_DAYS, WB_ANALYTICS_PERIOD_DAYS);
      const movers = await computeTopMovers_(env.DB, cur.start, cur.end, prev.start, prev.end);
      return json({ ok: true, period: cur, prev_period: prev, ...movers });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/analytics/sku/:nm_id — per-SKU history
  const skuMatch = pathname.match(/^\/agent\/analytics\/sku\/(.+)$/);
  if (request.method === 'GET' && skuMatch) {
    const nmId = skuMatch[1];
    const days = parseInt(url.searchParams.get('days') || '14', 10);
    try {
      const rows = await getSkuAnalyticsHistory_(env.DB, nmId, Math.min(days, 90));
      return json({ ok: true, nm_id: nmId, days, rows });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/analytics/run — trigger manual run
  if (request.method === 'POST' && pathname === '/agent/analytics/run') {
    try {
      const result = await runWbWeeklyAnalytics_(env);
      return json({ ok: true, result });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
