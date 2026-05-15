// ============================================================
// CS Operations Chief — Stage 2 (v1)
// Build: ai_helpers_stage2_cs_operations_v1
// Extends: cs_operations_stage1_v1.gs (do NOT modify Stage 1)
//
// ── New Tables ───────────────────────────────────────────────
//   cs_appeal_item         — WB review appeal drafts and submissions
//   cs_knowledge_gap       — detected KB gaps with frequency tracking
//
// ── Schema Patches (ALTER TABLE) ────────────────────────────
//   cs_inbox_item:    + marketplace, vendor_code, item_type,
//                       customer_name, sentiment, topic,
//                       requires_human_review
//   cs_draft_response: + source_agent, tone_status, risk_status
//
// ── New Agents ───────────────────────────────────────────────
//   runComplaintAppealAgent_    — classify/draft WB review appeals
//   runKnowledgeBaseAgent_      — detect KB gaps, suggest templates
//   runToneLoyaltyAgentV2_      — enhanced tone + risk phrase guard
//   runCsOperationsChiefV2_     — V2 orchestrator (all 6 agents)
//
// ── New Telegram Commands ────────────────────────────────────
//   /cs_appeals   — overrides Stage 1: shows appeal drafts with buttons
//   /cs_knowledge — knowledge gaps + stale items
//
// ── New Callbacks ────────────────────────────────────────────
//   cs_submit_appeal_*    — submit appeal (idempotent)
//   cs_cancel_appeal_*    — cancel appeal
//   cs_create_kb_*        — generate KB template from gap
//
// ── New API Endpoints ────────────────────────────────────────
//   GET  /agent/cs/appeals
//   POST /agent/cs/appeals/:id/submit
//   GET  /agent/cs/knowledge/gaps
//   POST /agent/cs/knowledge/gaps/:id/create-template
//   POST /agent/cs/report/run/v2
//
// Dependencies (Stage 1, always loaded first):
//   csCallAi_(), csEscapeMd_(), csSendTelegramMessage_(),
//   csBuildConfirmationId_(), csSafeText_(), csDetectLanguage_()
//   wbGenerateId_(), wbLog_(), wbYesterday_(), wbFormatDate_(),
//   wbRound_(), runReviewResponseAgent_(), runQaAgent_(),
//   runReturnReasonAgent_(), runProductIssueClassifierAgent_(),
//   runProductFeedbackAgent_(), routeCsCallbackQuery_()
// ============================================================

const CS_BUILD_V2 = 'ai_helpers_stage2_cs_operations_v1';

// ============================================================
// SECTION 1 — Schema Patch
// ============================================================

async function ensureCsStage2Schema_(db) {
  // New table: cs_appeal_item
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS cs_appeal_item (
      id TEXT PRIMARY KEY,
      inbox_item_id TEXT NOT NULL,
      nm_id INTEGER,
      sku_title TEXT,
      user_id TEXT,
      appeal_reason TEXT NOT NULL,
      appeal_possible INTEGER DEFAULT 0,
      evidence_json TEXT DEFAULT '[]',
      draft_appeal TEXT,
      risk_level TEXT DEFAULT 'low',
      status TEXT DEFAULT 'draft',
      confirmation_id TEXT UNIQUE,
      submitted_at TEXT,
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`).run();
  } catch (_) { /* already exists */ }

  // New table: cs_knowledge_gap
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS cs_knowledge_gap (
      id TEXT PRIMARY KEY,
      nm_id INTEGER,
      sku_title TEXT,
      topic TEXT NOT NULL,
      question_pattern TEXT,
      frequency_count INTEGER DEFAULT 1,
      source_items_json TEXT DEFAULT '[]',
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(nm_id, topic)
    )`).run();
  } catch (_) { /* already exists */ }

  // Patch cs_inbox_item — each column in its own try/catch
  const inboxPatches = [
    `ALTER TABLE cs_inbox_item ADD COLUMN marketplace TEXT DEFAULT 'wb'`,
    `ALTER TABLE cs_inbox_item ADD COLUMN vendor_code TEXT`,
    `ALTER TABLE cs_inbox_item ADD COLUMN item_type TEXT`,
    `ALTER TABLE cs_inbox_item ADD COLUMN customer_name TEXT`,
    `ALTER TABLE cs_inbox_item ADD COLUMN sentiment TEXT DEFAULT 'neutral'`,
    `ALTER TABLE cs_inbox_item ADD COLUMN topic TEXT`,
    `ALTER TABLE cs_inbox_item ADD COLUMN requires_human_review INTEGER DEFAULT 0`,
  ];

  for (const sql of inboxPatches) {
    try { await db.prepare(sql).run(); } catch (_) { /* duplicate column — ignore */ }
  }

  // Patch cs_draft_response — each column in its own try/catch
  const draftPatches = [
    `ALTER TABLE cs_draft_response ADD COLUMN source_agent TEXT`,
    `ALTER TABLE cs_draft_response ADD COLUMN tone_status TEXT DEFAULT 'pending'`,
    `ALTER TABLE cs_draft_response ADD COLUMN risk_status TEXT DEFAULT 'ok'`,
  ];

  for (const sql of draftPatches) {
    try { await db.prepare(sql).run(); } catch (_) { /* duplicate column — ignore */ }
  }
}

// ============================================================
// SECTION 2 — Complaint / Appeal Agent
// ============================================================

