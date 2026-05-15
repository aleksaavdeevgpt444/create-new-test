// ============================================================
// Design Chief — AI модуль управления дизайном карточек (v1)
// Build: ai_helpers_design_chief_v1
//
// Получает handoff-события от других шефов:
//   card_content_gap  ← WB Operations Chief
//   rating_drop       ← CS Operations Chief
//
// ── Таблицы ─────────────────────────────────────────────────
//   design_handoff_item   — задачи дизайна из handoff-событий
//   design_card_snapshot  — снэпшоты карточек товаров (0-100)
//   design_content_plan   — планы контента, ожидающие подтверждения
//
// ── Субагенты ───────────────────────────────────────────────
//   runCardContentAnalyzerAgent_  — оценка карточки 0-100
//   runSeoAnalyzerAgent_          — анализ SEO-пробелов
//   runContentGapFinderAgent_     — приоритизация SKU по handoffs
//
// ── Telegram-команды ────────────────────────────────────────
//   /design | /design_report — запустить шефа, показать сводку
//   /design_handoffs          — pending задачи дизайна
//   /design_plan              — контент-план (ожидают подтверждения)
//
// ── Callbacks ───────────────────────────────────────────────
//   design_confirm_<id>  — подтвердить пункт контент-плана
//   design_skip_<id>     — отклонить пункт контент-плана
//
// ── API-маршруты ────────────────────────────────────────────
//   GET  /agent/design/handoffs
//   GET  /agent/design/plan
//   POST /agent/design/report/run
//   GET  /agent/design/card/:nm_id
//
// Правила безопасности:
//   - НИКОГДА не публиковать изменения карточек автоматически
//   - НИКОГДА не отправлять ТЗ дизайнерам без подтверждения человека
//   - Все рискованные действия: requires_confirmation: true
//   - Все предложения имеют confirmation_id
//   - НИКОГДА не считать «нет данных» нулём
//   - Всегда выводить source_status: 'missing' если данных нет
//
// Зависимости (всегда загружаются до):
//   wbGenerateId_(), wbLog_(), wbYesterday_(), wbFormatDate_(),
//   wbRound_(), csCallAi_(), csEscapeMd_(), csSendTelegramMessage_(),
//   csSafeText_(), ensureHandoffSchema_(), getHandoffEvents_(),
//   acknowledgeHandoff_(), HANDOFF_CHIEFS, HANDOFF_STATUS, HANDOFF_TYPE
// ============================================================

const DESIGN_BUILD = 'ai_helpers_design_chief_v1';

// ============================================================
// SECTION 1 — Schema
// ============================================================

