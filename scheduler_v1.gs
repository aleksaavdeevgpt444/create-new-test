/**
 * scheduler_v1.gs
 * ================
 * Cloudflare Worker scheduled() handler orchestrator.
 * Powers all automated daily/periodic agent triggers.
 *
 * Build: ai_helpers_scheduler_v1
 *
 * Add to wrangler.toml:
 * [triggers]
 * crons = [
 *   "0 3 * * *",   # proposal_cleanup
 *   "0 4 * * *",   # qa_daily
 *   "0 5 * * *",   # wb_daily_report
 *   "0 7 * * *",   # cs_daily_report
 *   "0 * * * *",   # proposals_check
 *   "0 6 * * 1",   # weekly_insights
 * ]
 */

// ---------------------------------------------------------------------------
// SECTION 1: Schedule configuration
// ---------------------------------------------------------------------------

const SCHEDULES = {
  // Daily WB Operations Chief at 05:00 UTC
  WB_DAILY_REPORT:      '0 5 * * *',
  // Daily Fulfillment Chief at 06:00 UTC (after WB, before CS)
  FULFILLMENT_DAILY:    '0 6 * * *',
  // Daily CS Chief at 07:00 UTC
  CS_DAILY_REPORT:      '0 7 * * *',
  // Daily ROP Chief at 08:00 UTC
  ROP_DAILY_REPORT:     '0 8 * * *',
  // Daily Design Chief at 09:00 UTC
  DESIGN_DAILY_REPORT:   '0 9 * * *',
  // Daily Procurement Chief at 10:00 UTC
  PROCUREMENT_DAILY:     '0 10 * * *',
  // Hourly pending proposals check (sends digest if >=5 pending)
  PROPOSALS_CHECK:      '0 * * * *',
  // Weekly insights on Monday 06:00 UTC — NOTE: conflicts with FULFILLMENT_DAILY on Monday
  // so weekly_insights runs at 06:30 on Mondays (use separate cron)
  WEEKLY_INSIGHTS:      '30 6 * * 1',
  // Daily QA check at 04:00 UTC (before reports run)
  QA_DAILY:             '0 4 * * *',
  // Proposal expiry cleanup at 03:00 UTC
  PROPOSAL_CLEANUP:     '0 3 * * *',
  // WB data sync at 04:30 UTC — after QA (04:00), before WB chief (05:00)
  WB_DATA_SYNC:         '30 4 * * *',
};

// Map job names to their handler functions (populated below after function definitions)
const JOB_REGISTRY = {};

// ---------------------------------------------------------------------------
// SECTION 2: Schema bootstrap
// ---------------------------------------------------------------------------

/**
 * Ensures scheduler tables exist in D1.
 * Safe to call on every cold start.
 */
