// ============================================================
// CS Operations Chief — Stage 1 (v1)
// Build: ai_helpers_stage1_cs_operations_chief_v1
//
// AI-шеф клиент-сервиса (Customer Service Chief)
// Completely separate block from WB Operations.
//
// ── Tables ───────────────────────────────────────────────────
//   cs_inbox_item          — all customer touchpoints
//   cs_draft_response      — AI-generated draft responses
//   cs_product_issue       — product issue log from reviews/returns
//   cs_knowledge_item      — response knowledge base / templates
//   cs_feedback_insight    — aggregated learning from reviews/returns
//
// ── Agents ───────────────────────────────────────────────────
//   runReviewResponseAgent_       — draft replies to WB reviews
//   runQaAgent_                   — draft answers to WB questions
//   runReturnReasonAgent_         — classify and aggregate return reasons
//   runToneAnalysisAgent_         — QA-check approved draft tone
//   runProductIssueClassifierAgent_ — escalate recurring product issues
//   runProductFeedbackAgent_      — SKU-level sentiment insights
//   runCsOperationsChief_         — main orchestrator
//
// ── API Endpoints ────────────────────────────────────────────
//   GET  /agent/cs/health
//   POST /agent/cs/report/run
//   GET  /agent/cs/inbox
//   GET  /agent/cs/drafts
//   POST /agent/cs/drafts/:id/approve
//   POST /agent/cs/drafts/:id/reject
//   GET  /agent/cs/issues
//   GET  /agent/cs/insights
//   GET  /agent/cs/knowledge
//   POST /agent/cs/knowledge
//   GET  /agent/cs/log
//
// ── Telegram Commands ────────────────────────────────────────
//   /cs_today     — сводка за вчера
//   /cs_reviews   — новые отзывы с черновиками
//   /cs_questions — неотвеченные вопросы
//   /cs_returns   — возвраты за 7 дней
//   /cs_appeals   — открытые жалобы high/critical
//   /cs_issues    — все открытые проблемы с товарами
//   /cs_templates — шаблоны из knowledge base
//   /cs_run       — запустить CS Chief сейчас
//
// ── Telegram Callback Prefixes ───────────────────────────────
//   cs_approve_*      — одобрить черновик ответа
//   cs_reject_*       — отклонить, переделать
//   cs_escalate_*     — передать человеку
//   cs_create_task_*  — создать задачу по проблеме с товаром
//
// Dependencies (from wb_operations_stage1_v1.gs):
//   wbYesterday_(), wbFormatDate_(), wbRound_(),
//   wbGenerateId_(), wbLog_()
//
// Rules:
//   - AI drafts only — no auto-publish to WB API ever
//   - All unsafe actions: requires_confirmation + confirmation_id
//   - Gemini first → Groq fallback → static fallback text
//   - All DB errors caught, logged, never thrown to caller
//   - Timestamps: new Date().toISOString()
// ============================================================

const CS_BUILD = 'ai_helpers_stage1_cs_operations_chief_v1';
const CS_CHIEF = 'cs_operations_chief';

// ── CS Status Constants ───────────────────────────────────────
const CS_INBOX_STATUS = {
  NEW:         'new',
  DRAFT_READY: 'draft_ready',
  APPROVED:    'approved',
  SENT:        'sent',
  SKIPPED:     'skipped',
  ESCALATED:   'escalated',
};

const CS_DRAFT_STATUS = {
  PENDING:  'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SENT:     'sent',
  REVISED:  'revised',
};

const CS_ISSUE_STATUS = {
  OPEN:        'open',
  IN_PROGRESS: 'in_progress',
  RESOLVED:    'resolved',
  WONT_FIX:    'wont_fix',
};

const CS_SEVERITY = {
  LOW:      'low',
  NORMAL:   'normal',
  HIGH:     'high',
  CRITICAL: 'critical',
};

const CS_ISSUE_TYPES = ['defect', 'sizing', 'description_mismatch', 'packaging', 'delivery', 'other'];

// ============================================================
// SECTION 1 — Schema
// ============================================================