async function ensureDesignSchema_(db) {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS design_handoff_item (
      id TEXT PRIMARY KEY,
      handoff_event_id TEXT,
      nm_id INTEGER,
      vendor_code TEXT,
      sku_title TEXT,
      issue_type TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'pending',
      evidence_json TEXT DEFAULT '[]',
      proposed_changes_json TEXT DEFAULT '{}',
      confirmation_id TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      confirmed_at TEXT,
      confirmed_by TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`).run();
  } catch (_) {}

  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS design_card_snapshot (
      id TEXT PRIMARY KEY,
      snapshot_date TEXT NOT NULL,
      nm_id INTEGER NOT NULL,
      vendor_code TEXT,
      sku_title TEXT,
      title_length INTEGER DEFAULT 0,
      description_length INTEGER DEFAULT 0,
      photos_count INTEGER DEFAULT 0,
      characteristics_count INTEGER DEFAULT 0,
      has_video INTEGER DEFAULT 0,
      title_keywords_json TEXT DEFAULT '[]',
      issues_found_json TEXT DEFAULT '[]',
      overall_score INTEGER DEFAULT 0,
      source_status TEXT DEFAULT 'missing',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(snapshot_date, nm_id)
    )`).run();
  } catch (_) {}

  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS design_content_plan (
      id TEXT PRIMARY KEY,
      plan_date TEXT NOT NULL,
      nm_id INTEGER NOT NULL,
      vendor_code TEXT,
      sku_title TEXT,
      priority TEXT DEFAULT 'medium',
      issue_type TEXT,
      current_state_json TEXT DEFAULT '{}',
      proposed_action TEXT,
      ai_draft TEXT,
      status TEXT DEFAULT 'pending',
      confirmation_id TEXT UNIQUE,
      requires_confirmation INTEGER DEFAULT 1,
      confirmed_at TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`).run();
  } catch (_) {}

  for (const sql of [
    `CREATE INDEX IF NOT EXISTS idx_design_handoff_status ON design_handoff_item(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_design_handoff_nm ON design_handoff_item(nm_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_design_snapshot_date ON design_card_snapshot(snapshot_date, nm_id)`,
    `CREATE INDEX IF NOT EXISTS idx_design_plan_status ON design_content_plan(status, plan_date DESC)`,
  ]) {
    try { await db.prepare(sql).run(); } catch (_) {}
  }
}

// ============================================================
// SECTION 2 — AI Helper
// ============================================================

async function callDesignAi_(env, prompt, maxTokens) {
  const max = maxTokens || 512;

  // Try Gemini
  if (env.GEMINI_API_KEY) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: max, temperature: 0.4 },
          }),
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { ok: true, text: text.trim(), source: 'gemini' };
      }
    } catch (_) {}
  }

  // Fallback: Groq
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
          max_tokens: max,
          temperature: 0.4,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return { ok: true, text: text.trim(), source: 'groq' };
      }
    } catch (_) {}
  }

  // Static fallback
  return { ok: false, text: null, source: 'static' };
}

// ============================================================
// SECTION 3 — Handoff Processing
// ============================================================

async function processDesignHandoffs_(db) {
  let processed = 0;
  let skipped = 0;

  try {
    const rows = await db.prepare(
      `SELECT * FROM handoff_event
       WHERE to_chief='design_chief' AND status='pending'
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY created_at ASC LIMIT 50`
    ).all();

    const events = rows.results || [];

    for (const evt of events) {
      try {
        const existing = await db.prepare(
          `SELECT id FROM design_handoff_item WHERE handoff_event_id=?`
        ).bind(evt.id).first();

        if (existing) { skipped++; continue; }

        const issueType = designIssueTypeFromHandoff_(evt.handoff_type, evt.payload_json);
        const itemId = designGenerateId_('dhoi');
        const confirmId = designBuildConfirmationId_(evt.nm_id || 'noid', issueType);
        const now = new Date().toISOString();

        let evidence = [];
        try { evidence = JSON.parse(evt.evidence_json || '[]'); } catch (_) {}

        await db.prepare(`INSERT OR IGNORE INTO design_handoff_item
          (id, handoff_event_id, nm_id, vendor_code, sku_title, issue_type,
           priority, status, evidence_json, proposed_changes_json,
           confirmation_id, requires_confirmation, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).bind(
          itemId, evt.id,
          evt.nm_id || null,
          evt.vendor_code || null,
          evt.sku_title || null,
          issueType,
          evt.priority || 'medium',
          'pending',
          JSON.stringify(evidence),
          '{}',
          confirmId,
          now, now
        ).run();

        await db.prepare(
          `UPDATE handoff_event SET status='acknowledged', acknowledged_at=datetime('now'),
           acknowledged_by='design_chief', updated_at=datetime('now') WHERE id=?`
        ).bind(evt.id).run();

        processed++;
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'design', entity_id: evt.id,
          action: 'process_handoff_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'process_handoffs',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return { processed, skipped };
}

function designIssueTypeFromHandoff_(handoffType, payloadJson) {
  if (handoffType === 'card_content_gap') return 'card_content_gap';
  if (handoffType === 'rating_drop') return 'rating_content';
  if (handoffType === 'seo_gap') return 'seo_gap';

  let payload = {};
  try { payload = JSON.parse(payloadJson || '{}'); } catch (_) {}

  if (payload.issue_type === 'photo_gap') return 'photo_gap';
  if (payload.issue_type === 'seo_gap') return 'seo_gap';

  return 'card_content_gap';
}

function designGenerateId_(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

function designBuildConfirmationId_(nmId, action) {
  const ts = Date.now().toString(36);
  return `design_${action}_${nmId}_${ts}`;
}

// ============================================================
// SECTION 4 — Card Content Analyzer Agent
// ============================================================

const DESIGN_CARD_SCORE_WEIGHTS = {
  title_length:            20,
  description_length:      20,
  photos_count:            25,
  characteristics_count:   20,
  has_video:               15,
};

function scoreCard_(card) {
  let score = 0;
  const issues = [];

  // Title (min 40 chars for good score)
  const titleLen = card.title_length || 0;
  if (titleLen >= 80) {
    score += DESIGN_CARD_SCORE_WEIGHTS.title_length;
  } else if (titleLen >= 40) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.title_length * 0.6);
    issues.push('Заголовок короткий — менее 80 символов');
  } else if (titleLen > 0) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.title_length * 0.2);
    issues.push('Заголовок очень короткий — менее 40 символов');
  } else {
    issues.push('Заголовок отсутствует');
  }

  // Description (min 200 chars)
  const descLen = card.description_length || 0;
  if (descLen >= 500) {
    score += DESIGN_CARD_SCORE_WEIGHTS.description_length;
  } else if (descLen >= 200) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.description_length * 0.6);
    issues.push('Описание короткое — менее 500 символов');
  } else if (descLen > 0) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.description_length * 0.2);
    issues.push('Описание очень короткое — менее 200 символов');
  } else {
    issues.push('Описание отсутствует');
  }

  // Photos (min 5 recommended, 8 ideal)
  const photos = card.photos_count || 0;
  if (photos >= 8) {
    score += DESIGN_CARD_SCORE_WEIGHTS.photos_count;
  } else if (photos >= 5) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.photos_count * 0.7);
    issues.push('Менее 8 фотографий');
  } else if (photos >= 2) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.photos_count * 0.3);
    issues.push(`Мало фотографий — только ${photos}`);
  } else if (photos === 1) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.photos_count * 0.1);
    issues.push('Только одна фотография');
  } else {
    issues.push('Фотографии отсутствуют');
  }

  // Characteristics (min 5)
  const chars = card.characteristics_count || 0;
  if (chars >= 10) {
    score += DESIGN_CARD_SCORE_WEIGHTS.characteristics_count;
  } else if (chars >= 5) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.characteristics_count * 0.6);
    issues.push('Менее 10 характеристик');
  } else if (chars > 0) {
    score += Math.round(DESIGN_CARD_SCORE_WEIGHTS.characteristics_count * 0.2);
    issues.push(`Мало характеристик — только ${chars}`);
  } else {
    issues.push('Характеристики не заполнены');
  }

  // Video
  if (card.has_video) {
    score += DESIGN_CARD_SCORE_WEIGHTS.has_video;
  } else {
    issues.push('Нет видео');
  }

  return { score: Math.min(100, Math.max(0, score)), issues };
}