const CS_APPEAL_REASON = {
  NOT_ABOUT_PRODUCT:  'review_not_about_product',
  FALSE_CLAIM:        'false_claim_possible',
  NO_PRODUCT_USAGE:   'no_product_usage',
  COMPETITOR_ATTACK:  'competitor_attack_suspicion',
  OFFENSIVE_CONTENT:  'offensive_content',
  DELIVERY_ISSUE:     'delivery_or_pickup_issue',
  MARKETPLACE_RULE:   'marketplace_rule_violation',
  UNKNOWN:            'unknown',
};

function classifyAppealReason_(customerText, rating) {
  const text = (customerText || '').toLowerCase();

  // Not about product
  if (/не\s*мой\s*заказ|перепутали|не\s*получал|не\s*приходил|чужой\s*заказ/.test(text)) {
    return CS_APPEAL_REASON.NOT_ABOUT_PRODUCT;
  }

  // Offensive content (obscene language patterns)
  if (/[хx][уy][йяеё]|[бb][лl][яaя]|[пp][иi][зz][дd]|[еe][бb][аa][лl]|[гg][аa][вv][нн]/.test(text)) {
    return CS_APPEAL_REASON.OFFENSIVE_CONTENT;
  }

  // Competitor attack — mention of rival brands
  if (/\b(lamoda|ozon|озон|яндекс\s*маркет|yandex\s*market|aliexpress|ali\s*express|amazon|амазон)\b/.test(text)) {
    return CS_APPEAL_REASON.COMPETITOR_ATTACK;
  }

  // Delivery / courier issue without product mention
  if (/курьер|доставщик|пункт\s*выдачи|пвз|не\s*привез|не\s*привёз|привезли\s*не\s*то/.test(text) &&
      !/товар|изделие|продукт|вещь|качество/.test(text)) {
    return CS_APPEAL_REASON.DELIVERY_ISSUE;
  }

  // False claim: rating 1 but very short or generic text
  if (rating === 1 && (text.length < 20 || /^(плохо|ужасно|отвратительно|не\s*понравилось?)$/.test(text.trim()))) {
    return CS_APPEAL_REASON.FALSE_CLAIM;
  }

  // No product-specific usage info with low rating
  if (rating <= 2 && !/использовал|применял|надевал|носил|пользовался|работает|работал|проверил/.test(text)) {
    return CS_APPEAL_REASON.NO_PRODUCT_USAGE;
  }

  return CS_APPEAL_REASON.UNKNOWN;
}

function estimateAppealPotential_(appealReason, rating, textLength) {
  const potentialMap = {
    [CS_APPEAL_REASON.NOT_ABOUT_PRODUCT]:  0.8,
    [CS_APPEAL_REASON.COMPETITOR_ATTACK]:  0.7,
    [CS_APPEAL_REASON.OFFENSIVE_CONTENT]:  0.9,
    [CS_APPEAL_REASON.FALSE_CLAIM]:        0.5,
    [CS_APPEAL_REASON.DELIVERY_ISSUE]:     0.4,
    [CS_APPEAL_REASON.NO_PRODUCT_USAGE]:   0.3,
    [CS_APPEAL_REASON.MARKETPLACE_RULE]:   0.6,
    [CS_APPEAL_REASON.UNKNOWN]:            0.1,
  };

  const potential = potentialMap[appealReason] ?? 0.1;
  return { potential, worth_appeal: potential > 0.3 };
}

function buildAppealEvidence_(inboxItem) {
  const evidence = [];
  const rating = inboxItem.customer_rating || 0;
  const text = inboxItem.customer_text || '';
  const textLen = text.length;

  if (rating === 1) {
    evidence.push('Рейтинг 1/5 — минимальная оценка');
  } else if (rating <= 2) {
    evidence.push(`Рейтинг ${rating}/5 без развёрнутого описания проблемы`);
  }

  if (textLen < 20) {
    evidence.push('Текст отзыва слишком короткий для обоснованной критики');
  }

  if (!/товар|изделие|продукт|размер|качество|материал|цвет|функц/.test(text.toLowerCase())) {
    evidence.push('Текст не содержит упоминания конкретного товара или его характеристик');
  }

  if (/не\s*мой\s*заказ|перепутали|не\s*получал/.test(text.toLowerCase())) {
    evidence.push('Покупатель явно указывает, что это не его заказ');
  }

  if (/курьер|доставщик|пвз|пункт\s*выдачи/.test(text.toLowerCase())) {
    evidence.push('Претензии адресованы службе доставки, а не товару');
  }

  if (/[хx][уy][йяеё]|[бb][лl][яaя]/.test(text.toLowerCase())) {
    evidence.push('Отзыв содержит нецензурные выражения, нарушающие правила WB');
  }

  if (evidence.length === 0) {
    evidence.push(`Отзыв на ${rating}/5 звёзд`);
  }

  return evidence;
}

async function generateAppealDraft_(env, inboxItem, appealReason, evidence) {
  const prompt = `Ты помогаешь составить апелляцию на отзыв WB.
Товар: ${csSafeText_(inboxItem.sku_title || 'Товар', 100)}
Рейтинг отзыва: ${inboxItem.customer_rating || '—'}/5
Текст отзыва: ${csSafeText_(inboxItem.customer_text || '', 400)}
Причина апелляции: ${appealReason}
Доказательства: ${evidence.join('; ')}

Составь вежливую апелляцию к WB (до 500 символов).
Требования:
- Не обвиняй покупателя
- Ссылайся на правила WB
- Укажи конкретные несоответствия
- Без агрессии и ультиматумов

Только текст апелляции.`;

  const aiResult = await csCallAi_(env, prompt);
  if (aiResult.ok && aiResult.text) {
    return csSafeText_(aiResult.text.trim(), 500);
  }

  // Static fallback
  return `Уважаемая служба поддержки Wildberries! Просим рассмотреть данный отзыв на предмет соответствия правилам платформы. Основание: ${appealReason}. ${evidence[0] || ''}. Просим снять отзыв как не соответствующий правилам WB.`;
}

