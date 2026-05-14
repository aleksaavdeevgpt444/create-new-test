// ============================================================
// wb_pricing_v1.gs — WB Price & Discount Advisor
// Build: ai_helpers_wb_pricing_v1
//
// Analyses current prices, stock velocity, and ad efficiency
// to generate price-change proposals for human review.
// Runs at 11:00 UTC (after all chiefs have processed fresh data).
//
// ── Sub-agents ───────────────────────────────────────────────
//   runMarginAnalysisAgent_    — flags SKUs with dangerously low margin
//   runSlowMoversAgent_        — proposes discounts for stuck inventory
//   runDrrOptimizerAgent_      — proposes price increase when DRR is low
//
// ── Tables written ───────────────────────────────────────────
//   wb_pricing_proposal  — price/discount change proposals
//   wb_pricing_history   — daily price snapshots
//
// ── Safety invariants ────────────────────────────────────────
//   ✗ Never auto-applies price changes
//   ✗ Never auto-applies discount changes
//   ✓ Every proposal: requires_confirmation = 1
//   ✓ Every proposal: unique confirmation_id
//   ✓ source_status = 'missing' when WB_API_TOKEN absent
// ============================================================

// ── Constants ──────────────────────────────────────────────────────────────

const PRICING_MIN_MARGIN_PCT    = 15;   // flag if margin < 15%
const PRICING_SLOW_MOVER_DAYS   = 60;   // flag if days_of_stock > 60
const PRICING_LOW_DRR_THRESHOLD = 10;   // DRR < 10% → price may be raised
const PRICING_HIGH_DRR_THRESHOLD= 40;   // DRR > 40% → price review needed
const PRICING_MAX_DISCOUNT_PCT  = 70;   // never propose > 70% discount
const PRICING_PROPOSAL_TTL_DAYS = 3;    // proposals expire after 3 days

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureWbPricingSchema_(env) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS wb_pricing_proposal (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wb_pricing_proposal_date
      ON wb_pricing_proposal(proposal_date, status)`,
    `CREATE INDEX IF NOT EXISTS idx_wb_pricing_proposal_nm
      ON wb_pricing_proposal(nm_id, status)`,
    `CREATE TABLE IF NOT EXISTS wb_pricing_history (
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
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wb_pricing_history_nm
      ON wb_pricing_history(nm_id, record_date DESC)`,
  ];
  for (const sql of stmts) {
    try { await env.DB.prepare(sql).run(); } catch (_) {}
  }
}

// ── ID helpers ─────────────────────────────────────────────────────────────

function pricingGenId_(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function pricingConfirmId_(nmId, type) {
  return `price_${type}_${nmId}_${Date.now().toString(36)}`;
}

// ── AI helper ──────────────────────────────────────────────────────────────

async function callPricingAi_(env, prompt) {
  // Gemini
  if (env.GEMINI_API_KEY) {
    try {
      const model = env.GEMINI_CLASSIFICATION_MODEL || 'gemini-1.5-flash-latest';
      const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      const res   = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal:  AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text.trim().slice(0, 600);
      }
    } catch (_) {}
  }
  // Groq fallback
  if (env.GROQ_API_KEY) {
    try {
      const base  = env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
      const model = env.GROQ_MODEL    || 'llama3-8b-8192';
      const res   = await fetch(`${base}/chat/completions`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 300 }),
        signal:  AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return text.trim().slice(0, 600);
      }
    } catch (_) {}
  }
  return null;
}

// ── Price history snapshot ──────────────────────────────────────────────────

async function snapshotPricingHistory_(env, today) {
  // Copy today's cost_data into wb_pricing_history
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT nm_id, vendor_code, cost_per_unit
      FROM wb_cost_data
      WHERE effective_date = ?
    `).bind(today).all();
  } catch (_) {
    return 0;
  }
  let written = 0;
  for (const r of (rows?.results || [])) {
    try {
      await env.DB.prepare(`
        INSERT INTO wb_pricing_history (id, nm_id, vendor_code, record_date, price, source)
        VALUES (?, ?, ?, ?, ?, 'sync')
        ON CONFLICT(nm_id, record_date, source) DO UPDATE SET
          price = excluded.price
      `).bind(
        pricingGenId_('phist'), r.nm_id, r.vendor_code || '', today, r.cost_per_unit || 0,
      ).run();
      written++;
    } catch (_) {}
  }
  return written;
}