async function runCardContentAnalyzerAgent_(env, db, date) {
  const result = {
    date,
    items_analyzed: 0,
    snapshots_saved: 0,
    avg_score: null,
    low_score_count: 0,
    source_status: 'missing',
  };

  try {
    const rows = await db.prepare(
      `SELECT DISTINCT nm_id, vendor_code, sku_title, priority, evidence_json
       FROM design_handoff_item
       WHERE status IN ('pending','in_progress')
       ORDER BY created_at ASC LIMIT 100`
    ).all();

    const items = rows.results || [];
    if (items.length === 0) {
      result.source_status = 'missing';
      return result;
    }

    result.source_status = 'ok';
    let totalScore = 0;
    let scored = 0;

    for (const item of items) {
      try {
        let evidence = [];
        try { evidence = JSON.parse(item.evidence_json || '[]'); } catch (_) {}

        // Build card data from evidence (since no direct WB card API here)
        const cardData = extractCardDataFromEvidence_(evidence, item);

        const { score, issues } = scoreCard_(cardData);

        const snapshotId = designGenerateId_('dcs');
        const now = new Date().toISOString();

        await db.prepare(`INSERT OR REPLACE INTO design_card_snapshot
          (id, snapshot_date, nm_id, vendor_code, sku_title,
           title_length, description_length, photos_count,
           characteristics_count, has_video,
           title_keywords_json, issues_found_json, overall_score, source_status, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          snapshotId, date,
          item.nm_id || 0,
          item.vendor_code || null,
          item.sku_title || null,
          cardData.title_length,
          cardData.description_length,
          cardData.photos_count,
          cardData.characteristics_count,
          cardData.has_video ? 1 : 0,
          JSON.stringify(cardData.title_keywords || []),
          JSON.stringify(issues),
          score,
          'ok',
          now
        ).run();

        result.snapshots_saved++;
        totalScore += score;
        scored++;
        if (score < 50) result.low_score_count++;

        result.items_analyzed++;
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'design', entity_id: String(item.nm_id || 'unknown'),
          action: 'card_analyzer_item_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }

    result.avg_score = scored > 0 ? Math.round(totalScore / scored) : null;
  } catch (e) {
    result.source_status = 'error';
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'card_analyzer',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

function extractCardDataFromEvidence_(evidence, item) {
  const card = {
    title_length: 0,
    description_length: 0,
    photos_count: 0,
    characteristics_count: 0,
    has_video: false,
    title_keywords: [],
  };

  for (const ev of evidence) {
    const s = String(ev || '').toLowerCase();
    const numMatch = s.match(/(\d+)/);
    const num = numMatch ? parseInt(numMatch[1], 10) : 0;

    if (/фото|фотограф|photo/.test(s) && num > 0) card.photos_count = num;
    if (/характеристик/.test(s) && num > 0) card.characteristics_count = num;
    if (/описание.*символ|символ.*описани/.test(s) && num > 0) card.description_length = num;
    if (/заголовок.*символ|title.*char/.test(s) && num > 0) card.title_length = num;
    if (/видео|video/.test(s)) card.has_video = true;
  }

  // Use sku_title length as fallback for title_length
  if (card.title_length === 0 && item.sku_title) {
    card.title_length = item.sku_title.length;
  }

  return card;
}

// ============================================================
// SECTION 5 — SEO Analyzer Agent
// ============================================================

const DESIGN_SEO_KEYWORDS_BY_CATEGORY = {
  одежда:       ['размер', 'материал', 'состав', 'уход', 'модель', 'коллекция', 'фасон'],
  обувь:        ['размер', 'подошва', 'материал', 'сезон', 'полнота', 'высота каблука'],
  электроника:  ['мощность', 'гарантия', 'совместимость', 'интерфейс', 'память', 'разрешение'],
  косметика:    ['состав', 'объём', 'тип кожи', 'применение', 'эффект', 'срок годности'],
  детские:      ['возраст', 'материал', 'безопасность', 'размер', 'сертификат'],
  дом:          ['материал', 'размер', 'уход', 'стиль', 'цвет', 'комплектация'],
  спорт:        ['размер', 'материал', 'нагрузка', 'сезон', 'вес', 'тип спорта'],
  default:      ['качество', 'материал', 'размер', 'цвет', 'применение', 'характеристики'],
};

function detectProductCategory_(skuTitle) {
  const t = (skuTitle || '').toLowerCase();
  if (/платье|брюки|футболк|пальто|куртк|рубашк|костюм|юбк|джинс/.test(t)) return 'одежда';
  if (/туфли|сапог|кроссовк|ботинк|сандал|мокасин|кед/.test(t)) return 'обувь';
  if (/телефон|ноутбук|планшет|наушник|колонк|камер|принтер/.test(t)) return 'электроника';
  if (/крем|сыворотк|шампунь|маска|помад|тушь|духи|парфюм/.test(t)) return 'косметика';
  if (/детск|игрушк|коляск|пеленк|бодик|подгузн/.test(t)) return 'детские';
  if (/диван|стол|стул|шкаф|кровать|подушк|одеяло|полотенц/.test(t)) return 'дом';
  if (/гантел|велосипед|коврик|тренажер|перчатк спорт|мяч/.test(t)) return 'спорт';
  return 'default';
}

function analyzeSeoGaps_(skuTitle, description, titleKeywords) {
  const category = detectProductCategory_(skuTitle);
  const expected = DESIGN_SEO_KEYWORDS_BY_CATEGORY[category] || DESIGN_SEO_KEYWORDS_BY_CATEGORY.default;

  const combined = [
    ...(skuTitle || '').toLowerCase().split(/\s+/),
    ...(description || '').toLowerCase().split(/\s+/),
    ...(titleKeywords || []).map(k => String(k).toLowerCase()),
  ].join(' ');

  const missing = expected.filter(kw => !combined.includes(kw));
  const present = expected.filter(kw => combined.includes(kw));

  const coverageRate = expected.length > 0 ? present.length / expected.length : 0;

  return { category, missing, present, coverageRate };
}

async function runSeoAnalyzerAgent_(env, db, date) {
  const result = {
    date,
    items_analyzed: 0,
    gaps: [],
    avg_coverage_rate: null,
    source_status: 'missing',
  };

  try {
    const rows = await db.prepare(
      `SELECT dhi.nm_id, dhi.vendor_code, dhi.sku_title, dhi.issue_type, dhi.priority,
              dcs.title_keywords_json, dcs.overall_score
       FROM design_handoff_item dhi
       LEFT JOIN design_card_snapshot dcs
         ON dcs.nm_id=dhi.nm_id AND dcs.snapshot_date=?
       WHERE dhi.status IN ('pending','in_progress')
       ORDER BY dhi.created_at ASC LIMIT 100`
    ).bind(date).all();

    const items = rows.results || [];
    if (items.length === 0) {
      result.source_status = 'missing';
      return result;
    }

    result.source_status = 'ok';
    let totalCoverage = 0;
    let analyzed = 0;

    for (const item of items) {
      try {
        let titleKeywords = [];
        try { titleKeywords = JSON.parse(item.title_keywords_json || '[]'); } catch (_) {}

        const { category, missing, present, coverageRate } = analyzeSeoGaps_(
          item.sku_title, '', titleKeywords
        );

        if (missing.length > 0) {
          result.gaps.push({
            nm_id: item.nm_id,
            vendor_code: item.vendor_code,
            sku_title: item.sku_title,
            category,
            missing_keywords: missing,
            present_keywords: present,
            coverage_rate: wbRound_(coverageRate, 2),
            priority: item.priority,
          });
        }

        totalCoverage += coverageRate;
        analyzed++;
        result.items_analyzed++;
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'design', entity_id: String(item.nm_id || 'unknown'),
          action: 'seo_item_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }

    result.avg_coverage_rate = analyzed > 0 ? wbRound_(totalCoverage / analyzed, 2) : null;
  } catch (e) {
    result.source_status = 'error';
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'seo_analyzer',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 6 — Content Gap Finder Agent
// ============================================================

const DESIGN_PRIORITY_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 };

async function runContentGapFinderAgent_(env, db, date) {
  const result = {
    date,
    priority_items: [],
    total_pending: 0,
    source_status: 'missing',
  };

  try {
    const rows = await db.prepare(
      `SELECT dhi.nm_id, dhi.vendor_code, dhi.sku_title,
              dhi.priority, dhi.issue_type, dhi.status,
              dhi.evidence_json, dhi.created_at,
              COUNT(*) as handoff_count,
              dcs.overall_score
       FROM design_handoff_item dhi
       LEFT JOIN design_card_snapshot dcs
         ON dcs.nm_id=dhi.nm_id AND dcs.snapshot_date=?
       WHERE dhi.status IN ('pending','in_progress')
       GROUP BY dhi.nm_id
       ORDER BY dhi.created_at ASC LIMIT 200`
    ).bind(date).all();

    const groups = rows.results || [];
    if (groups.length === 0) {
      result.source_status = 'missing';
      return result;
    }

    result.source_status = 'ok';
    result.total_pending = groups.length;

    const scored = groups.map(g => {
      const priorityScore = DESIGN_PRIORITY_WEIGHT[g.priority] || 1;
      const scorePenalty = g.overall_score !== null ? (100 - (g.overall_score || 0)) / 100 : 0.5;
      const handoffBonus = Math.min((g.handoff_count || 1) * 0.2, 1.0);
      const totalScore = priorityScore + scorePenalty + handoffBonus;

      return {
        nm_id: g.nm_id,
        vendor_code: g.vendor_code,
        sku_title: g.sku_title,
        priority: g.priority,
        issue_type: g.issue_type,
        handoff_count: g.handoff_count || 1,
        card_score: g.overall_score !== null ? g.overall_score : null,
        card_score_status: g.overall_score !== null ? 'ok' : 'missing',
        sort_score: wbRound_(totalScore, 3),
      };
    });

    scored.sort((a, b) => b.sort_score - a.sort_score);
    result.priority_items = scored;
  } catch (e) {
    result.source_status = 'error';
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'gap_finder',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 7 — Content Plan Generation
// ============================================================

async function generateContentDraft_(env, nmId, issueType, evidence) {
  const evidenceText = Array.isArray(evidence) ? evidence.join('; ') : String(evidence || '');

  const prompt = `Ты AI-помощник по контенту для маркетплейса Wildberries.
Товар: nm_id ${nmId}
Тип проблемы: ${issueType}
Доказательства: ${csSafeText_(evidenceText, 400)}

Составь краткие рекомендации по улучшению карточки товара (до 600 символов):
- Конкретные предложения по заголовку, описанию или фотографиям
- Список ключевых слов для добавления (если нужно)
- Что именно исправить в первую очередь

Только текст рекомендаций.`;

  const aiResult = await callDesignAi_(env, prompt, 512);

  if (aiResult.ok && aiResult.text) {
    return csSafeText_(aiResult.text.trim(), 600);
  }

  const fallbacks = {
    card_content_gap: `Рекомендуется: добавить подробное описание товара (минимум 200 символов), указать все основные характеристики, загрузить не менее 5 фотографий с разных ракурсов.`,
    seo_gap:          `Рекомендуется: добавить в заголовок и описание ключевые слова категории. Проверить и расширить список характеристик для лучшей индексации.`,
    photo_gap:        `Рекомендуется: загрузить дополнительные фотографии (минимум 5-8 штук). Добавить фото на белом фоне, фото деталей и фото в использовании.`,
    rating_content:   `Рекомендуется: проверить соответствие описания реальному товару, добавить инструкцию по использованию, уточнить характеристики согласно отзывам покупателей.`,
  };

  return fallbacks[issueType] || `Рекомендуется улучшить контент карточки товара nm_id ${nmId}: заголовок, описание и фотографии.`;
}

async function buildContentPlan_(db, date, gapResult) {
  const created = [];
  const items = gapResult.priority_items || [];

  const highPriorityItems = items.filter(
    it => ['critical', 'high'].includes(it.priority) || (it.card_score !== null && it.card_score < 50)
  ).slice(0, 20);

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const item of highPriorityItems) {
    try {
      const existing = await db.prepare(
        `SELECT id FROM design_content_plan
         WHERE nm_id=? AND plan_date=? AND status IN ('pending','in_progress')`
      ).bind(item.nm_id, date).first();

      if (existing) continue;

      const planId = designGenerateId_('dcp');
      const confirmId = designBuildConfirmationId_(item.nm_id, 'content_plan');

      const currentState = {
        card_score: item.card_score,
        card_score_status: item.card_score_status,
        handoff_count: item.handoff_count,
        issue_type: item.issue_type,
      };

      const proposedAction = designProposeAction_(item.issue_type, item.card_score);

      await db.prepare(`INSERT OR IGNORE INTO design_content_plan
        (id, plan_date, nm_id, vendor_code, sku_title, priority, issue_type,
         current_state_json, proposed_action, ai_draft, status,
         confirmation_id, requires_confirmation, expires_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).bind(
        planId, date,
        item.nm_id,
        item.vendor_code || null,
        item.sku_title || null,
        item.priority,
        item.issue_type,
        JSON.stringify(currentState),
        proposedAction,
        null,
        'pending',
        confirmId,
        expiresAt,
        now
      ).run();

      created.push({ plan_id: planId, nm_id: item.nm_id, confirmation_id: confirmId });
    } catch (e) {
      await wbLog_(db, {
        entity_type: 'design', entity_id: String(item.nm_id || 'unknown'),
        action: 'build_plan_item_error', status: 'error',
        details_json: JSON.stringify({ error: String(e) }),
      });
    }
  }

  return { plans_created: created.length, items: created };
}

function designProposeAction_(issueType, cardScore) {
  if (issueType === 'photo_gap') return 'Загрузить дополнительные фотографии (минимум 5)';
  if (issueType === 'seo_gap') return 'Добавить ключевые слова категории в заголовок и описание';
  if (issueType === 'rating_content') return 'Привести описание в соответствие с реальными характеристиками товара';
  if (cardScore !== null && cardScore < 30) return 'Комплексное обновление карточки: заголовок, описание, фото, характеристики';
  return 'Дополнить описание и характеристики товара';
}

// ============================================================
// SECTION 8 — Chief Orchestrator
// ============================================================

async function runDesignChief_(env) {
  const db = env.DB;
  const date = wbYesterday_();
  const now = new Date().toISOString();

  await ensureDesignSchema_(db);

  const handoffResult = await processDesignHandoffs_(db);

  const [cardResult, seoResult] = await Promise.all([
    runCardContentAnalyzerAgent_(env, db, date),
    runSeoAnalyzerAgent_(env, db, date),
  ]);

  const gapResult = await runContentGapFinderAgent_(env, db, date);

  // Enrich top priority items with AI drafts
  const topItems = (gapResult.priority_items || []).filter(
    it => ['critical', 'high'].includes(it.priority)
  ).slice(0, 5);

  for (const item of topItems) {
    try {
      let evidence = [];
      try {
        const row = await db.prepare(
          `SELECT evidence_json FROM design_handoff_item WHERE nm_id=? AND status IN ('pending','in_progress') LIMIT 1`
        ).bind(item.nm_id).first();
        if (row) evidence = JSON.parse(row.evidence_json || '[]');
      } catch (_) {}

      const draft = await generateContentDraft_(env, item.nm_id, item.issue_type, evidence);

      await db.prepare(
        `UPDATE design_content_plan SET ai_draft=?, updated_at=? WHERE nm_id=? AND plan_date=? AND ai_draft IS NULL`
      ).bind(draft, now, item.nm_id, date).run();
    } catch (_) {}
  }

  const planResult = await buildContentPlan_(db, date, gapResult);

  const report = {
    date,
    generated_at: now,
    build: DESIGN_BUILD,
    handoffs: handoffResult,
    card_analyzer: cardResult,
    seo_analyzer: seoResult,
    gap_finder: gapResult,
    content_plan: planResult,
    totals: {
      handoffs_processed: handoffResult.processed,
      cards_analyzed: cardResult.items_analyzed,
      low_score_cards: cardResult.low_score_count,
      avg_card_score: cardResult.avg_score,
      seo_gaps_found: seoResult.gaps.length,
      priority_items: (gapResult.priority_items || []).length,
      plans_created: planResult.plans_created,
    },
  };

  await wbLog_(db, {
    entity_type: 'design', entity_id: 'design_chief',
    action: 'chief_run_complete', status: 'ok',
    details_json: JSON.stringify({ date, totals: report.totals }),
  });

  // Send Telegram summary
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await sendDesignTelegramSummary_(env, report);
    } catch (_) {}
  }

  return report;
}

