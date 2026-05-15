// ============================================================
// bot_setup_v1.gs — Telegram Bot Setup & Help System
// Build: ai_helpers_bot_setup_v1
//
// Provides /start, /help, /status, and webhook setup endpoints.
// /start registers the user's chat_id in scheduler_config so
// every chief knows where to send notifications.
//
// ── Tables ────────────────────────────────────────────────────
//   bot_users — registered Telegram users
//
// ── Telegram commands ────────────────────────────────────────
//   /start         — welcome + register
//   /help          — full command reference
//   /status        — system health snapshot
//   /setup_notify  — set this chat as notification target
//
// ── HTTP API ─────────────────────────────────────────────────
//   POST /webhook/setup          — register webhook + bot commands
//   GET  /agent/bot/users        — list registered users
//   GET  /agent/bot/status       — system status JSON
// ============================================================

// ── Schema ─────────────────────────────────────────────────────────────────

async function ensureBotSetupSchema_(env) {
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS bot_users (
        id              TEXT PRIMARY KEY,
        telegram_user_id TEXT NOT NULL UNIQUE,
        telegram_chat_id TEXT NOT NULL,
        username        TEXT,
        first_name      TEXT,
        is_admin        INTEGER DEFAULT 0,
        registered_at   TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
      )
    `).run();
    await env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_bot_users_tg
        ON bot_users(telegram_user_id)
    `).run();
  } catch (_) {}
}

// ── Bot API helpers ────────────────────────────────────────────────────────

async function botApiCall_(token, method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(10000),
    });
    return res.json();
  } catch (_) {
    return { ok: false };
  }
}

// ── Webhook setup ──────────────────────────────────────────────────────────

async function setupTelegramWebhook_(env, workerUrl) {
  const token  = env.TELEGRAM_BOT_TOKEN;
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };

  const webhookUrl = `${workerUrl.replace(/\/$/, '')}/telegram/webhook`;

  const r1 = await botApiCall_(token, 'setWebhook', {
    url:          webhookUrl,
    secret_token: secret || undefined,
    allowed_updates: ['message', 'callback_query'],
    max_connections: 40,
  });

  // Register bot command list with Telegram
  const commands = [
    { command: 'start',               description: 'Запустить бота и зарегистрироваться' },
    { command: 'help',                description: 'Список всех команд' },
    { command: 'status',              description: 'Статус системы' },
    { command: 'setup_notify',        description: 'Назначить этот чат для уведомлений' },
    { command: 'wb',                  description: 'WB Operations — сводка' },
    { command: 'wb_sync_run',         description: 'Запустить синхронизацию данных WB' },
    { command: 'pricing_proposals',   description: 'Предложения по ценам (подтвердить/отклонить)' },
    { command: 'suppliers',           description: 'Список поставщиков' },
    { command: 'fulfillment_tz',      description: 'ТЗ на поставку (подтвердить/отклонить)' },
    { command: 'procurement_orders',  description: 'Заказы закупки (подтвердить/отклонить)' },
    { command: 'alerts',              description: 'Активные алерты' },
    { command: 'qa',                  description: 'QA-проверка системы' },
    { command: 'scheduler_status',    description: 'Статус планировщика (все задачи)' },
  ];

  const r2 = await botApiCall_(token, 'setMyCommands', { commands });

  return { ok: r1.ok, webhook: r1, commands: r2 };
}

// ── /status helper ─────────────────────────────────────────────────────────

