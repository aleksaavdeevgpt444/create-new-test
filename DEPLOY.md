# Руководство по развёртыванию

Проект: ИИ агенты-помощники  
Платформа: Cloudflare Workers + D1

---

## Шаг 1: Подготовка

Установить Wrangler CLI:

```bash
npm install -g wrangler
```

Авторизоваться в Cloudflare:

```bash
wrangler login
```

---

## Шаг 2: Создать D1 базу данных

```bash
wrangler d1 create ai-agents-db
```

Команда выведет строку вида:

```
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Скопировать значение `database_id` и вставить в `wrangler.toml` в секцию `[[d1_databases]]`.

---

## Шаг 3: Установить секреты

Обязательные секреты (без них Worker не запустится):

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put GEMINI_API_KEY
wrangler secret put GROQ_API_KEY
wrangler secret put INTERNAL_API_BASE
```

Необязательные секреты (переопределяют значения по умолчанию):

```bash
wrangler secret put GEMINI_CLASSIFICATION_MODEL  # по умолчанию: gemini-1.5-flash-latest
wrangler secret put GROQ_API_BASE               # по умолчанию: https://api.groq.com/openai/v1
wrangler secret put GROQ_MODEL                  # по умолчанию: llama3-8b-8192
wrangler secret put WB_API_TOKEN                # когда будет готова интеграция WB API
```

---

## Шаг 4: Деплой

```bash
wrangler deploy
```

Для деплоя в staging-окружение:

```bash
wrangler deploy --env staging
```

---

## Шаг 5: Подключить Telegram Webhook

Заменить `{TOKEN}`, `YOUR_SUBDOMAIN` и `YOUR_WEBHOOK_SECRET` на реальные значения:

```bash
curl -X POST "https://api.telegram.org/bot{TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://ai-agents-worker.YOUR_SUBDOMAIN.workers.dev/telegram/webhook",
    "secret_token": "YOUR_WEBHOOK_SECRET",
    "allowed_updates": ["message", "callback_query"]
  }'
```

---

## Шаг 6: Проверить работу

Общий health check:

```
GET https://YOUR_WORKER.workers.dev/health
```

Health checks по агентам:

```
GET https://YOUR_WORKER.workers.dev/agent/wb/health
GET https://YOUR_WORKER.workers.dev/agent/cs/health
GET https://YOUR_WORKER.workers.dev/agent/proposals/stats
```

---

## Шаг 7: Первый запуск

```bash
# Проверить схему БД (создаётся автоматически при первом запросе)
curl https://YOUR_WORKER.workers.dev/agent/wb/health

# Запустить первый отчёт WB
curl -X POST https://YOUR_WORKER.workers.dev/agent/wb/report/run \
  -H "Content-Type: application/json" \
  -d '{"user_id": "YOUR_TELEGRAM_USER_ID"}'

# Запустить первый отчёт CS
curl -X POST https://YOUR_WORKER.workers.dev/agent/cs/report/run \
  -H "Content-Type: application/json" \
  -d '{"user_id": "YOUR_TELEGRAM_USER_ID"}'
```

---

## Структура файлов проекта

| Файл | Содержимое |
|------|------------|
| `worker.js` | Главный Worker — маршрутизация запросов, Telegram webhook |
| `wb_operations_stage1_v1.gs` | WB агент: базовые операции, отчёты, риски |
| `wb_operations_stage2_v1.gs` | WB агент: расширенные операции, закупки, реклама |
| `wb_operations_stage2_patch.gs` | Патч к WB stage 2 |
| `wb_ops_router_patch.gs` | Патч маршрутизатора WB операций |
| `cs_operations_stage1_v1.gs` | CS агент: отзывы, вопросы, апелляции |
| `cs_operations_stage2_v1.gs` | CS агент: шаблоны ответов, база знаний |
| `stage336_349_agent_extension.gs` | Расширение агента (proposals, digest) |
| `stage336_349_router_patch.gs` | Патч маршрутизатора для proposals |
| `wrangler.toml` | Конфигурация Cloudflare Workers |

---

## Переменные окружения

| Переменная | Обязательная | По умолчанию | Описание |
|------------|:------------:|--------------|----------|
| `TELEGRAM_BOT_TOKEN` | да | — | Токен бота Telegram от @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | да | — | Секрет для проверки подписи webhook |
| `GEMINI_API_KEY` | да | — | API-ключ Google Gemini (основной AI) |
| `GROQ_API_KEY` | да | — | API-ключ Groq (резервный AI) |
| `INTERNAL_API_BASE` | да | — | Базовый URL внутреннего backend API |
| `GEMINI_CLASSIFICATION_MODEL` | нет | `gemini-1.5-flash-latest` | Модель Gemini для классификации |
| `GROQ_API_BASE` | нет | `https://api.groq.com/openai/v1` | Базовый URL Groq API |
| `GROQ_MODEL` | нет | `llama3-8b-8192` | Модель Groq для генерации |
| `WB_API_TOKEN` | нет | — | Токен Wildberries API |

