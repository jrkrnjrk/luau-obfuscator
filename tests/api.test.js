import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openAccounts } from '../server/accounts.js';
import { createApp } from '../server/app.js';

let server;
let base;
let adminCookie;
let accounts;
before(async () => {
  accounts = openAccounts(':memory:');
  adminCookie = `veil_session=${encodeURIComponent(accounts.issueSession('leo'))}`;
  server = createApp({ accounts }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function post(body, extra = {}) {
  return fetch(`${base}/api/obfuscate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie, ...extra },
    body: JSON.stringify(body),
  });
}

test('obfuscation requires a signed-in account with credits', async () => {
  const anonymous = await fetch(`${base}/api/obfuscate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'return 1' }),
  });
  assert.equal(anonymous.status, 401);

  const registered = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ada_user', password: 'test-pass-1' }),
  });
  assert.equal(registered.status, 201);
  const adaCookie = registered.headers.get('set-cookie').split(';')[0];
  const broke = await fetch(`${base}/api/obfuscate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adaCookie },
    body: JSON.stringify({ source: 'return 1' }),
  });
  assert.equal(broke.status, 402);

  const granted = await fetch(`${base}/api/admin/credits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ username: 'ada_user', delta: 1 }),
  });
  assert.equal(granted.status, 200);
  const paid = await fetch(`${base}/api/obfuscate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adaCookie },
    body: JSON.stringify({ source: 'return 1' }),
  });
  assert.equal(paid.status, 200);
  const me = await fetch(`${base}/api/me`, { headers: { Cookie: adaCookie } });
  assert.equal((await me.json()).user.credits, 0);

  const banned = await fetch(`${base}/api/admin/ban`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ username: 'ada_user', banned: true }),
  });
  assert.equal(banned.status, 200);
  const denied = await fetch(`${base}/api/me`, { headers: { Cookie: adaCookie } });
  assert.equal(denied.status, 401);
  const outsider = await fetch(`${base}/api/admin/users`, { headers: { Cookie: adaCookie } });
  assert.equal(outsider.status, 401);
});

test('health endpoint reports an available engine', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('API returns compiler-validated output and statistics', async () => {
  const response = await post({ source: 'local value="hi"; return value' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.stats.virtualized, 1);
  assert.equal(result.stats.renamedLocals, 1);
  assert.equal(result.stats.encodedStrings, 1);
  assert.ok(!result.code.includes('local value'));
  assert.equal(typeof result.code, 'string');
  assert.ok(Array.isArray(result.warnings));
});

test('user code is compiled, never executed', async () => {
  const response = await post({ source: 'while true do end' });
  assert.equal(response.status, 200);
});

test('bad syntax returns an explicit error, not output', async () => {
  const response = await post({ source: 'local = ?' });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /syntax error/);
  assert.ok(!('code' in data));
});

test('input limits, malformed JSON, options, and origins are enforced', async () => {
  assert.equal((await post({ source: '' })).status, 400);
  assert.equal((await post({ source: '--' + 'a'.repeat(256 * 1024) })).status, 413);
  assert.equal((await post({ source: 'return 1', options: { minify: 'yes' } })).status, 400);
  assert.equal((await post({ source: 'return 1' }, { Origin: 'https://example.invalid' })).status, 403);
  const malformed = await fetch(`${base}/api/obfuscate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /Invalid JSON/);
});

test('API keys authenticate obfuscation and can be revoked', async () => {
  const registered = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'key_user', password: 'test-pass-1' }),
  });
  const cookie = registered.headers.get('set-cookie').split(';')[0];
  const created = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'ci' }),
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.match(body.key.key, /^veil_/);
  const listed = await fetch(`${base}/api/keys`, { headers: { Cookie: cookie } });
  const keys = (await listed.json()).keys;
  assert.equal(keys[0].prefix, body.key.prefix);
  assert.equal('key' in keys[0], false);
  assert.equal((await fetch(`${base}/api/keys`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/users`, { headers: { Authorization: `Bearer ${body.key.key}` } })).status, 401);

  await fetch(`${base}/api/admin/credits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ username: 'key_user', delta: 1 }),
  });
  const paid = await fetch(`${base}/api/obfuscate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${body.key.key}`, Origin: 'https://example.invalid' },
    body: JSON.stringify({ source: 'return 1', options: { virtualize: false } }),
  });
  assert.equal(paid.status, 200);
  const again = await fetch(`${base}/api/obfuscate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': body.key.key },
    body: JSON.stringify({ source: 'return 1', options: { virtualize: false } }),
  });
  assert.equal(again.status, 402);

  const revoked = await fetch(`${base}/api/keys`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: body.key.id }),
  });
  assert.equal(revoked.status, 200);
  const dead = await fetch(`${base}/api/obfuscate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${body.key.key}` },
    body: JSON.stringify({ source: 'return 1', options: { virtualize: false } }),
  });
  assert.equal(dead.status, 401);
});
