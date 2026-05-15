// ============================================================
// WB Returns Analysis  v1
// Build: ai_helpers_wb_returns_v1
//
// Persists WB returns data from the API into D1, computes per-SKU
// return rates and reason breakdowns. Plugs into the wb_sync pipeline.
//
// ── Tables ────────────────────────────────────────────────────
//   wb_returns_log      — raw per-order return records
//   wb_returns_summary  — daily per-SKU aggregated return stats
//
// ── Sync hook ────────────────────────────────────────────────
//   wbSyncReturnsData_(env, syncDate)  — called by runWbDataSync_()
//
// ── Analysis ─────────────────────────────────────────────────
//   1. Return rate per SKU (returns / (orders + returns))
//   2. Return reason breakdown (top reasons globally + per SKU)
//   3. High return rate SKUs (>30% threshold)
//   4. Return spikes vs 7-day average
//
// ── Telegram commands ─────────────────────────────────────────
//   /returns_report    — overall returns summary (last 7 days)
//   /returns_reasons   — top return reasons (last 30 days)
//   /returns_sku <nm_id> — per-SKU return stats + top reasons
//   /returns_risk      — SKUs with return rate >30%
//
// ── REST API ─────────────────────────────────────────────────
//   GET /agent/returns/report          — 7-day summary
//   GET /agent/returns/reasons         — global reason breakdown
//   GET /agent/returns/sku/:nm_id      — per-SKU detail
//   GET /agent/returns/risk            — high return rate SKUs
// ============================================================

const WB_RETURNS_BUILD  = 'ai_helpers_wb_returns_v1';
const RETURNS_HIGH_RATE = 0.30;  // 30% return rate = quality risk
const RETURNS_SPIKE_PCT = 0.50;  // 50% above 7-day avg = spike
const RETURNS_LOOKBACK  = 7;     // default lookback days

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureReturnsSchema_(env) {
  const db = env.DB;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS wb_returns_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        date           TEXT NOT NULL,
        nm_id          TEXT,
        vendor_code    TEXT,
        order_id       TEXT NOT NULL DEFAULT '',
        barcode        TEXT,
        subject_name   TEXT,
        warehouse_name TEXT,
        return_reason  TEXT,
        quantity       INTEGER DEFAULT 1,
        created_at     TEXT DEFAULT (datetime('now')),
        UNIQUE(date, nm_id, order_id)
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_wb_returns_log_date
        ON wb_returns_log(date, nm_id)
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_wb_returns_log_reason
        ON wb_returns_log(return_reason, date)
    `).run();
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS wb_returns_summary (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        date             TEXT NOT NULL,
        nm_id            TEXT NOT NULL,
        vendor_code      TEXT,
        total_returns    INTEGER DEFAULT 0,
        dominant_reason  TEXT,
        reason_breakdown TEXT,
        return_rate      REAL,
        updated_at       TEXT DEFAULT (datetime('now')),
        UNIQUE(date, nm_id)
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_wb_returns_summary_date
        ON wb_returns_summary(date, nm_id)
    `).run();
  } catch (_) {}
}

// ── Sync hook (called by wb_sync_v1.gs) ───────────────────────────────────

