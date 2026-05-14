// ============================================================
// supplier_management_v1.gs — Supplier Directory & Price History
// Build: ai_helpers_supplier_management_v1
//
// Manages the supplier_directory and procurement_price_history
// tables so the Procurement Chief has real data to work with.
//
// ── What this unlocks ────────────────────────────────────────
//   Procurement Chief reads supplier_directory to:
//     - find min_order_qty when drafting purchase orders
//     - find default lead times (production + delivery days)
//     - look up supplier contact details for confirmed orders
//   Price history is used to detect price anomalies (>30% increase)
//   and to populate estimated_unit_cost in procurement_order.
//
// ── Telegram commands ────────────────────────────────────────
//   /suppliers            — list active suppliers
//   /supplier_add         — guided add (name, lead times, min_qty)
//   /supplier_view <id>   — full details + recent prices
//   /supplier_prices <nm_id> — price history for a SKU
//
// ── HTTP API ─────────────────────────────────────────────────
//   GET    /agent/suppliers              — list all (filter: active=1)
//   POST   /agent/suppliers              — create
//   GET    /agent/suppliers/:id          — get one
//   PUT    /agent/suppliers/:id          — update
//   DELETE /agent/suppliers/:id          — deactivate (soft)
//   GET    /agent/suppliers/prices       — price history (?nm_id=N&supplier_id=S)
//   POST   /agent/suppliers/prices       — add price record
//   GET    /agent/suppliers/nm/:nm_id    — all suppliers for a SKU (with latest price)
// ============================================================

// ── ID helper ──────────────────────────────────────────────────────────────

