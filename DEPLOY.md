# Руководство по развёртыванию

Проект: **ИИ агенты-помощники**  
Платформа: Cloudflare Workers + D1 (SQLite)  
Версия схемы БД: 43 таблицы, 35 индексов

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

| Переменная | Тип | Значение |
|------------|-----|----------|
| `TELEGRAM_BOT_TOKEN` | Secret | токен бота от @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Secret | произвольная строка-секрет |
| `GEMINI_API_KEY` | Secret | ключ Google Gemini |
| `GROQ_API_KEY` | Secret | ключ Groq |
| `INTERNAL_API_BASE` | Secret | URL внутреннего backend (если есть) |
| `WB_API_TOKEN` | Secret | токен Wildberries API |

Необязательные:

| Переменная | Значение по умолчанию |
|------------|-----------------------|
| `GEMINI_CLASSIFICATION_MODEL` | `gemini-1.5-flash-latest` |
| `GROQ_API_BASE` | `https://api.groq.com/openai/v1` |
| `GROQ_MODEL` | `llama3-8b-8192` |
| `ADMIN_TELEGRAM_ID` | (если нужна защита `/scheduler_run`) |

### A6. Зарегистрировать Telegram Webhook

```bash
curl -X POST "https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://ai-agents-worker.YOUR_SUBDOMAIN.workers.dev/telegram/webhook",
    "secret_token": "YOUR_WEBHOOK_SECRET",
    "allowed_updates": ["message", "callback_query"]
  }'
```

### A7. Проверить

```
GET https://ai-agents-worker.YOUR_SUBDOMAIN.workers.dev/health
```

Ожидаемый ответ:

```json
{
  "ok": true,
  "build": "ai_helpers_worker_v1",
  "modules": ["stage336_349", "wb_ops_stage1", "wb_ops_stage2", ...]
}
```

---

## Вариант B — Wrangler CLI

### B1. Подготовка

```bash
npm install -g wrangler
wrangler login
```

### B2. Создать D1 базу данных

```bash
wrangler d1 create ai-agents-db
# → database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Вставить `database_id` в `wrangler.toml` → секцию `[[d1_databases]]`.

### B3. Инициализировать схему БД

```bash
# Продакшн
wrangler d1 execute ai-agents-db --file=schema.sql

# Staging
wrangler d1 execute ai-agents-db-staging --file=schema.sql --env staging
```

### B4. Установить секреты

```bash
# Обязательные
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put GEMINI_API_KEY
wrangler secret put GROQ_API_KEY
wrangler secret put INTERNAL_API_BASE
wrangler secret put WB_API_TOKEN

# Необязательные
wrangler secret put GEMINI_CLASSIFICATION_MODEL
wrangler secret put GROQ_API_BASE
wrangler secret put GROQ_MODEL
wrangler secret put ADMIN_TELEGRAM_ID
```

### B5. Деплой

```bash
# Продакшн
wrangler deploy

# Staging
wrangler deploy --env staging
```

### B6. Зарегистрировать webhook и проверить

Аналогично шагам A6 и A7.

---

## Обновление существующего деплоя

Если база данных уже существует — использовать `migration.sql` вместо `schema.sql`:

```bash
wrangler d1 execute ai-agents-db --file=migration.sql
```

`migration.sql` содержит только новые таблицы (безопасно применять к рабочей БД).  
Новые колонки в существующих таблицах добавляются автоматически при запуске Worker через `ALTER TABLE ... ADD COLUMN` (с обработкой ошибки дублирования).

---

## Настройка планировщика

После деплоя настроить уведомления для cron-заданий:

```bash
# Установить chat_id для уведомлений (replace 123456789 your Telegram chat ID)
curl -X POST https://YOUR_WORKER.workers.dev/agent/scheduler/config \
  -H "Content-Type: application/json" \
  -d '{"job_name":"wb_daily_report","notify_chat_id":"123456789","notify_on_error":true}'