async function getBotSystemStatus_(env) {
  const today  = new Date().toISOString().slice(0, 10);
  const status = { date: today };

  // Last sync
  try {
    const sync = await env.DB.prepare(
      `SELECT status, finished_at, records_written FROM wb_sync_log
       WHERE sync_date = ? ORDER BY started_at DESC LIMIT 1`
    ).bind(today).first();
    status.sync = sync
      ? `${sync.status === 'ok' ? '✅' : '⚠️'} ${sync.status} (${sync.records_written || 0} записей)`
      : '❓ не запускалась сегодня';
  } catch (_) { status.sync = '—'; }

  // Pending proposals
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM wb_pricing_proposal WHERE status = 'pending'`
    ).first();
    status.pricing_pending = row?.cnt || 0;
  } catch (_) { status.pricing_pending = 0; }

  // Pending fulfillment TZ
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM fulfillment_tz_item WHERE status = 'draft'`
    ).first();
    status.tz_pending = row?.cnt || 0;
  } catch (_) { status.tz_pending = 0; }

  // Pending procurement orders
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM procurement_order WHERE status = 'draft'`
    ).first();
    status.proc_pending = row?.cnt || 0;
  } catch (_) { status.proc_pending = 0; }

  // Critical stock items
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM wb_stock_snapshot_v2
       WHERE date = ? AND risk_level = 'critical'`
    ).bind(today).first();
    status.stock_critical = row?.cnt || 0;
  } catch (_) { status.stock_critical = 0; }

  // Active suppliers
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM supplier_directory WHERE is_active = 1`
    ).first();
    status.active_suppliers = row?.cnt || 0;
  } catch (_) { status.active_suppliers = 0; }

  // Last scheduler jobs
  try {
    const rows = await env.DB.prepare(
      `SELECT job_name, last_status, last_run_at FROM scheduler_config
       WHERE last_run_at IS NOT NULL ORDER BY last_run_at DESC LIMIT 3`
    ).all();
    status.recent_jobs = (rows?.results || []).map(r =>
      `${r.last_status === 'ok' ? '✅' : '❌'} ${r.job_name}`
    );
  } catch (_) { status.recent_jobs = []; }

  return status;
}

// ── /help text ─────────────────────────────────────────────────────────────

function buildHelpText_() {
  const sections = [
    ['🚀 Старт', [
      '/start — регистрация и приветствие',
      '/help — этот список',
      '/status — снимок состояния системы',
      '/setup\\_notify — назначить чат для уведомлений',
    ]],
    ['📊 WB Operations', [
      '/wb — сводный отчёт',
      '/wb\\_sync — статус синхронизации данных',
      '/wb\\_sync\\_run — принудительная синхронизация',
      '/wb\\_proposals — предложения WB',
    ]],
    ['💰 Ценообразование', [
      '/pricing — сводка по ценам',
      '/pricing\\_proposals — предложения цен (подтвердить/отклонить)',
    ]],
    ['🏪 CS', [
      '/cs — сводка CS',
      '/cs\\_inbox — входящие обращения',
      '/cs\\_appeals — апелляции',
    ]],
    ['🎨 Design', [
      '/design — сводка Design Chief',
      '/design\\_handoffs — задачи от других шефов',
      '/design\\_plan — план контента',
    ]],
    ['📈 ROP', [
      '/rop — KPI сводка',
      '/rop\\_kpi — метрики по SKU',
      '/rop\\_targets — цели периода',
    ]],
    ['🚚 Фулфилмент', [
      '/fulfillment — сводка фулфилмент',
      '/fulfillment\\_fbs — остатки FBS',
      '/fulfillment\\_tz — ТЗ на поставку',
      '/fulfillment\\_schedule — график поставок',
    ]],
    ['🛒 Закупки', [
      '/procurement — сводка закупок',
      '/procurement\\_orders — заказы (подтвердить/отклонить)',
      '/procurement\\_suppliers — поставщики в закупках',
    ]],
    ['🏭 Поставщики', [
      '/suppliers — справочник поставщиков',
      '/supplier\\_view \\<id\\> — детали поставщика',
      '/supplier\\_prices \\<nm\\_id\\> — цены по SKU',
    ]],
    ['🔔 Алерты', [
      '/alerts — активные алерты',
      '/alerts\\_config — настройки алертов',
    ]],
    ['⚙️ Система', [
      '/scheduler\\_status — статус всех задач',
      '/scheduler\\_logs — последние запуски',
      '/qa — быстрая QA проверка',
      '/qa\\_full — полная QA проверка',
    ]],
  ];

  const lines = ['*Команды ИИ агентов-помощников*', ''];
  for (const [title, cmds] of sections) {
    lines.push(`*${title}*`);
    lines.push(...cmds);
    lines.push('');
  }
  lines.push('_Все рискованные действия требуют подтверждения_');
  return lines.join('\n');
}

// ── Telegram command router ────────────────────────────────────────────────

async function routeBotSetupTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim().split('@')[0].toLowerCase();

  // /start — register user + welcome
  if (text === '/start') {
    await ensureBotSetupSchema_(env);
    const from     = msg.from || {};
    const tgUserId = String(from.id || userId);
    const name     = from.first_name || from.username || 'Пользователь';

    // Upsert bot_users
    try {
      await env.DB.prepare(`
        INSERT INTO bot_users
          (id, telegram_user_id, telegram_chat_id, username, first_name, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          telegram_chat_id = excluded.telegram_chat_id,
          username         = excluded.username,
          first_name       = excluded.first_name,
          updated_at       = datetime('now')
      `).bind(
        `bu_${Date.now().toString(36)}`, tgUserId, String(chatId),
        from.username || null, from.first_name || null,
      ).run();
    } catch (_) {}

    const welcome = [
      `Привет, *${name}*\\! 👋`,
      '',
      'Я — система ИИ агентов-помощников для управления бизнесом на Wildberries\\.',
      '',
      '*Что я умею:*',
      '• Ежедневные отчёты по WB, CS, ROP, Design, Fulfilment, Procurement',
      '• Предложения по ценам и скидкам с подтверждением',
      '• Мониторинг остатков и алерты о критических ситуациях',
      '• Управление справочником поставщиков и историей цен',
      '',
      'Используй /setup\\_notify чтобы получать уведомления от шефов\\.',
      'Полный список команд: /help',
    ].join('\n');

    await sendTelegramMessage_(env, chatId, welcome, { parse_mode: 'MarkdownV2' });
    return true;
  }

  // /help — full command reference
  if (text === '/help') {
    await sendTelegramMessage_(env, chatId, buildHelpText_(), { parse_mode: 'Markdown' });
    return true;
  }

  // /status — system health snapshot
  if (text === '/status') {
    let s;
    try {
      s = await getBotSystemStatus_(env);
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка статуса: ${e.message}`);
      return true;
    }

    const needsAction = (s.pricing_pending || 0) + (s.tz_pending || 0) + (s.proc_pending || 0);
    const lines = [
      `*Статус системы — ${s.date}*`,
      '',
      `🔄 Синхронизация: ${s.sync}`,
      `📦 Критич. остатки: ${s.stock_critical || 0} SKU`,
      `🏭 Поставщики: ${s.active_suppliers || 0} активных`,
      '',
      '*Требуют подтверждения:*',
      `  💰 Цены: ${s.pricing_pending} предложений`,
      `  🚚 ТЗ фулфилмент: ${s.tz_pending} черновиков`,
      `  🛒 Заказы закупки: ${s.proc_pending} черновиков`,
    ];
    if (needsAction > 0) {
      lines.push('', `⚡ Всего ожидает: *${needsAction}* действий`);
    }
    if (s.recent_jobs?.length) {
      lines.push('', '*Последние задачи:*');
      for (const j of s.recent_jobs) lines.push(`  ${j}`);
    }

    await sendTelegramMessage_(env, chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return true;
  }

  // /setup_notify — configure this chat_id for all scheduler jobs
  if (text === '/setup_notify') {
    try {
      await env.DB.prepare(`
        UPDATE scheduler_config SET notify_chat_id = ?, updated_at = datetime('now')
        WHERE notify_chat_id IS NULL OR notify_chat_id = ''
      `).bind(String(chatId)).run();

      // Also set for all jobs that have no chat yet (idempotent bulk set)
      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM scheduler_config WHERE notify_chat_id = ?`
      ).bind(String(chatId)).first();

      await sendTelegramMessage_(env, chatId,
        `✅ Этот чат назначен для уведомлений\\.\n` +
        `Задач настроено: *${count?.cnt || 0}*\n\n` +
        `_Уведомления о сбоях включены для всех задач\\._` +
        `\n_Уведомления об успехе выключены — включите через API если нужно\\._`,
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) {
      await sendTelegramMessage_(env, chatId, `❌ Ошибка: ${e.message}`);
    }
    return true;
  }

  return false;
}

// ── HTTP routes ────────────────────────────────────────────────────────────

async function handleBotSetupRoutes_(env, request) {
  const url      = new URL(request.url);
  const pathname = url.pathname;
  const json     = (obj, st) => new Response(JSON.stringify(obj), {
    status:  st || 200,
    headers: { 'Content-Type': 'application/json' },
  });

  // POST /webhook/setup — register webhook + commands with Telegram
  if (request.method === 'POST' && pathname === '/webhook/setup') {
    const workerUrl = `${url.protocol}//${url.host}`;
    const result    = await setupTelegramWebhook_(env, workerUrl);
    return json(result, result.ok ? 200 : 500);
  }

  // GET /agent/bot/users — list registered users
  if (request.method === 'GET' && pathname === '/agent/bot/users') {
    await ensureBotSetupSchema_(env);
    try {
      const rows = await env.DB.prepare(
        `SELECT * FROM bot_users ORDER BY registered_at DESC LIMIT 100`
      ).all();
      return json({ ok: true, users: rows?.results || [] });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // GET /agent/bot/status — JSON system status
  if (request.method === 'GET' && pathname === '/agent/bot/status') {
    try {
      const s = await getBotSystemStatus_(env);
      return json({ ok: true, status: s });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  return null;
}