async function ensureCsSchema_(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS cs_inbox_item (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      source TEXT NOT NULL,
      source_item_id TEXT,
      nm_id INTEGER,
      sku_title TEXT,
      customer_text TEXT NOT NULL,
      customer_rating INTEGER,
      item_date TEXT,
      status TEXT DEFAULT 'new',
      assigned_to TEXT,
      priority TEXT DEFAULT 'normal',
      tags_json TEXT DEFAULT '[]',
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS cs_draft_response (
      id TEXT PRIMARY KEY,
      inbox_item_id TEXT NOT NULL REFERENCES cs_inbox_item(id),
      user_id TEXT,
      draft_text TEXT NOT NULL,
      draft_version INTEGER DEFAULT 1,
      tone TEXT DEFAULT 'professional',
      language TEXT DEFAULT 'ru',
      ai_model_used TEXT,
      ai_confidence REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      rejection_reason TEXT,
      confirmation_id TEXT UNIQUE,
      approved_by TEXT,
      approved_at TEXT,
      sent_at TEXT,
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS cs_product_issue (
      id TEXT PRIMARY KEY,
      nm_id INTEGER NOT NULL,
      sku_title TEXT,
      user_id TEXT,
      issue_type TEXT NOT NULL,
      issue_description TEXT,
      severity TEXT DEFAULT 'normal',
      source_inbox_ids_json TEXT DEFAULT '[]',
      occurrence_count INTEGER DEFAULT 1,
      first_seen_date TEXT,
      last_seen_date TEXT,
      status TEXT DEFAULT 'open',
      resolution_notes TEXT,
      confirmation_id TEXT UNIQUE,
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(nm_id, issue_type, severity)
    )`,
    `CREATE TABLE IF NOT EXISTS cs_knowledge_item (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      category TEXT NOT NULL,
      trigger_keywords_json TEXT DEFAULT '[]',
      template_text TEXT NOT NULL,
      tone TEXT DEFAULT 'professional',
      language TEXT DEFAULT 'ru',
      usage_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      is_active INTEGER DEFAULT 1,
      tags_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS cs_feedback_insight (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      nm_id INTEGER,
      sku_title TEXT,
      insight_type TEXT NOT NULL,
      insight_text TEXT NOT NULL,
      data_points_count INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0,
      actionable INTEGER DEFAULT 0,
      suggested_action TEXT,
      status TEXT DEFAULT 'new',
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(date, nm_id, insight_type)
    )`,
  ];

  for (const sql of statements) {
    try {
      await db.prepare(sql).run();
    } catch (e) {
      // Table already exists or other non-fatal schema error — continue
    }
  }
}

// ============================================================
// SECTION 2 — Data Loading Stubs
// ============================================================

// Stub: returns [] until WB Reviews API is integrated
// Real: GET https://feedbacks-api.wildberries.ru/api/v1/feedbacks
async function loadWbReviews_(env, date) {
  return { data: [], source_status: 'missing' };
}

// Stub: returns [] until WB Questions API is integrated
// Real: GET https://feedbacks-api.wildberries.ru/api/v1/questions
async function loadWbQuestions_(env, date) {
  return { data: [], source_status: 'missing' };
}

// Stub: returns [] until WB Returns API is integrated
// Real: GET https://marketplace-api.wildberries.ru/api/v3/returns
async function loadWbReturns_(env, date) {
  return { data: [], source_status: 'missing' };
}

// ============================================================
// SECTION 3 — CS Utility Functions
// ============================================================

function csSafeText_(text, maxLen) {
  if (!text) return '';
  const s = String(text);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

function csDetectLanguage_(text) {
  if (!text) return 'ru';
  const total = text.length;
  if (total === 0) return 'ru';
  const cyrillicCount = (text.match(/[Ѐ-ӿ]/g) || []).length;
  return cyrillicCount / total > 0.5 ? 'ru' : 'en';
}

function csEscapeMd_(text) {
  if (!text) return '';
  // Escape Telegram MarkdownV2 special characters
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\-\\]/g, '\\$&');
}

function csBuildConfirmationId_(itemId, action) {
  return 'cs_' + action + '_' + itemId + '_' + Date.now().toString(36);
}

async function csSendTelegramMessage_(token, chatId, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 3800) {
    chunks.push(text.slice(i, i + 3800));
  }
  let lastOk = true;
  for (const chunk of chunks) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'MarkdownV2',
        }),
      });
      const data = await res.json();
      if (!data.ok) lastOk = false;
    } catch (e) {
      lastOk = false;
    }
  }
  return { ok: lastOk };
}

// ============================================================
// AI Call Helper — Gemini first, Groq fallback
// ============================================================

async function csCallAi_(env, prompt, expectJson = false) {
  // Try Gemini
  if (env.GEMINI_API_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
          }),
        }
      );
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) return { text, model: 'gemini-1.5-flash-latest', ok: true };
    } catch (_) { /* fall through */ }
  }

  // Groq fallback
  if (env.GROQ_API_KEY) {
    try {
      const base = env.GROQ_API_BASE || 'https://api.groq.com/openai/v1';
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4,
          max_tokens: 1024,
        }),
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '';
      if (text) return { text, model: 'llama3-8b-8192', ok: true };
    } catch (_) { /* fall through */ }
  }

  return { text: '', model: 'none', ok: false };
}

function csParseAiJson_(text, fallback) {
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (_) {
    return fallback;
  }
}

// ============================================================
// SECTION 4 — Review Response Agent
// ============================================================

async function runReviewResponseAgent_(env, db, date) {
  const result = {
    date,
    reviews_loaded: 0,
    drafts_created: 0,
    negative_count: 0,
    positive_count: 0,
    error_count: 0,
  };

  try {
    const { data: reviews, source_status } = await loadWbReviews_(env, date);
    result.reviews_loaded = reviews.length;

    if (source_status === 'missing' || reviews.length === 0) {
      return result;
    }

    for (const review of reviews) {
      try {
        // Upsert cs_inbox_item
        const itemId = wbGenerateId_('csi');
        const now = new Date().toISOString();
        const existingItem = review.source_item_id
          ? await db.prepare(
              `SELECT id FROM cs_inbox_item WHERE source='wb_review' AND source_item_id=?`
            ).bind(review.source_item_id).first()
          : null;

        let inboxItemId = existingItem?.id || itemId;

        if (!existingItem) {
          await db.prepare(`
            INSERT INTO cs_inbox_item
              (id, user_id, source, source_item_id, nm_id, sku_title, customer_text,
               customer_rating, item_date, status, priority, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,'new','normal',?,?)
          `).bind(
            itemId,
            review.user_id || null,
            'wb_review',
            review.source_item_id || null,
            review.nm_id || null,
            review.sku_title || '',
            review.customer_text || '',
            review.rating || null,
            review.date || date,
            now, now
          ).run();
          inboxItemId = itemId;
        }

        const rating = review.rating || review.customer_rating || 0;
        const isNegative = rating > 0 && rating <= 3;
        if (isNegative) result.negative_count++; else result.positive_count++;

        // Check if draft already exists
        const existingDraft = await db.prepare(
          `SELECT id FROM cs_draft_response WHERE inbox_item_id=? AND status='pending'`
        ).bind(inboxItemId).first();
        if (existingDraft) continue;

        // Generate AI draft
        const prompt = `Ты специалист по работе с клиентами WB-магазина.
Артикул: ${csSafeText_(review.sku_title || 'Товар', 100)}
Рейтинг: ${rating}/5
Отзыв: ${csSafeText_(review.customer_text || '', 800)}

Напиши профессиональный ответ на отзыв (до 1000 символов).
Требования:
- Поблагодари за отзыв
- Если негативный: извинись, предложи решение
- Если позитивный: поблагодари, пригласи снова
- Тон: дружелюбный, профессиональный
- Не используй клише типа "Ваше мнение важно для нас"
- Отвечай на конкретные замечания клиента

Ответь только текстом ответа, без пояснений.`;

        const aiResult = await csCallAi_(env, prompt);
        const draftText = aiResult.ok && aiResult.text
          ? csSafeText_(aiResult.text.trim(), 1000)
          : (isNegative
            ? 'Добрый день! Приносим извинения за доставленные неудобства. Пожалуйста, свяжитесь с нами для решения вопроса.'
            : 'Спасибо за ваш отзыв! Рады, что товар вам понравился. Будем рады видеть вас снова!');

        const draftId = wbGenerateId_('csd');
        const confirmId = csBuildConfirmationId_(inboxItemId, 'review_reply');
        const nowDraft = new Date().toISOString();

        await db.prepare(`
          INSERT INTO cs_draft_response
            (id, inbox_item_id, draft_text, draft_version, tone, language,
             ai_model_used, ai_confidence, status, confirmation_id, created_at, updated_at)
          VALUES (?,?,?,1,'professional',?,?,0.8,'pending',?,?,?)
        `).bind(
          draftId,
          inboxItemId,
          draftText,
          csDetectLanguage_(review.customer_text || ''),
          aiResult.model || 'none',
          confirmId,
          nowDraft, nowDraft
        ).run();

        // Mark inbox item as draft_ready
        await db.prepare(
          `UPDATE cs_inbox_item SET status='draft_ready', updated_at=? WHERE id=?`
        ).bind(nowDraft, inboxItemId).run();

        result.drafts_created++;
      } catch (e) {
        result.error_count++;
        await wbLog_(db, {
          entity_type: 'cs', entity_id: 'review_agent',
          action: 'draft_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    result.error_count++;
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'review_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 5 — Q&A Agent
// ============================================================

async function runQaAgent_(env, db, date) {
  const result = {
    date,
    questions_loaded: 0,
    drafts_created: 0,
    template_used_count: 0,
    ai_generated_count: 0,
  };

  try {
    const { data: questions, source_status } = await loadWbQuestions_(env, date);
    result.questions_loaded = questions.length;

    if (source_status === 'missing' || questions.length === 0) {
      return result;
    }

    for (const question of questions) {
      try {
        // Upsert inbox item
        const itemId = wbGenerateId_('csi');
        const now = new Date().toISOString();
        const existingItem = question.source_item_id
          ? await db.prepare(
              `SELECT id FROM cs_inbox_item WHERE source='wb_question' AND source_item_id=?`
            ).bind(question.source_item_id).first()
          : null;

        let inboxItemId = existingItem?.id || itemId;

        if (!existingItem) {
          await db.prepare(`
            INSERT INTO cs_inbox_item
              (id, user_id, source, source_item_id, nm_id, sku_title, customer_text,
               item_date, status, priority, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,'new','normal',?,?)
          `).bind(
            itemId,
            question.user_id || null,
            'wb_question',
            question.source_item_id || null,
            question.nm_id || null,
            question.sku_title || '',
            question.customer_text || '',
            question.date || date,
            now, now
          ).run();
          inboxItemId = itemId;
        }

        // Check for existing pending draft
        const existingDraft = await db.prepare(
          `SELECT id FROM cs_draft_response WHERE inbox_item_id=? AND status='pending'`
        ).bind(inboxItemId).first();
        if (existingDraft) continue;

        // Search knowledge base for matching templates
        const customerText = (question.customer_text || '').toLowerCase();
        const knowledgeItems = await db.prepare(
          `SELECT * FROM cs_knowledge_item WHERE is_active=1 ORDER BY usage_count DESC LIMIT 50`
        ).all();

        let templateBase = null;
        for (const ki of (knowledgeItems.results || [])) {
          let keywords = [];
          try { keywords = JSON.parse(ki.trigger_keywords_json || '[]'); } catch (_) {}
          const matched = keywords.some(kw => customerText.includes(String(kw).toLowerCase()));
          if (matched) { templateBase = ki; break; }
        }

        let draftText = '';
        let modelUsed = 'none';
        let usedTemplate = false;

        if (templateBase) {
          // Use template as base, optionally refine
          draftText = templateBase.template_text;
          modelUsed = 'template';
          usedTemplate = true;
          result.template_used_count++;

          // Update usage count
          await db.prepare(
            `UPDATE cs_knowledge_item SET usage_count=usage_count+1, last_used_at=? WHERE id=?`
          ).bind(new Date().toISOString(), templateBase.id).run();
        } else {
          // Generate with AI
          const prompt = `Вопрос покупателя о товаре "${csSafeText_(question.sku_title || 'Товар', 100)}": ${csSafeText_(question.customer_text || '', 600)}

Напиши точный и полезный ответ (до 500 символов).
- Отвечай конкретно на вопрос
- Если не знаешь точного ответа — скажи "Уточните у продавца"
- Не выдумывай характеристики товара
- Тон: дружелюбный, информативный

Только текст ответа.`;

          const aiResult = await csCallAi_(env, prompt);
          draftText = aiResult.ok && aiResult.text
            ? csSafeText_(aiResult.text.trim(), 500)
            : 'Добрый день! Пожалуйста, уточните этот вопрос у продавца через чат.';
          modelUsed = aiResult.model || 'none';
          result.ai_generated_count++;
        }

        const draftId = wbGenerateId_('csd');
        const confirmId = csBuildConfirmationId_(inboxItemId, 'qa_reply');
        const nowDraft = new Date().toISOString();

        await db.prepare(`
          INSERT INTO cs_draft_response
            (id, inbox_item_id, draft_text, draft_version, tone, language,
             ai_model_used, ai_confidence, status, confirmation_id, created_at, updated_at)
          VALUES (?,?,?,1,'friendly',?,?,?,  'pending',?,?,?)
        `).bind(
          draftId, inboxItemId, draftText,
          csDetectLanguage_(question.customer_text || ''),
          modelUsed,
          usedTemplate ? 1.0 : 0.75,
          confirmId, nowDraft, nowDraft
        ).run();

        await db.prepare(
          `UPDATE cs_inbox_item SET status='draft_ready', updated_at=? WHERE id=?`
        ).bind(nowDraft, inboxItemId).run();

        result.drafts_created++;
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: 'qa_agent',
          action: 'draft_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'qa_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 6 — Return Reason Agent
// ============================================================

async function runReturnReasonAgent_(env, db, date) {
  const result = {
    date,
    returns_loaded: 0,
    issues_logged: 0,
    new_issues: 0,
    escalated_issues: 0,
  };

  try {
    const { data: returns, source_status } = await loadWbReturns_(env, date);
    result.returns_loaded = returns.length;

    if (source_status === 'missing' || returns.length === 0) {
      return result;
    }

    for (const ret of returns) {
      try {
        const itemId = wbGenerateId_('csi');
        const now = new Date().toISOString();
        const existingItem = ret.source_item_id
          ? await db.prepare(
              `SELECT id FROM cs_inbox_item WHERE source='wb_return' AND source_item_id=?`
            ).bind(ret.source_item_id).first()
          : null;

        let inboxItemId = existingItem?.id || itemId;

        if (!existingItem) {
          await db.prepare(`
            INSERT INTO cs_inbox_item
              (id, user_id, source, source_item_id, nm_id, sku_title, customer_text,
               item_date, status, priority, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,'new','normal',?,?)
          `).bind(
            itemId,
            ret.user_id || null,
            'wb_return',
            ret.source_item_id || null,
            ret.nm_id || null,
            ret.sku_title || '',
            ret.customer_text || ret.reason || '',
            ret.date || date,
            now, now
          ).run();
          inboxItemId = itemId;
        }

        // Classify return reason with AI
        const classifyPrompt = `Причина возврата от покупателя: ${csSafeText_(ret.customer_text || ret.reason || '', 500)}
Артикул: ${csSafeText_(ret.sku_title || 'Товар', 100)}

Классифицируй причину возврата. Выбери одну из:
defect, sizing, description_mismatch, packaging, delivery, other

Ответь JSON: {"issue_type": "...", "severity": "low|normal|high|critical", "description": "..."}`;

        const aiResult = await csCallAi_(env, classifyPrompt, true);
        const classification = csParseAiJson_(aiResult.text, {
          issue_type: 'other',
          severity: 'normal',
          description: ret.customer_text || 'Не указано',
        });

        const issueType = CS_ISSUE_TYPES.includes(classification.issue_type)
          ? classification.issue_type : 'other';
        const severity = ['low', 'normal', 'high', 'critical'].includes(classification.severity)
          ? classification.severity : 'normal';

        const nmId = ret.nm_id || 0;

        // Aggregate: upsert cs_product_issue
        const existing = await db.prepare(
          `SELECT id, occurrence_count, source_inbox_ids_json FROM cs_product_issue
           WHERE nm_id=? AND issue_type=? AND severity=?`
        ).bind(nmId, issueType, severity).first();

        if (existing) {
          let ids = [];
          try { ids = JSON.parse(existing.source_inbox_ids_json || '[]'); } catch (_) {}
          if (!ids.includes(inboxItemId)) ids.push(inboxItemId);

          const newCount = (existing.occurrence_count || 0) + 1;
          const newSeverity = newCount >= 5 ? 'high' : severity;
          const escalated = newSeverity === 'high' && severity !== 'high';
          if (escalated) result.escalated_issues++;

          await db.prepare(`
            UPDATE cs_product_issue
            SET occurrence_count=?, severity=?, source_inbox_ids_json=?,
                last_seen_date=?, updated_at=?
            WHERE id=?
          `).bind(
            newCount, newSeverity, JSON.stringify(ids),
            date, new Date().toISOString(),
            existing.id
          ).run();

          result.issues_logged++;
        } else {
          const issueId = wbGenerateId_('csp');
          const confirmId = csBuildConfirmationId_(issueId, 'product_issue');
          const nowIssue = new Date().toISOString();

          await db.prepare(`
            INSERT INTO cs_product_issue
              (id, nm_id, sku_title, issue_type, issue_description, severity,
               source_inbox_ids_json, occurrence_count, first_seen_date, last_seen_date,
               status, confirmation_id, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,1,?,?,'open',?,?,?)
          `).bind(
            issueId, nmId, ret.sku_title || '',
            issueType, classification.description || '',
            severity,
            JSON.stringify([inboxItemId]),
            date, date,
            confirmId, nowIssue, nowIssue
          ).run();

          result.new_issues++;
          result.issues_logged++;
        }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: 'return_agent',
          action: 'classify_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'return_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 7 — Tone & Loyalty Agent
// ============================================================

async function runToneAnalysisAgent_(env, db, date) {
  const result = {
    date,
    drafts_analyzed: 0,
    passed_count: 0,
    needs_revision_count: 0,
    avg_score: 0,
  };

  try {
    const drafts = await db.prepare(
      `SELECT * FROM cs_draft_response WHERE status='approved' AND DATE(created_at)=?`
    ).bind(date).all();

    const draftList = drafts.results || [];
    result.drafts_analyzed = draftList.length;

    if (draftList.length === 0) return result;

    let totalScore = 0;

    for (const draft of draftList) {
      try {
        const tonePrompt = `Проверь тон ответа на соответствие фирменному стилю:
Ответ: ${csSafeText_(draft.draft_text || '', 800)}

Оцени по шкале 1-10:
- professionalism (профессионализм)
- friendliness (дружелюбие)
- empathy (эмпатия)
- clarity (ясность)

Ответь JSON: {"professionalism": N, "friendliness": N, "empathy": N, "clarity": N, "overall": N, "suggestion": "..."}`;

        const aiResult = await csCallAi_(env, tonePrompt, true);
        const scores = csParseAiJson_(aiResult.text, {
          professionalism: 7, friendliness: 7, empathy: 7, clarity: 7,
          overall: 7, suggestion: '',
        });

        const overall = typeof scores.overall === 'number' ? scores.overall : 7;
        totalScore += overall;

        // Save scores to payload_json
        let existingPayload = {};
        try { existingPayload = JSON.parse(draft.payload_json || '{}'); } catch (_) {}
        const updatedPayload = { ...existingPayload, tone_scores: scores };

        const now = new Date().toISOString();

        if (overall < 6) {
          // Send back to pending
          await db.prepare(
            `UPDATE cs_draft_response SET status='pending', payload_json=?, updated_at=? WHERE id=?`
          ).bind(JSON.stringify(updatedPayload), now, draft.id).run();

          result.needs_revision_count++;

          await wbLog_(db, {
            entity_type: 'cs', entity_id: draft.id,
            action: 'tone_revision_needed', status: 'warning',
            details_json: JSON.stringify({ overall, suggestion: scores.suggestion || '' }),
          });
        } else {
          await db.prepare(
            `UPDATE cs_draft_response SET payload_json=?, updated_at=? WHERE id=?`
          ).bind(JSON.stringify(updatedPayload), now, draft.id).run();

          result.passed_count++;
        }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: draft.id,
          action: 'tone_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }

    result.avg_score = draftList.length > 0
      ? wbRound_(totalScore / draftList.length, 1)
      : 0;
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'tone_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 8 — Product Issue Classifier Agent
// ============================================================

async function runProductIssueClassifierAgent_(env, db, date) {
  const result = {
    date,
    issues_analyzed: 0,
    escalated_count: 0,
    proposals_created: 0,
    insights_created: 0,
  };

  try {
    const issues = await db.prepare(
      `SELECT * FROM cs_product_issue WHERE status='open' AND occurrence_count >= 3`
    ).all();

    const issueList = issues.results || [];
    result.issues_analyzed = issueList.length;

    for (const issue of issueList) {
      try {
        const shouldEscalate =
          issue.occurrence_count >= 5 || issue.severity === 'critical';

        if (shouldEscalate) {
          result.escalated_count++;

          // Create proposal
          const proposalPayload = {
            proposal_type: 'create_product_task',
            title: `Проблема с товаром: ${issue.issue_type} — ${issue.sku_title || 'nm_id:' + issue.nm_id}`,
            issue_id: issue.id,
            nm_id: issue.nm_id,
            occurrence_count: issue.occurrence_count,
            severity: issue.severity,
            requires_confirmation: true,
          };

          let existingPayload = {};
          try { existingPayload = JSON.parse(issue.payload_json || '{}'); } catch (_) {}
          const updatedPayload = {
            ...existingPayload,
            proposal: proposalPayload,
          };

          const now = new Date().toISOString();
          await db.prepare(
            `UPDATE cs_product_issue SET payload_json=?, updated_at=? WHERE id=?`
          ).bind(JSON.stringify(updatedPayload), now, issue.id).run();

          result.proposals_created++;

          await wbLog_(db, {
            entity_type: 'cs', entity_id: issue.id,
            action: 'issue_escalated', status: 'warning',
            details_json: JSON.stringify(proposalPayload),
          });
        }

        // Generate insight
        const summaryPrompt = `В ${issue.occurrence_count} возвратах за последние дни покупатели указывают на ${issue.issue_type} товара ${issue.sku_title || 'nm_id:' + issue.nm_id}.
Описание: ${csSafeText_(issue.issue_description || '', 300)}

Напиши краткий инсайт (1-2 предложения) и предложи действие.
Ответ JSON: {"insight": "...", "suggested_action": "...", "actionable": true|false}`;

        const aiResult = await csCallAi_(env, summaryPrompt, true);
        const insightData = csParseAiJson_(aiResult.text, {
          insight: `В ${issue.occurrence_count} случаях зафиксирована проблема: ${issue.issue_type}`,
          suggested_action: 'Проверить товар и скорректировать описание или качество',
          actionable: true,
        });

        const insightId = wbGenerateId_('csfi');
        const insightNow = new Date().toISOString();

        try {
          await db.prepare(`
            INSERT OR REPLACE INTO cs_feedback_insight
              (id, date, nm_id, sku_title, insight_type, insight_text,
               data_points_count, confidence, actionable, suggested_action,
               status, payload_json, created_at)
            VALUES (?,?,?,?,'common_complaint',?,?,0.8,?,?,'new','{}',?)
          `).bind(
            insightId, date, issue.nm_id || null, issue.sku_title || '',
            insightData.insight || '',
            issue.occurrence_count,
            insightData.actionable ? 1 : 0,
            insightData.suggested_action || '',
            insightNow
          ).run();

          result.insights_created++;
        } catch (_) { /* UNIQUE constraint — insight already exists for this date/nm_id/type */ }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: issue.id,
          action: 'classifier_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'issue_classifier',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 9 — Product Feedback Agent
// ============================================================

async function runProductFeedbackAgent_(env, db, date) {
  const result = {
    date,
    skus_analyzed: 0,
    insights_created: 0,
    actionable_count: 0,
  };

  try {
    // Aggregate reviews for the date by nm_id
    const reviewsRaw = await db.prepare(
      `SELECT nm_id, sku_title, customer_text, customer_rating
       FROM cs_inbox_item
       WHERE source='wb_review' AND DATE(created_at)=?`
    ).bind(date).all();

    const reviewsList = reviewsRaw.results || [];

    // Group by nm_id
    const byNmId = {};
    for (const r of reviewsList) {
      const key = String(r.nm_id || '0');
      if (!byNmId[key]) byNmId[key] = { nm_id: r.nm_id, sku_title: r.sku_title, reviews: [] };
      byNmId[key].reviews.push(r);
    }

    for (const [, skuData] of Object.entries(byNmId)) {
      if (skuData.reviews.length < 3) continue;

      result.skus_analyzed++;

      try {
        const ratings = skuData.reviews
          .map(r => r.customer_rating || 0)
          .filter(v => v > 0);
        const avgRating = ratings.length > 0
          ? wbRound_(ratings.reduce((a, b) => a + b, 0) / ratings.length, 1)
          : 0;

        const reviewsTextList = skuData.reviews
          .map((r, i) => `${i + 1}. [${r.customer_rating || '?'}/5] ${csSafeText_(r.customer_text || '', 200)}`)
          .join('\n');

        const feedbackPrompt = `Отзывы по товару "${csSafeText_(skuData.sku_title || 'Товар', 100)}" за ${date}:
${csSafeText_(reviewsTextList, 1500)}

Выдели 2-3 главных темы из отзывов: что хвалят, что критикуют.
Ответь JSON: {"praise": ["..."], "complaints": ["..."], "actionable": true|false, "suggested_action": "..."}`;

        const aiResult = await csCallAi_(env, feedbackPrompt, true);
        const feedbackData = csParseAiJson_(aiResult.text, {
          praise: [],
          complaints: [],
          actionable: false,
          suggested_action: '',
        });

        // Rating drop insight
        if (avgRating > 0 && avgRating < 3.5) {
          const dropInsightId = wbGenerateId_('csfi');
          const insightText = `Средний рейтинг товара ${skuData.sku_title || skuData.nm_id} упал до ${avgRating} по ${skuData.reviews.length} отзывам за ${date}.`;
          const nowIns = new Date().toISOString();

          try {
            await db.prepare(`
              INSERT OR REPLACE INTO cs_feedback_insight
                (id, date, nm_id, sku_title, insight_type, insight_text,
                 data_points_count, confidence, actionable, suggested_action,
                 status, payload_json, created_at)
              VALUES (?,?,?,?,'rating_drop',?,?,0.9,1,?,'new','{}',?)
            `).bind(
              dropInsightId, date,
              skuData.nm_id || null, skuData.sku_title || '',
              insightText,
              skuData.reviews.length,
              feedbackData.suggested_action || 'Проверить качество товара и ответить на негативные отзывы',
              nowIns
            ).run();

            result.insights_created++;
            result.actionable_count++;
          } catch (_) { /* UNIQUE constraint */ }
        }

        // Sentiment insight
        const hasPraise = feedbackData.praise && feedbackData.praise.length > 0;
        const hasComplaints = feedbackData.complaints && feedbackData.complaints.length > 0;

        if (hasPraise || hasComplaints) {
          const insightType = hasComplaints ? 'common_complaint' : 'praise_topic';
          const insightText = hasComplaints
            ? `Жалобы по товару ${skuData.sku_title || skuData.nm_id}: ${feedbackData.complaints.join(', ')}.`
            : `Хвалят товар ${skuData.sku_title || skuData.nm_id}: ${feedbackData.praise.join(', ')}.`;

          const sentInsightId = wbGenerateId_('csfi');
          const nowSent = new Date().toISOString();

          try {
            await db.prepare(`
              INSERT OR REPLACE INTO cs_feedback_insight
                (id, date, nm_id, sku_title, insight_type, insight_text,
                 data_points_count, confidence, actionable, suggested_action,
                 status, payload_json, created_at)
              VALUES (?,?,?,?,?,?,?,0.8,?,?,'new',?,?)
            `).bind(
              sentInsightId, date,
              skuData.nm_id || null, skuData.sku_title || '',
              insightType,
              insightText,
              skuData.reviews.length,
              feedbackData.actionable ? 1 : 0,
              feedbackData.suggested_action || '',
              JSON.stringify({ praise: feedbackData.praise, complaints: feedbackData.complaints }),
              nowSent
            ).run();

            result.insights_created++;
            if (feedbackData.actionable) result.actionable_count++;
          } catch (_) { /* UNIQUE constraint */ }
        }
      } catch (e) {
        await wbLog_(db, {
          entity_type: 'cs', entity_id: String(skuData.nm_id || 'unknown'),
          action: 'feedback_error', status: 'error',
          details_json: JSON.stringify({ error: String(e) }),
        });
      }
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'feedback_agent',
      action: 'agent_error', status: 'error',
      details_json: JSON.stringify({ error: String(e) }),
    });
  }

  return result;
}

// ============================================================
// SECTION 10 — CS Chief Orchestrator
// ============================================================

async function runCsOperationsChief_(env, date, userId) {
  const db = env.DB;
  const reportDate = date || wbYesterday_();
  const now = new Date().toISOString();

  await ensureCsSchema_(db);

  // Phase 1: run data-loading agents in parallel
  const [reviewResult, qaResult, returnResult] = await Promise.all([
    runReviewResponseAgent_(env, db, reportDate),
    runQaAgent_(env, db, reportDate),
    runReturnReasonAgent_(env, db, reportDate),
  ]);

  // Phase 2: sequential agents that depend on Phase 1
  const toneResult = await runToneAnalysisAgent_(env, db, reportDate);
  const classifierResult = await runProductIssueClassifierAgent_(env, db, reportDate);
  const feedbackResult = await runProductFeedbackAgent_(env, db, reportDate);

  // Collect proposals
  const proposals = await db.prepare(
    `SELECT id, nm_id, sku_title, payload_json FROM cs_product_issue
     WHERE status='open' AND occurrence_count >= 5`
  ).all();

  const proposalList = (proposals.results || []).filter(p => {
    try {
      const pl = JSON.parse(p.payload_json || '{}');
      return pl.proposal && pl.proposal.requires_confirmation;
    } catch (_) { return false; }
  });

  // Generate AI summary
  const summaryPrompt = `Сводка клиент-сервиса за ${reportDate}:
- Отзывов: ${reviewResult.reviews_loaded}, черновиков готово: ${reviewResult.drafts_created}
- Вопросов: ${qaResult.questions_loaded}, черновиков готово: ${qaResult.drafts_created}
- Возвратов: ${returnResult.returns_loaded}, проблем выявлено: ${returnResult.issues_logged}
- Проблем с товарами (>3 случаев): ${classifierResult.issues_analyzed}

Напиши краткий дайджест (3-5 предложений) для руководителя.`;

  const summaryAi = await csCallAi_(env, summaryPrompt);
  const summaryText = summaryAi.ok && summaryAi.text
    ? summaryAi.text.trim()
    : `За ${reportDate}: обработано ${reviewResult.reviews_loaded} отзывов, ${qaResult.questions_loaded} вопросов, ${returnResult.returns_loaded} возвратов. Черновиков ответов: ${reviewResult.drafts_created + qaResult.drafts_created}. Проблем с товарами выявлено: ${classifierResult.issues_analyzed}.`;

  const report = {
    date: reportDate,
    generated_at: now,
    build: CS_BUILD,
    summary: summaryText,
    review_agent: reviewResult,
    qa_agent: qaResult,
    return_agent: returnResult,
    tone_agent: toneResult,
    issue_classifier: classifierResult,
    feedback_agent: feedbackResult,
    proposals: proposalList.map(p => {
      let pl = {};
      try { pl = JSON.parse(p.payload_json || '{}'); } catch (_) {}
      return pl.proposal || {};
    }),
    totals: {
      reviews_loaded: reviewResult.reviews_loaded,
      questions_loaded: qaResult.questions_loaded,
      returns_loaded: returnResult.returns_loaded,
      drafts_created: reviewResult.drafts_created + qaResult.drafts_created,
      issues_found: classifierResult.issues_analyzed,
      insights_created: feedbackResult.insights_created,
    },
  };

  await wbLog_(db, {
    entity_type: 'cs', entity_id: CS_CHIEF,
    action: 'chief_run_complete', status: 'ok',
    details_json: JSON.stringify({ date: reportDate, totals: report.totals }),
  });

  return report;
}

// ============================================================
// SECTION 11 — CS Telegram Handler
// ============================================================

async function routeCsTelegramCommand_(env, msg, chatId, userId) {
  const text = (msg.text || '').trim();
  const db = env.DB;
  const token = env.TELEGRAM_BOT_TOKEN;

  if (!text.startsWith('/cs_')) return false;

  const command = text.split(' ')[0].toLowerCase();

  try {
    await ensureCsSchema_(db);

    if (command === '/cs_today') {
      const date = wbYesterday_();
      const report = await runCsOperationsChief_(env, date, userId);
      const safeSummary = csEscapeMd_(report.summary);
      const safeDate = csEscapeMd_(wbFormatDate_(date));
      const t = report.totals;
      const msgText =
        `*Сводка клиент\\-сервиса за ${safeDate}*\n\n` +
        `${safeSummary}\n\n` +
        `📥 Отзывов: ${t.reviews_loaded}\n` +
        `❓ Вопросов: ${t.questions_loaded}\n` +
        `↩️ Возвратов: ${t.returns_loaded}\n` +
        `✍️ Черновиков: ${t.drafts_created}\n` +
        `⚠️ Проблем с товарами: ${t.issues_found}`;
      await csSendTelegramMessage_(token, chatId, msgText);
      return true;
    }

    if (command === '/cs_reviews') {
      const rows = await db.prepare(
        `SELECT i.id, i.sku_title, i.customer_text, i.customer_rating,
                d.id as draft_id, d.draft_text, d.status as draft_status
         FROM cs_inbox_item i
         LEFT JOIN cs_draft_response d ON d.inbox_item_id=i.id AND d.status='pending'
         WHERE i.source='wb_review' AND i.status IN ('new','draft_ready')
         ORDER BY i.created_at DESC LIMIT 10`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Новых отзывов нет.'));
        return true;
      }

      for (const item of items) {
        const title = csEscapeMd_(item.sku_title || 'Товар');
        const rating = item.customer_rating ? `${item.customer_rating}/5` : '—';
        const reviewText = csEscapeMd_(csSafeText_(item.customer_text || '', 300));
        const draftText = item.draft_text
          ? csEscapeMd_(csSafeText_(item.draft_text, 400))
          : csEscapeMd_('Черновик не готов');

        let msgBody =
          `*Отзыв* — ${title} \\(${csEscapeMd_(rating)}\\)\n` +
          `_${reviewText}_\n\n` +
          `*Черновик ответа:*\n${draftText}`;

        if (item.draft_id) {
          msgBody += `\n\n` +
            `✅ /cs\\_approve\\_${item.draft_id}\n` +
            `🔄 /cs\\_reject\\_${item.draft_id}\n` +
            `👤 /cs\\_escalate\\_${item.draft_id}`;
        }

        await csSendTelegramMessage_(token, chatId, msgBody);
      }
      return true;
    }

    if (command === '/cs_questions') {
      const rows = await db.prepare(
        `SELECT i.id, i.sku_title, i.customer_text,
                d.id as draft_id, d.draft_text
         FROM cs_inbox_item i
         LEFT JOIN cs_draft_response d ON d.inbox_item_id=i.id AND d.status='pending'
         WHERE i.source='wb_question' AND i.status IN ('new','draft_ready')
         ORDER BY i.created_at DESC LIMIT 10`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Неотвеченных вопросов нет.'));
        return true;
      }

      for (const item of items) {
        const title = csEscapeMd_(item.sku_title || 'Товар');
        const qText = csEscapeMd_(csSafeText_(item.customer_text || '', 300));
        const draftText = item.draft_text
          ? csEscapeMd_(csSafeText_(item.draft_text, 400))
          : csEscapeMd_('Черновик не готов');

        let msgBody =
          `*Вопрос* — ${title}\n_${qText}_\n\n` +
          `*Черновик ответа:*\n${draftText}`;

        if (item.draft_id) {
          msgBody += `\n\n` +
            `✅ /cs\\_approve\\_${item.draft_id}\n` +
            `🔄 /cs\\_reject\\_${item.draft_id}\n` +
            `👤 /cs\\_escalate\\_${item.draft_id}`;
        }

        await csSendTelegramMessage_(token, chatId, msgBody);
      }
      return true;
    }

    if (command === '/cs_returns') {
      const rows = await db.prepare(
        `SELECT id, sku_title, customer_text, item_date, priority
         FROM cs_inbox_item
         WHERE source='wb_return'
           AND DATE(created_at) >= DATE('now','-7 days')
         ORDER BY created_at DESC LIMIT 20`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Возвратов за последние 7 дней нет.'));
        return true;
      }

      let out = `*Возвраты за последние 7 дней* \\(${items.length}\\)\n\n`;
      for (const item of items) {
        const date = csEscapeMd_(item.item_date || '—');
        const sku = csEscapeMd_(item.sku_title || 'Товар');
        const reason = csEscapeMd_(csSafeText_(item.customer_text || '', 150));
        out += `• ${date} — ${sku}: _${reason}_\n`;
      }
      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/cs_appeals') {
      const rows = await db.prepare(
        `SELECT id, nm_id, sku_title, issue_type, severity, occurrence_count, status
         FROM cs_product_issue
         WHERE status='open' AND severity IN ('high','critical')
         ORDER BY severity DESC, occurrence_count DESC LIMIT 20`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Открытых жалоб высокого приоритета нет.'));
        return true;
      }

      let out = `*Открытые жалобы \\(high/critical\\)* \\(${items.length}\\)\n\n`;
      for (const item of items) {
        const sev = csEscapeMd_(item.severity || '—');
        const sku = csEscapeMd_(item.sku_title || `nm_id:${item.nm_id}`);
        const type = csEscapeMd_(item.issue_type || '—');
        out += `⚠️ *${sev}* — ${sku} — ${type} \\(${item.occurrence_count} раз\\)\n`;
        out += `   /cs\\_create\\_task\\_${item.id}\n`;
      }
      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/cs_issues') {
      const rows = await db.prepare(
        `SELECT id, nm_id, sku_title, issue_type, severity, occurrence_count, status, first_seen_date
         FROM cs_product_issue
         WHERE status IN ('open','in_progress')
         ORDER BY occurrence_count DESC, severity DESC LIMIT 20`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('Открытых проблем с товарами нет.'));
        return true;
      }

      let out = `*Все открытые проблемы с товарами* \\(${items.length}\\)\n\n`;
      for (const item of items) {
        const sev = csEscapeMd_(item.severity || '—');
        const sku = csEscapeMd_(item.sku_title || `nm:${item.nm_id}`);
        const type = csEscapeMd_(item.issue_type || '—');
        const status = csEscapeMd_(item.status || '—');
        out += `• ${sku} — ${type} \\[${sev}\\] — ${item.occurrence_count}x — ${status}\n`;
      }
      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/cs_templates') {
      const rows = await db.prepare(
        `SELECT id, category, template_text, tone, usage_count, is_active
         FROM cs_knowledge_item
         WHERE is_active=1
         ORDER BY usage_count DESC LIMIT 15`
      ).all();

      const items = rows.results || [];
      if (items.length === 0) {
        await csSendTelegramMessage_(token, chatId, csEscapeMd_('База шаблонов пуста.'));
        return true;
      }

      let out = `*Шаблоны ответов* \\(${items.length}\\)\n\n`;
      for (const item of items) {
        const cat = csEscapeMd_(item.category || '—');
        const tone = csEscapeMd_(item.tone || '—');
        const preview = csEscapeMd_(csSafeText_(item.template_text || '', 100));
        out += `*${cat}* \\(${tone}\\) — использован ${item.usage_count}x\n_${preview}_\n\n`;
      }
      await csSendTelegramMessage_(token, chatId, out);
      return true;
    }

    if (command === '/cs_run') {
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Запускаю CS Chief... Это займёт несколько секунд.'));
      const date = wbYesterday_();
      const report = await runCsOperationsChief_(env, date, userId);
      const safeSummary = csEscapeMd_(report.summary);
      const t = report.totals;
      const doneMsg =
        `*CS Chief завершён* \\(${csEscapeMd_(wbFormatDate_(date))}\\)\n\n` +
        `${safeSummary}\n\n` +
        `📥 Отзывов: ${t.reviews_loaded}\n` +
        `❓ Вопросов: ${t.questions_loaded}\n` +
        `↩️ Возвратов: ${t.returns_loaded}\n` +
        `✍️ Черновиков создано: ${t.drafts_created}\n` +
        `⚠️ Проблем с товарами: ${t.issues_found}\n` +
        `💡 Инсайтов: ${t.insights_created}`;
      await csSendTelegramMessage_(token, chatId, doneMsg);
      return true;
    }

    // Handle inline-style deep-link commands (from button callbacks sent as messages)
    if (command.startsWith('/cs_approve_')) {
      const draftId = text.replace('/cs_approve_', '');
      await handleCsApproveDraft_(db, draftId, userId);
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Ответ одобрен.'));
      return true;
    }

    if (command.startsWith('/cs_reject_')) {
      const draftId = text.replace('/cs_reject_', '');
      await handleCsRejectDraft_(db, draftId, null, userId);
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Черновик отклонён, будет переработан.'));
      return true;
    }

    if (command.startsWith('/cs_escalate_')) {
      const draftId = text.replace('/cs_escalate_', '');
      await handleCsEscalateDraft_(db, draftId, userId);
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Обращение передано специалисту.'));
      return true;
    }

    if (command.startsWith('/cs_create_task_')) {
      const issueId = text.replace('/cs_create_task_', '');
      await handleCsCreateTask_(db, issueId, userId);
      await csSendTelegramMessage_(token, chatId, csEscapeMd_('Задача по проблеме с товаром создана.'));
      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'telegram_handler',
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
// SECTION 12 — CS Callback Handler (shared action helpers)
// ============================================================

async function handleCsApproveDraft_(db, draftId, userId) {
  const draft = await db.prepare(`SELECT * FROM cs_draft_response WHERE id=?`).bind(draftId).first();
  if (!draft) return { ok: false, error: 'draft_not_found' };
  if (draft.status === 'approved' || draft.status === 'sent') {
    return { ok: true, idempotent: true };
  }

  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE cs_draft_response SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?`
  ).bind(userId || null, now, now, draftId).run();

  await db.prepare(
    `UPDATE cs_inbox_item SET status='approved', updated_at=? WHERE id=?`
  ).bind(now, draft.inbox_item_id).run();

  await wbLog_(db, {
    entity_type: 'cs', entity_id: draftId,
    action: 'draft_approved', status: 'ok',
    details_json: JSON.stringify({ approved_by: userId }),
  });

  return { ok: true };
}

async function handleCsRejectDraft_(db, draftId, reason, userId) {
  const draft = await db.prepare(`SELECT * FROM cs_draft_response WHERE id=?`).bind(draftId).first();
  if (!draft) return { ok: false, error: 'draft_not_found' };
  if (draft.status === 'rejected') return { ok: true, idempotent: true };

  const now = new Date().toISOString();
  const newVersion = (draft.draft_version || 1) + 1;

  await db.prepare(
    `UPDATE cs_draft_response
     SET status='rejected', rejection_reason=?, draft_version=?, updated_at=?
     WHERE id=?`
  ).bind(reason || null, newVersion, now, draftId).run();

  await wbLog_(db, {
    entity_type: 'cs', entity_id: draftId,
    action: 'draft_rejected', status: 'ok',
    details_json: JSON.stringify({ reason, rejected_by: userId }),
  });

  return { ok: true };
}

async function handleCsEscalateDraft_(db, draftId, userId) {
  const draft = await db.prepare(`SELECT * FROM cs_draft_response WHERE id=?`).bind(draftId).first();
  if (!draft) return { ok: false, error: 'draft_not_found' };

  const now = new Date().toISOString();

  await db.prepare(
    `UPDATE cs_inbox_item SET status='escalated', updated_at=? WHERE id=?`
  ).bind(now, draft.inbox_item_id).run();

  await wbLog_(db, {
    entity_type: 'cs', entity_id: draftId,
    action: 'draft_escalated', status: 'ok',
    details_json: JSON.stringify({ escalated_by: userId }),
  });

  return { ok: true };
}

async function handleCsCreateTask_(db, issueId, userId) {
  const issue = await db.prepare(`SELECT * FROM cs_product_issue WHERE id=?`).bind(issueId).first();
  if (!issue) return { ok: false, error: 'issue_not_found' };
  if (issue.status === 'in_progress' || issue.status === 'resolved') {
    return { ok: true, idempotent: true };
  }

  const now = new Date().toISOString();

  await db.prepare(
    `UPDATE cs_product_issue SET status='in_progress', updated_at=? WHERE id=?`
  ).bind(now, issueId).run();

  await wbLog_(db, {
    entity_type: 'cs', entity_id: issueId,
    action: 'product_task_created', status: 'ok',
    details_json: JSON.stringify({ created_by: userId }),
  });

  return { ok: true };
}

async function routeCsCallbackQuery_(env, callbackQuery) {
  const db = env.DB;
  const data = callbackQuery.data || '';
  const userId = String(callbackQuery.from?.id || '');
  const chatId = callbackQuery.message?.chat?.id;
  const token = env.TELEGRAM_BOT_TOKEN;

  try {
    await ensureCsSchema_(db);

    if (data.startsWith('cs_approve_')) {
      const draftId = data.replace('cs_approve_', '');
      const result = await handleCsApproveDraft_(db, draftId, userId);
      if (token && chatId) {
        const txt = result.idempotent
          ? csEscapeMd_('Ответ уже был одобрен ранее.')
          : csEscapeMd_('Ответ одобрен.');
        await csSendTelegramMessage_(token, chatId, txt);
      }
      return true;
    }

    if (data.startsWith('cs_reject_')) {
      const draftId = data.replace('cs_reject_', '');
      const result = await handleCsRejectDraft_(db, draftId, null, userId);
      if (token && chatId) {
        const txt = result.idempotent
          ? csEscapeMd_('Черновик уже был отклонён.')
          : csEscapeMd_('Черновик отклонён, будет переработан.');
        await csSendTelegramMessage_(token, chatId, txt);
      }
      return true;
    }

    if (data.startsWith('cs_escalate_')) {
      const draftId = data.replace('cs_escalate_', '');
      const result = await handleCsEscalateDraft_(db, draftId, userId);
      if (token && chatId) {
        const txt = result.ok
          ? csEscapeMd_('Обращение передано специалисту.')
          : csEscapeMd_('Ошибка при эскалации.');
        await csSendTelegramMessage_(token, chatId, txt);
      }
      return true;
    }

    if (data.startsWith('cs_create_task_')) {
      const issueId = data.replace('cs_create_task_', '');
      const result = await handleCsCreateTask_(db, issueId, userId);
      if (token && chatId) {
        const txt = result.idempotent
          ? csEscapeMd_('Задача уже была создана.')
          : (result.ok
            ? csEscapeMd_('Задача по проблеме с товаром создана.')
            : csEscapeMd_('Ошибка при создании задачи.'));
        await csSendTelegramMessage_(token, chatId, txt);
      }
      return true;
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'callback_handler',
      action: 'callback_error', status: 'error',
      details_json: JSON.stringify({ data, error: String(e) }),
    });
  }

  return false;
}

// ============================================================
// SECTION 13 — CS API Router
// ============================================================

async function handleCsAgentRoutes_(env, request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.DB;

  if (!path.startsWith('/agent/cs/')) return null;

  const jsonResponse = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    await ensureCsSchema_(db);

    // GET /agent/cs/health
    if (method === 'GET' && path === '/agent/cs/health') {
      const tables = ['cs_inbox_item', 'cs_draft_response', 'cs_product_issue',
                      'cs_knowledge_item', 'cs_feedback_insight'];
      const counts = {};
      for (const tbl of tables) {
        try {
          const row = await db.prepare(`SELECT COUNT(*) as n FROM ${tbl}`).first();
          counts[tbl] = row?.n || 0;
        } catch (_) {
          counts[tbl] = -1;
        }
      }
      return jsonResponse({ ok: true, build: CS_BUILD, table_counts: counts });
    }

    // POST /agent/cs/report/run
    if (method === 'POST' && path === '/agent/cs/report/run') {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const date = body.date || wbYesterday_();
      const userId = body.user_id || null;
      const report = await runCsOperationsChief_(env, date, userId);
      return jsonResponse({ ok: true, report });
    }

    // GET /agent/cs/inbox
    if (method === 'GET' && path === '/agent/cs/inbox') {
      const status = url.searchParams.get('status') || null;
      const source = url.searchParams.get('source') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_inbox_item WHERE 1=1`;
      const binds = [];
      if (status) { sql += ` AND status=?`; binds.push(status); }
      if (source) { sql += ` AND source=?`; binds.push(source); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, items: rows.results || [], count: (rows.results || []).length });
    }

    // GET /agent/cs/drafts
    if (method === 'GET' && path === '/agent/cs/drafts') {
      const status = url.searchParams.get('status') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_draft_response WHERE 1=1`;
      const binds = [];
      if (status) { sql += ` AND status=?`; binds.push(status); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, drafts: rows.results || [], count: (rows.results || []).length });
    }

    // POST /agent/cs/drafts/:id/approve
    const approveMatch = path.match(/^\/agent\/cs\/drafts\/([^/]+)\/approve$/);
    if (method === 'POST' && approveMatch) {
      const draftId = approveMatch[1];
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const result = await handleCsApproveDraft_(db, draftId, body.user_id || null);
      return jsonResponse(result, result.ok ? 200 : 404);
    }

    // POST /agent/cs/drafts/:id/reject
    const rejectMatch = path.match(/^\/agent\/cs\/drafts\/([^/]+)\/reject$/);
    if (method === 'POST' && rejectMatch) {
      const draftId = rejectMatch[1];
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const result = await handleCsRejectDraft_(db, draftId, body.reason || null, body.user_id || null);
      return jsonResponse(result, result.ok ? 200 : 404);
    }

    // GET /agent/cs/issues
    if (method === 'GET' && path === '/agent/cs/issues') {
      const status = url.searchParams.get('status') || null;
      const severity = url.searchParams.get('severity') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_product_issue WHERE 1=1`;
      const binds = [];
      if (status) { sql += ` AND status=?`; binds.push(status); }
      if (severity) { sql += ` AND severity=?`; binds.push(severity); }
      sql += ` ORDER BY occurrence_count DESC, created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, issues: rows.results || [], count: (rows.results || []).length });
    }

    // GET /agent/cs/insights
    if (method === 'GET' && path === '/agent/cs/insights') {
      const date = url.searchParams.get('date') || null;
      const nmId = url.searchParams.get('nm_id') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_feedback_insight WHERE 1=1`;
      const binds = [];
      if (date) { sql += ` AND date=?`; binds.push(date); }
      if (nmId) { sql += ` AND nm_id=?`; binds.push(nmId); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, insights: rows.results || [], count: (rows.results || []).length });
    }

    // GET /agent/cs/knowledge
    if (method === 'GET' && path === '/agent/cs/knowledge') {
      const category = url.searchParams.get('category') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM cs_knowledge_item WHERE is_active=1`;
      const binds = [];
      if (category) { sql += ` AND category=?`; binds.push(category); }
      sql += ` ORDER BY usage_count DESC LIMIT ?`;
      binds.push(limit);

      const rows = await db.prepare(sql).bind(...binds).all();
      return jsonResponse({ ok: true, items: rows.results || [], count: (rows.results || []).length });
    }

    // POST /agent/cs/knowledge
    if (method === 'POST' && path === '/agent/cs/knowledge') {
      let body = {};
      try { body = await request.json(); } catch (_) {}

      if (!body.category || !body.template_text) {
        return jsonResponse({ ok: false, error: 'category and template_text are required' }, 400);
      }

      const id = wbGenerateId_('csk');
      const now = new Date().toISOString();

      await db.prepare(`
        INSERT INTO cs_knowledge_item
          (id, user_id, category, trigger_keywords_json, template_text,
           tone, language, is_active, tags_json, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,1,?,?,?)
      `).bind(
        id,
        body.user_id || null,
        body.category,
        JSON.stringify(body.trigger_keywords || []),
        body.template_text,
        body.tone || 'professional',
        body.language || 'ru',
        JSON.stringify(body.tags || []),
        now, now
      ).run();

      return jsonResponse({ ok: true, id });
    }

    // GET /agent/cs/log
    if (method === 'GET' && path === '/agent/cs/log') {
      const entityId = url.searchParams.get('entity_id') || null;
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

      let sql = `SELECT * FROM wb_action_log WHERE entity_type='cs'`;
      const binds = [];
      if (entityId) { sql += ` AND entity_id=?`; binds.push(entityId); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      binds.push(limit);

      let rows = { results: [] };
      try { rows = await db.prepare(sql).bind(...binds).all(); } catch (_) {}
      return jsonResponse({ ok: true, log: rows.results || [], count: (rows.results || []).length });
    }
  } catch (e) {
    await wbLog_(db, {
      entity_type: 'cs', entity_id: 'api_router',
      action: 'route_error', status: 'error',
      details_json: JSON.stringify({ path, method, error: String(e) }),
    });
    return jsonResponse({ ok: false, error: String(e) }, 500);
  }

  return null;
}
