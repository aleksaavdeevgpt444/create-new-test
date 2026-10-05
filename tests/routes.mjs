import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({entryPoints: ['src/router.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
const {handleRequest} = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
const auth = {Authorization: 'Bearer test'};
async function check(path, env, status, options = {}) {
  const response = await handleRequest(new Request('http://local' + path, options), env);
  assert.equal(response.status, status, path);
  return response;
}
await check('/health', {}, 200);
await check('/agents', {}, 503);
await check('/agents', {API_BEARER_TOKEN: 'test'}, 401);
await check('/dev/ensure-schema', {API_BEARER_TOKEN: 'test'}, 405, {headers: auth});
await check('/telegram/webhook', {}, 503, {method: 'POST'});
await check('/telegram/webhook', {TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_OWNER_ID: '123'}, 401, {method: 'POST'});
await check('/telegram/webhook', {TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_OWNER_ID: '123', AGENT_DB: {}}, 403, {
  method: 'POST', headers: {'X-Telegram-Bot-Api-Secret-Token': 'secret'},
  body: JSON.stringify({message: {from: {id: 999}, text: 'hello'}})
});
const db = {prepare: () => ({first: async () => ({c: 12})})};
const acceptance = await check('/dev/mvp-acceptance-check', {API_BEARER_TOKEN: 'test', AGENT_DB: db}, 200, {headers: auth});
assert.equal((await acceptance.json()).module, 'mvp_acceptance');
const system = await check('/dev/system-check', {API_BEARER_TOKEN: 'test'}, 500, {headers: auth});
assert.equal((await system.json()).ok, false);
console.log('9 route regression checks passed');