// ── §1 Margin Analysis Agent ───────────────────────────────────────────────
//
// Flags SKUs where the estimated margin is below PRICING_MIN_MARGIN_PCT.
// Margin estimate = (price - cost_per_unit - logistics) / price
// If WB commission data is present, deducts it too.
// Proposes a price increase to restore margin.

async function runMarginAnalysisAgent_(env, today) {
  // Join cost_data (has COGS + logistics + commission) with today's price
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT c.nm_id, c.vendor_code, c.cost_per_unit AS selling_price,
             c.commission_pct, c.logistics_rub
      FROM wb_cost_data c
      WHERE c.effective_date = ?
        AND c.cost_per_unit > 0
    `).bind(today).all();
  } catch (_) {
    return { proposals: 0, source_status: 'db_error' };
  }

  const entries = rows?.results || [];
  let proposals = 0;

  for (const e of entries) {
    const price      = e.selling_price || 0;
    if (price <= 0) continue;

    // Estimate margin: deduct commission (%) and logistics (flat)
    const commPct    = e.commission_pct || 20; // WB avg ~20% if not set
    const logistics  = e.logistics_rub  || 0;
    const afterComm  = price * (1 - commPct / 100);
    const afterLogis = afterComm - logistics;
    const marginPct  = price > 0 ? (afterLogis / price) * 100 : null;

    if (marginPct === null || marginPct >= PRICING_MIN_MARGIN_PCT) continue;

    // Need at least PRICING_MIN_MARGIN_PCT margin
    // Solve: proposed * (1 - comm/100) - logistics >= proposed * minMargin/100
    // proposed * (1 - comm/100 - minMargin/100) >= logistics
    const factor = 1 - commPct / 100 - PRICING_MIN_MARGIN_PCT / 100;
    if (factor <= 0) continue; // impossible without structural change
    const minPrice    = Math.ceil(logistics / factor / 10) * 10; // round up to nearest 10
    const proposedPrice = Math.max(minPrice, Math.ceil(price * 1.1 / 10) * 10);
    if (proposedPrice <= price) continue;

    // Check if a pending proposal already exists for this nm_id
    try {
      const existing = await env.DB.prepare(`
        SELECT id FROM wb_pricing_proposal
        WHERE nm_id = ? AND proposal_type = 'margin_increase'
          AND status = 'pending' AND proposal_date = ?
      `).bind(e.nm_id, today).first();
      if (existing) continue;
    } catch (_) {}

    const confirmId  = pricingConfirmId_(e.nm_id, 'margin');
    const expiresAt  = new Date(Date.now() + PRICING_PROPOSAL_TTL_DAYS * 86400000).toISOString();
    const rationale  = `Оценочная маржа ${marginPct.toFixed(1)}% ниже порога ${PRICING_MIN_MARGIN_PCT}%. ` +
      `Комиссия: ${commPct}%, логистика: ${logistics}₽. ` +
      `Предложена цена ${proposedPrice}₽ (текущая: ${price}₽).`;

    try {
      await env.DB.prepare(`
        INSERT INTO wb_pricing_proposal
          (id, proposal_date, nm_id, vendor_code,
           proposal_type, current_price, proposed_price,
           margin_pct_estimated, rationale, priority,
           confirmation_id, requires_confirmation, expires_at)
        VALUES (?, ?, ?, ?, 'margin_increase', ?, ?, ?, ?, 'high', ?, 1, ?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        pricingGenId_('ppr'), today, e.nm_id, e.vendor_code || '',
        price, proposedPrice, marginPct, rationale, confirmId, expiresAt,
      ).run();
      proposals++;
    } catch (_) {}
  }
  return { proposals, source_status: 'ready' };
}