async function ensureSchedulerSchema_(db) {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_run_log (
        id          TEXT PRIMARY KEY,
        job_name    TEXT NOT NULL,
        cron_expr   TEXT,
        status      TEXT DEFAULT 'running',
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        result_json TEXT DEFAULT '{}',
        error       TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_config (
        id                TEXT PRIMARY KEY,
        job_name          TEXT NOT NULL UNIQUE,
        enabled           INTEGER DEFAULT 1,
        notify_chat_id    TEXT,
        notify_on_error   INTEGER DEFAULT 1,
        notify_on_success INTEGER DEFAULT 0,
        last_run_at       TEXT,
        last_status       TEXT,
        created_at        TEXT DEFAULT (datetime('now')),
        updated_at        TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (e) {
    // Schema errors are non-fatal at startup; individual jobs will fail gracefully
    try {
      await wbLog_(db, {
        event_type: 'scheduler_schema_error',
        details_json: JSON.stringify({ error: String(e) }),
      });
    } catch (_) { /* swallow */ }
  }
}

// ---------------------------------------------------------------------------
// SECTION 3: Telegram notification helper
// ---------------------------------------------------------------------------

/**
 * Sends a Telegram notification from the scheduler.
 * Failures are swallowed — notifications never break a job.
 */
async function sendSchedulerTelegramNotification_(env, chatId, jobName, status, details) {
  try {
    const text = `🤖 Планировщик: ${jobName}\nСтатус: ${status}\n${details}`;
    if (typeof csSendTelegramMessage_ === 'function') {
      await csSendTelegramMessage_(env.TELEGRAM_BOT_TOKEN, chatId, text);
    }
  } catch (_) { /* notification failures must not propagate */ }
}

// ---------------------------------------------------------------------------
// SECTION 3 (cont.): Job runner helper
// ---------------------------------------------------------------------------

/**
 * Wraps any async job function with:
 * - Run-log insertion (status='running')
 * - Success/failure UPDATE
 * - Optional Telegram notifications per scheduler_config
 * - scheduler_config last_run_at / last_status update
 *
 * Returns { ok, status, duration_ms, result }
 */
async function runScheduledJob_(env, jobName, cronExpr, jobFn) {
  const db = env.DB;
  const id = wbGenerateId_('sched');
  const startedAt = new Date().toISOString();
  let durationMs = 0;
  let status = 'failed';
  let result = null;
  let errorText = null;

  // Insert initial running row
  try {
    await db.prepare(
      `INSERT INTO scheduler_run_log (id, job_name, cron_expr, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`
    ).bind(id, jobName, cronExpr ?? null, startedAt).run();
  } catch (e) {
    try {
      await wbLog_(db, {
        event_type: 'scheduler_log_insert_error',
        details_json: JSON.stringify({ job_name: jobName, error: String(e) }),
      });
    } catch (_) { /* swallow */ }
  }

  // Execute the job
  const t0 = Date.now();
  try {
    result = await jobFn();
    durationMs = Date.now() - t0;
    status = 'ok';
  } catch (e) {
    durationMs = Date.now() - t0;
    status = 'failed';
    errorText = String(e);
  }

  const finishedAt = new Date().toISOString();

  // Update run log
  try {
    await db.prepare(
      `UPDATE scheduler_run_log
       SET status = ?, finished_at = ?, duration_ms = ?, result_json = ?, error = ?
       WHERE id = ?`
    ).bind(
      status,
      finishedAt,
      durationMs,
      JSON.stringify(result ?? {}),
      errorText,
      id
    ).run();
  } catch (e) {
    try {
      await wbLog_(db, {
        event_type: 'scheduler_log_update_error',
        details_json: JSON.stringify({ job_name: jobName, error: String(e) }),
      });
    } catch (_) { /* swallow */ }
  }

  // Load scheduler_config for notification settings
  let config = null;
  try {
    const row = await db.prepare(
      `SELECT * FROM scheduler_config WHERE job_name = ?`
    ).bind(jobName).first();
    config = row ?? null;
  } catch (_) { /* config load failure is non-fatal */ }

  // Send Telegram notification if configured
  if (config?.notify_chat_id) {
    const chatId = config.notify_chat_id;
    if (status === 'failed' && config.notify_on_error) {
      await sendSchedulerTelegramNotification_(
        env, chatId, jobName, 'failed',
        `Ошибка: ${errorText ?? 'unknown'}\nДлительность: ${durationMs}ms`
      );
    } else if (status === 'ok' && config.notify_on_success) {
      await sendSchedulerTelegramNotification_(
        env, chatId, jobName, 'ok',
        `Успешно завершено за ${durationMs}ms`
      );
    }
  }

  // Update scheduler_config last_run metadata
  try {
    await db.prepare(
      `UPDATE scheduler_config
       SET last_run_at = ?, last_status = ?, updated_at = ?
       WHERE job_name = ?`
    ).bind(finishedAt, status, finishedAt, jobName).run();
  } catch (_) { /* non-fatal */ }

  return { ok: status === 'ok', status, duration_ms: durationMs, result };
}

// ---------------------------------------------------------------------------
// SECTION 4: Individual job handlers
// ---------------------------------------------------------------------------

/**
 * WB daily operations chief report.
 */
async function runWbDailyReportJob_(env) {
  const db = env.DB;
  const date = wbYesterday_();
  let reportResult = null;

  // Load notify_chat_id for optional Telegram summary
  let notifyChatId = null;
  try {
    const cfg = await db.prepare(
      `SELECT notify_chat_id FROM scheduler_config WHERE job_name = ?`
    ).bind('wb_daily_report').first();
    notifyChatId = cfg?.notify_chat_id ?? null;
  } catch (_) { /* non-fatal */ }

  // Call WB Operations Chief if available
  try {
    if (typeof runWbOperationsChiefV2_ === 'function') {
      reportResult = await runWbOperationsChiefV2_(env, date, 'scheduled');
    }
  } catch (e) {
    await wbLog_(db, {
      event_type: 'wb_daily_report_error',
      details_json: JSON.stringify({ date, error: String(e) }),
    });
    throw e;
  }

  // Send Telegram summary if chat configured and we have a summary
  if (notifyChatId && reportResult?.summary) {
    await sendSchedulerTelegramNotification_(
      env, notifyChatId, 'wb_daily_report', 'ok',
      csEscapeMd_(String(reportResult.summary).slice(0, 500))
    );
  }

  return {
    date: wbFormatDate_(date),
    status: reportResult?.status ?? 'completed',
    summary_preview: String(reportResult?.summary ?? '').slice(0, 200),
  };
}

/**
 * CS daily operations chief report.
 */
async function runCsDailyReportJob_(env) {
  const db = env.DB;
  const date = wbYesterday_();
  let reportResult = null;

  // Load notify_chat_id
  let notifyChatId = null;
  try {
    const cfg = await db.prepare(
      `SELECT notify_chat_id FROM scheduler_config WHERE job_name = ?`
    ).bind('cs_daily_report').first();
    notifyChatId = cfg?.notify_chat_id ?? null;
  } catch (_) { /* non-fatal */ }

  // Call CS Operations Chief if available
  try {
    if (typeof runCsOperationsChiefV2_ === 'function') {
      reportResult = await runCsOperationsChiefV2_(env, date, 'scheduled');
    }
  } catch (e) {
    await wbLog_(db, {
      event_type: 'cs_daily_report_error',
      details_json: JSON.stringify({ date, error: String(e) }),
    });
    throw e;
  }

  // Send Telegram summary if chat configured
  if (notifyChatId && reportResult?.summary) {
    await sendSchedulerTelegramNotification_(
      env, notifyChatId, 'cs_daily_report', 'ok',
      csEscapeMd_(String(reportResult.summary).slice(0, 500))
    );
  }

  return {
    date: wbFormatDate_(date),
    status: reportResult?.status ?? 'completed',
    drafts_created: reportResult?.drafts_created ?? 0,
    reviews_loaded: reportResult?.reviews_loaded ?? 0,
  };
}

/**
 * Hourly pending proposals check — sends digest if >=5 pending.
 */
async function runProposalsCheckJob_(env) {
  const db = env.DB;
  let notifyChatId = null;

  try {
    const cfg = await db.prepare(
      `SELECT notify_chat_id FROM scheduler_config WHERE job_name = ?`
    ).bind('proposals_check').first();
    notifyChatId = cfg?.notify_chat_id ?? null;
  } catch (_) { /* non-fatal */ }

  let totalPending = 0;
  let digestSent = false;

  try {
    if (typeof getAllPendingProposals_ === 'function') {
      const proposals = await getAllPendingProposals_(db, null); // null = all users
      totalPending = Array.isArray(proposals) ? proposals.length : 0;

      if (totalPending >= 5 && notifyChatId) {
        if (typeof sendApprovalDigest_ === 'function') {
          await sendApprovalDigest_(env, notifyChatId, null);
          digestSent = true;
        }
      }
    }
  } catch (e) {
    await wbLog_(db, {
      event_type: 'proposals_check_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }

  return { total_pending: totalPending, digest_sent: digestSent };
}

/**
 * Weekly insights review for all enabled users.
 */
async function runWeeklyInsightsJob_(env) {
  const db = env.DB;
  let usersProcessed = 0;
  const errors = [];

  let users = [];
  try {
    const { results } = await db.prepare(
      `SELECT user_id, chat_id FROM agent_settings WHERE agent_enabled = 1 AND chat_id IS NOT NULL`
    ).all();
    users = results ?? [];
  } catch (e) {
    await wbLog_(db, {
      event_type: 'weekly_insights_users_load_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }

  for (const user of users) {
    try {
      if (typeof runWeeklyInsightsReview_ === 'function') {
        await runWeeklyInsightsReview_(env, user.user_id, user.chat_id);
        usersProcessed++;
      }
    } catch (e) {
      errors.push({ user_id: user.user_id, error: String(e) });
      try {
        await wbLog_(db, {
          event_type: 'weekly_insights_user_error',
          details_json: JSON.stringify({ user_id: user.user_id, error: String(e) }),
        });
      } catch (_) { /* swallow */ }
    }
  }

  return { users_processed: usersProcessed, errors };
}

/**
 * Daily QA check — alerts on failure.
 */
async function runQaDailyJob_(env) {
  const db = env.DB;
  let qaResult = null;

  try {
    if (typeof runFullQaCheck_ === 'function') {
      qaResult = await runFullQaCheck_(env);
    }
  } catch (e) {
    await wbLog_(db, {
      event_type: 'qa_daily_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }

  // Alert on failure
  if (qaResult?.overall_status === 'failed') {
    let notifyChatId = null;
    try {
      const cfg = await db.prepare(
        `SELECT notify_chat_id FROM scheduler_config WHERE job_name = ?`
      ).bind('qa_daily').first();
      notifyChatId = cfg?.notify_chat_id ?? null;
    } catch (_) { /* non-fatal */ }

    if (notifyChatId) {
      await sendSchedulerTelegramNotification_(
        env, notifyChatId, 'qa_daily', 'failed',
        `QA провалился: ${qaResult?.summary ?? 'см. логи'}`
      );
    }
  }

  return {
    overall_status: qaResult?.overall_status ?? 'unknown',
    checks_passed: qaResult?.checks_passed ?? 0,
    checks_failed: qaResult?.checks_failed ?? 0,
    summary: qaResult?.summary ?? '',
  };
}

/**
 * Proposal expiry cleanup.
 */
async function runProposalCleanupJob_(env) {
  const db = env.DB;
  let expiredCount = 0;

  try {
    if (typeof markProposalsExpired_ === 'function') {
      const result = await markProposalsExpired_(db);
      expiredCount = result?.expired_count ?? (typeof result === 'number' ? result : 0);
    }
  } catch (e) {
    await wbLog_(db, {
      event_type: 'proposal_cleanup_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }

  return { expired_count: expiredCount };
}

async function runFulfillmentDailyJob_(env) {
  try {
    if (typeof runFulfillmentChief_ === 'function') {
      return await runFulfillmentChief_(env);
    }
    return { status: 'skipped', reason: 'runFulfillmentChief_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'fulfillment_daily_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

async function runRopDailyJob_(env) {
  try {
    if (typeof runRopChief_ === 'function') {
      return await runRopChief_(env);
    }
    return { status: 'skipped', reason: 'runRopChief_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'rop_daily_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

async function runDesignDailyJob_(env) {
  try {
    if (typeof runDesignChief_ === 'function') {
      return await runDesignChief_(env);
    }
    return { status: 'skipped', reason: 'runDesignChief_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'design_daily_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

async function runProcurementDailyJob_(env) {
  try {
    if (typeof runProcurementChief_ === 'function') {
      return await runProcurementChief_(env);
    }
    return { status: 'skipped', reason: 'runProcurementChief_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'procurement_daily_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

async function runWbDataSyncCronJob_(env) {
  try {
    if (typeof runWbSyncJob_ === 'function') {
      return await runWbSyncJob_(env);
    }
    return { status: 'skipped', reason: 'runWbSyncJob_ not available' };
  } catch (e) {
    await wbLog_(env.DB, {
      event_type: 'wb_data_sync_error',
      details_json: JSON.stringify({ error: String(e) }),
    });
    throw e;
  }
}

// Populate job registry after all handlers are defined
Object.assign(JOB_REGISTRY, {
  wb_daily_report:     (env) => runWbDailyReportJob_(env),
  fulfillment_daily:   (env) => runFulfillmentDailyJob_(env),
  cs_daily_report:     (env) => runCsDailyReportJob_(env),
  rop_daily_report:    (env) => runRopDailyJob_(env),
  design_daily_report: (env) => runDesignDailyJob_(env),
  procurement_daily:   (env) => runProcurementDailyJob_(env),
  proposals_check:     (env) => runProposalsCheckJob_(env),
  weekly_insights:     (env) => runWeeklyInsightsJob_(env),
  qa_daily:            (env) => runQaDailyJob_(env),
  proposal_cleanup:    (env) => runProposalCleanupJob_(env),
  wb_data_sync:        (env) => runWbDataSyncCronJob_(env),
});

// Map SCHEDULES cron strings to their canonical job names
const CRON_TO_JOB = {
  [SCHEDULES.WB_DAILY_REPORT]:     'wb_daily_report',
  [SCHEDULES.FULFILLMENT_DAILY]:   'fulfillment_daily',
  [SCHEDULES.CS_DAILY_REPORT]:     'cs_daily_report',
  [SCHEDULES.ROP_DAILY_REPORT]:    'rop_daily_report',
  [SCHEDULES.DESIGN_DAILY_REPORT]: 'design_daily_report',
  [SCHEDULES.PROCUREMENT_DAILY]:   'procurement_daily',
  [SCHEDULES.PROPOSALS_CHECK]:     'proposals_check',
  [SCHEDULES.WEEKLY_INSIGHTS]:     'weekly_insights',
  [SCHEDULES.QA_DAILY]:            'qa_daily',
  [SCHEDULES.PROPOSAL_CLEANUP]:    'proposal_cleanup',
  [SCHEDULES.WB_DATA_SYNC]:        'wb_data_sync',
};

// ---------------------------------------------------------------------------
// SECTION 5: Main scheduled() dispatcher
// ---------------------------------------------------------------------------

/**
 * Entry point called from worker.js scheduled() handler.
 *
 * Usage in worker.js:
 *   export default {
 *     async scheduled(event, env, ctx) {
 *       await handleScheduledEvent_(event, env, ctx);
 *     }
 *   };
 */
async function handleScheduledEvent_(event, env, ctx) {
  await ensureSchedulerSchema_(env.DB);

  switch (event.cron) {
    case SCHEDULES.QA_DAILY:
      ctx.waitUntil(
        runScheduledJob_(env, 'qa_daily', event.cron, () => runQaDailyJob_(env))
      );
      break;

    case SCHEDULES.PROPOSAL_CLEANUP:
      ctx.waitUntil(
        runScheduledJob_(env, 'proposal_cleanup', event.cron, () => runProposalCleanupJob_(env))
      );
      break;

    case SCHEDULES.WB_DAILY_REPORT:
      ctx.waitUntil(
        runScheduledJob_(env, 'wb_daily_report', event.cron, () => runWbDailyReportJob_(env))
      );
      break;

    case SCHEDULES.FULFILLMENT_DAILY:
      ctx.waitUntil(
        runScheduledJob_(env, 'fulfillment_daily', event.cron, () => runFulfillmentDailyJob_(env))
      );
      break;

    case SCHEDULES.CS_DAILY_REPORT:
      ctx.waitUntil(
        runScheduledJob_(env, 'cs_daily_report', event.cron, () => runCsDailyReportJob_(env))
      );
      break;

    case SCHEDULES.ROP_DAILY_REPORT:
      ctx.waitUntil(
        runScheduledJob_(env, 'rop_daily_report', event.cron, () => runRopDailyJob_(env))
      );
      break;

    case SCHEDULES.DESIGN_DAILY_REPORT:
      ctx.waitUntil(
        runScheduledJob_(env, 'design_daily_report', event.cron, () => runDesignDailyJob_(env))
      );
      break;

    case SCHEDULES.PROCUREMENT_DAILY:
      ctx.waitUntil(
        runScheduledJob_(env, 'procurement_daily', event.cron, () => runProcurementDailyJob_(env))
      );
      break;

    case SCHEDULES.PROPOSALS_CHECK:
      ctx.waitUntil(
        runScheduledJob_(env, 'proposals_check', event.cron, () => runProposalsCheckJob_(env))
      );
      break;

    case SCHEDULES.WEEKLY_INSIGHTS:
      ctx.waitUntil(
        runScheduledJob_(env, 'weekly_insights', event.cron, () => runWeeklyInsightsJob_(env))
      );
      break;

    case SCHEDULES.WB_DATA_SYNC:
      ctx.waitUntil(
        runScheduledJob_(env, 'wb_data_sync', event.cron, () => runWbDataSyncCronJob_(env))
      );
      break;

    default:
      // Unknown cron — log and continue without throwing
      try {
        await wbLog_(env.DB, {
          event_type: 'scheduler_unknown_cron',
          details_json: JSON.stringify({ cron: event.cron }),
        });
      } catch (_) { /* swallow */ }
  }
}

// ---------------------------------------------------------------------------
// SECTION 6: Telegram command router
// ---------------------------------------------------------------------------

/**
 * Handles scheduler-related Telegram commands.
 * Returns true if command was handled, false otherwise.
 */
async function routeSchedulerTelegramCommand_(env, msg, chatId, userId) {
  const db = env.DB;
  const text = (msg?.text ?? '').trim();

  // /scheduler_status — show all job statuses
  if (text === '/scheduler_status') {
    let reply = '🤖 Планировщик\n\n';
    try {
      const { results } = await db.prepare(
        `SELECT job_name, last_run_at, last_status, enabled
         FROM scheduler_config ORDER BY job_name`
      ).all();

      if (!results?.length) {
        reply += 'Нет данных о заданиях.';
      } else {
        for (const row of results) {
          const icon = row.last_status === 'ok' ? '✅' :
                       row.last_status === 'failed' ? '❌' :
                       row.last_status === 'partial' ? '⚠️' : '❓';
          const when = row.last_run_at
            ? new Date(row.last_run_at).toLocaleString('ru-RU', { timeZone: 'UTC' })
            : 'никогда';
          const disabled = row.enabled ? '' : ' [выкл]';
          reply += `${row.job_name}: ${icon} ${row.last_status ?? '?'} (${when})${disabled}\n`;
        }
      }
    } catch (e) {
      reply += `Ошибка загрузки статуса: ${String(e)}`;
    }

    try {
      if (typeof csSendTelegramMessage_ === 'function') {
        await csSendTelegramMessage_(env.TELEGRAM_BOT_TOKEN, chatId, reply);
      }
    } catch (_) { /* swallow */ }
    return true;
  }

  // /scheduler_run <job_name> — manual trigger (admin-only if ADMIN_TELEGRAM_ID set)
  if (text.startsWith('/scheduler_run')) {
    const parts = text.split(/\s+/);
    const jobName = parts[1] ?? '';

    // Admin check
    if (env.ADMIN_TELEGRAM_ID && String(userId) !== String(env.ADMIN_TELEGRAM_ID)) {
      try {
        if (typeof csSendTelegramMessage_ === 'function') {
          await csSendTelegramMessage_(env.TELEGRAM_BOT_TOKEN, chatId, '⛔ Доступ запрещён.');
        }
      } catch (_) { /* swallow */ }
      return true;
    }

    if (!jobName || !JOB_REGISTRY[jobName]) {
      const knownJobs = Object.keys(JOB_REGISTRY).join(', ');
      try {
        if (typeof csSendTelegramMessage_ === 'function') {
          await csSendTelegramMessage_(
            env.TELEGRAM_BOT_TOKEN, chatId,
            `❓ Неизвестное задание: "${jobName}"\nДоступные: ${knownJobs}`
          );
        }
      } catch (_) { /* swallow */ }
      return true;
    }

    // Run immediately
    let runResult;
    try {
      runResult = await runScheduledJob_(env, jobName, 'manual', () => JOB_REGISTRY[jobName](env));
    } catch (e) {
      runResult = { ok: false, status: 'failed', error: String(e) };
    }

    const icon = runResult.ok ? '✅' : '❌';
    const replyText = `${icon} Задание ${jobName}\nСтатус: ${runResult.status}\nДлительность: ${runResult.duration_ms ?? '?'}ms\n${JSON.stringify(runResult.result ?? {}, null, 2).slice(0, 300)}`;
    try {
      if (typeof csSendTelegramMessage_ === 'function') {
        await csSendTelegramMessage_(env.TELEGRAM_BOT_TOKEN, chatId, replyText);
      }
    } catch (_) { /* swallow */ }
    return true;
  }

  // /scheduler_logs — last 10 runs
  if (text === '/scheduler_logs') {
    let reply = '📋 Последние запуски планировщика\n\n';
    try {
      const { results } = await db.prepare(
        `SELECT job_name, status, started_at, duration_ms, error
         FROM scheduler_run_log ORDER BY started_at DESC LIMIT 10`
      ).all();

      if (!results?.length) {
        reply += 'Нет записей.';
      } else {
        for (const row of results) {
          const icon = row.status === 'ok' ? '✅' : row.status === 'failed' ? '❌' : '⚠️';
          const when = new Date(row.started_at).toLocaleString('ru-RU', { timeZone: 'UTC' });
          const duration = row.duration_ms != null ? ` ${row.duration_ms}ms` : '';
          const err = row.error ? ` — ${String(row.error).slice(0, 60)}` : '';
          reply += `${icon} ${row.job_name} (${when})${duration}${err}\n`;
        }
      }
    } catch (e) {
      reply += `Ошибка: ${String(e)}`;
    }

    try {
      if (typeof csSendTelegramMessage_ === 'function') {
        await csSendTelegramMessage_(env.TELEGRAM_BOT_TOKEN, chatId, reply);
      }
    } catch (_) { /* swallow */ }
    return true;
  }

  return false; // command not handled
}

// ---------------------------------------------------------------------------
// SECTION 7: API routes
// ---------------------------------------------------------------------------

/**
 * Handles /agent/scheduler/* HTTP routes.
 * Returns a Response, or null if the path is not matched.
 */
async function handleSchedulerRoutes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.DB;

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  // GET /agent/scheduler/status
  if (request.method === 'GET' && path === '/agent/scheduler/status') {
    try {
      const { results } = await db.prepare(
        `SELECT * FROM scheduler_config ORDER BY job_name`
      ).all();
      return json({ ok: true, jobs: results ?? [] });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  // GET /agent/scheduler/logs?job_name=&limit=20
  if (request.method === 'GET' && path === '/agent/scheduler/logs') {
    try {
      const jobNameFilter = url.searchParams.get('job_name') ?? null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);

      let stmt;
      if (jobNameFilter) {
        stmt = db.prepare(
          `SELECT * FROM scheduler_run_log WHERE job_name = ? ORDER BY started_at DESC LIMIT ?`
        ).bind(jobNameFilter, limit);
      } else {
        stmt = db.prepare(
          `SELECT * FROM scheduler_run_log ORDER BY started_at DESC LIMIT ?`
        ).bind(limit);
      }

      const { results } = await stmt.all();
      return json({ ok: true, logs: results ?? [] });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  // POST /agent/scheduler/run
  if (request.method === 'POST' && path === '/agent/scheduler/run') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const jobName = body?.job_name ?? '';
    if (!jobName || !JOB_REGISTRY[jobName]) {
      return json({ ok: false, error: `Unknown job_name: "${jobName}"`, known: Object.keys(JOB_REGISTRY) }, 400);
    }

    let runResult;
    try {
      runResult = await runScheduledJob_(env, jobName, 'api_manual', () => JOB_REGISTRY[jobName](env));
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }

    return json({ ok: runResult.ok, ...runResult });
  }

  // POST /agent/scheduler/config
  if (request.method === 'POST' && path === '/agent/scheduler/config') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ ok: false, error: 'Invalid JSON body' }, 400);
    }

    const { job_name, enabled, notify_chat_id, notify_on_error, notify_on_success } = body ?? {};
    if (!job_name) {
      return json({ ok: false, error: 'job_name is required' }, 400);
    }

    try {
      const now = new Date().toISOString();
      const id = wbGenerateId_('scfg');

      await db.prepare(`
        INSERT INTO scheduler_config
          (id, job_name, enabled, notify_chat_id, notify_on_error, notify_on_success, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_name) DO UPDATE SET
          enabled           = excluded.enabled,
          notify_chat_id    = excluded.notify_chat_id,
          notify_on_error   = excluded.notify_on_error,
          notify_on_success = excluded.notify_on_success,
          updated_at        = excluded.updated_at
      `).bind(
        id,
        job_name,
        enabled != null ? (enabled ? 1 : 0) : 1,
        notify_chat_id ?? null,
        notify_on_error != null ? (notify_on_error ? 1 : 0) : 1,
        notify_on_success != null ? (notify_on_success ? 1 : 0) : 0,
        now,
        now
      ).run();

      const updated = await db.prepare(
        `SELECT * FROM scheduler_config WHERE job_name = ?`
      ).bind(job_name).first();

      return json({ ok: true, config: updated });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  return null; // route not matched
}
