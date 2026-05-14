// ============================================================
// WB API Client — production-ready замена стабов
// Build: ai_helpers_wb_api_client_v1
//
// Заменяет stub-функции из Stage 1 реальными вызовами WB API.
// Если WB_API_TOKEN не задан — возвращает { data: [], source_status: 'missing' }.
//
// ── Используемые WB API эндпоинты ───────────────────────────
// GET  statistics-api.wb.ru/api/v5/supplier/reportDetailByPeriod  ← loadWbSkuData_
// GET  statistics-api.wb.ru/api/v1/supplier/stocks                ← loadWbStockData_
// GET  advert-api.wb.ru/adv/v2/adverts                            ← loadWbAdsData_ (step 1)
// POST advert-api.wb.ru/adv/v2/fullstats                          ← loadWbAdsData_ (step 2)
// GET  feedbacks-api.wb.ru/api/v1/feedbacks                       ← loadWbReviews_
// GET  feedbacks-api.wb.ru/api/v1/questions                       ← loadWbQuestions_
// GET  marketplace-api.wb.ru/api/v3/warehouses                    ← loadWbStockData_ (warehouses)
// POST discounts-prices-api.wb.ru/api/v2/list/goods/filter        ← loadWbPricesAndDiscounts_
// GET  marketplace-api.wb.ru/api/v3/tariffs/commission            ← loadWbCommissions_
//
// ── Новые API ────────────────────────────────────────────────
// GET /agent/wb/api/health
// GET /agent/wb/api/prices?nm_ids=1,2,3
// GET /agent/wb/api/commissions
//
// ВАЖНО: Эти функции определены ПОСЛЕДНИМИ в цепочке загрузки,
// поэтому переопределяют одноимённые стабы из Stage 1.
// ============================================================

const WB_API_BASE = {
  STATISTICS:  'https://statistics-api.wildberries.ru',
  CONTENT:     'https://content-api.wildberries.ru',
  ADS:         'https://advert-api.wildberries.ru',
  MARKETPLACE: 'https://marketplace-api.wildberries.ru',
  FEEDBACKS:   'https://feedbacks-api.wildberries.ru',
  PRICES:      'https://discounts-prices-api.wildberries.ru',
};

const WB_API_TIMEOUT_MS    = 25000;
const WB_API_MAX_RETRIES   = 2;
const WB_API_PAGE_DELAY_MS = 250;

// ── Section 1: HTTP helpers ───────────────────────────────────

async function wbApiFetch_(token, url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WB_API_TIMEOUT_MS);

  let lastError = null;
  let attempt = 0;

  while (attempt <= WB_API_MAX_RETRIES) {
    try {
      const res = await fetch(url, {
        ...opts,
        signal: controller.signal,
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
          ...(opts?.headers || {}),
        },
      });

      clearTimeout(timer);

      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, error: 'auth_failed', data: null };
      }

      if (res.status === 429) {
        if (attempt < WB_API_MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 60000));
          attempt++;
          continue;
        }
        return { ok: false, status: 429, error: 'rate_limited', data: null };
      }

      if (res.status >= 500) {
        if (attempt < WB_API_MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          attempt++;
          continue;
        }
        return { ok: false, status: res.status, error: `server_error_${res.status}`, data: null };
      }

      if (!res.ok) {
        return { ok: false, status: res.status, error: `http_${res.status}`, data: null };
      }

      const data = await res.json().catch(() => null);
      return { ok: true, status: res.status, data, error: null };

    } catch (e) {
      clearTimeout(timer);
      lastError = String(e);
      if (attempt < WB_API_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        attempt++;
        continue;
      }
      return { ok: false, status: 0, error: lastError, data: null };
    }
  }

  return { ok: false, status: 0, error: lastError || 'max_retries', data: null };
}

async function wbApiGet_(token, baseUrl, path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return wbApiFetch_(token, baseUrl + path + qs, { method: 'GET' });
}

