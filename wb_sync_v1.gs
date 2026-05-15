// ============================================================
// wb_sync_v1.gs — WB Data Synchronisation Pipeline
// Build: ai_helpers_wb_sync_v1
//
// Fetches data from Wildberries API and writes to D1 snapshot
// tables so every chief finds fresh data when it wakes up.
// Runs at 04:30 UTC (after QA at 04:00, before WB chief at 05:00).
//
// ── WB API endpoints used ────────────────────────────────────
// GET statistics-api.wildberries.ru/api/v1/supplier/stocks
// GET statistics-api.wildberries.ru/api/v1/supplier/orders
// GET statistics-api.wildberries.ru/api/v1/supplier/nm-report/grouped
// POST content-api.wildberries.ru/content/v2/get/cards/list
// POST discounts-prices-api.wildberries.ru/api/v2/list/goods/filter
//
// ── Tables written ───────────────────────────────────────────
//   wb_stock_snapshot_v2    — stock levels + avg_daily + urgency
//   wb_sku_snapshot         — order / revenue metrics per nm_id
//   design_card_snapshot    — card content quality metrics
//   wb_cost_data            — price / cost data
//   wb_procurement_snapshot — derived: days_of_stock, reorder qty
//   wb_sync_log             — sync run history
//
// ── Safety rules ─────────────────────────────────────────────
//   - Never writes requires_confirmation records
//   - Never modifies proposals or action records
//   - source_status = 'missing' if WB_API_TOKEN absent
//   - source_status = 'api_error' on network failure
//   - ON CONFLICT … DO UPDATE — safe to re-run
// ============================================================