async function wbSyncReturnsData_(env, syncDate) {
  await ensureReturnsSchema_(env);
  const db = env.DB;

  let returnsData = { data: [], source_status: 'missing' };
  try {
    if (typeof loadWbReturns_ === 'function') {
      returnsData = await loadWbReturns_(env, syncDate);
    }
  } catch (e) {
    await wbLog_(db, {
      source_agent: WB_RETURNS_BUILD,
      event_type:   'returns_sync_load_error',
      details_json: JSON.stringify({ date: syncDate, error: String(e) }),
    });
    return { ok: false, error: String(e), source_status: 'error' };
  }

  if (!returnsData.data?.length) {
    return { ok: true, source_status: returnsData.source_status, records_written: 0 };
  }

  let written = 0;
  const byNm = {};

  // Write raw rows and aggregate by nm_id
  for (const r of returnsData.data) {
    const nmId = String(r.nm_id || '');
    try {
      await db.prepare(`
        INSERT INTO wb_returns_log
          (date, nm_id, vendor_code, order_id, barcode,
           subject_name, warehouse_name, return_reason, quantity)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(date, nm_id, order_id) DO NOTHING
      `).bind(
        r.date || syncDate,
        nmId,
        r.vendor_code || null,
        r.order_id || '',
        r.barcode || null,
        r.subject_name || null,
        r.warehouse_name || null,
        r.return_reason || null,
        r.quantity || 1,
      ).run();
      written++;
    } catch (_) {}

    if (nmId) {
      if (!byNm[nmId]) byNm[nmId] = { vendor_code: r.vendor_code, total: 0, reasons: {} };
      byNm[nmId].total += r.quantity || 1;
      const reason = r.return_reason || 'не указана';
      byNm[nmId].reasons[reason] = (byNm[nmId].reasons[reason] || 0) + (r.quantity || 1);
    }
  }

  // Write daily summaries
  for (const [nmId, agg] of Object.entries(byNm)) {
    const sortedReasons = Object.entries(agg.reasons).sort((a, b) => b[1] - a[1]);
    const dominantReason = sortedReasons[0]?.[0] || null;

    // Compute return rate using wb_sku_snapshot for same day
    let returnRate = null;
    try {
      const skuRow = await db.prepare(
        `SELECT orders_count FROM wb_sku_snapshot WHERE date = ? AND nm_id = ? LIMIT 1`
      ).bind(syncDate, nmId).first();
      if (skuRow?.orders_count != null) {
        const total = (skuRow.orders_count || 0) + agg.total;
        returnRate = total > 0 ? wbRound_(agg.total / total, 4) : 0;
      }
    } catch (_) {}

    try {
      await db.prepare(`
        INSERT INTO wb_returns_summary
          (date, nm_id, vendor_code, total_returns, dominant_reason,
           reason_breakdown, return_rate, updated_at)
        VALUES (?,?,?,?,?,?,?,datetime('now'))
        ON CONFLICT(date, nm_id) DO UPDATE SET
          total_returns    = excluded.total_returns,
          dominant_reason  = excluded.dominant_reason,
          reason_breakdown = excluded.reason_breakdown,
          return_rate      = excluded.return_rate,
          updated_at       = datetime('now')
      `).bind(
        syncDate, nmId, agg.vendor_code || null,
        agg.total, dominantReason,
        JSON.stringify(Object.fromEntries(sortedReasons)),
        returnRate,
      ).run();
    } catch (_) {}
  }

  await wbLog_(db, {
    source_agent: WB_RETURNS_BUILD,
    event_type:   'returns_sync_ok',
    status:       'success',
    payload: { date: syncDate, records: written, skus: Object.keys(byNm).length },
  });

  return { ok: true, source_status: 'ok', records_written: written, skus_with_returns: Object.keys(byNm).length };
}

// ── Analysis queries ───────────────────────────────────────────────────────

async function getReturnsSummaryPeriod_(db, startDate, endDate) {
  try {
    const row = await db.prepare(`
      SELECT
        COALESCE(SUM(total_returns), 0) AS total_returns,
        COUNT(DISTINCT nm_id)           AS skus_with_returns,
        COUNT(DISTINCT date)            AS days_with_data
      FROM wb_returns_summary
      WHERE date BETWEEN ? AND ?
    `).bind(startDate, endDate).first();
    return row || { total_returns: 0, skus_with_returns: 0, days_with_data: 0 };
  } catch (_) { return { total_returns: 0, skus_with_returns: 0, days_with_data: 0 }; }
}

