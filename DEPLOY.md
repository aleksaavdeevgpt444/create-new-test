# Руководство по развёртыванию

Проект: **ИИ агенты-помощники**  
Платформа: Cloudflare Workers + D1 (SQLite)  
Версия схемы БД: 49 таблиц, 40 индексов  
Исходных модулей: 22 `.gs` файла + `worker.js`  
Единый деплой-файл: `worker_bundle.js` (21 663 строки, ~856 KB)

---

## Два способа деплоя

| Способ | Когда использовать |
|--------|-------------------|
| **Вариант A — веб-интерфейс** | Быстрый старт без CLI, ручная настройка переменных |
| **Вариант B — Wrangler CLI** | Полная автоматизация, staging-окружение, хуки |

---

## Вариант A — Веб-интерфейс Cloudflare (быстрый старт)

### A1. Создать Worker

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Create
2. Дать имя: `ai-agents-worker`
3. Edit Code → вставить содержимое файла `worker_bundle.js` → Save and Deploy

### A2. Создать D1 базу данных

1. Dashboard → Workers & Pages → D1 → Create database
2. Имя: `ai-agents-db`
3. Скопировать `Database ID`

### A3. Подключить D1 к Worker

1. Worker → Settings → Bindings → Add → D1 Database
2. Variable name: `DB`
3. Database: `ai-agents-db` → Save

### A4. Инициализировать схему БД

Dashboard → D1 → `ai-agents-db` → Console → вставить содержимое `schema.sql` → Execute.

Или через Wrangler:

```bash
wrangler d1 execute ai-agents-db --file=schema.sql
```

### A5. Добавить секреты

Worker → Settings → Variables → Environment Variables → Add:

| Переменная | Тип | Описание |
|------------|-----|---------|
| `TELEGRAM_BOT_TOKEN` | Secret | Токен бота от @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | Произвольная строка-секрет для проверки вебхука |
| `GEMINI_API_KEY` | Secret | Ключ Google Gemini (основной AI провайдер) |
| `GROQ_API_KEY` | Secret | Ключ Groq (резервный AI провайдер) |
| `WB_API_TOKEN` | Secret | Токен Wildberries API (для wb_data_sync) |
| `INTERNAL_API_BASE` | Secret | URL внутреннего backend (если есть) |

### A6. Настроить Telegram вебхук

После деплоя и добавления секретов отправить боту команду `/setup_notify` или вызвать:

```
POST https://<your-worker>.workers.dev/webhook/setup
```

Бот пришлёт подтверждение с `setWebhook` статусом.

### A7. Настроить Cron триггеры

Worker → Settings → Triggers → Cron Triggers → Add:

| Cron | Задание |
|------|---------|
| `0 3 * * *` | proposal_cleanup |
| `0 4 * * *` | qa_daily |
| `30 4 * * *` | wb_data_sync |
| `30 5 * * *` | alerts_check |
| `0 11 * * *` | wb_pricing_daily |
| `0 5 * * *` | wb_daily_report |
| `0 6 * * *` | fulfillment_daily |
| `0 7 * * *` | cs_daily_report |
| `0 8 * * *` | rop_daily_report |
| `0 9 * * *` | design_daily_report |
| `0 10 * * *` | procurement_daily |
| `0 * * * *` | proposals_check |
| `30 6 * * 1` | weekly_insights |

---

## Вариант B — Wrangler CLI

### Предварительные требования

```bash
npm install -g wrangler
wrangler login
```

### B1. Создать D1 базу данных

```bash
wrangler d1 create ai-agents-db
# Скопировать database_id из вывода
```

Вставить `database_id` в `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "ai-agents-db"
database_id = "<ВСТАВИТЬ_ID>"
```

### B2. Применить схему БД

```bash
wrangler d1 execute ai-agents-db --file=schema.sql
```

### B3. Установить секреты

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put GEMINI_API_KEY
wrangler secret put GROQ_API_KEY
wrangler secret put WB_API_TOKEN
wrangler secret put INTERNAL_API_BASE   # если нужен
```

### B4. Деплой

```bash
# Production
wrangler deploy

# Staging
wrangler deploy --env staging
```

### B5. Настроить вебхук

```bash
curl -X POST https://<your-worker>.workers.dev/webhook/setup \
  -H "Content-Type: application/json"
