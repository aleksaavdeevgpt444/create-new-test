// ============================================================
// WB Ads Chief — Advertising Analytics  v1
// Build: ai_helpers_wb_ads_chief_v1
//
// Multi-day campaign performance analysis using wb_ads_snapshot.
// No new WB API calls — reads from D1 snapshots populated by
// wb_sync_v1.gs / wb_api_client_v1.gs.
//
// ── Analysis ─────────────────────────────────────────────────
//   1. Campaign efficiency ranking (CPO, DRR, CTR)
//   2. Waste detection: spend > 0, orders = 0 for N+ days
//   3. Scale opportunities: DRR < threshold, consistent CTR
//   4. Budget concentration (top-3 campaigns vs total)
//   5. Per-SKU ad spend attribution
//
// ── Telegram commands ─────────────────────────────────────────
//   /ads_report      — today's ad summary with top issues
//   /ads_campaigns   — 7-day campaign efficiency ranking
//   /ads_waste       — campaigns wasting budget (spend, 0 orders)
//   /ads_sku <nm_id> — per-SKU ad attribution
//
// ── REST API ─────────────────────────────────────────────────
//   GET /agent/ads/report          — today's analysis JSON
//   GET /agent/ads/campaigns       — 7-day campaign ranking
//   GET /agent/ads/waste           — waste detection
//   GET /agent/ads/sku/:nm_id      — per-SKU ad data
//
// ── Safety ───────────────────────────────────────────────────
//   Read-only. All recommendations require_confirmation=true.
//   No automated budget changes. No automated campaign pauses.
// ============================================================

const WB_ADS_CHIEF_BUILD = 'ai_helpers_wb_ads_chief_v1';

// Thresholds
const ADS_WASTE_MIN_DAYS       = 3;    // days of spend with 0 orders = wasted
const ADS_SCALE_MAX_DRR        = 0.10; // 10% DRR — good enough to scale
const ADS_SCALE_MIN_ORDERS     = 3;    // minimum orders to consider scaling
const ADS_HIGH_DRR_THRESHOLD   = 0.40; // 40% DRR — high
const ADS_CRITICAL_DRR         = 0.60; // 60% DRR — critical
const ADS_LOW_CTR_THRESHOLD    = 0.003; // 0.3% CTR — card quality issue

// ── Core data queries ──────────────────────────────────────────────────────

async function adsCampaignPeriodStats_(db, startDate, endDate) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        campaign_id,
        MAX(campaign_name) AS campaign_name,
        COUNT(DISTINCT date)  AS days_active,
        COUNT(DISTINCT nm_id) AS skus_count,
        SUM(ad_spend)         AS total_spend,
        SUM(ad_orders)        AS total_orders,
        SUM(impressions)      AS total_impressions,
        SUM(clicks)           AS total_clicks,
        AVG(CASE WHEN drr IS NOT NULL THEN drr END) AS avg_drr,
        AVG(CASE WHEN ctr IS NOT NULL THEN ctr END) AS avg_ctr,
        AVG(CASE WHEN cpc IS NOT NULL THEN cpc END) AS avg_cpc,
        SUM(CASE WHEN ad_spend > 0 AND ad_orders = 0 THEN 1 ELSE 0 END) AS zero_order_days
      FROM wb_ads_snapshot
      WHERE date BETWEEN ? AND ?
      GROUP BY campaign_id
      ORDER BY total_spend DESC
    `).bind(startDate, endDate).all();
    return results;
  } catch (_) { return []; }
}

async function adsWastedCampaigns_(db, startDate, endDate, minDays) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        campaign_id,
        MAX(campaign_name) AS campaign_name,
        COUNT(DISTINCT date) AS days_with_spend,
        SUM(ad_spend)        AS total_spend,
        SUM(ad_orders)       AS total_orders
      FROM wb_ads_snapshot
      WHERE date BETWEEN ? AND ? AND ad_spend > 0
      GROUP BY campaign_id
      HAVING total_orders = 0 AND days_with_spend >= ?
      ORDER BY total_spend DESC
    `).bind(startDate, endDate, minDays).all();
    return results;
  } catch (_) { return []; }
}