async function getTopReturnReasons_(db, startDate, endDate, limit) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        return_reason,
        SUM(quantity) AS total_qty,
        COUNT(DISTINCT nm_id) AS skus_affected
      FROM wb_returns_log
      WHERE date BETWEEN ? AND ?
        AND return_reason IS NOT NULL
      GROUP BY return_reason
      ORDER BY total_qty DESC
      LIMIT ?
    `).bind(startDate, endDate, limit || 10).all();
    return results;
  } catch (_) { return []; }
}

async function getHighReturnRateSkus_(db, startDate, endDate, threshold) {
  try {
    const { results = [] } = await db.prepare(`
      SELECT
        nm_id,
        MAX(vendor_code) AS vendor_code,
        AVG(return_rate) AS avg_return_rate,
        SUM(total_returns) AS total_returns,
        MAX(dominant_reason) AS dominant_reason
      FROM wb_returns_summary
      WHERE date BETWEEN ? AND ?
        AND return_rate IS NOT NULL
      GROUP BY nm_id
      HAVING avg_return_rate >= ?
      ORDER BY avg_return_rate DESC
      LIMIT 20
    `).bind(startDate, endDate, threshold || RETURNS_HIGH_RATE).all();
    return results;
  } catch (_) { return []; }
}

async function getSkuReturnHistory_(db, nmId, days) {
  try {
    const { results: summary = [] } = await db.prepare(`
      SELECT date, total_returns, return_rate, dominant_reason, reason_breakdown
      FROM wb_returns_summary
      WHERE nm_id = ?
      ORDER BY date DESC
      LIMIT ?
    `).bind(String(nmId), days).all();

    const { results: reasons = [] } = await db.prepare(`
      SELECT return_reason, SUM(quantity) AS qty
      FROM wb_returns_log
      WHERE nm_id = ?
      GROUP BY return_reason
      ORDER BY qty DESC
      LIMIT 10
    `).bind(String(nmId)).all();

    return { summary, reasons };
  } catch (_) { return { summary: [], reasons: [] }; }
}

async function detectReturnSpikes_(db, date) {
  const prevStart = (() => { const d = new Date(date); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })();
  const prevEnd   = (() => { const d = new Date(date); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();

  try {
    const { results: today = [] } = await db.prepare(`
      SELECT nm_id, total_returns FROM wb_returns_summary WHERE date = ?
    `).bind(date).all();

    const { results: avgRows = [] } = await db.prepare(`
      SELECT nm_id, AVG(total_returns) AS avg_returns
      FROM wb_returns_summary
      WHERE date BETWEEN ? AND ?
      GROUP BY nm_id
    `).bind(prevStart, prevEnd).all();

    const avgMap = {};
    for (const r of avgRows) avgMap[r.nm_id] = r.avg_returns;

    const spikes = [];
    for (const t of today) {
      const avg = avgMap[t.nm_id] || 0;
      if (avg > 0 && t.total_returns > avg * (1 + RETURNS_SPIKE_PCT)) {
        spikes.push({
          nm_id: t.nm_id,
          today_returns: t.total_returns,
          avg_returns:   wbRound_(avg, 1),
          spike_pct:     wbRound_(((t.total_returns - avg) / avg) * 100, 1),
        });
      }
    }
    spikes.sort((a, b) => b.spike_pct - a.spike_pct);
    return spikes;
  } catch (_) { return []; }
}

// ── Main report orchestrator ───────────────────────────────────────────────

async function runReturnsAnalysis_(env) {
  const db    = env.DB;
  const today = new Date().toISOString().slice(0, 10);
  const start = (() => { const d = new Date(); d.setDate(d.getDate() - RETURNS_LOOKBACK); return d.toISOString().slice(0, 10); })();

  const [summary, reasons, highRateSkus, spikes] = await Promise.all([
    getReturnsSummaryPeriod_(db, start, today),
    getTopReturnReasons_(db, start, today, 8),
    getHighReturnRateSkus_(db, start, today, RETURNS_HIGH_RATE),
    detectReturnSpikes_(db, today),
  ]);

  return { date: today, period: { start, end: today }, summary, reasons, high_rate_skus: highRateSkus, spikes };
}

// ── Telegram formatting ────────────────────────────────────────────────────

function formatReturnsReport_(report) {
  const { date, period, summary, reasons, high_rate_skus, spikes } = report;

  const lines = [
    `↩️ *Возвраты — ${period.start} — ${period.end}*`,
    '',
    `📦 Всего возвратов: *${summary.total_returns || 0}*`,
    `🔢 SKU с возвратами: ${summary.skus_with_returns || 0}`,
  ];

  if (spikes.length > 0) {
    lines.push('', `⚠️ *Всплески сегодня (>${Math.round(RETURNS_SPIKE_PCT * 100)}% выше нормы):*`);
    for (const s of spikes.slice(0, 4)) {
      lines.push(`  — SKU ${s.nm_id}: ${s.today_returns} возвр. (+${s.spike_pct}%)`);
    }
  }

  if (high_rate_skus.length > 0) {
    lines.push('', `❌ *Высокий % возвратов (>${Math.round(RETURNS_HIGH_RATE * 100)}%):*`);
    for (const s of high_rate_skus.slice(0, 5)) {
      const pct = s.avg_return_rate != null ? `${wbRound_(s.avg_return_rate * 100, 1)}%` : '—';
      const reason = s.dominant_reason ? ` — "${s.dominant_reason}"` : '';
      lines.push(`  — SKU ${s.nm_id}: ${pct}${reason}`);
    }
  }

  if (reasons.length > 0) {
    lines.push('', '*Топ причин возвратов:*');
    for (const r of reasons.slice(0, 5)) {
      lines.push(`  ${r.total_qty} шт. — ${r.return_reason || 'не указана'} (${r.skus_affected} SKU)`);
    }
  }

  if (!spikes.length && !high_rate_skus.length) {
    lines.push('', '✅ Критичных ситуаций с возвратами нет');
  }

  return lines.join('\n');
}

function formatReturnReasons_(reasons, period) {
  if (!reasons.length) return `↩️ *Причины возвратов*\n\n_Данных нет за ${period.start} — ${period.end}_`;

  const total = reasons.reduce((s, r) => s + (r.total_qty || 0), 0);
  const lines = [`↩️ *Причины возвратов (${period.start} — ${period.end})*`, ''];

  for (const r of reasons) {
    const pct = total > 0 ? wbRound_((r.total_qty / total) * 100, 1) : 0;
    lines.push(`*${r.total_qty}* шт. (${pct}%) — ${r.return_reason || 'не указана'}`);
    lines.push(`  SKU: ${r.skus_affected}`);
  }
  return lines.join('\n');
}

function formatSkuReturns_(nmId, data) {
  const { summary, reasons } = data;
  if (!summary.length) return `↩️ *SKU ${nmId}*\n\nДанных о возвратах нет.`;

  const lines = [`↩️ *Возвраты SKU ${nmId}*`, ''];
  for (const r of summary.slice(0, 10)) {
    const rate = r.return_rate != null ? `${wbRound_(r.return_rate * 100, 1)}%` : '—';
    lines.push(`${r.date}: ${r.total_returns} шт. / ${rate}${r.dominant_reason ? ` — "${r.dominant_reason}"` : ''}`);
  }

  if (reasons.length > 0) {
    lines.push('', '*Частые причины:*');
    for (const r of reasons.slice(0, 5)) {
      lines.push(`  ${r.qty} шт. — ${r.return_reason || 'не указана'}`);
    }
  }

  return lines.join('\n');
}

// ── Telegram command router ────────────────────────────────────────────────

async function routeReturnsTelegramCommand_(env, msg, chatId, userId) {
  const text    = (msg.text || '').trim().split('@')[0];
  const parts   = text.split(/\s+/);
  const command = parts[0].toLowerCase();

  const sendMsg = (t) => sendTelegramMessage_(env, chatId, t, { parse_mode: 'Markdown' });

  if (command === '/returns_report') {
    await sendMsg('⏳ Анализирую возвраты...');
    try {
      const report = await runReturnsAnalysis_(env);
      await sendMsg(formatReturnsReport_(report));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/returns_reasons') {
    try {
      const days  = 30;
      const end   = new Date().toISOString().slice(0, 10);
      const start = (() => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); })();
      const reasons = await getTopReturnReasons_(env.DB, start, end, 10);
      await sendMsg(formatReturnReasons_(reasons, { start, end }));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/returns_sku') {
    const nmId = parts[1];
    if (!nmId) {
      await sendMsg('Использование: `/returns_sku <nm_id>`');
      return true;
    }
    try {
      const data = await getSkuReturnHistory_(env.DB, nmId, 14);
      await sendMsg(formatSkuReturns_(nmId, data));
    } catch (e) {
      await sendMsg(`❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  if (command === '/returns_risk') {
    await sendMsg('⏳ Ищу SKU с высоким % возвратов...');
    try {
      const end   = new Date().toISOString().slice(0, 10);
      const start = (() => { const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString().slice(0, 10); })();
      const skus  = await getHighReturnRateSkus_(env.DB, start, end, RETURNS_HIGH_RATE);
      if (!skus.length) {
        await sendMsg(`✅ *Возвраты в норме*\n\nНет SKU с % возвратов выше ${Math.round(RETURNS_HIGH_RATE * 100)}%`);
        return true;
      }
      const lines = [`❌ *SKU с высоким % возвратов (>${Math.round(RETURNS_HIGH_RATE * 100)}%, 14 дней)*`, ''];
      for (const s of skus) {
        const pct    = s.avg_return_rate != null ? `${wbRound_(s.avg_return_rate * 100, 1)}%` : '—';
        const reason = s.dominant_reason ? `\n  Главная причина: "${s.dominant_reason}"` : '';
        lines.push(`— SKU ${s.nm_id}: ${pct} возвратов, ${s.total_returns} шт.${reason}`);
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

async function handleReturnsRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;

  if (!pathname.startsWith('/agent/returns')) return null;

  const json = (obj, st) => new Response(JSON.stringify(obj, null, 2), {
    status: st || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = (() => { const d = new Date(); d.setDate(d.getDate() - RETURNS_LOOKBACK); return d.toISOString().slice(0, 10); })();

  // GET /agent/returns/report
  if (request.method === 'GET' && pathname === '/agent/returns/report') {
    try {
      const report = await runReturnsAnalysis_(env);
      return json({ ok: true, ...report });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/returns/reasons?days=30
  if (request.method === 'GET' && pathname === '/agent/returns/reasons') {
    try {
      const days  = Math.min(parseInt(url.searchParams.get('days') || '30', 10), 90);
      const start = (() => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); })();
      const reasons = await getTopReturnReasons_(env.DB, start, today, 20);
      return json({ ok: true, period: { start, end: today }, reasons });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/returns/sku/:nm_id
  const skuMatch = pathname.match(/^\/agent\/returns\/sku\/(.+)$/);
  if (request.method === 'GET' && skuMatch) {
    const nmId = skuMatch[1];
    const days = parseInt(url.searchParams.get('days') || '30', 10);
    try {
      const data = await getSkuReturnHistory_(env.DB, nmId, Math.min(days, 90));
      return json({ ok: true, nm_id: nmId, ...data });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/returns/risk?threshold=0.3
  if (request.method === 'GET' && pathname === '/agent/returns/risk') {
    try {
      const threshold = parseFloat(url.searchParams.get('threshold') || String(RETURNS_HIGH_RATE));
      const days  = parseInt(url.searchParams.get('days') || '14', 10);
      const start = (() => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); })();
      const skus  = await getHighReturnRateSkus_(env.DB, start, today, threshold);
      return json({ ok: true, threshold, period: { start, end: today }, skus });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
