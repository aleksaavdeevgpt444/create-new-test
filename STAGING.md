# Local and staging readiness

Run `npm ci`, `npm run type-check`, `node tests/routes.mjs`, and
`npm run check:staging`. The last command bundles only; it does not deploy
or verify the remote database UUID.

Copy `.dev.vars.example` to `.dev.vars` for local development and set a
random `API_BEARER_TOKEN`. Leave external integration credentials empty
to keep the first run in mock mode. Start `npm run dev -- --local`.
All administrative requests, including Dashboard HTML and its API calls,
require `Authorization: Bearer <token>`. A plain browser navigation does
not attach this header; use an authenticated client or a trusted local
header injector. Do not put the token in URLs or client-side source.

Initialize only a disposable local database with authenticated
`POST /dev/ensure-schema`. GET now returns 405. Schema initialization and
cron tests write data. Check `/dev/schema-check`, `/dev/system-check`,
and `/dev/mvp-acceptance-check` after initialization. Existing dev checks
still contain declarative assertions and are not full acceptance tests.

Before staging deployment, replace the staging D1 placeholder with the
UUID of a separate test database. Set secrets on the staging Worker only:
API_BEARER_TOKEN is required; TELEGRAM_WEBHOOK_SECRET and TELEGRAM_OWNER_ID
are required if using the webhook. Configure Telegram's webhook secret
to match and use a test bot/chat. External integration secrets are optional
for mock tests; their presence does not verify API access.

Use `npm run deploy:staging` only when deployment is authorized. This
change does not deploy, set secrets, create D1, or complete remote tests.
WB and Google external actions remain mock-only. Cron is every five
minutes, so initialize the staging schema before relying on scheduled work.