async function adsDaySummary_(db, date) {
  try {
    const row = await db.prepare(`
      SELECT
        COUNT(DISTINCT campaign_id) AS campaigns_count,
        COUNT(DISTINCT nm_id)       AS skus_with_ads,
        COALESCE(SUM(ad_spend),  0) AS total_spend,
        COALESCE(SUM(ad_orders), 0) AS total_orders,
        COALESCE(SUM(impressions), 0) AS total_impressions,
        COALESCE(SUM(clicks),    0) AS total_clicks,
        COUNT(CASE WHEN ads_status = 'critical' THEN 1 END) AS critical_count,
        COUNT(CASE WHEN ads_status = 'risk'     THEN 1 END) AS risk_count
      FROM wb_ads_snapshot
      WHERE date = ?
    `).bind(date).first();
    return row || {};
  } catch (_) { return {}; }
}

async function adsSkuBreakdown_(db, nmId, days) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        date,
        campaign_id,
        MAX(campaign_name) AS campaign_name,
        SUM(ad_spend)      AS spend,
        SUM(ad_orders)     AS orders,
        SUM(impressions)   AS impressions,
        AVG(ctr)           AS ctr,
        AVG(drr)           AS drr,
        MAX(ads_status)    AS ads_status
      FROM wb_ads_snapshot
      WHERE nm_id = ?
      GROUP BY date, campaign_id
      ORDER BY date DESC, spend DESC
      LIMIT ?
    `).bind(String(nmId), days * 5).all();
    return results;
  } catch (_) { return []; }
}

// ── Efficiency scoring ─────────────────────────────────────────────────────

function scoreCampaign_(c) {
  const spend  = c.total_spend  || 0;
  const orders = c.total_orders || 0;
  const drr    = c.avg_drr;
  const ctr    = c.avg_ctr;

  if (spend === 0) return { ...c, cpo: null, efficiency: 'no_spend', score: 0 };
  if (orders === 0) return { ...c, cpo: null, efficiency: 'waste',   score: -100 };

  const cpo = wbRound_(spend / orders, 2);

  let efficiency;
  if (drr !== null && drr <= ADS_SCALE_MAX_DRR && orders >= ADS_SCALE_MIN_ORDERS) {
    efficiency = 'scale';
  } else if (drr !== null && drr >= ADS_CRITICAL_DRR) {
    efficiency = 'critical';
  } else if (drr !== null && drr >= ADS_HIGH_DRR_THRESHOLD) {
    efficiency = 'high_drr';
  } else if (ctr !== null && ctr < ADS_LOW_CTR_THRESHOLD) {
    efficiency = 'low_ctr';
  } else {
    efficiency = 'normal';
  }

  // Score: lower CPO + lower DRR = better
  const drrScore   = drr   !== null ? Math.max(0, 100 - drr * 100)   : 50;
  const orderScore = Math.min(orders * 5, 50);
  const score      = drrScore + orderScore;

  return { ...c, cpo, efficiency, score: wbRound_(score, 1) };
}

function classifyScalingOpportunities_(campaigns) {
  return campaigns
    .filter(c => c.efficiency === 'scale')
    .map(c => ({
      campaign_id:   c.campaign_id,
      campaign_name: c.campaign_name || c.campaign_id,
      total_spend:   c.total_spend,
      total_orders:  c.total_orders,
      avg_drr_pct:   c.avg_drr != null ? wbRound_(c.avg_drr * 100, 1) : null,
      avg_ctr_pct:   c.avg_ctr != null ? wbRound_(c.avg_ctr * 100, 2) : null,
      cpo:           c.cpo,
      recommendation: 'Рассмотреть увеличение бюджета — эффективная кампания',
      requires_confirmation: true,
    }));
}

// ── AI enrichment ──────────────────────────────────────────────────────────

async function enrichAdsWithAi_(env, reportData) {
  const { day_summary, wasted, scale_opps, total_efficiency } = reportData;

  const prompt = `Ты — аналитик рекламы на Wildberries. Дай краткий (2-3 предложения) вывод по рекламным кампаниям.

Сегодня:
- Кампаний: ${day_summary.campaigns_count || 0}, SKU с рекламой: ${day_summary.skus_with_ads || 0}
- Общий расход: ${wbRound_(day_summary.total_spend || 0, 0)} ₽
- Заказов: ${day_summary.total_orders || 0}
- Критичных/рисковых: ${(day_summary.critical_count || 0) + (day_summary.risk_count || 0)}

Проблемы (последние 7 дней):
- Кампаний с расходом и 0 заказами: ${wasted.length}
- Потрачено впустую: ${wbRound_(wasted.reduce((s, w) => s + (w.total_spend || 0), 0), 0)} ₽

Возможности:
- Кампаний для масштабирования: ${scale_opps.length}