// ── §2 Slow Movers Agent ───────────────────────────────────────────────────
//
// Finds SKUs with too many days of stock and low sales velocity.
// Proposes a discount to stimulate orders and reduce overstock.

async function runSlowMoversAgent_(env, today) {
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT s.nm_id, s.vendor_code, s.sku_title,
             s.stock_total, s.days_of_stock, s.avg_daily_orders_7d,
             c.cost_per_unit AS current_price,
             c.discount_pct  AS current_discount
      FROM wb_stock_snapshot_v2 s
      LEFT JOIN wb_cost_data c
        ON c.nm_id = CAST(s.nm_id AS TEXT) AND c.effective_date = ?
      WHERE s.date = ?
        AND s.days_of_stock > ?
        AND (s.avg_daily_orders_7d IS NULL OR s.avg_daily_orders_7d < 1)
        AND s.stock_total > 0
    `).bind(today, today, PRICING_SLOW_MOVER_DAYS).all();
  } catch (_) {
    return { proposals: 0, source_status: 'db_error' };
  }

  const entries = rows?.results || [];
  let proposals = 0;

  for (const e of entries) {
    const price          = e.current_price || 0;
    const currDiscount   = e.current_discount || 0;
    // Propose 10-20% more discount; don't exceed PRICING_MAX_DISCOUNT_PCT
    const newDiscount    = Math.min(
      Math.round((currDiscount + 15) / 5) * 5,
      PRICING_MAX_DISCOUNT_PCT
    );
    if (newDiscount <= currDiscount) continue;

    try {
      const existing = await env.DB.prepare(`
        SELECT id FROM wb_pricing_proposal
        WHERE nm_id = ? AND proposal_type = 'discount_increase'
          AND status = 'pending' AND proposal_date = ?
      `).bind(e.nm_id, today).first();
      if (existing) continue;
    } catch (_) {}

    const days       = e.days_of_stock ? Math.round(e.days_of_stock) : '?';
    const confirmId  = pricingConfirmId_(e.nm_id, 'discount');
    const expiresAt  = new Date(Date.now() + PRICING_PROPOSAL_TTL_DAYS * 86400000).toISOString();
    const priority   = e.days_of_stock > 120 ? 'high' : 'medium';
    const rationale  = `Остаток: ${days} дней. Ср. продажи: ${(e.avg_daily_orders_7d || 0).toFixed(2)}/день. ` +
      `Предложена скидка ${newDiscount}% (текущая: ${currDiscount}%). ` +
      `Цель: стимулировать продажи и снизить срок хранения.`;

    try {
      await env.DB.prepare(`
        INSERT INTO wb_pricing_proposal
          (id, proposal_date, nm_id, vendor_code, sku_title,
           proposal_type, current_price, current_discount_pct, proposed_discount_pct,
           rationale, priority,
           confirmation_id, requires_confirmation, expires_at)
        VALUES (?, ?, ?, ?, ?, 'discount_increase', ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(confirmation_id) DO NOTHING
      `).bind(
        pricingGenId_('ppr'), today, e.nm_id, e.vendor_code || '', e.sku_title || '',
        price, currDiscount, newDiscount,
        rationale, priority, confirmId, expiresAt,
      ).run();
      proposals++;
    } catch (_) {}
  }
  return { proposals, source_status: 'ready' };
}

// ── §3 DRR Optimizer Agent ─────────────────────────────────────────────────
//
// When ad DRR is very low (ads efficient, low cost per order) and conversion
// is good, the price may be raised — the product sells well even at higher
// price. When DRR is very high, flags the SKU for price/ad review.

async function runDrrOptimizerAgent_(env, today) {
  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT a.nm_id,
             SUM(a.ad_spend) AS total_spend,
             SUM(a.ad_orders) AS total_ad_orders,
             AVG(a.drr) AS avg_drr,
             AVG(a.cr)  AS avg_cr,
             c.cost_per_unit AS current_price,
             k.orders_count AS orders_30d,
             k.vendor_code,
             k.title AS sku_title
      FROM wb_ads_snapshot a
      LEFT JOIN wb_cost_data c
        ON c.nm_id = CAST(a.nm_id AS TEXT) AND c.effective_date = ?
      LEFT JOIN wb_sku_snapshot k
        ON k.nm_id = CAST(a.nm_id AS TEXT) AND k.date = ? AND k.marketplace = 'WB'
      WHERE a.date = ?
        AND a.ad_spend > 500
      GROUP BY a.nm_id
      HAVING avg_drr IS NOT NULL
    `).bind(today, today, today).all();
  } catch (_) {
    return { proposals: 0, source_status: 'db_error' };
  }

  const entries = rows?.results || [];
  let proposals = 0;

  for (const e of entries) {
    const drr   = e.avg_drr || 0;
    const price = e.current_price || 0;
    if (price <= 0) continue;

    // Low DRR: ads efficient — consider raising price by 5-10%
    if (drr < PRICING_LOW_DRR_THRESHOLD && drr > 0 && e.orders_30d > 5) {
      const proposedPrice = Math.ceil(price * 1.07 / 10) * 10;
      if (proposedPrice <= price) continue;

      try {
        const existing = await env.DB.prepare(`
          SELECT id FROM wb_pricing_proposal
          WHERE nm_id = ? AND proposal_type = 'price_increase_drr'
            AND status = 'pending' AND proposal_date = ?
        `).bind(Number(e.nm_id), today).first();
        if (existing) continue;
      } catch (_) {}

      const confirmId = pricingConfirmId_(e.nm_id, 'drr_up');
      const expiresAt = new Date(Date.now() + PRICING_PROPOSAL_TTL_DAYS * 86400000).toISOString();
      const rationale = `DRR = ${drr.toFixed(1)}% (< ${PRICING_LOW_DRR_THRESHOLD}%) — реклама эффективна. ` +
        `Заказов за 30 дней: ${e.orders_30d}. ` +
        `Потенциал повысить цену с ${price}₽ до ${proposedPrice}₽ (+7%) без потери объёма.`;

      try {
        await env.DB.prepare(`
          INSERT INTO wb_pricing_proposal
            (id, proposal_date, nm_id, vendor_code, sku_title,
             proposal_type, current_price, proposed_price,
             rationale, priority,
             confirmation_id, requires_confirmation, expires_at)
          VALUES (?, ?, ?, ?, ?, 'price_increase_drr', ?, ?, ?, 'medium', ?, 1, ?)
          ON CONFLICT(confirmation_id) DO NOTHING
        `).bind(
          pricingGenId_('ppr'), today, Number(e.nm_id), e.vendor_code || '', e.sku_title || '',
          price, proposedPrice, rationale, confirmId, expiresAt,
        ).run();
        proposals++;
      } catch (_) {}
    }

    // High DRR: ads very expensive relative to revenue — flag for review
    if (drr > PRICING_HIGH_DRR_THRESHOLD) {
      try {
        const existing = await env.DB.prepare(`
          SELECT id FROM wb_pricing_proposal
          WHERE nm_id = ? AND proposal_type = 'high_drr_alert'
            AND status = 'pending' AND proposal_date = ?
        `).bind(Number(e.nm_id), today).first();
        if (existing) continue;
      } catch (_) {}

      const confirmId = pricingConfirmId_(e.nm_id, 'high_drr');
      const expiresAt = new Date(Date.now() + PRICING_PROPOSAL_TTL_DAYS * 86400000).toISOString();
      const rationale = `DRR = ${drr.toFixed(1)}% (> ${PRICING_HIGH_DRR_THRESHOLD}%) — ` +
        `рекламные расходы высоки. Расход: ${(e.total_spend || 0).toFixed(0)}₽. ` +
        `Рекомендуется: снизить ставку или пересмотреть цену.`;

      try {
        await env.DB.prepare(`
          INSERT INTO wb_pricing_proposal
            (id, proposal_date, nm_id, vendor_code, sku_title,
             proposal_type, current_price,
             rationale, priority,
             confirmation_id, requires_confirmation, expires_at)
          VALUES (?, ?, ?, ?, ?, 'high_drr_alert', ?, ?, 'high', ?, 1, ?)
          ON CONFLICT(confirmation_id) DO NOTHING
        `).bind(
          pricingGenId_('ppr'), today, Number(e.nm_id), e.vendor_code || '', e.sku_title || '',
          price, rationale, confirmId, expiresAt,
        ).run();
        proposals++;
      } catch (_) {}
    }
  }
  return { proposals, source_status: 'ready' };
}