function supplierGenId_(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── Validation helpers ─────────────────────────────────────────────────────

function supplierValidate_(data) {
  const errors = [];
  if (!data.supplier_name || String(data.supplier_name).trim().length < 2) {
    errors.push('supplier_name обязателен (минимум 2 символа)');
  }
  if (data.default_production_days != null && (isNaN(data.default_production_days) || data.default_production_days < 0)) {
    errors.push('default_production_days должен быть >= 0');
  }
  if (data.default_delivery_days != null && (isNaN(data.default_delivery_days) || data.default_delivery_days < 0)) {
    errors.push('default_delivery_days должен быть >= 0');
  }
  if (data.min_order_qty != null && (isNaN(data.min_order_qty) || data.min_order_qty < 0)) {
    errors.push('min_order_qty должен быть >= 0');
  }
  return errors;
}

// ── §1 Supplier CRUD ───────────────────────────────────────────────────────

async function createSupplier_(env, data) {
  const errors = supplierValidate_(data);
  if (errors.length) return { ok: false, errors };

  const id  = supplierGenId_('sup');
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO supplier_directory
      (id, supplier_name, contact_person, contact_email, contact_phone,
       default_production_days, default_delivery_days,
       min_order_qty, min_order_amount, currency,
       payment_terms, notes, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    id,
    String(data.supplier_name).trim(),
    data.contact_person  || null,
    data.contact_email   || null,
    data.contact_phone   || null,
    Number(data.default_production_days ?? 14),
    Number(data.default_delivery_days   ?? 7),
    Number(data.min_order_qty           ?? 1),
    Number(data.min_order_amount        ?? 0),
    data.currency      || 'RUB',
    data.payment_terms || null,
    data.notes         || null,
    now, now,
  ).run();

  return { ok: true, id };
}

async function updateSupplier_(env, id, data) {
  const existing = await env.DB.prepare(
    `SELECT id FROM supplier_directory WHERE id = ?`
  ).bind(id).first();
  if (!existing) return { ok: false, error: 'Поставщик не найден' };

  const errors = supplierValidate_({ supplier_name: 'placeholder', ...data });
  if (data.supplier_name != null && errors.some(e => e.includes('supplier_name'))) {
    return { ok: false, errors };
  }

  const fields = [];
  const values = [];

  const allowed = [
    'supplier_name', 'contact_person', 'contact_email', 'contact_phone',
    'default_production_days', 'default_delivery_days',
    'min_order_qty', 'min_order_amount', 'currency', 'payment_terms', 'notes',
  ];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(data[key]);
    }
  }
  if (fields.length === 0) return { ok: false, error: 'Нет полей для обновления' };

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  await env.DB.prepare(
    `UPDATE supplier_directory SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  return { ok: true };
}

async function getSupplier_(env, id) {
  const row = await env.DB.prepare(
    `SELECT * FROM supplier_directory WHERE id = ?`
  ).bind(id).first();
  return row || null;
}

async function listSuppliers_(env, onlyActive) {
  const sql = onlyActive
    ? `SELECT * FROM supplier_directory WHERE is_active = 1 ORDER BY supplier_name`
    : `SELECT * FROM supplier_directory ORDER BY is_active DESC, supplier_name`;
  const rows = await env.DB.prepare(sql).all();
  return rows?.results || [];
}

async function deactivateSupplier_(env, id) {
  const existing = await env.DB.prepare(
    `SELECT id FROM supplier_directory WHERE id = ?`
  ).bind(id).first();
  if (!existing) return { ok: false, error: 'Поставщик не найден' };

  await env.DB.prepare(`
    UPDATE supplier_directory SET is_active = 0, updated_at = ? WHERE id = ?
  `).bind(new Date().toISOString(), id).run();

  return { ok: true };
}

// ── §2 Price History ───────────────────────────────────────────────────────

async function addPriceRecord_(env, data) {
  if (!data.nm_id || !data.unit_cost || !data.price_date) {
    return { ok: false, error: 'nm_id, unit_cost, price_date обязательны' };
  }

  // Look up supplier name if id provided
  let supplierName = data.supplier_name || null;
  if (data.supplier_id && !supplierName) {
    try {
      const sup = await env.DB.prepare(
        `SELECT supplier_name FROM supplier_directory WHERE id = ?`
      ).bind(data.supplier_id).first();
      supplierName = sup?.supplier_name || null;
    } catch (_) {}
  }

  const id = supplierGenId_('prh');
  await env.DB.prepare(`
    INSERT INTO procurement_price_history
      (id, nm_id, vendor_code, supplier_id, supplier_name,
       price_date, unit_cost, currency, min_order_qty, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(nm_id, supplier_id, price_date) DO UPDATE SET
      unit_cost     = excluded.unit_cost,
      currency      = excluded.currency,
      min_order_qty = excluded.min_order_qty,
      notes         = excluded.notes
  `).bind(
    id,
    Number(data.nm_id),
    data.vendor_code   || null,
    data.supplier_id   || null,
    supplierName,
    data.price_date,
    Number(data.unit_cost),
    data.currency      || 'RUB',
    data.min_order_qty != null ? Number(data.min_order_qty) : null,
    data.notes         || null,
  ).run();

  return { ok: true, id };
}

async function getPriceHistory_(env, nmId, supplierId) {
  let sql, binds;
  if (supplierId) {
    sql   = `SELECT ph.*, s.supplier_name AS sup_name
             FROM procurement_price_history ph
             LEFT JOIN supplier_directory s ON s.id = ph.supplier_id
             WHERE ph.nm_id = ? AND ph.supplier_id = ?
             ORDER BY ph.price_date DESC LIMIT 30`;
    binds = [Number(nmId), supplierId];
  } else {
    sql   = `SELECT ph.*, s.supplier_name AS sup_name
             FROM procurement_price_history ph
             LEFT JOIN supplier_directory s ON s.id = ph.supplier_id
             WHERE ph.nm_id = ?
             ORDER BY ph.price_date DESC LIMIT 30`;
    binds = [Number(nmId)];
  }
  const rows = await env.DB.prepare(sql).bind(...binds).all();
  return rows?.results || [];
}

// Latest price per supplier for a given nm_id (used by Procurement Chief)
async function getLatestPricesForNm_(env, nmId) {
  const rows = await env.DB.prepare(`
    SELECT ph.supplier_id, ph.supplier_name, ph.unit_cost,
           ph.currency, ph.min_order_qty, ph.price_date,
           s.contact_person, s.contact_email, s.contact_phone,
           s.default_production_days, s.default_delivery_days,
           s.payment_terms
    FROM procurement_price_history ph
    LEFT JOIN supplier_directory s ON s.id = ph.supplier_id
    WHERE ph.nm_id = ?
      AND ph.price_date = (
        SELECT MAX(ph2.price_date) FROM procurement_price_history ph2
        WHERE ph2.nm_id = ph.nm_id AND ph2.supplier_id = ph.supplier_id
      )
    ORDER BY ph.unit_cost ASC
  `).bind(Number(nmId)).all();
  return rows?.results || [];
}

// ── §3 Telegram commands ───────────────────────────────────────────────────

async function routeSupplierTelegramCommand_(env, msg, chatId, userId) {
  const raw  = (msg.text || '').trim();
  const text = raw.split('@')[0].toLowerCase();
  const args = raw.split(/\s+/).slice(1);

  // /suppliers — list active suppliers
  if (text === '/suppliers') {
    let suppliers;
    try {
      suppliers = await listSuppliers_(env, true);
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка: ${e.message}`);
      return true;
    }

    if (suppliers.length === 0) {
      const lines = [
        '*Справочник поставщиков пуст*',
        '',
        'Добавьте первого поставщика через API:',
        '`POST /agent/suppliers`',
        '`{"supplier_name":"Имя","min_order_qty":50,"default_production_days":14}`',
      ];
      await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      return true;
    }

    const lines = [`*Поставщики (${suppliers.length})*`, ''];
    for (const s of suppliers) {
      const lead = (s.default_production_days || 14) + (s.default_delivery_days || 7);
      lines.push(
        `• *${s.supplier_name}* \`${s.id}\`` +
        `\n  MOQ: ${s.min_order_qty || 1} шт | Lead: ${lead}д | ${s.currency || 'RUB'}` +
        (s.contact_person ? `\n  ${s.contact_person}` : '')
      );
    }
    lines.push('', 'Детали: /supplier\\_view \\<id\\>');
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  // /supplier_view <id> — full details + last 5 price records
  if (text === '/supplier_view') {
    const id = args[0];
    if (!id) {
      await sendTelegramMessage_(env, chatId, 'Использование: /supplier\\_view \\<id\\>', { parse_mode: 'Markdown' });
      return true;
    }
    let sup;
    try {
      sup = await getSupplier_(env, id);
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка: ${e.message}`);
      return true;
    }
    if (!sup) {
      await sendTelegramMessage_(env, chatId, `Поставщик \`${id}\` не найден.`, { parse_mode: 'Markdown' });
      return true;
    }

    const active = sup.is_active ? '✅ Активен' : '❌ Неактивен';
    const lead   = (sup.default_production_days || 14) + (sup.default_delivery_days || 7);
    const lines  = [
      `*${sup.supplier_name}*  ${active}`,
      `ID: \`${sup.id}\``,
      `MOQ: ${sup.min_order_qty || 1} шт | Мин. сумма: ${sup.min_order_amount || 0} ${sup.currency || 'RUB'}`,
      `Lead time: ${lead}д (произв: ${sup.default_production_days || 14}д + доставка: ${sup.default_delivery_days || 7}д)`,
    ];
    if (sup.payment_terms)  lines.push(`Оплата: ${sup.payment_terms}`);
    if (sup.contact_person) lines.push(`Контакт: ${sup.contact_person}`);
    if (sup.contact_email)  lines.push(`Email: ${sup.contact_email}`);
    if (sup.contact_phone)  lines.push(`Тел: ${sup.contact_phone}`);
    if (sup.notes)          lines.push(`Заметки: ${sup.notes.slice(0, 200)}`);

    // Last 5 price records
    try {
      const priceRows = await env.DB.prepare(`
        SELECT nm_id, vendor_code, unit_cost, currency, price_date, min_order_qty
        FROM procurement_price_history
        WHERE supplier_id = ?
        ORDER BY price_date DESC LIMIT 5
      `).bind(id).all();
      const prices = priceRows?.results || [];
      if (prices.length > 0) {
        lines.push('', '*Последние цены:*');
        for (const p of prices) {
          lines.push(`  nm ${p.nm_id}${p.vendor_code ? ' ' + p.vendor_code : ''}: ${p.unit_cost}₽ (${p.price_date})`);
        }
      }
    } catch (_) {}

    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  // /supplier_prices <nm_id> — price history for a SKU across all suppliers
  if (text === '/supplier_prices') {
    const nmId = Number(args[0]);
    if (!nmId) {
      await sendTelegramMessage_(env, chatId, 'Использование: /supplier\\_prices \\<nm\\_id\\>', { parse_mode: 'Markdown' });
      return true;
    }
    let prices;
    try {
      prices = await getLatestPricesForNm_(env, nmId);
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка: ${e.message}`);
      return true;
    }

    if (prices.length === 0) {
      await sendTelegramMessage_(env, chatId, `Нет данных о ценах для nm_id ${nmId}.`);
      return true;
    }

    const lines = [`*Цены поставщиков — nm_id ${nmId}*`, ''];
    for (const p of prices) {
      const lead = (p.default_production_days || 14) + (p.default_delivery_days || 7);
      lines.push(
        `• *${p.supplier_name || p.supplier_id || '—'}*` +
        `\n  ${p.unit_cost}${p.currency || '₽'} / шт` +
        (p.min_order_qty ? ` | MOQ: ${p.min_order_qty}` : '') +
        `\n  Lead: ${lead}д | Актуально: ${p.price_date}`
      );
    }
    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  return false;
}

// ── §4 HTTP routes ─────────────────────────────────────────────────────────

async function handleSupplierRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;

  if (!pathname.startsWith('/agent/suppliers')) return null;

  const json = (obj, st) => new Response(JSON.stringify(obj), {
    status:  st || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  // GET /agent/suppliers — list
  if (request.method === 'GET' && pathname === '/agent/suppliers') {
    const activeOnly = url.searchParams.get('active') !== '0';
    try {
      const list = await listSuppliers_(env, activeOnly);
      return json({ ok: true, suppliers: list });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/suppliers — create
  if (request.method === 'POST' && pathname === '/agent/suppliers') {
    let body;
    try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Invalid JSON' }, 400); }
    try {
      const result = await createSupplier_(env, body);
      return json(result, result.ok ? 201 : 400);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/suppliers/prices — price history
  if (request.method === 'GET' && pathname === '/agent/suppliers/prices') {
    const nmId      = url.searchParams.get('nm_id');
    const suppId    = url.searchParams.get('supplier_id') || null;
    if (!nmId) return json({ ok: false, error: 'nm_id required' }, 400);
    try {
      const history = await getPriceHistory_(env, Number(nmId), suppId);
      return json({ ok: true, history });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /agent/suppliers/prices — add price record
  if (request.method === 'POST' && pathname === '/agent/suppliers/prices') {
    let body;
    try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Invalid JSON' }, 400); }
    try {
      const result = await addPriceRecord_(env, body);
      return json(result, result.ok ? 201 : 400);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // Routes with /:id
  const idMatch = pathname.match(/^\/agent\/suppliers\/([^/]+)$/);
  if (idMatch) {
    const id = idMatch[1];

    // GET /agent/suppliers/:id
    if (request.method === 'GET') {
      try {
        const sup = await getSupplier_(env, id);
        if (!sup) return json({ ok: false, error: 'Not found' }, 404);
        // Also return latest prices per nm_id
        const prices = await env.DB.prepare(`
          SELECT nm_id, vendor_code, unit_cost, currency, price_date, min_order_qty
          FROM procurement_price_history WHERE supplier_id = ?
          ORDER BY price_date DESC LIMIT 20
        `).bind(id).all();
        return json({ ok: true, supplier: sup, prices: prices?.results || [] });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // PUT /agent/suppliers/:id
    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      try {
        const result = await updateSupplier_(env, id, body);
        return json(result, result.ok ? 200 : 400);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // DELETE /agent/suppliers/:id — soft deactivate
    if (request.method === 'DELETE') {
      try {
        const result = await deactivateSupplier_(env, id);
        return json(result, result.ok ? 200 : 404);
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }
  }

  // GET /agent/suppliers/nm/:nm_id — all suppliers + latest prices for a SKU
  const nmMatch = pathname.match(/^\/agent\/suppliers\/nm\/(\d+)$/);
  if (request.method === 'GET' && nmMatch) {
    const nmId = Number(nmMatch[1]);
    try {
      const prices = await getLatestPricesForNm_(env, nmId);
      return json({ ok: true, nm_id: nmId, suppliers: prices });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