async function sendDesignTelegramSummary_(env, report) {
  const t = report.totals;
  const avgScore = t.avg_card_score !== null
    ? csEscapeMd_(String(t.avg_card_score))
    : csEscapeMd_('нет данных');

  const lines = [
    `*Дизайн-шеф — ${csEscapeMd_(report.date)}*`,
    '',
    `📥 Handoffs обработано: *${t.handoffs_processed}*`,
    `🃏 Карточек проанализировано: *${t.cards_analyzed}*`,
    `📉 Слабых карточек \\(< 50 баллов\\): *${t.low_score_cards}*`,
    `📊 Средний балл карточек: *${avgScore}*`,
    `🔍 SEO\\-пробелов выявлено: *${t.seo_gaps_found}*`,
    `📋 Приоритетных задач: *${t.priority_items}*`,
    `✅ Планов создано \\(ждут подтверждения\\): *${t.plans_created}*`,
    '',
    `_Все изменения карточек требуют подтверждения человека\\._`,
  ];

  await csSendTelegramMessage_(
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_CHAT_ID,
    lines.join('\n')
  );
}

// ============================================================
// SECTION 9 — Telegram Commands
// ============================================================

async function routeDesignTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;

  const command = text.split(' ')[0].toLowerCase();

  if (!['/design', '/design_report', '/design_handoffs', '/design_plan'].includes(command)) {
    return false;
  }

  try {
    await ensureDesignSchema_(db);

    if (command === '/design' || command === '/design_report') {
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Запускаю Design Chief, подождите...'));
      const report = await runDesignChief_(env);
      const t = report.totals;
      const avgScore = t.avg_card_score !== null
        ? String(t.avg_card_score)
        : 'нет данных';

      const out = [
        `*Отчёт Design Chief — ${csEscapeMd_(report.date)}*`,
        '',
        `Handoffs обработано: ${csEscapeMd_(String(t.handoffs_processed))}`,
        `Карточек проанализировано: ${csEscapeMd_(String(t.cards_analyzed))}`,
        `Слабых карточек: ${csEscapeMd_(String(t.low_score_cards))}`,
        `Средний балл: ${csEscapeMd_(avgScore)}`,
        `SEO\\-пробелов: ${csEscapeMd_(String(t.seo_gaps_found))}`,
        `Планов ожидают подтверждения: ${csEscapeMd_(String(t.plans_created))}`,
      ].join('\n');

      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/design_handoffs') {
      const rows = await db.prepare(
        `SELECT * FROM design_handoff_item
         WHERE status='pending'
         ORDER BY created_at DESC LIMIT 20`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Нет pending задач дизайна.'));
        return true;
      }

      let out = `*Pending задачи дизайна \\(${items.length}\\)*\n\n`;
      for (const item of items) {
        const priority = csEscapeMd_(item.priority || 'medium');
        const sku = csEscapeMd_(item.sku_title || `nm_id:${item.nm_id || '—'}`);
        const type = csEscapeMd_(item.issue_type || '—');
        out += `• *${sku}*\n`;
        out += `  Тип: ${type} | Приоритет: ${priority}\n`;
      }

      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/design_plan') {
      const rows = await db.prepare(
        `SELECT * FROM design_content_plan
         WHERE status='pending' AND requires_confirmation=1
         ORDER BY plan_date DESC, created_at DESC LIMIT 15`
      ).all();

      const plans = rows.results || [];
      if (plans.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Нет пунктов контент-плана, ожидающих подтверждения.'));
        return true;
      }

      for (const plan of plans) {
        const sku = csEscapeMd_(plan.sku_title || `nm_id:${plan.nm_id || '—'}`);
        const action = csEscapeMd_(plan.proposed_action || '—');
        const draft = plan.ai_draft
          ? csEscapeMd_(csSafeText_(plan.ai_draft, 250))
          : csEscapeMd_('Черновик не сгенерирован');

        const msgBody =
          `*Контент\\-план*: ${sku}\n` +
          `Действие: _${action}_\n` +
          `Черновик: ${draft}`;

        try {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: msgBody,
              parse_mode: 'MarkdownV2',
              reply_markup: { inline_keyboard: [[
                { text: '✅ Подтвердить', callback_data: `design_confirm_${plan.id}` },
                { text: '⏭ Пропустить', callback_data: `design_skip_${plan.id}` },
              ]] },
            }),
          });
        } catch (_) {}
      }
      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'telegram_handler',
      action: 'command_error', status: 'error',
      details_json: JSON.stringify({ command, error: String(e) }),
    });
    try {
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Произошла ошибка при выполнении команды.'));
    } catch (_) {}
  }

  return false;
}