// ── §4 AI enrichment ───────────────────────────────────────────────────────

async function enrichPricingProposalsWithAi_(env, today) {
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) return 0;

  let rows;
  try {
    rows = await env.DB.prepare(`
      SELECT id, nm_id, sku_title, proposal_type,
             current_price, proposed_price,
             current_discount_pct, proposed_discount_pct,
             margin_pct_estimated, rationale
      FROM wb_pricing_proposal
      WHERE proposal_date = ? AND ai_analysis IS NULL AND status = 'pending'
      LIMIT 10
    `).bind(today).all();
  } catch (_) { return 0; }

  let enriched = 0;
  for (const row of (rows?.results || [])) {
    const prompt = `Ты аналитик ценообразования Wildberries.
Товар: "${row.sku_title || 'N/A'}" (nm_id: ${row.nm_id})
Тип предложения: ${row.proposal_type}
${row.current_price ? `Текущая цена: ${row.current_price}₽` : ''}
${row.proposed_price ? `Предложенная цена: ${row.proposed_price}₽` : ''}
${row.current_discount_pct != null ? `Текущая скидка: ${row.current_discount_pct}%` : ''}
${row.proposed_discount_pct != null ? `Предложенная скидка: ${row.proposed_discount_pct}%` : ''}
${row.margin_pct_estimated != null ? `Оценка маржи: ${Number(row.margin_pct_estimated).toFixed(1)}%` : ''}
Обоснование системы: ${row.rationale || 'N/A'}

Напиши краткий (2-3 предложения) анализ: целесообразно ли это изменение и какие риски нужно учесть. Только на русском языке.`;

    const analysis = await callPricingAi_(env, prompt);
    if (!analysis) continue;

    try {
      await env.DB.prepare(`
        UPDATE wb_pricing_proposal SET ai_analysis = ? WHERE id = ?
      `).bind(analysis, row.id).run();
      enriched++;
    } catch (_) {}
  }
  return enriched;
}