```

### Расписание cron-заданий (UTC)

| Время UTC | Задание | Описание |
|-----------|---------|----------|
| 03:00 | `proposal_cleanup` | Истечение старых proposals |
| 04:00 | `qa_daily` | Системный health check |
| 05:00 | `wb_daily_report` | WB Operations Chief |
| 06:00 | `fulfillment_daily` | Fulfillment Chief |
| 07:00 | `cs_daily_report` | CS Operations Chief |
| 08:00 | `rop_daily_report` | ROP Chief |
| 09:00 | `design_daily_report` | Design Chief |
| 10:00 | `procurement_daily` | Procurement Chief |
| каждый час | `proposals_check` | Дайджест если >5 pending |
| 06:30 пн | `weekly_insights` | Еженедельные инсайты |

---

## Структура файлов

| Файл | Назначение |
|------|-----------|
| `worker_bundle.js` | **Единый JS-файл для загрузки в Workers** (все модули склеены) |
| `worker.js` | Главный роутер (исходник) |
| `schema.sql` | **Полная схема БД** для инициализации с нуля |
| `migration.sql` | Инкрементальное обновление существующей БД |
| `wrangler.toml` | Конфигурация Cloudflare Workers |
| `stage336_349_agent_extension.gs` | Базовый агент: proposals, audit log, inbox hub |
| `wb_operations_stage1_v1.gs` | WB: SKU Monitor, Ads Control, Finance, Alerts |
| `wb_operations_stage2_v1.gs` | WB: Stock&Fulfillment, Procurement, Consistency |
| `wb_operations_stage2_patch.gs` | WB Stage 2: schema patch + reconciliation checks |
| `cs_operations_stage1_v1.gs` | CS: Review Response, Q&A, Return Reason, Tone |
| `cs_operations_stage2_v1.gs` | CS: Complaint/Appeal, Knowledge Base, Tone V2 |
| `approval_flow_v1.gs` | Unified proposals digest и подтверждения |
| `qa_runner_v1.gs` | QA: 43 таблицы, 37 колонок, integrity checks |
| `handoff_events_v1.gs` | Межшефная коммуникация |
| `scheduler_v1.gs` | Cron-оркестратор (10 заданий) |
| `design_chief_v1.gs` | AI-шеф дизайна: карточки, SEO, контент-план |
| `rop_chief_v1.gs` | AI-шеф РОП: KPI, воронка продаж, цели |
| `fulfillment_chief_v1.gs` | AI-шеф фулфилмент: FBS Monitor, TZ Generator |
| `procurement_chief_v1.gs` | AI-шеф закупок: заказы поставщикам, цены |
| `wb_api_client_v1.gs` | **Последний в цепочке**: реальные WB API-вызовы |

---

## Telegram-команды

### WB Operations

| Команда | Описание |
|---------|----------|
| `/wb_report` | Запустить полный WB-отчёт |
| `/wb_risks` | Критические риски |
| `/wb_sku` | Анализ SKU |
| `/wb_ads` | Рекламные кампании |
| `/wb_finance` | Финансовый отчёт |
| `/wb_stock` | Остатки на складах |
| `/wb_procurement` | Закупки Stage 1 |
| `/wb_stock_v2` | Расширенный анализ остатков (Stage 2) |
| `/wb_report_health` | Состояние отчётности + inconsistency check |
| `/wb_supply` | Поставки и рекомендации |

### CS Operations

| Команда | Описание |
|---------|----------|
| `/cs_run` | Запустить полный CS-отчёт |
| `/cs_reviews` | Необработанные отзывы |
| `/cs_questions` | Вопросы покупателей |
| `/cs_returns` | Анализ возвратов |
| `/cs_appeals` | Апелляции к WB |
| `/cs_issues` | Проблемные обращения |
| `/cs_knowledge` | База знаний (пробелы, шаблоны) |

### Proposals и дайджест

| Команда | Описание |
|---------|----------|
| `/pending` | Список ожидающих подтверждения |
| `/digest` | Дайджест proposals |
| `/expired` | Просроченные proposals |
| `/approve_all_low` | Подтвердить все low-risk proposals |

### Handoff Events

| Команда | Описание |
|---------|----------|
| `/handoffs` | Все pending handoffs |
| `/handoffs_wb` | Handoffs для WB Operations Chief |
| `/handoffs_cs` | Handoffs для CS Operations Chief |

### Планировщик

| Команда | Описание |
|---------|----------|
| `/scheduler_status` | Статус всех cron-заданий |
| `/scheduler_run <job>` | Запустить задание вручную |
| `/scheduler_logs` | Последние 10 запусков |

### QA

| Команда | Описание |
|---------|----------|
| `/qa_check` | Полный health check системы |
| `/qa_tables` | Только проверка таблиц |
| `/qa_calc` | Только smoke tests вычислений |

### Design Chief

| Команда | Описание |
|---------|----------|
| `/design` | Запустить Design Chief |
| `/design_handoffs` | Pending handoffs для дизайна |
| `/design_plan` | Контент-план (ожидают подтверждения) |

### ROP Chief

| Команда | Описание |
|---------|----------|
| `/rop` | Запустить ROP Chief |
| `/rop_handoffs` | Pending handoffs ROP |
| `/rop_kpi` | KPI-снимок за сегодня |
| `/rop_targets` | Активные цели и отклонения |

### Fulfillment Chief

| Команда | Описание |
|---------|----------|
| `/fulfillment` | Запустить Fulfillment Chief |
| `/fulfillment_handoffs` | Pending handoffs фулфилмент |
| `/fulfillment_tz` | ТЗ на поставку (ожидают подтверждения) |
| `/fulfillment_fbs` | FBS-остатки (critical + high urgency) |
| `/fulfillment_schedule` | График поставок |

### Procurement Chief

| Команда | Описание |
|---------|----------|
| `/procurement` | Запустить Procurement Chief |
| `/procurement_handoffs` | Pending handoffs закупки |
| `/procurement_orders` | Черновики заказов (ожидают подтверждения) |
| `/procurement_suppliers` | Список активных поставщиков |

---

## API-эндпоинты

### Общие

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/health` | Общий health check |
| POST | `/telegram/webhook` | Точка входа Telegram webhook |