const WB_SYNC_STATS_BASE   = 'https://statistics-api.wildberries.ru';
const WB_SYNC_CONTENT_BASE = 'https://content-api.wildberries.ru';
const WB_SYNC_PRICES_BASE  = 'https://discounts-prices-api.wildberries.ru';
const WB_SYNC_TIMEOUT_MS   = 25000;

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureWbSyncSchema_(env) {
  try {
    await env.DB.prepare(`
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
      )
    `).run();
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_wb_sync_log_date
        ON wb_sync_log(sync_date, sync_type)
    `).run();
  } catch (_) {}
}

// ── ID helper ──────────────────────────────────────────────────────────────

function wbSyncGenId_(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function wbSyncGet_(token, url) {
  const res = await fetch(url, {
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(WB_SYNC_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} GET ${url}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function wbSyncPost_(token, url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WB_SYNC_TIMEOUT_MS),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} POST ${url}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ── §1 Stock sync → wb_stock_snapshot_v2 ───────────────────────────────────
//
// WB returns one row per (nm_id, warehouse). Aggregate by nm_id:
//   stock_total      = quantity + inWayToClient + inWayFromClient
//   stock_in_transit = inWayToClient   (on the way to buyer)
//   stock_reserved   = inWayFromClient (returns in transit)
// The "available for new orders" qty is `quantity` — stored in
// stock_total for now; avg_daily step refines days_of_stock.

async function wbSyncStocks_(env, syncDate) {
  if (!env.WB_API_TOKEN) return { records: 0, source_status: 'missing' };
  const token  = env.WB_API_TOKEN;
  // WB stocks endpoint needs dateFrom; use 2 days ago to always get current snapshot
  const d2From = new Date(new Date(syncDate).getTime() - 2 * 86400000)
    .toISOString().slice(0, 10);
  const url = `${WB_SYNC_STATS_BASE}/api/v1/supplier/stocks?dateFrom=${d2From}`;

  let rows;
  try {
    rows = await wbSyncGet_(token, url);
  } catch (e) {
    return { records: 0, source_status: 'api_error', error: e.message };
  }
  if (!Array.isArray(rows)) return { records: 0, source_status: 'empty' };

  // Aggregate by nmId across warehouses
  const byNm = {};
  for (const r of rows) {
    const nmId = r.nmId;
    if (!nmId) continue;
    if (!byNm[nmId]) {
      byNm[nmId] = {
        nm_id:           nmId,
        vendor_code:     r.supplierArticle || '',
        sku_title:       r.subjectName || '',
        stock_total:     0,
        stock_in_transit: 0,
        stock_reserved:  0,
      };
    }
    byNm[nmId].stock_total       += (r.quantity || 0) + (r.inWayToClient || 0) + (r.inWayFromClient || 0);
    byNm[nmId].stock_in_transit  += r.inWayToClient  || 0;
    byNm[nmId].stock_reserved    += r.inWayFromClient || 0;
  }

  let written = 0;
  for (const e of Object.values(byNm)) {
    try {
      await env.DB.prepare(`
        INSERT INTO wb_stock_snapshot_v2
          (id, date, nm_id, vendor_code, sku_title,
           stock_total, stock_in_transit, stock_reserved,
           source_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', datetime('now'))
        ON CONFLICT(date, nm_id) DO UPDATE SET
          vendor_code      = excluded.vendor_code,
          sku_title        = excluded.sku_title,
          stock_total      = excluded.stock_total,
          stock_in_transit = excluded.stock_in_transit,
          stock_reserved   = excluded.stock_reserved,
          source_status    = 'ready',
          updated_at       = datetime('now')
      `).bind(
        wbSyncGenId_('stk'), syncDate, e.nm_id,
        e.vendor_code, e.sku_title,
        e.stock_total, e.stock_in_transit, e.stock_reserved,
      ).run();
      written++;
    } catch (_) {}
  }
  return { records: written, source_status: written > 0 ? 'ready' : 'empty' };
}

// ── §2 Orders 7d → avg_daily_orders_7d + days_of_stock ────────────────────
//
// Fetches the last 7 days of non-cancelled orders, counts per nm_id,
// then updates wb_stock_snapshot_v2 with avg_daily, days_of_stock,
// risk_level, stock_status, and recommended_supply_qty.
// Must run AFTER §1 (needs stock_total already written).

async function wbSyncAvgDaily_(env, syncDate) {
  if (!env.WB_API_TOKEN) return { records: 0, source_status: 'missing' };
  const token  = env.WB_API_TOKEN;
  const d7From = new Date(new Date(syncDate).getTime() - 7 * 86400000)
    .toISOString().slice(0, 10);
  const url = `${WB_SYNC_STATS_BASE}/api/v1/supplier/orders?dateFrom=${d7From}&flag=0`;

  let orders;
  try {
    orders = await wbSyncGet_(token, url);
  } catch (e) {
    return { records: 0, source_status: 'api_error', error: e.message };
  }
  if (!Array.isArray(orders)) return { records: 0, source_status: 'empty' };

  // Sum non-cancelled quantities per nm_id
  const countByNm = {};
  for (const o of orders) {
    if (o.isCancel) continue;
    const nm = o.nmId;
    if (!nm) continue;
    countByNm[nm] = (countByNm[nm] || 0) + (o.quantity || 1);
  }

  let updated = 0;
  for (const [nmIdStr, total7d] of Object.entries(countByNm)) {
    const nmId  = Number(nmIdStr);
    const avg7d = total7d / 7;

    try {
      const row = await env.DB.prepare(
        `SELECT stock_total FROM wb_stock_snapshot_v2 WHERE date = ? AND nm_id = ?`
      ).bind(syncDate, nmId).first();

      const stock       = row ? (row.stock_total || 0) : 0;
      const daysOfStock = avg7d > 0 ? stock / avg7d : null;
      const urgency     = !daysOfStock ? 'none'
        : daysOfStock < 3  ? 'critical'
        : daysOfStock < 7  ? 'high'
        : daysOfStock < 14 ? 'medium'
        : daysOfStock < 21 ? 'low' : 'none';
      const stockStatus = !daysOfStock ? 'unknown'
        : daysOfStock < 7  ? 'critical'
        : daysOfStock < 14 ? 'warning' : 'ok';
      // 30-day target supply: keep 30d of stock
      const repQty = avg7d > 0 ? Math.max(0, Math.round(30 * avg7d - stock)) : 0;

      if (row) {
        await env.DB.prepare(`
          UPDATE wb_stock_snapshot_v2
          SET avg_daily_orders_7d  = ?,
              days_of_stock        = ?,
              risk_level           = ?,
              stock_status         = ?,
              recommended_supply_qty = ?,
              updated_at           = datetime('now')
          WHERE date = ? AND nm_id = ?
        `).bind(avg7d, daysOfStock, urgency, stockStatus, repQty, syncDate, nmId).run();
      } else {
        // Stock row not yet written (no WB stock entry) — insert minimal placeholder
        await env.DB.prepare(`
          INSERT OR IGNORE INTO wb_stock_snapshot_v2
            (id, date, nm_id, avg_daily_orders_7d, days_of_stock,
             risk_level, stock_status, recommended_supply_qty,
             source_status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'partial', datetime('now'))
        `).bind(
          wbSyncGenId_('stk'), syncDate, nmId,
          avg7d, daysOfStock, urgency, stockStatus, repQty,
        ).run();
      }
      updated++;
    } catch (_) {}
  }
  return { records: updated, source_status: updated > 0 ? 'ready' : 'empty' };
}

// ── §3 NM grouped report → wb_sku_snapshot ─────────────────────────────────
//
// 30-day aggregated metrics per nm_id: orders, revenue, returns,
// avg_rating, feedbacksCount, conversion. Used by ROP Chief.

async function wbSyncFetchNmPage_(token, dateFrom, dateTo, page) {
  const url = `${WB_SYNC_STATS_BASE}/api/v1/supplier/nm-report/grouped` +
    `?period.begin=${dateFrom}&period.end=${dateTo}` +
    `&aggregationLevel=nm&page=${page}&limit=100`;
  return wbSyncGet_(token, url);
}

async function wbSyncSkuMetrics_(env, syncDate) {
  if (!env.WB_API_TOKEN) return { records: 0, source_status: 'missing' };
  const token   = env.WB_API_TOKEN;
  const d30From = new Date(new Date(syncDate).getTime() - 30 * 86400000)
    .toISOString().slice(0, 10);

  const allCards = [];
  let page = 1;
  while (page <= 30) {
    try {
      const res   = await wbSyncFetchNmPage_(token, d30From, syncDate, page);
      const cards = res?.data?.cards || [];
      allCards.push(...cards);
      if (!res?.data?.isNextPage || cards.length === 0) break;
      page++;
    } catch (_) { break; }
  }

  let written = 0;
  const now = new Date().toISOString();

  for (const card of allCards) {
    const nmId = card.nmID;
    if (!nmId) continue;

    const ordersCount  = card.ordersCount  || 0;
    const returnsCount = card.returnsCount  || 0;
    const salesRub     = card.buyoutsSumRub || card.ordersSumRub || 0;
    const returnRate   = ordersCount > 0 ? returnsCount / ordersCount : 0;
    const skuStatus    = returnRate > 0.3 ? 'risk_high_returns'
      : (card.avgRating != null && card.avgRating < 4) ? 'risk_low_rating' : 'ok';

    try {
      await env.DB.prepare(`
        INSERT INTO wb_sku_snapshot
          (date, marketplace, nm_id, vendor_code, title,
           orders_count, sales_rub, returns_count,
           sku_status, source_status, updated_at)
        VALUES (?, 'WB', ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
        ON CONFLICT(date, marketplace, nm_id) DO UPDATE SET
          orders_count  = excluded.orders_count,
          sales_rub     = excluded.sales_rub,
          returns_count = excluded.returns_count,
          sku_status    = excluded.sku_status,
          source_status = 'ready',
          updated_at    = excluded.updated_at
      `).bind(
        syncDate, String(nmId),
        card.vendorCode || '', card.imtName || '',
        ordersCount, salesRub, returnsCount,
        skuStatus, now,
      ).run();
      written++;
    } catch (_) {}
  }
  return { records: written, source_status: written > 0 ? 'ready' : 'empty' };
}

// ── §4 Card content → design_card_snapshot ─────────────────────────────────
//
// Paginates through the seller's entire card catalogue. For each card,
// computes a quality score and lists concrete issues.
// Used by Design Chief's card content analyser.

async function wbSyncCardContent_(env, syncDate) {
  if (!env.WB_API_TOKEN) return { records: 0, source_status: 'missing' };
  const token = env.WB_API_TOKEN;
  const url   = `${WB_SYNC_CONTENT_BASE}/content/v2/get/cards/list`;

  let cursor  = null;
  let written = 0;
  let page    = 0;

  while (page < 50) {
    let res;
    try {
      res = await wbSyncPost_(token, url, {
        settings: {
          sort:   { ascending: false },
          filter: { withPhoto: -1 },
          cursor: { limit: 100, ...(cursor || {}) },
        },
      });
    } catch (_) { break; }

    const cards = res?.cards || [];
    if (cards.length === 0) break;

    for (const card of cards) {
      const nmId    = card.nmID;
      if (!nmId) continue;
      const titleLen = (card.title        || '').length;
      const descLen  = (card.description  || '').length;
      const photos   = (card.photos       || []).length;
      const chars    = (card.characteristics || []).length;
      const hasVideo = card.video ? 1 : 0;

      const issues = [];
      if (titleLen < 30)  issues.push({ type: 'short_title',         detail: `${titleLen} chars` });
      if (photos   < 5)   issues.push({ type: 'few_photos',          detail: `${photos} photos` });
      if (!hasVideo)      issues.push({ type: 'no_video' });
      if (descLen  < 100) issues.push({ type: 'short_description',   detail: `${descLen} chars` });
      if (chars    < 3)   issues.push({ type: 'few_characteristics', detail: `${chars} chars` });

      const score = Math.max(0, 100 - issues.length * 15);

      try {
        await env.DB.prepare(`
          INSERT INTO design_card_snapshot
            (id, snapshot_date, nm_id, vendor_code, sku_title,
             title_length, description_length, photos_count,
             characteristics_count, has_video,
             title_keywords_json, issues_found_json, overall_score, source_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'ready')
          ON CONFLICT(snapshot_date, nm_id) DO UPDATE SET
            title_length          = excluded.title_length,
            description_length    = excluded.description_length,
            photos_count          = excluded.photos_count,
            characteristics_count = excluded.characteristics_count,
            has_video             = excluded.has_video,
            issues_found_json     = excluded.issues_found_json,
            overall_score         = excluded.overall_score,
            source_status         = 'ready'
        `).bind(
          wbSyncGenId_('dcs'), syncDate, nmId,
          card.vendorCode || '', card.title || '',
          titleLen, descLen, photos, chars, hasVideo,
          JSON.stringify(issues), score,
        ).run();
        written++;
      } catch (_) {}
    }

    const newCursor = res?.cursor;
    if (!newCursor || cards.length < 100) break;
    cursor = { updatedAt: newCursor.updatedAt, nmID: newCursor.nmID, limit: 100 };
    page++;
  }
  return { records: written, source_status: written > 0 ? 'ready' : 'empty' };
}

// ── §5 Prices → wb_cost_data ───────────────────────────────────────────────
//
// Fetches goods with current prices/discounts. Writes the lowest-size
// discounted price as cost_per_unit — a proxy for the buyer price.
// Supplier cost (COGS) should be set manually or from a separate feed.

async function wbSyncCostData_(env, syncDate) {
  if (!env.WB_API_TOKEN) return { records: 0, source_status: 'missing' };
  const token = env.WB_API_TOKEN;
  const url   = `${WB_SYNC_PRICES_BASE}/api/v2/list/goods/filter`;
  const now   = new Date().toISOString();

  let offset  = 0;
  let written = 0;

  while (offset < 5000) {
    let res;
    try {
      res = await wbSyncPost_(token, url, {
        sort:   { ascending: false },
        filter: {},
        cursor: { limit: 100, offset },
      });
    } catch (_) { break; }

    const goods = res?.data?.listGoods || [];
    if (goods.length === 0) break;

    for (const g of goods) {
      const nmId = g.nmID;
      if (!nmId) continue;
      const sizes = g.sizes || [];
      const price = sizes.length > 0
        ? (sizes[0].discountedPrice || sizes[0].price || 0)
        : 0;

      try {
        await env.DB.prepare(`
          INSERT INTO wb_cost_data (nm_id, effective_date, cost_per_unit, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(nm_id, effective_date) DO UPDATE SET
            cost_per_unit = excluded.cost_per_unit,
            updated_at    = excluded.updated_at
        `).bind(String(nmId), syncDate, price, now).run();
        written++;
      } catch (_) {}
    }

    if (goods.length < 100) break;
    offset += 100;
  }
  return { records: written, source_status: written > 0 ? 'ready' : 'empty' };
}

// ── §6 Procurement snapshot (derived, no API call) ─────────────────────────
//
// Reads wb_stock_snapshot_v2 (written in §1–2) and computes:
//   recommended_order_qty = max(0, 45 * avg_daily - stock_total)
//   procurement_status    = 'order_needed' | 'ok' | 'missing_data'
// Used by Procurement Chief's reorder-point agent.

async function wbSyncProcurementSnapshot_(env, syncDate) {
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, vendor_code, sku_title,
             stock_total, avg_daily_orders_7d,
             days_of_stock, risk_level
      FROM wb_stock_snapshot_v2
      WHERE date = ?
    `).bind(syncDate).all();
  } catch (_) {
    return { records: 0, source_status: 'db_error' };
  }

  const entries = rows?.results || [];
  let written   = 0;

  for (const e of entries) {
    const avg7d       = e.avg_daily_orders_7d || 0;
    const stock       = e.stock_total || 0;
    const days        = e.days_of_stock;
    const recommended = avg7d > 0 ? Math.max(0, Math.round(45 * avg7d - stock)) : 0;
    const procStatus  = days == null ? 'missing_data'
      : days < 14    ? 'order_needed' : 'ok';

    try {
      await env.DB.prepare(`
        INSERT INTO wb_procurement_snapshot
          (id, date, nm_id, sku_title, vendor_code,
           avg_daily_orders_30d, days_of_stock,
           recommended_order_qty, procurement_status, source_status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', datetime('now'))
        ON CONFLICT(date, nm_id) DO UPDATE SET
          avg_daily_orders_30d  = excluded.avg_daily_orders_30d,
          days_of_stock         = excluded.days_of_stock,
          recommended_order_qty = excluded.recommended_order_qty,
          procurement_status    = excluded.procurement_status,
          source_status         = 'ready',
          updated_at            = datetime('now')
      `).bind(
        wbSyncGenId_('prsnap'), syncDate, e.nm_id,
        e.sku_title || '', e.vendor_code || '',
        avg7d, days, recommended, procStatus,
      ).run();
      written++;
    } catch (_) {}
  }
  return { records: written, source_status: written > 0 ? 'ready' : 'empty' };
}

// ── §7 Orchestrator ────────────────────────────────────────────────────────

async function runWbDataSync_(env) {
  await ensureWbSyncSchema_(env);

  const syncDate = new Date().toISOString().slice(0, 10);
  const syncId   = wbSyncGenId_('wbsync');
  const startMs  = Date.now();

  try {
    await env.DB.prepare(`
      INSERT INTO wb_sync_log
        (id, sync_date, sync_type, status, started_at)
      VALUES (?, ?, 'full_sync', 'running', datetime('now'))
    `).bind(syncId, syncDate).run();
  } catch (_) {}

  const results    = {};
  const errorParts = [];

  const run = async (key, fn) => {
    try {
      results[key] = await fn();
      if (results[key].error) errorParts.push(`${key}: ${results[key].error}`);
    } catch (e) {
      results[key] = { records: 0, source_status: 'error', error: e.message };
      errorParts.push(`${key}: ${e.message}`);
    }
  };

  // Steps 1–2 are sequential (avg_daily needs stocks written first)
  await run('stocks',      () => wbSyncStocks_(env, syncDate));
  await run('avg_daily',   () => wbSyncAvgDaily_(env, syncDate));

  // Steps 3–5 can run in parallel (independent API sources)
  // Step 7: returns data runs in parallel alongside steps 3–5
  await Promise.all([
    run('sku_metrics', () => wbSyncSkuMetrics_(env, syncDate)),
    run('cards',       () => wbSyncCardContent_(env, syncDate)),
    run('cost_data',   () => wbSyncCostData_(env, syncDate)),
    run('returns',     () => typeof wbSyncReturnsData_ === 'function'
      ? wbSyncReturnsData_(env, syncDate)
      : Promise.resolve({ ok: true, records_written: 0, source_status: 'skipped' })),
  ]);

  // Step 6 is derived from the results of steps 1–2
  await run('procurement', () => wbSyncProcurementSnapshot_(env, syncDate));

  const duration     = Date.now() - startMs;
  const totalRecords = Object.values(results).reduce((s, r) => s + (r.records || 0), 0);
  const status       = errorParts.length > 0 ? 'partial' : 'ok';

  try {
    await env.DB.prepare(`
      UPDATE wb_sync_log
      SET status          = ?,
          finished_at     = datetime('now'),
          duration_ms     = ?,
          records_written = ?,
          error           = ?
      WHERE id = ?
    `).bind(
      status, duration, totalRecords,
      errorParts.length > 0 ? errorParts.join('; ') : null,
      syncId,
    ).run();
  } catch (_) {}

  return {
    sync_id:       syncId,
    sync_date:     syncDate,
    status,
    duration_ms:   duration,
    total_records: totalRecords,
    results,
  };
}

// ── §8 Scheduler job wrapper ───────────────────────────────────────────────

async function runWbSyncJob_(env) {
  return runWbDataSync_(env);
}

// ── §9 HTTP routes ─────────────────────────────────────────────────────────

async function handleWbSyncRoutes_(env, request) {
  const pathname = new URL(request.url).pathname;

  // GET /agent/wb/sync/status — last 20 sync runs
  if (request.method === 'GET' && pathname === '/agent/wb/sync/status') {
    await ensureWbSyncSchema_(env);
    const rows = await env.DB.prepare(
      `SELECT * FROM wb_sync_log ORDER BY started_at DESC LIMIT 20`
    ).all();
    return new Response(JSON.stringify({ ok: true, logs: rows?.results || [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /agent/wb/sync/run — manual trigger
  if (request.method === 'POST' && pathname === '/agent/wb/sync/run') {
    const result = await runWbDataSync_(env);
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}

// ── §10 Telegram commands ──────────────────────────────────────────────────

async function routeWbSyncTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim().split('@')[0].toLowerCase();

  // /wb_sync — show last sync status
  if (text === '/wb_sync') {
    let row = null;
    try {
      await ensureWbSyncSchema_(env);
      row = await env.DB.prepare(
        `SELECT * FROM wb_sync_log ORDER BY started_at DESC LIMIT 1`
      ).first();
    } catch (_) {}

    const esc = (s) => String(s || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

    if (!row) {
      await sendTelegramMessage_(env, chatId,
        '*WB Sync*\nСинхронизация ещё не запускалась\\.\nЗапустить: /wb\\_sync\\_run',
        { parse_mode: 'MarkdownV2' });
      return true;
    }

    const icon = row.status === 'ok' ? '✅' : row.status === 'partial' ? '⚠️' : '🔄';
    const dur  = row.duration_ms ? `${Math.round(row.duration_ms / 1000)}с` : 'N/A';
    const lines = [
      `*WB Sync — последний запуск*`,
      `Дата: ${esc(row.sync_date)}`,
      `Статус: ${icon} ${esc(row.status)}`,
      `Начало: ${esc(row.started_at)}`,
      `Длительность: ${esc(dur)}`,
      `Записей: ${esc(row.records_written || 0)}`,
    ];
    if (row.error) lines.push(`Ошибки: ${esc(row.error.slice(0, 300))}`);
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
    return true;
  }

  // /wb_sync_run — manual sync trigger
  if (text === '/wb_sync_run') {
    await sendTelegramMessage_(env, chatId, '⏳ Синхронизация данных WB запущена...');
    try {
      const result = await runWbDataSync_(env);
      const r = result.results || {};
      const icon = result.status === 'ok' ? '✅' : '⚠️';
      const lines = [
        `*WB Sync завершён* ${icon}`,
        `Дата: ${result.sync_date}  |  Время: ${Math.round(result.duration_ms / 1000)}с`,
        '',
        `📦 Остатки: ${r.stocks?.records || 0} SKU \\(${r.stocks?.source_status || '—'}\\)`,
        `📊 Ср\\. дн\\. заказы: ${r.avg_daily?.records || 0} SKU`,
        `📈 Метрики NM: ${r.sku_metrics?.records || 0} SKU`,
        `🖼 Карточки: ${r.cards?.records || 0} SKU`,
        `💰 Цены: ${r.cost_data?.records || 0} SKU`,
        `🚚 Закупки: ${r.procurement?.records || 0} SKU`,
        `*Всего: ${result.total_records} записей*`,
      ];
      await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка синхронизации: ${e.message}`);
    }
    return true;
  }

  return false;
}