async function createAppealProposal_(db, inboxItem, appealItem) {
  const now = new Date().toISOString();

  // Create wb_agent_proposals record
  try {
    const proposalId = wbGenerateId_('csap');
    await db.prepare(`INSERT OR IGNORE INTO wb_agent_proposals
      (id, proposal_type, entity_type, entity_id, title, requires_confirmation,
       confirmation_id, status, payload_json, created_at, updated_at)
      VALUES (?,?,?,?,?,1,?,?,?,?,?)`).bind(
      proposalId,
      'create_appeal',
      'cs_appeal_item',
      appealItem.id,
      `Апелляция: ${csSafeText_(inboxItem.sku_title || 'Товар', 60)}`,
      appealItem.confirmation_id,
      'pending',
      JSON.stringify({ inbox_item_id: inboxItem.id, nm_id: inboxItem.nm_id }),
      now, now
    ).run();
  } catch (_) {
    // wb_agent_proposals may not exist yet — store proposal in appeal payload instead
    await db.prepare(
      `UPDATE cs_appeal_item SET payload_json=?, updated_at=? WHERE id=?`
    ).bind(
      JSON.stringify({ proposal_type: 'create_appeal', requires_confirmation: true }),
      now,
      appealItem.id
    ).run();
  }
}

async function runComplaintAppealAgent_(env, db, date) {
  const result = {
    date,
    reviews_analyzed: 0,
    appeals_worth: 0,
    appeal_drafts_created: 0,
    skipped_count: 0,
  };

  try {
    const rows = await db.prepare(
      `SELECT * FROM cs_inbox_item
       WHERE source='wb_review'
         AND customer_rating <= 2
         AND status NOT IN ('archived','escalated')
         AND DATE(item_date)=?`
    ).bind(date).all();

    const items = rows.results || [];
    result.reviews_analyzed = items.length;

    for (const item of items) {
      try {
        // Check if appeal already exists
        const existing = await db.prepare(
          `SELECT id FROM cs_appeal_item WHERE inbox_item_id=?`
        ).bind(item.id).first();
        if (existing) { result.skipped_count++; continue; }

        const appealReason = classifyAppealReason_(item.customer_text, item.customer_rating);
        const { potential, worth_appeal } = estimateAppealPotential_(
          appealReason, item.customer_rating, (item.customer_text || '').length
        );

        if (!worth_appeal) { result.skipped_count++; continue; }

        result.appeals_worth++;

        const evidence = buildAppealEvidence_(item);
        const draftText = await generateAppealDraft_(env, item, appealReason, evidence);

        const appealId = wbGenerateId_('csa');
        const confirmId = csBuildConfirmationId_(appealId, 'submit_appeal');
        const riskLevel = potential >= 0.7 ? 'low' : potential >= 0.4 ? 'medium' : 'high';
        const now = new Date().toISOString();

        const appealRecord = {
          id: appealId,
          inbox_item_id: item.id,
          nm_id: item.nm_id || null,
          sku_title: item.sku_title || '',
          user_id: item.user_id || null,
          appeal_reason: appealReason,
          appeal_possible: 1,
          evidence_json: JSON.stringify(evidence),
          draft_appeal: draftText,
          risk_level: riskLevel,
          status: 'waiting_confirmation',
          confirmation_id: confirmId,
          created_at: now,
          updated_at: now,
        };

        await db.prepare(`INSERT INTO cs_appeal_item
          (id, inbox_item_id, nm_id, sku_title, user_id, appeal_reason, appeal_possible,
           evidence_json, draft_appeal, risk_level, status, confirmation_id,
           payload_json, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'{}',?,?)`).bind(
          appealRecord.id, appealRecord.inbox_item_id, appealRecord.nm_id,
          appealRecord.sku_title, appealRecord.user_id, appealRecord.appeal_reason,
          appealRecord.appeal_possible, appealRecord.evidence_json, appealRecord.draft_appeal,
          appealRecord.risk_level, appealRecord.status, appealRecord.confirmation_id,
          appealRecord.created_at, appealRecord.updated_at
        ).run();

        await createAppealProposal_(db, item, appealRecord);

        // Tag inbox item as appeal candidate
        await db.prepare(
          `UPDATE cs_inbox_item SET topic='appeal_candidate', updated_at=? WHERE id=?`
        ).bind(now, item.id).run();

        result.appeal_drafts_created++;
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: item.id,
          action: 'appeal_draft_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'appeal_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 3 — Knowledge Base Agent
// ============================================================

const CS_KB_CATEGORIES = {
  GREETING:          'greeting',
  APOLOGY:           'apology',
  SIZING:            'sizing',
  RETURN_POLICY:     'return_policy',
  DELIVERY:          'delivery',
  PACKAGE_CONTENTS:  'package_contents',
  PRODUCT_INFO:      'product_info',
  WARRANTY:          'warranty',
  USAGE_INSTRUCTION: 'usage_instruction',
  TECHNICAL_ISSUE:   'technical_issue',
  CUSTOM:            'custom',
};

async function lookupKnowledgeAnswer_(db, nmId, questionText) {
  const rows = await db.prepare(
    `SELECT * FROM cs_knowledge_item
     WHERE is_active=1 AND (nm_id=? OR nm_id IS NULL)
     ORDER BY usage_count DESC`
  ).bind(nmId || null).all();

  const items = rows.results || [];
  if (items.length === 0) return null;

  const words = (questionText || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  let bestItem = null;
  let bestScore = 0;

  for (const item of items) {
    let keywords = [];
    try { keywords = JSON.parse(item.trigger_keywords_json || '[]'); } catch (_) {}
    const score = keywords.reduce((acc, kw) => {
      return acc + (words.some(w => w.includes(String(kw).toLowerCase())) ? 1 : 0);
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestItem = item;
    }
  }

  if (!bestItem || bestScore === 0) return null;

  // Update usage stats
  await updateKnowledgeUsageCount_(db, bestItem.id);
  return bestItem;
}

async function detectKnowledgeGap_(db, nmId, topic, questionText, sourceItemId) {
  const now = new Date().toISOString();

  const existing = await db.prepare(
    `SELECT * FROM cs_knowledge_gap WHERE nm_id=? AND topic=?`
  ).bind(nmId || null, topic).first();

  if (existing) {
    let sourceIds = [];
    try { sourceIds = JSON.parse(existing.source_items_json || '[]'); } catch (_) {}
    if (sourceItemId && !sourceIds.includes(sourceItemId)) {
      sourceIds.push(sourceItemId);
    }

    await db.prepare(
      `UPDATE cs_knowledge_gap
       SET frequency_count=frequency_count+1, source_items_json=?,
           question_pattern=?, updated_at=?
       WHERE id=?`
    ).bind(JSON.stringify(sourceIds), csSafeText_(questionText || '', 300), now, existing.id).run();

    return await db.prepare(`SELECT * FROM cs_knowledge_gap WHERE id=?`).bind(existing.id).first();
  }

  const gapId = wbGenerateId_('cskgp');
  await db.prepare(`INSERT INTO cs_knowledge_gap
    (id, nm_id, sku_title, topic, question_pattern, frequency_count,
     source_items_json, status, created_at, updated_at)
    VALUES (?,?,?,?,?,1,?,?,?,?)`).bind(
    gapId,
    nmId || null,
    null,
    topic,
    csSafeText_(questionText || '', 300),
    sourceItemId ? JSON.stringify([sourceItemId]) : '[]',
    'open',
    now, now
  ).run();

  return await db.prepare(`SELECT * FROM cs_knowledge_gap WHERE id=?`).bind(gapId).first();
}

async function suggestKnowledgeItem_(env, db, gapRecord) {
  if ((gapRecord.frequency_count || 0) < 3) return null;
  if (gapRecord.status !== 'open') return null;

  const prompt = `Создай шаблон ответа для базы знаний.
Товар: ${gapRecord.sku_title || `nm_id: ${gapRecord.nm_id || 'не указан'}`}
Тема: ${gapRecord.topic}
Частые вопросы: ${gapRecord.question_pattern || gapRecord.topic}

Создай универсальный шаблон ответа (до 600 символов).
- Профессиональный тон
- Конкретный и полезный
- Можно использовать как базовый для вариантов

Только текст шаблона.`;

  const aiResult = await csCallAi_(env, prompt);
  const templateText = aiResult.ok && aiResult.text
    ? csSafeText_(aiResult.text.trim(), 600)
    : `Добрый день! По теме "${gapRecord.topic}" наши специалисты готовы помочь. Пожалуйста, уточните детали вашего вопроса.`;

  const itemId = wbGenerateId_('csk');
  const now = new Date().toISOString();

  await db.prepare(`INSERT INTO cs_knowledge_item
    (id, category, trigger_keywords_json, template_text, tone, language,
     usage_count, is_active, tags_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,0,0,'[]',?,?)`).bind(
    itemId,
    CS_KB_CATEGORIES.CUSTOM,
    JSON.stringify([gapRecord.topic]),
    templateText,
    'professional',
    'ru',
    now, now
  ).run();

  await db.prepare(
    `UPDATE cs_knowledge_gap SET status='draft_created', updated_at=? WHERE id=?`
  ).bind(now, gapRecord.id).run();

  return itemId;
}

function detectTopicFromText_(text) {
  const t = (text || '').toLowerCase();
  if (/размер|мерк|таблиц|подойдет\s*ли/.test(t)) return 'sizing';
  if (/вернуть|обмен|возврат/.test(t)) return 'return_policy';
  if (/доставк|когда\s*придёт|когда\s*приедет|трек/.test(t)) return 'delivery';
  if (/состав|комплект|что\s*входит|содержим/.test(t)) return 'package_contents';
  if (/гарантия|гарантийн/.test(t)) return 'warranty';
  if (/как\s*использовать|как\s*применять|инструкц/.test(t)) return 'usage_instruction';
  if (/не\s*работает|сломал|неисправ/.test(t)) return 'technical_issue';
  return 'product_info';
}

function createKnowledgeDraft_(db, opts) {
  const id = wbGenerateId_('csk');
  const now = new Date().toISOString();
  return db.prepare(`INSERT INTO cs_knowledge_item
    (id, user_id, category, trigger_keywords_json, template_text, tone, language,
     usage_count, is_active, tags_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,0,0,'[]',?,?)`).bind(
    id,
    opts.user_id || null,
    opts.category || CS_KB_CATEGORIES.CUSTOM,
    JSON.stringify(Array.isArray(opts.trigger_keywords) ? opts.trigger_keywords : []),
    opts.template_text || '',
    opts.tone || 'professional',
    'ru',
    now, now
  ).run().then(() => id);
}

async function updateKnowledgeUsageCount_(db, itemId) {
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `UPDATE cs_knowledge_item SET usage_count=usage_count+1, last_used_at=? WHERE id=?`
    ).bind(now, itemId).run();
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: itemId,
      action: 'usage_count_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }
}

async function runKnowledgeBaseAgent_(env, db, date) {
  const result = {
    date,
    items_checked: 0,
    gaps_detected: 0,
    suggestions_created: 0,
    stale_items_count: 0,
  };

  try {
    const rows = await db.prepare(
      `SELECT * FROM cs_inbox_item
       WHERE source IN ('wb_review','wb_question')
         AND DATE(created_at)=?`
    ).bind(date).all();

    const items = rows.results || [];
    result.items_checked = items.length;

    for (const item of items) {
      try {
        // Only run KB lookup for questions
        if (item.source === 'wb_question') {
          const match = await lookupKnowledgeAnswer_(db, item.nm_id, item.customer_text);
          if (!match) {
            const topic = detectTopicFromText_(item.customer_text);
            const gap = await detectKnowledgeGap_(db, item.nm_id, topic, item.customer_text, item.id);
            if (gap) result.gaps_detected++;

            if (gap && (gap.frequency_count || 0) >= 3) {
              const newItemId = await suggestKnowledgeItem_(env, db, gap);
              if (newItemId) result.suggestions_created++;
            }
          }
        }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: item.id,
          action: 'kb_item_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }

    // Find stale knowledge items (usage_count=0 for 30+ days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const staleRows = await db.prepare(
      `SELECT * FROM cs_knowledge_item
       WHERE is_active=1
         AND usage_count=0
         AND DATE(created_at) < ?`
    ).bind(thirtyDaysAgo).all();

    const staleItems = staleRows.results || [];
    result.stale_items_count = staleItems.length;

    const now = new Date().toISOString();
    for (const staleItem of staleItems) {
      try {
        let payload = {};
        try { payload = JSON.parse(staleItem.payload_json || '{}'); } catch (_) {}
        payload.stale = true;
        payload.stale_detected_at = now;
        await db.prepare(
          `UPDATE cs_knowledge_item SET payload_json=?, updated_at=? WHERE id=?`
        ).bind(JSON.stringify(payload), now, staleItem.id).run();
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: staleItem.id,
          action: 'stale_flag_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'kb_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 4 — Enhanced Tone & Loyalty Agent V2
// ============================================================

const CS_RISK_PHRASES = [
  { pattern: /брак|дефект|неисправн/i,                               category: 'defect_admission',   severity: 'high' },
  { pattern: /вы\s+неправильно|неверно\s+используете|ваша\s+вина/i,  category: 'customer_blame',     severity: 'high' },
  { pattern: /гарантийн|замен(им|яем)|вернём\s+деньги/i,             category: 'promise_risk',       severity: 'medium' },
  { pattern: /всегда\s+так|никогда\s+такого/i,                       category: 'absolute_claim',     severity: 'medium' },
  { pattern: /не\s+наша\s+ответственность|не\s+наша\s+проблема/i,    category: 'denial',             severity: 'high' },
  { pattern: /обратитесь\s+в\s+суд|юридически/i,                    category: 'legal_threat',       severity: 'critical' },
];

function detectRiskPhrases_(draftText) {
  const text = draftText || '';
  const found = [];
  for (const rule of CS_RISK_PHRASES) {
    const match = text.match(rule.pattern);
    if (match) {
      found.push({ category: rule.category, severity: rule.severity, match: match[0] });
    }
  }
  return found;
}

function classifyToneV2_(draftText, riskPhrases) {
  if (riskPhrases.some(r => r.severity === 'critical')) return 'potential_liability';
  if (riskPhrases.some(r => r.category === 'customer_blame')) return 'too_aggressive';
  if (riskPhrases.some(r => r.category === 'defect_admission')) return 'risky_wording';
  if ((draftText || '').length < 50) return 'too_dry';
  if (riskPhrases.length === 0) return 'approved';
  return 'needs_softening';
}

async function rewriteForLoyalty_(env, draftText, issues) {
  if (!issues || issues.length === 0) {
    return { rewritten_text: draftText, changed: false };
  }

  const issuesSummary = issues.map(i => `${i.category} (${i.severity}): "${i.match}"`).join('; ');

  const prompt = `Улучши тон ответа покупателю.
Оригинал: ${csSafeText_(draftText || '', 800)}
Проблемы: ${issuesSummary}

Перепиши ответ, устранив проблемы:
- Не обвиняй покупателя
- Не признавай брак без диагностики
- Будь теплее и эмпатичнее
- Сохрани суть ответа

Только исправленный текст.`;

  const aiResult = await csCallAi_(env, prompt);
  if (aiResult.ok && aiResult.text) {
    return { rewritten_text: csSafeText_(aiResult.text.trim(), 1000), changed: true };
  }

  return { rewritten_text: draftText, changed: false };
}

function finalGuard_(riskPhrases) {
  if (riskPhrases.some(r => r.severity === 'critical')) {
    return { blocked: true, reason: 'potential_liability' };
  }
  return { blocked: false };
}

async function runToneLoyaltyAgentV2_(env, db, date) {
  const result = {
    date,
    drafts_checked: 0,
    passed: 0,
    blocked: 0,
    rewritten: 0,
    needs_human_review: 0,
  };

  try {
    const rows = await db.prepare(
      `SELECT * FROM cs_draft_response
       WHERE status='pending' AND DATE(created_at)=?`
    ).bind(date).all();

    const drafts = rows.results || [];
    result.drafts_checked = drafts.length;

    for (const draft of drafts) {
      try {
        const riskPhrases = detectRiskPhrases_(draft.draft_text);
        const toneStatus = classifyToneV2_(draft.draft_text, riskPhrases);
        const guard = finalGuard_(riskPhrases);
        const now = new Date().toISOString();

        if (guard.blocked) {
          await db.prepare(
            `UPDATE cs_draft_response
             SET tone_status=?, risk_status=?, status='needs_revision', updated_at=?
             WHERE id=?`
          ).bind('potential_liability', 'blocked', now, draft.id).run();

          result.blocked++;
          result.needs_human_review++;

          await wbLog_(db, {
            entity_type: 'cs', entity_id: draft.id,
            action: 'draft_blocked', status: 'warning',
            details_json: JSON.stringify({ reason: guard.reason, risk_phrases: riskPhrases }),
          });
          continue;
        }

        const hasIssues = toneStatus !== 'approved';

        if (hasIssues) {
          const { rewritten_text, changed } = await rewriteForLoyalty_(env, draft.draft_text, riskPhrases);

          if (changed) {
            const newVersion = (draft.draft_version || 1) + 1;
            await db.prepare(
              `UPDATE cs_draft_response
               SET draft_text=?, draft_version=?, tone_status=?, risk_status='ok',
                   updated_at=?
               WHERE id=?`
            ).bind(rewritten_text, newVersion, toneStatus, now, draft.id).run();
            result.rewritten++;
          } else {
            // AI rewrite failed — flag for human review
            await db.prepare(
              `UPDATE cs_draft_response
               SET tone_status=?, risk_status='flagged', updated_at=?
               WHERE id=?`
            ).bind(toneStatus, now, draft.id).run();
            result.needs_human_review++;
          }
        } else {
          await db.prepare(
            `UPDATE cs_draft_response
             SET tone_status='approved', risk_status='ok', updated_at=?
             WHERE id=?`
          ).bind(now, draft.id).run();
          result.passed++;
        }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: draft.id,
          action: 'tone_v2_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'tone_agent_v2',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 5 — CS Chief V2 Orchestrator
// ============================================================

async function runCsOperationsChiefV2_(env, date, userId) {
  const db = env.DB;
  const reportDate = date || wbYesterday_();
  const now = new Date().toISOString();

  await ensureCsStage2Schema_(db);

  // Phase 1: parallel data-loading agents (same as Stage 1)
  const [reviewResult, qaResult, returnResult] = await Promise.all([
    runReviewResponseAgent_(env, db, reportDate),
    runQaAgent_(env, db, reportDate),
    runReturnReasonAgent_(env, db, reportDate),
  ]);

  // Phase 2: sequential agents
  const toneResult     = await runToneLoyaltyAgentV2_(env, db, reportDate);
  const appealResult   = await runComplaintAppealAgent_(env, db, reportDate);
  const classifierResult = await runProductIssueClassifierAgent_(env, db, reportDate);
  const kbResult       = await runKnowledgeBaseAgent_(env, db, reportDate);
  const feedbackResult = await runProductFeedbackAgent_(env, db, reportDate);

  // Build summary
  const summaryPrompt = `Сводка клиент-сервиса за ${reportDate}:
- Отзывов: ${reviewResult.reviews_loaded}, черновиков: ${reviewResult.drafts_created}
- Вопросов: ${qaResult.questions_loaded}, черновиков: ${qaResult.drafts_created}
- Возвратов: ${returnResult.returns_loaded}, проблем: ${returnResult.issues_logged}
- Апелляций создано: ${appealResult.appeal_drafts_created} из ${appealResult.reviews_analyzed} проверено
- Тон/риски: проверено ${toneResult.drafts_checked}, заблокировано ${toneResult.blocked}, переписано ${toneResult.rewritten}
- KB: пробелов выявлено ${kbResult.gaps_detected}, шаблонов предложено ${kbResult.suggestions_created}
- Проблем с товарами (>3 случаев): ${classifierResult.issues_analyzed}

Напиши краткий дайджест (3-5 предложений) для руководителя.`;

  const summaryAi = await csCallAi_(env, summaryPrompt);
  const summaryText = summaryAi.ok && summaryAi.text
    ? summaryAi.text.trim()
    : `За ${reportDate}: обработано ${reviewResult.reviews_loaded} отзывов, ${qaResult.questions_loaded} вопросов, ` +
      `${returnResult.returns_loaded} возвратов. Черновиков ответов: ${reviewResult.drafts_created + qaResult.drafts_created}. ` +
      `Апелляций подготовлено: ${appealResult.appeal_drafts_created}. ` +
      `Пробелов в KB: ${kbResult.gaps_detected}. Проблем с товарами: ${classifierResult.issues_analyzed}.`;

  const report = {
    date: reportDate,
    generated_at: now,
    build: CS_BUILD_V2,
    summary: summaryText,
    review_agent: reviewResult,
    qa_agent: qaResult,
    return_agent: returnResult,
    tone_agent_v2: toneResult,
    appeal_agent: appealResult,
    issue_classifier: classifierResult,
    kb_agent: kbResult,
    feedback_agent: feedbackResult,
    totals: {
      reviews_loaded: reviewResult.reviews_loaded,
      questions_loaded: qaResult.questions_loaded,
      returns_loaded: returnResult.returns_loaded,
      drafts_created: reviewResult.drafts_created + qaResult.drafts_created,
      drafts_blocked: toneResult.blocked,
      drafts_rewritten: toneResult.rewritten,
      appeals_created: appealResult.appeal_drafts_created,
      kb_gaps: kbResult.gaps_detected,
      kb_suggestions: kbResult.suggestions_created,
      issues_found: classifierResult.issues_analyzed,
      insights_created: feedbackResult.insights_created,
    },
  };

  await wbLog_(db, {
    entity_type: 'cs', entity_id: 'cs_operations_chief_v2',
    action: 'chief_v2_run_complete', status: 'ok',
    details_json: JSON.stringify({ date: reportDate, totals: report.totals }),
  });

  return report;
}

// ============================================================
// SECTION 6 — New Telegram Commands
// ============================================================

async function routeCsTelegramCommandV2_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!text.startsWith('/cs_')) return false;

  const command = text.split(' ')[0].toLowerCase();

  try {
    await ensureCsStage2Schema_(db);

    // /cs_appeals — overrides Stage 1 to show actual appeal drafts with action buttons
    if (command === '/cs_appeals') {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const rows = await db.prepare(
        `SELECT * FROM cs_appeal_item
         WHERE status='waiting_confirmation'
           AND DATE(created_at) >= ?
         ORDER BY created_at DESC LIMIT 20`
      ).bind(sevenDaysAgo).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Нет жалоб для подачи.'));
        return true;
      }

      for (const appeal of items) {
        const sku = csEscapeMd_(appeal.sku_title || `nm_id:${appeal.nm_id || '—'}`);
        const reason = csEscapeMd_(appeal.appeal_reason || '—');
        const draft = csEscapeMd_(csSafeText_(appeal.draft_appeal || '', 300));

        const msgBody =
          `*Апелляция* — ${sku}\n` +
          `Причина: ${reason}\n` +
          `_${draft}_\n\n` +
          `✅ /cs\\_submit\\_appeal\\_${appeal.id}\n` +
          `❌ /cs\\_cancel\\_appeal\\_${appeal.id}`;

        await csSendTelegramMessage_(token, chatId, msgBody);
      }
      return true;
    }

    // /cs_knowledge — gaps + stale items
    if (command === '/cs_knowledge') {
      const gapRows = await db.prepare(
        `SELECT * FROM cs_knowledge_gap
         WHERE frequency_count >= 3 AND status='open'
         ORDER BY frequency_count DESC LIMIT 15`
      ).all();

      const gaps = gapRows.results || [];

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const staleRows = await db.prepare(
        `SELECT * FROM cs_knowledge_item
         WHERE is_active=1 AND usage_count=0 AND DATE(created_at) < ?
         ORDER BY created_at ASC LIMIT 10`
      ).bind(thirtyDaysAgo).all();

      const staleItems = staleRows.results || [];

      if (gaps.length === 0 && staleItems.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Нет пробелов в KB и устаревших шаблонов.'));
        return true;
      }

      if (gaps.length > 0) {
        let out = `*Пробелы в базе знаний* \\(${gaps.length}\\)\n\n`;
        for (const gap of gaps) {
          const topic = csEscapeMd_(gap.topic || '—');
          const freq = gap.frequency_count || 0;
          out += `• ${topic} — встречается ${freq}x\n`;
          out += `  📝 /cs\\_create\\_kb\\_${gap.id}\n`;
        }
        await csSendTelegramMessage_(token, chatId, out);
      }

      if (staleItems.length > 0) {
        let out = `*Неиспользуемые шаблоны \\(30\\+ дней\\)* \\(${staleItems.length}\\)\n\n`;
        for (const item of staleItems) {
          const cat = csEscapeMd_(item.category || '—');
          const preview = csEscapeMd_(csSafeText_(item.template_text || '', 80));
          out += `• *${cat}*: _${preview}_\n`;
        }
        await csSendTelegramMessage_(token, chatId, out);
      }

      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'telegram_v2_handler',
      action: 'command_v2_error', status: 'error',
      details_json: JSON.stringify({ command, error: String(e) }),
    });
    try {
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Произошла ошибка при выполнении команды.'));
    } catch (_) {}
  }

  return false;
}

// ============================================================
// SECTION 7 — New Callbacks
// ============================================================

async function routeCsCallbackQueryV2_(env, callbackQuery) {
  const db = env.DB;
  const data = callbackQuery.data || '';
  const userId = String(callbackQuery.from?.id || '');
  const chatId = callbackQuery.message?.chat?.id;
  const token = env.TELEGRAM_BOT_TOKEN;

  try {
    await ensureCsStage2Schema_(db);

    if (data.startsWith('cs_submit_appeal_')) {
      const appealId = data.replace('cs_submit_appeal_', '');
      const appeal = await db.prepare(`SELECT * FROM cs_appeal_item WHERE id=?`).bind(appealId).first();

      if (!appeal) {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция не найдена.'));
        }
        return true;
      }

      // Idempotency check
      if (appeal.status === 'submitted') {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция уже была подана ранее.'));
        }
        return true;
      }

      if (appeal.status === 'cancelled') {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция была отменена и не может быть подана.'));
        }
        return true;
      }

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE cs_appeal_item SET status='submitted', submitted_at=?, updated_at=? WHERE id=?`
      ).bind(now, now, appealId).run();

      await wbLog_(db, {
        entity_type: 'cs', entity_id: appealId,
        action: 'appeal_submitted', status: 'ok',
        details_json: JSON.stringify({ submitted_by: userId, confirmation_id: appeal.confirmation_id }),
      });

      if (token && chatId) {
        await csSendTelegramMessage_(token, chatId,
          csEscapeMd_('Апелляция будет подана при наличии WB API. Статус: submitted.')
        );
      }
      return true;
    }

    if (data.startsWith('cs_cancel_appeal_')) {
      const appealId = data.replace('cs_cancel_appeal_', '');
      const appeal = await db.prepare(`SELECT * FROM cs_appeal_item WHERE id=?`).bind(appealId).first();

      if (!appeal) {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция не найдена.'));
        }
        return true;
      }

      // Idempotency check
      if (appeal.status === 'cancelled') {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция уже была отменена.'));
        }
        return true;
      }

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE cs_appeal_item SET status='cancelled', updated_at=? WHERE id=?`
      ).bind(now, appealId).run();

      await wbLog_(db, {
        entity_type: 'cs', entity_id: appealId,
        action: 'appeal_cancelled', status: 'ok',
        details_json: JSON.stringify({ cancelled_by: userId }),
      });

      if (token && chatId) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Апелляция отменена.'));
      }
      return true;
    }

    if (data.startsWith('cs_create_kb_')) {
      const gapId = data.replace('cs_create_kb_', '');
      const gap = await db.prepare(`SELECT * FROM cs_knowledge_gap WHERE id=?`).bind(gapId).first();

      if (!gap) {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Пробел в KB не найден.'));
        }
        return true;
      }

      if (gap.status === 'draft_created' || gap.status === 'published') {
        if (token && chatId) {
          await csSendTelegramMessage_(token, chatId, csEscapeMd_('Шаблон для этого пробела уже создан.'));
        }
        return true;
      }

      const newItemId = await suggestKnowledgeItem_(env, db, { ...gap, frequency_count: 3 });

      await wbLog_(db, {
        entity_type: 'cs', entity_id: gapId,
        action: 'kb_template_created', status: 'ok',
        details_json: JSON.stringify({ created_by: userId, item_id: newItemId }),
      });

      if (token && chatId) {
        await csSendTelegramMessage_(token, chatId,
          csEscapeMd_('Шаблон создан как черновик, требует проверки перед активацией.')
        );
      }
      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'callback_v2_handler',
      action: 'callback_v2_error', status: 'error',
      details_json: JSON.stringify({ data, error: String(e) }),
    });
  }

  return false;
}

// ============================================================
// SECTION 8 — Extended CS API Routes
// ============================================================

async function handleCsStage2Routes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;

  const jsonResponse = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    await ensureCsStage2Schema_(db);

    // GET /agent/cs/appeals?status=&limit=50
    if (method === 'GET' && path === '/agent/cs/appeals') {
      const status = url.searchParams.get('status') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_appeal_item WHERE 1=1`;
      const binds = [];
      if (status) { sql += ` AND status=?`; binds.push(status); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, appeals: rows.results || [], count: (rows.results || []).length });
    }

    // POST /agent/cs/appeals/:id/submit
    const appealSubmitMatch = path.match(/^\/agent\/cs\/appeals\/([^/]+)\/submit$/);
    if (method === 'POST' && appealSubmitMatch) {
      const appealId = appealSubmitMatch[1];
      const appeal = await db.prepare(`SELECT * FROM cs_appeal_item WHERE id=?`).bind(appealId).first();

      if (!appeal) return jsonResponse({ ok: false, error: 'appeal_not_found' }, 404);
      if (appeal.status === 'submitted') return jsonResponse({ ok: true, idempotent: true });
      if (appeal.status === 'cancelled') {
        return jsonResponse({ ok: false, error: 'appeal_cancelled' }, 409);
      }

      let body = {};
      try { body = await request.json(); } catch (_) {}

      const now = new Date().toISOString();
      await db.prepare(
        `UPDATE cs_appeal_item SET status='submitted', submitted_at=?, updated_at=? WHERE id=?`
      ).bind(now, now, appealId).run();

      await wbLog_(db, {
        entity_type: 'cs', entity_id: appealId,
        action: 'appeal_submitted_api', status: 'ok',
        details_json: JSON.stringify({ submitted_by: body.user_id || null }),
      });

      return jsonResponse({ ok: true, appeal_id: appealId, status: 'submitted' });
    }

    // GET /agent/cs/knowledge/gaps?nm_id=&limit=50
    if (method === 'GET' && path === '/agent/cs/knowledge/gaps') {
      const nmId = url.searchParams.get('nm_id') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_knowledge_gap WHERE 1=1`;
      const binds = [];
      if (nmId) { sql += ` AND nm_id=?`; binds.push(nmId); }
      sql += ` ORDER BY frequency_count DESC, created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, gaps: rows.results || [], count: (rows.results || []).length });
    }

    // POST /agent/cs/knowledge/gaps/:id/create-template
    const gapTemplateMatch = path.match(/^\/agent\/cs\/knowledge\/gaps\/([^/]+)\/create-template$/);
    if (method === 'POST' && gapTemplateMatch) {
      const gapId = gapTemplateMatch[1];
      const gap = await db.prepare(`SELECT * FROM cs_knowledge_gap WHERE id=?`).bind(gapId).first();

      if (!gap) return jsonResponse({ ok: false, error: 'gap_not_found' }, 404);
      if (gap.status === 'draft_created' || gap.status === 'published') {
        return jsonResponse({ ok: true, idempotent: true, status: gap.status });
      }

      const newItemId = await suggestKnowledgeItem_(env, db, { ...gap, frequency_count: 3 });

      await wbLog_(db, {
        entity_type: 'cs', entity_id: gapId,
        action: 'kb_template_created_api', status: 'ok',
        details_json: JSON.stringify({ item_id: newItemId }),
      });

      return jsonResponse({ ok: true, gap_id: gapId, knowledge_item_id: newItemId });
    }

    // POST /agent/cs/report/run/v2
    if (method === 'POST' && path === '/agent/cs/report/run/v2') {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const date = body.date || wbYesterday_();
      const userId = body.user_id || null;
      const report = await runCsOperationsChiefV2_(env, date, userId);
      return jsonResponse({ ok: true, report });
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'api_router_v2',
      action: 'route_v2_error', status: 'error',
      details_json: JSON.stringify({ path, method, error: String(e) }),
    });
    return jsonResponse({ ok: false, error: String(e) }, 500);
  }

  return null;
}