### WB Operations

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/agent/wb/report/run` | Запустить WB-отчёт |
| GET | `/agent/wb/report/health` | Состояние отчётности |
| GET | `/agent/wb/api/health` | Проверка WB API |
| GET | `/agent/wb/api/prices?nm_ids=1,2,3` | Цены товаров |
| GET | `/agent/wb/api/commissions` | Комиссии WB |

### CS Operations

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/agent/cs/report/run` | Запустить CS-отчёт |
| POST | `/agent/cs/report/run/v2` | CS-отчёт V2 (новые агенты) |
| GET | `/agent/cs/appeals` | Список апелляций |
| GET | `/agent/cs/knowledge/gaps` | Пробелы в базе знаний |

### Proposals

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/agent/proposals/pending` | Ожидающие подтверждения |
| GET | `/agent/proposals/expired` | Просроченные |
| GET | `/agent/proposals/stats` | Статистика |
| POST | `/agent/proposals/digest` | Отправить дайджест |
| POST | `/agent/proposals/cleanup` | Истечь старые proposals |

### QA

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/agent/qa/check` | Полный health check |
| GET | `/agent/qa/tables` | Проверка таблиц |
| GET | `/agent/qa/schema` | Проверка схемы |
| GET | `/agent/qa/integrity` | Целостность данных |
| GET | `/agent/qa/calculations` | Smoke tests |
| GET | `/agent/qa/environment` | Переменные окружения |

### Handoffs

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/agent/handoffs` | Список handoffs |
| GET | `/agent/handoffs/stats` | Статистика |
| POST | `/agent/handoffs` | Создать handoff |
| POST | `/agent/handoffs/:id/acknowledge` | Подтвердить получение |
| POST | `/agent/handoffs/:id/resolve` | Закрыть handoff |
| POST | `/agent/handoffs/:id/dismiss` | Отклонить |
| POST | `/agent/handoffs/expire` | Истечь старые |

### Scheduler

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/agent/scheduler/status` | Статус заданий |
| GET | `/agent/scheduler/logs` | Журнал запусков |
| POST | `/agent/scheduler/run` | Запустить задание |
| POST | `/agent/scheduler/config` | Настроить задание |