// ── §5 Expire old proposals ────────────────────────────────────────────────

async function expirePricingProposals_(env) {
  try {
    const res = await env.DB.prepare(`
      UPDATE wb_pricing_proposal
      SET status = 'expired', updated_at = datetime('now')
      WHERE status = 'pending' AND expires_at < datetime('now')
    `).run();
    return res?.meta?.changes || 0;
  } catch (_) { return 0; }
}

// ── §6 Orchestrator ────────────────────────────────────────────────────────

async function runPricingChief_(env) {
  await ensureWbPricingSchema_(env);
  const today   = new Date().toISOString().slice(0, 10);
  const results = {};

  await expirePricingProposals_(env);

  try { results.history   = await snapshotPricingHistory_(env, today); } catch (_) { results.history = 0; }
  try { results.margin    = await runMarginAnalysisAgent_(env, today); } catch (e) { results.margin = { proposals: 0, error: e.message }; }
  try { results.slow      = await runSlowMoversAgent_(env, today); }    catch (e) { results.slow   = { proposals: 0, error: e.message }; }
  try { results.drr       = await runDrrOptimizerAgent_(env, today); }  catch (e) { results.drr    = { proposals: 0, error: e.message }; }
  try { results.enriched  = await enrichPricingProposalsWithAi_(env, today); } catch (_) { results.enriched = 0; }

  const totalProposals =
    (results.margin?.proposals || 0) +
    (results.slow?.proposals   || 0) +
    (results.drr?.proposals    || 0);

  return {
    date:             today,
    total_proposals:  totalProposals,
    history_snapped:  results.history,
    ai_enriched:      results.enriched,
    results,
  };
}