```

### B6. Проверить здоровье системы

```bash
curl https://<your-worker>.workers.dev/agent/qa/check | jq .overall_status
```

---

## Миграция существующей БД

Если у вас уже есть база и вы обновляете систему — применяйте `migration.sql` вместо `schema.sql`:

```bash
wrangler d1 execute ai-agents-db --file=migration.sql
```

`migration.sql` содержит 25 секций (`ALTER TABLE`, `CREATE TABLE IF NOT EXISTS`) и безопасен для повторного запуска.

---

## Структура системы

### Исходные модули (в порядке загрузки в bundle)

| Файл | Назначение |
|------|-----------|
| `stage336_349_agent_extension.gs` | Базовая инфраструктура агентов, типы |
| `stage336_349_router_patch.gs` | Патч маршрутизатора |
| `wb_operations_stage1_v1.gs` | WB Operations Chief, отчёты |
| `wb_ops_router_patch.gs` | Патч WB маршрутов |
| `wb_operations_stage2_v1.gs` | WB Stock Analyst, стоковые расчёты |
| `wb_operations_stage2_patch.gs` | Патч Stage 2 |
| `cs_operations_stage1_v1.gs` | CS Chief, входящие сообщения |
| `cs_operations_stage2_v1.gs` | CS Stage 2, апелляции, пробелы знаний |
| `approval_flow_v1.gs` | Дайджест подтверждений |
| `qa_runner_v1.gs` | QA, проверка здоровья системы |
| `handoff_events_v1.gs` | События передачи между агентами |
| `scheduler_v1.gs` | Планировщик cron-задач |
| `design_chief_v1.gs` | Design Chief, карточки товаров |
| `rop_chief_v1.gs` | ROP Chief, KPI и таргеты |
| `fulfillment_chief_v1.gs` | Fulfillment Chief, FBS, ТЗ |
| `procurement_chief_v1.gs` | Procurement Chief, закупки |
| `wb_sync_v1.gs` | WB Data Sync, снапшоты из WB API |
| `wb_pricing_v1.gs` | Price & Discount Advisor |
| `supplier_management_v1.gs` | Справочник поставщиков |
| `bot_setup_v1.gs` | Настройка бота, регистрация пользователей |
| `alerts_v1.gs` | Система алертов (7 типов, дедупликация) |
| `wb_api_client_v1.gs` | WB API клиент |
| `worker.js` | Cloudflare Worker entry point |

### Таблицы D1 (49 обязательных + 1 опциональная)

| Группа | Таблицы |
|--------|---------|
| Agent Extension | agent_incoming_messages, agent_proposals, agent_settings, agent_audit_log |
| WB Stage 1 | wb_daily_snapshot, wb_sku_snapshot, wb_ads_snapshot, wb_finance_snapshot, wb_stock_snapshot, wb_agent_report, wb_agent_alerts, wb_agent_proposals, wb_action_log, wb_cost_data |
| WB Stage 2 | wb_stock_snapshot_v2, wb_procurement_snapshot, supplier_directory, wb_report_consistency_check, wb_report_health_summary, wb_report_consistency_check_v2 |
| CS | cs_inbox_item, cs_draft_response, cs_product_issue, cs_knowledge_item, cs_feedback_insight, cs_appeal_item, cs_knowledge_gap |
| Approval | approval_digest_log |
| Handoff | handoff_event |
| Scheduler | scheduler_run_log, scheduler_config |
| Design | design_handoff_item, design_card_snapshot, design_content_plan |
| ROP | rop_kpi_snapshot, rop_target, rop_insight |
| Fulfillment | fulfillment_fbs_snapshot, fulfillment_tz_item, fulfillment_schedule |
| Procurement | procurement_order, procurement_handoff_item, procurement_price_history |
| WB Sync | wb_sync_log |
| WB Pricing | wb_pricing_proposal, wb_pricing_history |
| Bot Setup | bot_users |
| Alerts | alert_config, alert_log |
| Optional | hub_records |

---

## Telegram команды

### Основные

| Команда | Описание |
|---------|---------|
| `/start` | Регистрация, приветствие |
| `/help` | Полный список команд |
| `/status` | Статус синхронизации и алертов |
| `/setup_notify` | Назначить этот чат получателем уведомлений |

### WB Operations

| Команда | Описание |
|---------|---------|
| `/wb_report` | Ежедневный отчёт WB Operations |
| `/wb_stock` | Критические стоки |
| `/wb_proposals` | Ожидающие предложения |
| `/wb_approve <id>` | Подтвердить предложение |
| `/wb_reject <id>` | Отклонить предложение |
| `/wb_sync` | Статус последней синхронизации WB |
| `/wb_sync_run` | Запустить синхронизацию вручную |

### CS Operations

| Команда | Описание |
|---------|---------|
| `/cs_inbox` | Новые входящие обращения |
| `/cs_drafts` | Черновики ответов |
| `/cs_approve <id>` | Одобрить черновик |
| `/cs_issues` | Открытые проблемы с товарами |
| `/cs_knowledge` | База знаний |

### Ценообразование

| Команда | Описание |
|---------|---------|
| `/pricing` | Запустить Price & Discount Advisor |
| `/pricing_proposals` | Ожидающие ценовые предложения |

### Алерты

| Команда | Описание |
|---------|---------|
| `/alerts` | Алерты за сегодня |
| `/alerts_config` | Настройка порогов алертов |

### Design Chief

| Команда | Описание |
|---------|---------|
| `/design_report` | Ежедневный отчёт Design Chief |
| `/design_tasks` | Задачи на контент |

### ROP Chief

| Команда | Описание |
|---------|---------|
| `/rop_report` | Ежедневный KPI отчёт |
| `/rop_targets` | Таргеты с pending статусом |

### Fulfillment Chief

| Команда | Описание |
|---------|---------|
| `/fulfillment_report` | Ежедневный отчёт фулфилмента |
| `/fulfillment_schedule` | Расписание поставок |

### Procurement Chief

| Команда | Описание |
|---------|---------|
| `/procurement_report` | Ежедневный отчёт закупок |
| `/procurement_orders` | Ожидающие заявки на закупку |

### Поставщики

| Команда | Описание |
|---------|---------|
| `/suppliers` | Список поставщиков |
| `/supplier_add` | Добавить поставщика |

### Планировщик

| Команда | Описание |
|---------|---------|
| `/scheduler_status` | Статус всех cron-заданий |
| `/scheduler_run <job>` | Запустить задание вручную |
| `/scheduler_history` | История запусков |

### QA

| Команда | Описание |
|---------|---------|
| `/qa_check` | Полная QA проверка системы |
| `/qa_tables` | Проверка наличия таблиц |
| `/qa_calc` | Тесты расчётных функций |

---

## REST API (основные эндпоинты)

### Health & QA
```
GET  /health
GET  /agent/qa/check
GET  /agent/qa/tables
GET  /agent/qa/schema
GET  /agent/qa/integrity
GET  /agent/qa/calculations
GET  /agent/qa/environment
```

### WB Operations
```
GET  /agent/wb/report
GET  /agent/wb/stock/critical
GET  /agent/wb/proposals
POST /agent/wb/proposals/:id/approve
POST /agent/wb/proposals/:id/reject
```

### WB Data Sync
```
GET  /agent/wb/sync/status
GET  /agent/wb/sync/log
POST /agent/wb/sync/run
```

### WB Pricing
```
GET  /agent/pricing/proposals
GET  /agent/pricing/proposals/:id
POST /agent/pricing/run
POST /agent/pricing/proposals/:id/confirm
POST /agent/pricing/proposals/:id/skip
GET  /agent/pricing/history
```

### CS Operations
```
GET  /agent/cs/inbox
GET  /agent/cs/drafts
POST /agent/cs/drafts/:id/approve
POST /agent/cs/drafts/:id/reject
GET  /agent/cs/issues
GET  /agent/cs/knowledge
```

### Suppliers
```
GET  /agent/suppliers
POST /agent/suppliers
GET  /agent/suppliers/:id
PUT  /agent/suppliers/:id
DELETE /agent/suppliers/:id
GET  /agent/suppliers/nm/:nm_id
GET  /agent/suppliers/prices
POST /agent/suppliers/prices
```

### Alerts
```
GET  /agent/alerts
GET  /agent/alerts/config
POST /agent/alerts/config
POST /agent/alerts/run
```

### Bot
```
POST /webhook/setup
GET  /agent/bot/users
GET  /agent/bot/status
```

### Scheduler
```
GET  /agent/scheduler/status
POST /agent/scheduler/run/:job
GET  /agent/scheduler/history
GET  /agent/scheduler/config
```

---

## Ограничения безопасности (hardcoded, не отключаются)

Система намеренно не выполняет следующие действия автоматически:

- Не меняет рекламные ставки и бюджеты
- Не создаёт поставки на WB
- Не согласовывает закупки
- Не отправляет ТЗ на фулфилмент
- Не отправляет письма поставщикам
- Не создаёт задачи без подтверждения оператора
- Не удаляет данные
- Не подменяет расчётные данные выводом AI
- Не скрывает отсутствующие данные

Все действия с `requires_confirmation=1` требуют явного подтверждения через Telegram (кнопки) или API. Каждое подтверждение имеет уникальный `confirmation_id`.

---

## Проверка после деплоя

```bash
# Проверить здоровье
curl https://<worker>.workers.dev/health

# Полная QA проверка
curl https://<worker>.workers.dev/agent/qa/check | jq '{status: .overall_status, summary: .summary}'

# Статус таблиц
curl https://<worker>.workers.dev/agent/qa/tables | jq '.missing_tables'
```

Или через Telegram: отправить боту `/qa_check`.
