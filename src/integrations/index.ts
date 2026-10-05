// Stage A19 — Integrations Layer v1
import { Env, generateId, now, maskSecret } from '../types';

export const INTEGRATION_DEFINITIONS = [
  { integration_key: 'telegram', name: 'Telegram Bot API', type: 'messaging' },
  { integration_key: 'planner', name: 'Planner API', type: 'productivity' },
  { integration_key: 'inbox_hub', name: 'Inbox Hub API', type: 'productivity' },
  { integration_key: 'wb_api', name: 'Wildberries API', type: 'marketplace' },
  { integration_key: 'google_sheets', name: 'Google Sheets', type: 'google' },
  { integration_key: 'google_drive', name: 'Google Drive', type: 'google' },
  { integration_key: 'gmail', name: 'Gmail', type: 'google' },
  { integration_key: 'openai', name: 'OpenAI / AI Provider', type: 'ai' },
  { integration_key: 'cloudflare_d1', name: 'Cloudflare D1', type: 'database' },
];

export async function seedIntegrations(db: D1Database) {
  for (const integration of INTEGRATION_DEFINITIONS) {
    await db.prepare(`
      INSERT OR IGNORE INTO agent_integrations (id, integration_key, name, type, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
    `).bind(generateId(), integration.integration_key, integration.name, integration.type).run();
  }
}

export async function getIntegrations(db: D1Database) {
  const r = await db.prepare('SELECT * FROM agent_integrations ORDER BY type, name').all();
  return r.results ?? [];
}

export async function checkIntegrationHealth(env: Env, integrationKey: string): Promise<{ status: 'ok' | 'degraded' | 'down'; latency_ms?: number; detail?: string }> {
  const start = Date.now();

  switch (integrationKey) {
    case 'telegram':
      if (!env.TELEGRAM_BOT_TOKEN) return { status: 'degraded', detail: 'TELEGRAM_BOT_TOKEN not configured' };
      return { status: 'ok', latency_ms: Date.now() - start, detail: 'Token present (not verified)' };

    case 'openai':
      if (!env.OPENAI_API_KEY) return { status: 'degraded', detail: 'OPENAI_API_KEY not configured' };
      return { status: 'ok', latency_ms: Date.now() - start, detail: 'Key present (not verified)' };

    case 'wb_api':
      if (!env.WB_API_TOKEN) return { status: 'degraded', detail: 'WB_API_TOKEN not configured' };
      return { status: 'ok', latency_ms: Date.now() - start, detail: 'Token present (not verified)' };

    case 'cloudflare_d1':
      if (!env.AGENT_DB) return { status: 'down', detail: 'AGENT_DB binding not configured' };
      return { status: 'ok', latency_ms: Date.now() - start, detail: 'D1 binding present' };

    case 'google_sheets':
    case 'google_drive':
    case 'gmail':
      if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return { status: 'degraded', detail: 'GOOGLE_SERVICE_ACCOUNT_JSON not configured' };
      return { status: 'ok', latency_ms: Date.now() - start, detail: 'Service account present (not verified)' };

    default:
      return { status: 'degraded', detail: `No health check implemented for ${integrationKey}` };
  }
}

// AI Provider Adapter — single interface for all AI models
export async function callAI(env: Env, prompt: string, systemPrompt?: string, model = 'gpt-4o-mini'): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    // Return mock response when no AI key configured
    return JSON.stringify({
      mock: true,
      message: 'AI provider not configured. This is a mock response.',
      prompt_preview: prompt.slice(0, 100),
    });
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: prompt },
      ],
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(30000), // 30s timeout
  });

  if (!response.ok) {
    throw new Error(`AI API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? '';
}

// Telegram integration
export async function sendTelegramMessage(env: Env, text: string, chatId?: string): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = chatId ?? env.TELEGRAM_CHAT_ID;

  if (!token || !chat) {
    console.log('[TELEGRAM MOCK]', text);
    return false; // mock
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function sendTelegramApprovalButtons(env: Env, text: string, actionId: string, chatId?: string): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = chatId ?? env.TELEGRAM_CHAT_ID;

  if (!token || !chat) {
    console.log('[TELEGRAM APPROVAL MOCK]', text, actionId);
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve:${actionId}` },
            { text: '❌ Reject', callback_data: `reject:${actionId}` },
          ]],
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