### Design Chief

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/agent/design/report/run` | Запустить Design Chief |
| GET | `/agent/design/handoffs` | Handoffs дизайна |
| GET | `/agent/design/plan` | Контент-план |
| GET | `/agent/design/card/:nm_id` | Снимок карточки |

### ROP Chief

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/agent/rop/report/run` | Запустить ROP Chief |
| GET | `/agent/rop/handoffs` | Handoffs ROP |
| GET | `/agent/rop/kpi` | KPI-снимки |
| GET | `/agent/rop/targets` | Активные цели |
| POST | `/agent/rop/targets` | Создать цель |

### Fulfillment Chief

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/agent/fulfillment/report/run` | Запустить Fulfillment Chief |
| GET | `/agent/fulfillment/fbs` | FBS-снимки |
| GET | `/agent/fulfillment/tz` | ТЗ на поставку |
| GET | `/agent/fulfillment/schedule` | График поставок |
| POST | `/agent/fulfillment/tz/:id/confirm` | Подтвердить ТЗ |
| POST | `/agent/fulfillment/tz/:id/cancel` | Отменить ТЗ |

### Procurement Chief

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/agent/procurement/report/run` | Запустить Procurement Chief |
| GET | `/agent/procurement/handoffs` | Handoffs закупки |
| GET | `/agent/procurement/orders` | Черновики заказов |
| GET | `/agent/procurement/suppliers` | Список поставщиков |
| POST | `/agent/procurement/orders/:id/confirm` | Подтвердить заказ |
| POST | `/agent/procurement/orders/:id/cancel` | Отменить заказ |
| POST | `/agent/procurement/prices` | Добавить цену поставщика |

---

## Правила безопасности (встроены в код)

| Правило | Где проверяется |
|---------|----------------|
| Все рискованные действия: `requires_confirmation = 1` | Все chiefs |
| Все proposals имеют уникальный `confirmation_id` | Все chiefs |
| `source_status: 'missing'` при отсутствии данных (никогда не ноль) | Все data loaders |
| Нельзя автоматически менять рекламные ставки | WB Ads Control |
| Нельзя автоматически создавать поставки | Fulfillment Chief |
| Нельзя автоматически отправлять письма поставщикам | Procurement Chief |
| Нельзя автоматически согласовывать закупки | Procurement Chief |
| Нельзя автоматически отправлять ТЗ на фулфилмент | Fulfillment Chief |
| AI готовит черновик, человек подтверждает | CS Stage 1 |
| TZ-документы всегда `requires_confirmation = 1` | Fulfillment Chief |

---

## Troubleshooting

**Telegram webhook не срабатывает**

```bash
curl "https://api.telegram.org/bot{TOKEN}/getWebhookInfo"
```

Проверить что `secret_token` совпадает с `TELEGRAM_WEBHOOK_SECRET`.

**Ошибки D1 / таблица не найдена**

```bash
wrangler d1 execute ai-agents-db --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Если таблиц меньше 43 — запустить `schema.sql` или `migration.sql`.

**WB API не отвечает**

```
GET /agent/wb/api/health
```

Проверить что `WB_API_TOKEN` установлен и не истёк. При статусе `auth_failed` получить новый токен в личном кабинете WB.

**AI не отвечает, ответы пустые**

Worker автоматически пробует Gemini → Groq → static fallback. Проверить оба ключа:

```
GET /agent/qa/environment
```

**Дубли proposals**

Защита на уровне БД: `UNIQUE(confirmation_id)`. Дубли невозможны.

**Проверить работу всей системы**

```
GET /agent/qa/check
```

Показывает: таблицы, схему, целостность данных, переменные окружения.

**Живые логи**

```bash
wrangler tail
```