async function wbApiPost_(token, baseUrl, path, body) {
  return wbApiFetch_(token, baseUrl + path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function wbApiDelay_() {
  await new Promise(r => setTimeout(r, WB_API_PAGE_DELAY_MS));
}

// ── Section 2: SKU / Sales loader (overrides Stage 1 stub) ───

async function loadWbSkuData_(env, date) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;
  const allRows = [];
  let rrdid = 0;
  let pages = 0;
  const MAX_PAGES = 20;

  try {
    while (pages < MAX_PAGES) {
      const res = await wbApiGet_(token, WB_API_BASE.STATISTICS,
        '/api/v5/supplier/reportDetailByPeriod', {
          dateFrom: date,
          dateTo:   date,
          limit:    100000,
          rrdid,
        });

      if (!res.ok) {
        await wbLog_(env.DB, {
          event_type: 'wb_api_sku_error',
          details_json: JSON.stringify({ error: res.error, status: res.status }),
        });
        break;
      }

      const rows = Array.isArray(res.data) ? res.data : (res.data?.data || []);
      allRows.push(...rows);

      if (rows.length < 100000) break;  // last page
      rrdid = rows[rows.length - 1]?.rr_dt || 0;
      pages++;
      await wbApiDelay_();
    }

    if (!allRows.length) return { data: [], source_status: 'ready', rows_count: 0 };

    // Aggregate by nm_id
    const byNm = {};
    for (const row of allRows) {
      const nmId = row.nm_id;
      if (!nmId) continue;
      if (!byNm[nmId]) {
        byNm[nmId] = {
          nm_id:        nmId,
          vendor_code:  row.sa_name,
          subject_name: row.subject_name,
          brand_name:   row.brand_name,
          orders_count:  0,
          orders_revenue: 0,
          returns_count: 0,
          returns_amount: 0,
          commission_pct: row.commission_percent || 0,
        };
      }
      const opType = (row.supplier_oper_name || '').toLowerCase();
      if (opType.includes('продажа') || opType.includes('реализация')) {
        byNm[nmId].orders_count++;
        byNm[nmId].orders_revenue += row.retail_price_withdisc_rub || 0;
      } else if (opType.includes('возврат')) {
        byNm[nmId].returns_count++;
        byNm[nmId].returns_amount += row.retail_price_withdisc_rub || 0;
      }
    }

    const data = Object.values(byNm).map(r => ({
      ...r,
      orders_revenue: wbRound_(r.orders_revenue, 2),
      returns_amount: wbRound_(r.returns_amount, 2),
    }));

    return { data, source_status: 'ready', rows_count: allRows.length };

  } catch (e) {
    await wbLog_(env.DB, { event_type: 'wb_api_sku_exception', details_json: JSON.stringify({ error: String(e) }) });
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 3: Ads loader (overrides Stage 1 stub) ────────────

async function loadWbAdsData_(env, date) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;

  try {
    // Step 1: get active campaign list
    const advertsRes = await wbApiGet_(token, WB_API_BASE.ADS, '/adv/v2/adverts', {
      status: 9,  // active
    });

    if (!advertsRes.ok) {
      await wbLog_(env.DB, { event_type: 'wb_api_ads_list_error', details_json: JSON.stringify({ error: advertsRes.error }) });
      return { data: [], source_status: 'missing' };
    }

    const adverts = Array.isArray(advertsRes.data) ? advertsRes.data : [];
    if (!adverts.length) return { data: [], source_status: 'ready', campaigns_count: 0 };

    const advertIds = adverts.map(a => a.advertId);

    // Step 2: batch stats (max 100 per request)
    const allStats = [];
    const BATCH = 100;

    for (let i = 0; i < advertIds.length; i += BATCH) {
      const batch = advertIds.slice(i, i + BATCH);
      await wbApiDelay_();

      const statsRes = await wbApiPost_(token, WB_API_BASE.ADS, '/adv/v2/fullstats', batch);
      if (!statsRes.ok) continue;

      const statsArr = Array.isArray(statsRes.data) ? statsRes.data : [];
      allStats.push(...statsArr);
    }

    // Merge adverts with stats
    const statsById = {};
    for (const s of allStats) {
      if (s.advertId) statsById[String(s.advertId)] = s;
    }

    const data = adverts.map(adv => {
      const stats = statsById[String(adv.advertId)] || {};
      const views  = stats.views  || 0;
      const clicks = stats.clicks || 0;
      const spend  = stats.sum    || 0;
      const orders = stats.orders || 0;

      return {
        campaign_id:   String(adv.advertId),
        nm_id:         stats.nmId || null,
        campaign_name: adv.name || '',
        campaign_type: adv.type,
        ad_spend:      wbRound_(spend, 2),
        ad_orders:     orders,
        ad_views:      views,
        ad_clicks:     clicks,
        ctr:           views ? wbRound_(clicks / views, 4) : 0,
        cpc:           clicks ? wbRound_(spend / clicks, 2) : 0,
        drr:           orders > 0 ? null : null,  // needs revenue data from SKU
        daily_budget:  adv.dailyBudget || 0,
      };
    });

    return { data, source_status: 'ready', campaigns_count: adverts.length };

  } catch (e) {
    await wbLog_(env.DB, { event_type: 'wb_api_ads_exception', details_json: JSON.stringify({ error: String(e) }) });
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 4: Stock loader (overrides Stage 1 stub) ──────────

async function loadWbStockData_(env, date) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;

  try {
    // Parallel: warehouses + stocks
    const [warehousesRes, stocksRes] = await Promise.all([
      wbApiGet_(token, WB_API_BASE.MARKETPLACE, '/api/v3/warehouses', {}),
      wbApiGet_(token, WB_API_BASE.STATISTICS, '/api/v1/supplier/stocks', { dateFrom: date }),
    ]);

    const warehouses = warehousesRes.ok ? (Array.isArray(warehousesRes.data) ? warehousesRes.data : []) : [];
    const stockRows  = stocksRes.ok ? (Array.isArray(stocksRes.data) ? stocksRes.data : []) : [];

    if (!stockRows.length) {
      return { data: [], source_status: stocksRes.ok ? 'ready' : 'missing', warehouses_count: warehouses.length };
    }

    // Aggregate by nmId
    const byNm = {};
    for (const row of stockRows) {
      const nmId = row.nmId;
      if (!nmId) continue;
      if (!byNm[nmId]) {
        byNm[nmId] = {
          nm_id:                  nmId,
          vendor_code:            row.supplierArticle,
          subject_name:           row.subject,
          stock_total:            0,
          stock_in_transit:       0,
          stock_reserved:         0,
          stock_by_warehouse_json: {},
        };
      }
      const qty     = row.quantityFull   || 0;
      const inWay   = row.inWayToClient  || 0;
      const notInOrd = row.quantityNotInOrders || 0;

      byNm[nmId].stock_total        += qty;
      byNm[nmId].stock_in_transit   += inWay;
      byNm[nmId].stock_reserved     += Math.max(0, qty - notInOrd);

      const wh = row.warehouseName || 'unknown';
      byNm[nmId].stock_by_warehouse_json[wh] =
        (byNm[nmId].stock_by_warehouse_json[wh] || 0) + qty;
    }

    const data = Object.values(byNm).map(r => ({
      ...r,
      stock_by_warehouse_json: JSON.stringify(r.stock_by_warehouse_json),
    }));

    return { data, source_status: 'ready', warehouses_count: warehouses.length, rows_count: stockRows.length };

  } catch (e) {
    await wbLog_(env.DB, { event_type: 'wb_api_stock_exception', details_json: JSON.stringify({ error: String(e) }) });
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 5: Reviews loader (overrides CS Stage 1 stub) ─────

async function loadWbReviews_(env, date) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;
  const allFeedbacks = [];
  let skip = 0;
  const TAKE = 1000;

  try {
    while (true) {
      const res = await wbApiGet_(token, WB_API_BASE.FEEDBACKS, '/api/v1/feedbacks', {
        isAnswered: false,
        take: TAKE,
        skip,
        order: 'dateDesc',
      });

      if (!res.ok) break;

      const feedbacks = res.data?.feedbacks || (Array.isArray(res.data) ? res.data : []);
      allFeedbacks.push(...feedbacks);

      if (feedbacks.length < TAKE) break;
      skip += TAKE;
      await wbApiDelay_();
    }

    const data = allFeedbacks.map(f => ({
      id:           String(f.id),
      nm_id:        f.productDetails?.nmId,
      sku_title:    f.productDetails?.productName,
      text:         f.text || '',
      rating:       f.productValuation,
      date:         f.createdDate?.slice(0, 10) || date,
    }));

    return { data, source_status: 'ready' };

  } catch (e) {
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 6: Questions loader (overrides CS Stage 1 stub) ───

async function loadWbQuestions_(env, date) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;
  const allQuestions = [];
  let skip = 0;
  const TAKE = 1000;

  try {
    while (true) {
      const res = await wbApiGet_(token, WB_API_BASE.FEEDBACKS, '/api/v1/questions', {
        isAnswered: false,
        take: TAKE,
        skip,
        order: 'dateDesc',
      });

      if (!res.ok) break;

      const questions = res.data?.questions || (Array.isArray(res.data) ? res.data : []);
      allQuestions.push(...questions);

      if (questions.length < TAKE) break;
      skip += TAKE;
      await wbApiDelay_();
    }

    const data = allQuestions.map(q => ({
      id:        String(q.id),
      nm_id:     q.productDetails?.nmId,
      sku_title: q.productDetails?.productName,
      text:      q.text || '',
      date:      q.createdDate?.slice(0, 10) || date,
    }));

    return { data, source_status: 'ready' };

  } catch (e) {
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 7: Prices & Commissions ──────────────────────────

async function loadWbPricesAndDiscounts_(env, nmIds) {
  if (!env.WB_API_TOKEN || !nmIds?.length) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;
  try {
    const res = await wbApiPost_(token, WB_API_BASE.PRICES, '/api/v2/list/goods/filter', {
      filterNmIds: nmIds.slice(0, 1000),
    });

    if (!res.ok) return { data: [], source_status: 'missing', error: res.error };

    const goods = res.data?.data?.listGoods || [];
    const data = goods.map(g => ({
      nm_id:    g.nmID,
      price:    g.price,
      discount: g.discount,
      price_with_discount: wbRound_(g.price * (1 - (g.discount || 0) / 100), 2),
    }));

    return { data, source_status: 'ready' };
  } catch (e) {
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

async function loadWbCommissions_(env) {
  if (!env.WB_API_TOKEN) return { data: [], source_status: 'missing' };

  const token = env.WB_API_TOKEN;
  try {
    const res = await wbApiGet_(token, WB_API_BASE.MARKETPLACE, '/api/v3/tariffs/commission', {});
    if (!res.ok) return { data: [], source_status: 'missing', error: res.error };

    return { data: res.data?.report || res.data || [], source_status: 'ready' };
  } catch (e) {
    return { data: [], source_status: 'missing', error: String(e) };
  }
}

// ── Section 8: API health check ───────────────────────────────

async function checkWbApiHealth_(env) {
  const token_configured = !!env.WB_API_TOKEN;
  if (!token_configured) {
    return { ok: false, token_configured: false, api_reachable: false, error: 'WB_API_TOKEN not set', latency_ms: 0 };
  }

  const start = Date.now();
  try {
    const yesterday = wbYesterday_();
    const res = await wbApiGet_(env.WB_API_TOKEN, WB_API_BASE.STATISTICS,
      '/api/v5/supplier/reportDetailByPeriod', {
        dateFrom: yesterday, dateTo: yesterday, limit: 1, rrdid: 0,
      });
    const latency_ms = Date.now() - start;

    if (res.status === 401 || res.status === 403) {
      return { ok: false, token_configured: true, api_reachable: true, error: 'auth_failed', latency_ms };
    }

    return {
      ok: res.ok,
      token_configured: true,
      api_reachable: res.status !== 0,
      error: res.error || null,
      latency_ms,
    };
  } catch (e) {
    return { ok: false, token_configured: true, api_reachable: false, error: String(e), latency_ms: Date.now() - start };
  }
}

// ── Section 9: API routes ─────────────────────────────────────

async function handleWbApiClientRoutes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith('/agent/wb/api')) return null;

  const json = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  if (path === '/agent/wb/api/health' && request.method === 'GET') {
    const result = await checkWbApiHealth_(env);
    return json(result);
  }

  if (path === '/agent/wb/api/prices' && request.method === 'GET') {
    const raw = url.searchParams.get('nm_ids') || '';
    const nmIds = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    if (!nmIds.length) return json({ ok: false, error: 'nm_ids required' }, 400);
    const result = await loadWbPricesAndDiscounts_(env, nmIds);
    return json({ ok: true, ...result });
  }

  if (path === '/agent/wb/api/commissions' && request.method === 'GET') {
    const result = await loadWbCommissions_(env);
    return json({ ok: true, ...result });
  }

  return null;
}
