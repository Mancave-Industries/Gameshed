import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, liveFixtures, OWNER_ID } from './harness.mjs';

const hash = value => createHash('sha256').update(value).digest('base64url');
const CHAT_CLIENT = 'https://chatgpt.com/oauth/client.json';

test('one GitHub sign-in stores the encrypted six-month refresh session', async t => {
  let exchanges = 0;
  const h = await createHarness({ oauthRefresh: form => {
    exchanges++;
    assert.equal(form.code, 'test-code');
    assert.equal(form.scope, undefined);
    return {
      access_token: 'ghu_initialaccess',
      expires_in: 28_800,
      refresh_token: 'ghr_initialrefresh',
      refresh_token_expires_in: 15_897_600,
    };
  } });
  t.after(h.restore);

  const login = await h.request('/auth/login', { method: 'POST' });
  assert.equal(login.status, 303);
  const authorize = new URL(login.headers.get('location'));
  const state = authorize.searchParams.get('state');
  assert.equal(authorize.searchParams.get('scope'), 'offline_access');
  const stateCookie = login.headers.getSetCookie().find(value => value.startsWith('__Host-alfred_oauth='));
  assert.ok(stateCookie);

  const callback = await h.request('/auth/callback?code=test-code&state=' + state, { headers: {
    Cookie: stateCookie.split(';')[0],
  } });
  assert.equal(callback.status, 303);
  assert.equal(exchanges, 1);
  const sessionCookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-alfred_session='));
  assert.match(sessionCookie, /Max-Age=15552000/);
  const session = sessionCookie.match(/^__Host-alfred_session=([^;]+)/)[1];
  assert.equal((await h.request('/api/workspace', { session })).status, 200);
});

test('expired GitHub access rotates once and keeps concurrent Alfred requests signed in', async t => {
  const repos = liveFixtures();
  const oldAccess = 'ghu_oldaccess';
  const newAccess = 'ghu_newaccess';
  repos.Gameshed.authResponses = {
    [oldAccess]: { status: 401 },
    [newAccess]: { user: { login: 'Mancave-Industries', id: OWNER_ID } },
  };
  let refreshes = 0;
  const h = await createHarness({ repos, oauthRefresh: async form => {
    refreshes++;
    assert.equal(form.grant_type, 'refresh_token');
    assert.equal(form.refresh_token, 'ghr_oldrefresh');
    assert.equal(form.client_id, 'Iv1.test');
    assert.equal(form.client_secret, 'test-secret');
    await wait(20);
    return {
      access_token: newAccess,
      expires_in: 28_800,
      refresh_token: 'ghr_newrefresh',
      refresh_token_expires_in: 15_897_600,
    };
  } });
  t.after(h.restore);
  const now = Date.now();
  const session = await h.signIn({
    version: 1,
    accessToken: oldAccess,
    accessExpiresAt: now - 1,
    refreshToken: 'ghr_oldrefresh',
    refreshExpiresAt: now + 15_897_600_000,
  }, { expiresAt: now + 15_552_000_000 });

  const responses = await Promise.all([
    h.request('/api/workspace', { session }),
    h.request('/api/workspace', { session }),
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(refreshes, 1, 'single-use GitHub refresh token was spent once');
  assert.equal((await h.request('/api/workspace', { session })).status, 200);
  assert.equal(refreshes, 1, 'fresh access token was reused');
  assert.deepEqual(h.blocked, []);
});

test('ChatGPT read-only connection rotates its own token without another consent screen', async t => {
  const h = await createHarness();
  t.after(h.restore);
  const session = await h.signIn();
  const oldRefresh = 'r'.repeat(43);
  const now = Date.now();
  h.db.prepare(
    'INSERT INTO chat_grants (id, session_id, phase, challenge, state, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(hash(oldRefresh), hash(session), 'refresh', '', '', now + 3600_000);

  const metadata = await h.request('/.well-known/oauth-authorization-server');
  assert.deepEqual(metadata.json.grant_types_supported, ['authorization_code', 'refresh_token']);

  const rotate = refresh => h.request('/chat/oauth/token', { method: 'POST', form: {
    client_id: CHAT_CLIENT,
    grant_type: 'refresh_token',
    refresh_token: refresh,
    resource: h.env.ALFRED_ORIGIN + '/mcp',
  } });
  const first = await rotate(oldRefresh);
  assert.equal(first.status, 200);
  assert.equal(first.json.expires_in, 21_600);
  assert.equal(first.json.refresh_token_expires_in, 15_552_000);
  assert.match(first.json.access_token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.json.refresh_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await rotate(oldRefresh)).json.error, 'invalid_grant', 'a refresh token cannot be replayed');

  const tools = await h.request('/mcp', { method: 'POST', headers: {
    Authorization: 'Bearer ' + first.json.access_token,
  }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(tools.status, 200);
  assert.equal(tools.json.result.tools[0].name, 'alfred_status');

  const second = await rotate(first.json.refresh_token);
  assert.equal(second.status, 200);
  assert.notEqual(second.json.access_token, first.json.access_token);
  const oldAccess = await h.request('/mcp', { method: 'POST', headers: {
    Authorization: 'Bearer ' + first.json.access_token,
  }, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  assert.equal(oldAccess.status, 401, 'rotation revokes the previous connector access token');
  const newAccess = await h.request('/mcp', { method: 'POST', headers: {
    Authorization: 'Bearer ' + second.json.access_token,
  }, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } });
  assert.equal(newAccess.status, 200);
});