---

## Telegram-команды

### WB агент (Wildberries)

| Команда | Описание |
|---------|----------|
| `/wb_today` | Сводка за сегодня |
| `/wb_run` | Запустить полный WB-отчёт |
| `/wb_risks` | Отчёт по рискам |
| `/wb_sku` | Анализ SKU |
| `/wb_ads` | Состояние рекламных кампаний |
| `/wb_finance` | Финансовый отчёт |
| `/wb_stock` | Остатки на складах |
| `/wb_tasks` | Текущие задачи |
| `/wb_procurement` | Отчёт по закупкам |
| `/wb_stock_v2` | Расширенный анализ остатков |
| `/wb_report_health` | Проверка состояния отчётности |
| `/wb_supply` | Поставки и планирование |

### CS агент (клиентский сервис)

| Команда | Описание |
|---------|----------|
| `/cs_today` | Сводка по CS за сегодня |
| `/cs_reviews` | Необработанные отзывы |
| `/cs_questions` | Вопросы покупателей |
| `/cs_returns` | Возвраты |
| `/cs_appeals` | Апелляции |
| `/cs_issues` | Проблемные обращения |
| `/cs_templates` | Шаблоны ответов |
| `/cs_run` | Запустить полный CS-отчёт |
| `/cs_knowledge` | База знаний |

### Proposals и дайджест

| Команда | Описание |
|---------|----------|
| `/pending` | Список ожидающих подтверждения proposals |
| `/digest` | Дайджест за период |
| `/expired` | Просроченные proposals |
| `/approve_all_low` | Подтвердить все proposals с низким риском |

---

## API эндпоинты

### Общие

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/health` | Общий health check |
| POST | `/telegram/webhook` | Точка входа Telegram webhook |

### WB агент

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/agent/wb/health` | Health check WB агента |
| POST | `/agent/wb/report/run` | Запустить WB-отчёт |
| GET | `/agent/wb/risks` | Получить список рисков |
| GET | `/agent/wb/sku` | Данные по SKU |
| GET | `/agent/wb/ads` | Данные по рекламе |
| GET | `/agent/wb/finance` | Финансовые данные |
| GET | `/agent/wb/stock` | Данные по остаткам |
| GET | `/agent/wb/procurement` | Данные по закупкам |
| GET | `/agent/wb/supply` | Данные по поставкам |

### CS агент

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/agent/cs/health` | Health check CS агента |
| POST | `/agent/cs/report/run` | Запустить CS-отчёт |
| GET | `/agent/cs/reviews` | Список отзывов |
| GET | `/agent/cs/questions` | Список вопросов |
| GET | `/agent/cs/returns` | Список возвратов |
| GET | `/agent/cs/appeals` | Список апелляций |

### Proposals

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/agent/proposals/stats` | Статистика по proposals |
| GET | `/agent/proposals/pending` | Ожидающие подтверждения |
| POST | `/agent/proposals/approve` | Подтвердить proposal |
| POST | `/agent/proposals/reject` | Отклонить proposal |
| GET | `/agent/proposals/expired` | Просроченные proposals |

---

## Безопасность

- Никаких автоматических действий без `confirmation_id` — все изменяющие операции требуют явного подтверждения.
- Все ответы покупателям отправляются только после подтверждения пользователем через proposal.
- Изменения рекламных ставок проходят только через механизм proposals.
- Закупки инициируются только через proposals — автоматических закупок нет.

---

## Troubleshooting

**Telegram webhook не срабатывает**

Проверить, что `TELEGRAM_WEBHOOK_SECRET` совпадает со значением `secret_token`, переданным при регистрации webhook. Проверить статус webhook:

```bash
curl "https://api.telegram.org/bot{TOKEN}/getWebhookInfo"
```

**Ошибки D1**

Проверить доступность базы данных:

```bash
wrangler d1 execute ai-agents-db --command "SELECT 1"
```

Убедиться, что `database_id` в `wrangler.toml` совпадает с ID базы в Cloudflare Dashboard.

**AI не отвечает**

Проверить `GEMINI_API_KEY`. Если Gemini недоступен — Worker автоматически переключается на Groq. Проверить `GROQ_API_KEY` и значение `GROQ_MODEL`.

**Дублирующиеся proposals**

Защита обеспечивается автоматически: на поле `confirmation_id` стоит ограничение `UNIQUE`. Дубли на уровне базы данных невозможны.

**Просмотр живых логов**

```bash
wrangler tail
```

**Локальная разработка**

```bash
wrangler dev
```