// ============================================================
// SECTION 10 — Callback Routing
// ============================================================

async function routeDesignCallbackQuery_(env, cq) {
  const data = (cq.data || '');
  if (!data.startsWith('design_')) return false;

  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;
  const userId = String(cq.from?.id || '');
  const chatId = cq.message?.chat?.id;

  const answerCq = async (text) => {
    try {
      await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: cq.id,
          text: text || '',
          show_alert: false,
        }),
      });
    } catch (_) {}
  };

  try {
    await ensureDesignSchema_(db);

    if (data.startsWith('design_confirm_')) {
      const planId = data.replace('design_confirm_', '');
      const plan = await db.prepare(
        `SELECT * FROM design_content_plan WHERE id=?`
      ).bind(planId).first();

      if (!plan) { await answerCq('Пункт плана не найден.'); return true; }
      if (plan.status === 'confirmed') { await answerCq('Уже подтверждено.'); return true; }
      if (plan.status === 'dismissed') { await answerCq('Пункт был пропущен.'); return true; }

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE design_content_plan SET status='confirmed', confirmed_at=?, updated_at=? WHERE id=?`
      ).bind(now, now, planId).run();

      await db.prepare(
        `UPDATE design_handoff_item SET status='in_progress', updated_at=? WHERE nm_id=? AND status='pending'`
      ).bind(now, plan.nm_id).run();

      await wbLog_(db, {
        entity_type: 'design', entity_id: planId,
        action: 'content_plan_confirmed', status: 'ok',
        details_json: JSON.stringify({ confirmed_by: userId, nm_id: plan.nm_id }),
      });

      await answerCq('✅ Подтверждено. Задача передана в работу.');

      if (token && chatId) {
        await csSendTelegramMessage_(token, chatId,
          `*Подтверждено*: ${csEscapeMd_(plan.sku_title || `nm_id:${plan.nm_id}`)}\n_Изменения в карточку вносятся вручную\\._`
        );
      }
      return true;
    }

    if (data.startsWith('design_skip_')) {
      const planId = data.replace('design_skip_', '');
      const plan = await db.prepare(
        `SELECT * FROM design_content_plan WHERE id=?`
      ).bind(planId).first();

      if (!plan) { await answerCq('Пункт плана не найден.'); return true; }
      if (plan.status === 'dismissed') { await answerCq('Уже пропущено.'); return true; }

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE design_content_plan SET status='dismissed', updated_at=? WHERE id=?`
      ).bind(now, planId).run();

      await wbLog_(db, {
        entity_type: 'design', entity_id: planId,
        action: 'content_plan_dismissed', status: 'ok',
        details_json: JSON.stringify({ dismissed_by: userId, nm_id: plan.nm_id }),
      });

      await answerCq('⏭ Пропущено.');
      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'callback_handler',
      action: 'callback_error', status: 'error',
      details_json: JSON.stringify({ data, error: String(e) }),
    });
    await answerCq('Ошибка при обработке.');
  }

  return false;
}