Дай вывод и 1 конкретный приоритет.`;

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
            generationConfig: { maxOutputTokens: 200, temperature: 0.3 },
          }),
          signal: AbortSignal.timeout(12000),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text.trim();
      }
    } catch (_) {}
  }

  if (env.GROQ_API_KEY) {
    try {
      const base  = env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
      const model = env.GROQ_MODEL    || 'llama3-8b-8192';
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 200,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return text.trim();
      }
    } catch (_) {}
  }

  if (wasted.length > 0) return `${wasted.length} кампаний расходуют бюджет без заказов. Приоритет — остановить или скорректировать их.`;
  if (scale_opps.length > 0) return `${scale_opps.length} кампаний показывают хорошую эффективность. Рассмотрите увеличение бюджета.`;
  return 'Реклама работает в штатном режиме. Контролируйте ДРР по кампаниям.';
}

// ── Main analysis orchestrator ─────────────────────────────────────────────

async function runAdsChief_(env) {
  const db    = env.DB;
  const today = new Date().toISOString().slice(0, 10);

  const periodEnd   = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const periodStart = (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })();

  const [daySummary, periodCampaigns, wasted] = await Promise.all([
    adsDaySummary_(db, periodEnd),
    adsCampaignPeriodStats_(db, periodStart, periodEnd),
    adsWastedCampaigns_(db, periodStart, periodEnd, ADS_WASTE_MIN_DAYS),
  ]);

  const scoredCampaigns = periodCampaigns.map(scoreCampaign_);
  scoredCampaigns.sort((a, b) => b.score - a.score);

  const scaleOpps = classifyScalingOpportunities_(scoredCampaigns);
  const highDrrCampaigns = scoredCampaigns.filter(c => c.efficiency === 'critical' || c.efficiency === 'high_drr');
  const lowCtrCampaigns  = scoredCampaigns.filter(c => c.efficiency === 'low_ctr');

  const totalSpend7d = periodCampaigns.reduce((s, c) => s + (c.total_spend || 0), 0);
  const top3Spend    = scoredCampaigns.slice(0, 3).reduce((s, c) => s + (c.total_spend || 0), 0);
  const concentrationPct = totalSpend7d > 0 ? wbRound_((top3Spend / totalSpend7d) * 100, 1) : 0;

  const reportData = {
    period: { start: periodStart, end: periodEnd },
    day_summary: daySummary,
    campaigns: scoredCampaigns,
    wasted,
    scale_opps: scaleOpps,
    high_drr: highDrrCampaigns,
    low_ctr: lowCtrCampaigns,
    total_spend_7d: wbRound_(totalSpend7d, 2),
    concentration_pct: concentrationPct,
  };

  let ai_commentary = null;
  try {
    ai_commentary = await enrichAdsWithAi_(env, reportData);
  } catch (_) {}

  try {
    await wbLog_(db, {
      source_agent: WB_ADS_CHIEF_BUILD,
      event_type:   'ads_chief_run',
      status:       'success',
      payload: {
        campaigns_count: scoredCampaigns.length,
        wasted_count:    wasted.length,
        scale_opps:      scaleOpps.length,
        total_spend_7d:  reportData.total_spend_7d,
      },
    });
  } catch (_) {}

  return { ...reportData, ai_commentary };
}

// ── Telegram formatting ────────────────────────────────────────────────────

function formatAdsDayReport_(report) {
  const { day_summary: d, wasted, scale_opps, high_drr, total_spend_7d, concentration_pct, ai_commentary, period } = report;

  const spend     = wbRound_(d.total_spend || 0, 0);
  const orders    = d.total_orders || 0;
  const cpo       = orders > 0 ? wbRound_(spend / orders, 0) : null;
  const critRisk  = (d.critical_count || 0) + (d.risk_count || 0);

  const lines = [
    `📣 *Реклама — отчёт (${period.start} — ${period.end})*`,
    '',
    `💰 Расход (7д): *${total_spend_7d.toLocaleString('ru-RU')} ₽*`,
    `📦 Заказов (${period.end}): *${orders}* шт.${cpo ? `  CPO: ${cpo} ₽` : ''}`,
    `🎯 Кампаний: ${d.campaigns_count || 0}  SKU: ${d.skus_with_ads || 0}`,
  ];

  if (concentration_pct >= 70) {
    lines.push(`⚠️ Концентрация: топ-3 кампании = ${concentration_pct}% расхода`);
  }

  if (critRisk > 0) {
    lines.push(`\n⚠️ Требуют внимания сегодня: ${critRisk} кампаний`);
  }

  if (wasted.length > 0) {
    const wastedTotal = wbRound_(wasted.reduce((s, w) => s + (w.total_spend || 0), 0), 0);
    lines.push(`\n🚫 *Слив бюджета (${ADS_WASTE_MIN_DAYS}+ дней без заказов):*`);
    for (const w of wasted.slice(0, 4)) {
      lines.push(`  — ${w.campaign_name || w.campaign_id}: ${wbRound_(w.total_spend || 0, 0)} ₽ / ${w.days_with_spend}д`);
    }
    if (wasted.length > 4) lines.push(`  _...и ещё ${wasted.length - 4}_`);
    lines.push(`  Итого: *${wastedTotal.toLocaleString('ru-RU')} ₽* — рекомендуется приостановить`);
  }

  if (high_drr.length > 0) {
    lines.push(`\n❌ *Высокий ДРР:*`);
    for (const c of high_drr.slice(0, 3)) {
      const drr = c.avg_drr != null ? `${wbRound_(c.avg_drr * 100, 1)}%` : '—';
      lines.push(`  — ${c.campaign_name || c.campaign_id}: ДРР ${drr}`);
    }
  }

  if (scale_opps.length > 0) {
    lines.push(`\n✅ *Масштабировать (хорошая эффективность):*`);
    for (const s of scale_opps.slice(0, 3)) {
      lines.push(`  — ${s.campaign_name || s.campaign_id}: ДРР ${s.avg_drr_pct}%, ${s.total_orders} зак.`);
    }
  }

  if (ai_commentary) {
    lines.push('', `_${ai_commentary}_`);
  }

  return lines.join('\n');
}

function formatAdsCampaignList_(campaigns) {
  if (!campaigns.length) return '📣 *Кампании*\n\nДанных нет.';

  const lines = [`📣 *Кампании — эффективность (7 дней)*`, ''];

  const icons = { scale: '🚀', normal: '✅', low_ctr: '📉', high_drr: '⚠️', critical: '❌', waste: '🚫', no_spend: '⏸' };

  for (const c of campaigns.slice(0, 10)) {
    const icon  = icons[c.efficiency] || '•';
    const name  = (c.campaign_name || c.campaign_id || '—').slice(0, 30);
    const spend = wbRound_(c.total_spend || 0, 0);
    const drr   = c.avg_drr != null ? `ДРР ${wbRound_(c.avg_drr * 100, 1)}%` : '';
    const cpo   = c.cpo ? `CPO ${c.cpo}₽` : '';
    const meta  = [drr, cpo].filter(Boolean).join(' / ');
    lines.push(`${icon} ${name}`);
    lines.push(`  ${spend.toLocaleString('ru-RU')} ₽  ${c.total_orders || 0} зак.  ${meta}`);
  }

  if (campaigns.length > 10) {
    lines.push('', `_...и ещё ${campaigns.length - 10} кампаний_`);
  }

  return lines.join('\n');
}

function formatAdsWasteReport_(wasted) {
  if (!wasted.length) return '✅ *Слив бюджета*\n\nНет кампаний с расходом и нулём заказов.';

  const total = wbRound_(wasted.reduce((s, w) => s + (w.total_spend || 0), 0), 0);
  const lines = [`🚫 *Слив бюджета — ${wasted.length} кампаний*`, `Потрачено впустую (7 дней): *${total.toLocaleString('ru-RU')} ₽*`, ''];

  for (const w of wasted) {
    const name = (w.campaign_name || w.campaign_id || '—').slice(0, 35);
    lines.push(`— ${name}`);
    lines.push(`  ${wbRound_(w.total_spend || 0, 0).toLocaleString('ru-RU')} ₽ за ${w.days_with_spend} дн., 0 заказов`);
  }

  lines.push('', '_Рекомендация: проверить настройки таргетинга или приостановить кампании_');
  lines.push('_Все изменения требуют подтверждения_');

  return lines.join('\n');
}

// ── Telegram command router ────────────────────────────────────────────────

async function routeAdsTelegramCommand_(env, msg, chatId, userId) {
  const text    = (msg.text || '').trim().split('@')[0];
  const parts   = text.split(/\s+/);
  const command = parts[0].toLowerCase();

  const sendMsg = (t) => sendTelegramMessage_(env, chatId, t, { parse_mode: 'Markdown' });

  if (command === '/ads_report') {
    await sendMsg('⏳ Анализирую рекламные кампании...');
    try {
      const report = await runAdsChief_(env);
      await sendMsg(formatAdsDayReport_(report));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/ads_campaigns') {
    await sendMsg('⏳ Загружаю рейтинг кампаний...');
    try {
      const periodEnd   = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
      const periodStart = (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })();
      const campaigns = (await adsCampaignPeriodStats_(env.DB, periodStart, periodEnd)).map(scoreCampaign_);
      campaigns.sort((a, b) => b.score - a.score);
      await sendMsg(formatAdsCampaignList_(campaigns));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/ads_waste') {
    await sendMsg('⏳ Ищу неэффективные кампании...');
    try {
      const periodEnd   = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
      const periodStart = (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })();
      const wasted = await adsWastedCampaigns_(env.DB, periodStart, periodEnd, ADS_WASTE_MIN_DAYS);
      await sendMsg(formatAdsWasteReport_(wasted));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/ads_sku') {
    const nmId = parts[1];
    if (!nmId) {
      await sendMsg('Использование: `/ads_sku <nm_id>`');
      return true;
    }
    try {
      const rows = await adsSkuBreakdown_(env.DB, nmId, 7);
      if (!rows.length) {
        await sendMsg(`SKU ${nmId}: данных о рекламе нет.`);
        return true;
      }
      const lines = [`📣 *Реклама SKU ${nmId} — 7 дней*`, ''];
      let prevDate = null;
      for (const r of rows) {
        if (r.date !== prevDate) {
          lines.push(`*${r.date}*`);
          prevDate = r.date;
        }
        const ctrPct  = r.ctr  != null ? `CTR ${wbRound_(r.ctr * 100, 2)}%` : '';
        const drrPct  = r.drr  != null ? `ДРР ${wbRound_(r.drr * 100, 1)}%` : '';
        const name    = (r.campaign_name || r.campaign_id || '—').slice(0, 25);
        lines.push(`  — ${name}: ${wbRound_(r.spend || 0, 0)}₽ / ${r.orders || 0}зак  ${[ctrPct, drrPct].filter(Boolean).join(' ')}`);
      }
      await sendMsg(lines.join('\n'));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  return false;
}

// ── HTTP routes ────────────────────────────────────────────────────────────

async function handleAdsChiefRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;

  if (!pathname.startsWith('/agent/ads')) return null;

  const json = (obj, st) => new Response(JSON.stringify(obj, null, 2), {
    status: st || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

  const periodEnd   = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const periodStart = (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10); })();

  // GET /agent/ads/report
  if (request.method === 'GET' && pathname === '/agent/ads/report') {
    try {
      const report = await runAdsChief_(env);
      return json({ ok: true, ...report });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/ads/campaigns?days=7
  if (request.method === 'GET' && pathname === '/agent/ads/campaigns') {
    try {
      const days    = Math.min(parseInt(url.searchParams.get('days') || '7', 10), 30);
      const start   = (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - (days - 1)); return d.toISOString().slice(0, 10); })();
      const campaigns = (await adsCampaignPeriodStats_(env.DB, start, periodEnd)).map(scoreCampaign_);
      campaigns.sort((a, b) => b.score - a.score);
      return json({ ok: true, period: { start, end: periodEnd }, campaigns });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/ads/waste
  if (request.method === 'GET' && pathname === '/agent/ads/waste') {
    try {
      const minDays = parseInt(url.searchParams.get('min_days') || String(ADS_WASTE_MIN_DAYS), 10);
      const wasted  = await adsWastedCampaigns_(env.DB, periodStart, periodEnd, minDays);
      const total   = wasted.reduce((s, w) => s + (w.total_spend || 0), 0);
      return json({ ok: true, period: { start: periodStart, end: periodEnd }, wasted, total_wasted: wbRound_(total, 2) });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/ads/sku/:nm_id
  const skuMatch = pathname.match(/^\/agent\/ads\/sku\/(.+)$/);
  if (request.method === 'GET' && skuMatch) {
    const nmId = skuMatch[1];
    const days = parseInt(url.searchParams.get('days') || '14', 10);
    try {
      const rows = await adsSkuBreakdown_(env.DB, nmId, Math.min(days, 60));
      return json({ ok: true, nm_id: nmId, days, rows });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/ads/run
  if (request.method === 'POST' && pathname === '/agent/ads/run') {
    try {
      const report = await runAdsChief_(env);
      return json({ ok: true, report });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