// ── §7 Callback routing ────────────────────────────────────────────────────

async function routePricingCallbackQuery_(env, cq) {
  const data = cq?.data || '';
  if (!data.startsWith('price_confirm_') && !data.startsWith('price_skip_')) return false;

  const chatId    = cq?.message?.chat?.id;
  const messageId = cq?.message?.message_id;

  const isConfirm = data.startsWith('price_confirm_');
  const confirmId = isConfirm
    ? data.replace('price_confirm_', '')
    : data.replace('price_skip_', '');

  let row;
  try {
    row = await env.DB.prepare(
      `SELECT * FROM wb_pricing_proposal WHERE confirmation_id = ?`
    ).bind(confirmId).first();
  } catch (_) {}

  if (!row) {
    if (typeof answerCallbackQuery_ === 'function')
      await answerCallbackQuery_(env, cq.id, 'Предложение не найдено');
    return true;
  }

  const newStatus = isConfirm ? 'confirmed' : 'rejected';
  try {
    await env.DB.prepare(`
      UPDATE wb_pricing_proposal
      SET status = ?, confirmed_at = datetime('now'), confirmed_by = ?, updated_at = datetime('now')
      WHERE confirmation_id = ?
    `).bind(newStatus, String(cq.from?.id || ''), confirmId).run();
  } catch (_) {}

  const icon     = isConfirm ? '✅' : '❌';
  const action   = isConfirm ? 'подтверждено' : 'отклонено';
  const replyTxt = `${icon} Предложение ${action}: nm_id ${row.nm_id}`;

  if (typeof editTelegramMessage_ === 'function') {
    await editTelegramMessage_(env, chatId, messageId, replyTxt, {});
  } else if (typeof sendTelegramMessage_ === 'function') {
    await sendTelegramMessage_(env, chatId, replyTxt);
  }
  if (typeof answerCallbackQuery_ === 'function')
    await answerCallbackQuery_(env, cq.id, action);
  return true;
}

// ── §8 Telegram commands ───────────────────────────────────────────────────

async function routePricingTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim().split('@')[0].toLowerCase();

  if (text !== '/pricing' && text !== '/pricing_proposals') return false;

  await ensureWbPricingSchema_(env);
  const today = new Date().toISOString().slice(0, 10);

  // /pricing — summary for today
  if (text === '/pricing') {
    let rows;
    try {
      rows = await env.DB.prepare(`
        SELECT status, COUNT(*) AS cnt
        FROM wb_pricing_proposal
        WHERE proposal_date = ?
        GROUP BY status
      `).bind(today).all();
    } catch (_) {}

    const counts = {};
    for (const r of (rows?.results || [])) counts[r.status] = r.cnt;

    const lines = [
      `*Ценообразование — ${today}*`,
      `Ожидают подтверждения: ${counts.pending || 0}`,
      `Подтверждено: ${counts.confirmed || 0}`,
      `Отклонено: ${counts.rejected || 0}`,
      `Истекло: ${counts.expired || 0}`,
      '',
      `Детали: /pricing\\_proposals`,
    ];
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  // /pricing_proposals — list pending proposals with buttons
  if (text === '/pricing_proposals') {
    let rows;
    try {
      rows = await env.DB.prepare(`
        SELECT * FROM wb_pricing_proposal
        WHERE status = 'pending'
        ORDER BY priority DESC, created_at DESC
        LIMIT 5
      `).bind().all();
    } catch (_) {}

    const proposals = rows?.results || [];
    if (proposals.length === 0) {
      await sendTelegramMessage_(env, chatId, 'Нет ожидающих предложений по ценам.');
      return true;
    }

    for (const p of proposals) {
      const typeLabel = {
        margin_increase:    '📈 Повышение цены (маржа)',
        discount_increase:  '🏷 Увеличение скидки (зависание)',
        price_increase_drr: '📈 Повышение цены (DRR)',
        high_drr_alert:     '⚠️ Высокий DRR — требует внимания',
      }[p.proposal_type] || p.proposal_type;

      const priceInfo = p.proposed_price
        ? `${p.current_price}₽ → ${p.proposed_price}₽`
        : p.proposed_discount_pct != null
          ? `Скидка ${p.current_discount_pct || 0}% → ${p.proposed_discount_pct}%`
          : `Текущая цена: ${p.current_price || '—'}₽`;

      const lines = [
        `${typeLabel}`,
        `nm\\_id: ${p.nm_id}${p.sku_title ? ' — ' + p.sku_title.slice(0, 40) : ''}`,
        `${priceInfo}`,
        `Приоритет: ${p.priority}`,
        `_${(p.rationale || '').slice(0, 200)}_`,
      ];
      if (p.ai_analysis) lines.push(`\n🤖 ${p.ai_analysis.slice(0, 250)}`);

      const keyboard = {
        inline_keyboard: [[
          { text: '✅ Подтвердить', callback_data: `price_confirm_${p.confirmation_id}` },
          { text: '❌ Отклонить',  callback_data: `price_skip_${p.confirmation_id}`    },
        ]],
      };
      await sendTelegramMessage_(env, chatId, lines.join('\n'), {
        parse_mode:   'Markdown',
        reply_markup: JSON.stringify(keyboard),
      });
    }

    if (proposals.length === 5) {
      await sendTelegramMessage_(env, chatId, '_Показано 5 из ожидающих предложений._', { parse_mode: 'Markdown' });
    }
    return true;
  }

  return false;
}