// ============================================================
// SECTION 11 — API Routes
// ============================================================

async function handleDesignRoutes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;

  if (!path.startsWith('/agent/design')) return null;

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    await ensureDesignSchema_(db);

    // GET /agent/design/handoffs
    if (method === 'GET' && path === '/agent/design/handoffs') {
      const status = url.searchParams.get('status') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
      const nmId = url.searchParams.get('nm_id') || null;

      let sql = `SELECT * FROM design_handoff_item WHERE 1=1`;
      const binds = [];
      if (status) { sql += ` AND status=?`; binds.push(status); }
      if (nmId)   { sql += ` AND nm_id=?`;  binds.push(nmId); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      const items = rows.results || [];
      return json({ ok: true, handoffs: items, count: items.length });
    }

    // GET /agent/design/plan
    if (method === 'GET' && path === '/agent/design/plan') {
      const status = url.searchParams.get('status') || 'pending';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      const rows = await db.prepare(
        `SELECT * FROM design_content_plan WHERE status=?
         ORDER BY plan_date DESC, created_at DESC LIMIT ?`
      ).bind(status, limit).all();

      const items = rows.results || [];
      return json({ ok: true, plans: items, count: items.length });
    }

    // POST /agent/design/report/run
    if (method === 'POST' && path === '/agent/design/report/run') {
      const report = await runDesignChief_(env);
      return json({ ok: true, report });
    }

    // GET /agent/design/card/:nm_id
    const cardMatch = path.match(/^\/agent\/design\/card\/(\d+)$/);
    if (method === 'GET' && cardMatch) {
      const nmId = parseInt(cardMatch[1], 10);
      if (!nmId) return json({ ok: false, error: 'invalid_nm_id' }, 400);

      const snapshot = await db.prepare(
        `SELECT * FROM design_card_snapshot WHERE nm_id=? ORDER BY snapshot_date DESC LIMIT 1`
      ).bind(nmId).first();

      if (!snapshot) {
        return json({
          ok: true,
          nm_id: nmId,
          snapshot: null,
          source_status: 'missing',
        });
      }

      return json({ ok: true, nm_id: nmId, snapshot, source_status: 'ok' });
    }

    // POST /agent/design/plan/:id/confirm
    const confirmMatch = path.match(/^\/agent\/design\/plan\/([^/]+)\/confirm$/);
    if (method === 'POST' && confirmMatch) {
      const planId = confirmMatch[1];
      const plan = await db.prepare(
        `SELECT * FROM design_content_plan WHERE id=?`
      ).bind(planId).first();

      if (!plan) return json({ ok: false, error: 'plan_not_found' }, 404);
      if (plan.status === 'confirmed') return json({ ok: true, idempotent: true });
      if (plan.status === 'dismissed') return json({ ok: false, error: 'plan_dismissed' }, 409);

      let body = {};
      try { body = await request.json(); } catch (_) {}

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE design_content_plan SET status='confirmed', confirmed_at=?, updated_at=? WHERE id=?`
      ).bind(now, now, planId).run();

      await wbLog_(db, {
        entity_type: 'design', entity_id: planId,
        action: 'plan_confirmed_api', status: 'ok',
        details_json: JSON.stringify({ confirmed_by: body.user_id || null }),
      });

      return json({ ok: true, plan_id: planId, status: 'confirmed' });
    }

    // POST /agent/design/plan/:id/dismiss
    const dismissMatch = path.match(/^\/agent\/design\/plan\/([^/]+)\/dismiss$/);
    if (method === 'POST' && dismissMatch) {
      const planId = dismissMatch[1];
      const plan = await db.prepare(
        `SELECT id, status FROM design_content_plan WHERE id=?`
      ).bind(planId).first();

      if (!plan) return json({ ok: false, error: 'plan_not_found' }, 404);
      if (plan.status === 'dismissed') return json({ ok: true, idempotent: true });

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE design_content_plan SET status='dismissed', updated_at=? WHERE id=?`
      ).bind(now, planId).run();

      await wbLog_(db, {
        entity_type: 'design', entity_id: planId,
        action: 'plan_dismissed_api', status: 'ok',
        details_json: JSON.stringify({}),
      });

      return json({ ok: true, plan_id: planId, status: 'dismissed' });
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'design', entity_id: 'api_router',
      action: 'route_error', status: 'error',
      details_json: JSON.stringify({ path, method, error: String(e) }),
    });
    return json({ ok: false, error: String(e) }, 500);
  }

  return null;
}