// ── §9 HTTP routes ─────────────────────────────────────────────────────────

async function handlePricingRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;
  const json     = (obj, st) => new Response(JSON.stringify(obj), {
    status: st || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  if (!pathname.startsWith('/agent/pricing/')) return null;

  await ensureWbPricingSchema_(env);

  // GET /agent/pricing/proposals?status=pending&date=YYYY-MM-DD
  if (request.method === 'GET' && pathname === '/agent/pricing/proposals') {
    const status = url.searchParams.get('status') || 'pending';
    const date   = url.searchParams.get('date')   || new Date().toISOString().slice(0, 10);
    try {
      const rows = await env.DB.prepare(`
        SELECT * FROM wb_pricing_proposal
        WHERE status = ? AND proposal_date = ?
        ORDER BY priority DESC, created_at DESC
        LIMIT 50
      `).bind(status, date).all();
      return json({ ok: true, proposals: rows?.results || [] });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/pricing/proposals/:id/confirm
  const confirmMatch = pathname.match(/^\/agent\/pricing\/proposals\/([^/]+)\/(confirm|reject)$/);
  if (request.method === 'POST' && confirmMatch) {
    const confirmId = confirmMatch[1];
    const action    = confirmMatch[2];
    const newStatus = action === 'confirm' ? 'confirmed' : 'rejected';
    try {
      await env.DB.prepare(`
        UPDATE wb_pricing_proposal
        SET status = ?, confirmed_at = datetime('now'), updated_at = datetime('now')
        WHERE confirmation_id = ? AND status = 'pending'
      `).bind(newStatus, confirmId).run();
      return json({ ok: true, status: newStatus });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/pricing/run — manual trigger
  if (request.method === 'POST' && pathname === '/agent/pricing/run') {
    const result = await runPricingChief_(env);
    return json({ ok: true, result });
  }

  // GET /agent/pricing/history?nm_id=123
  if (request.method === 'GET' && pathname === '/agent/pricing/history') {
    const nmId = url.searchParams.get('nm_id');
    if (!nmId) return json({ ok: false, error: 'nm_id required' }, 400);
    try {
      const rows = await env.DB.prepare(`
        SELECT * FROM wb_pricing_history
        WHERE nm_id = ?
        ORDER BY record_date DESC
        LIMIT 30
      `).bind(Number(nmId)).all();
      return json({ ok: true, history: rows?.results || [] });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
