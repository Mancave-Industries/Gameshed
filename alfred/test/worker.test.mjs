import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, liveFixtures, OSMOSIS_RESULT } from './harness.mjs';

const EVENT = '<!-- alfred-workflow-event:v1 -->\n';
const lastEvent = h => JSON.parse(h.comments(4).at(-1).body.slice(EVENT.length));

async function setup(options) {
  const h = await createHarness(options);
  const session = await h.signIn();
  return { h, session };
}

test('workspace requires sign-in', async t => {
  const h = await createHarness();
  t.after(h.restore);
  const response = await h.request('/api/workspace');
  assert.equal(response.status, 401);
});

test('workspace reflects the live records: #3 awaiting a check, #4 awaiting a decision', async t => {
  const { h, session } = await setup();
  t.after(h.restore);
  const { status, json } = await h.request('/api/workspace', { session });
  assert.equal(status, 200);
  const byNumber = Object.fromEntries(json.workflows.map(w => [w.number, w]));
  assert.deepEqual(Object.keys(byNumber).map(Number).sort(), [3, 4], 'issue #1 is not a workflow');
  assert.equal(byNumber[3].status, 'completed');
  assert.equal(byNumber[3].choice, 'osmosis');
  assert.equal(byNumber[3].result, OSMOSIS_RESULT);
  assert.deepEqual(byNumber[3].events.map(e => e.type), ['choice', 'started', 'completed']);
  assert.equal(byNumber[4].status, 'decision');
  assert.equal(json.projects.length, 4);
  assert.equal(json.projects.find(p => p.id === 'songbook-hold').decision.choice, null);
  assert.equal(json.claude.askReady, false);
  assert.deepEqual(h.blocked, []);
});

test('approving writes the exact choice event the ChatGPT executor reads', async t => {
  const { h, session } = await setup();
  t.after(h.restore);
  const option = JSON.parse(liveFixtures().Gameshed.issues[2].body.split('\n').slice(1).join('\n')).options[0];
  const { status, json } = await h.request('/api/workflows/4/choice', { method: 'POST', session, body: option.id ? { option: option.id, label: option.label, detail: option.detail } : {} });
  assert.equal(status, 200);
  assert.equal(json.workflow.status, 'queued');
  const body = h.comments(4).at(-1).body;
  assert.ok(body.startsWith(EVENT), 'event marker on its own line');
  assert.deepEqual(JSON.parse(body.slice(EVENT.length)), { type: 'choice', option: option.id, label: option.label, detail: option.detail });
  // A second, different choice is refused once one is recorded.
  const other = JSON.parse(liveFixtures().Gameshed.issues[2].body.split('\n').slice(1).join('\n')).options[1];
  const again = await h.request('/api/workflows/4/choice', { method: 'POST', session, body: { option: other.id, label: other.label, detail: other.detail } });
  assert.equal(again.status, 409);
  assert.equal(h.comments(4).length, 1);
});

test('decide later records a defer event and keeps the decision open', async t => {
  const { h, session } = await setup();
  t.after(h.restore);
  const { json } = await h.request('/api/workflows/4/choice', { method: 'POST', session, body: { option: 'defer' } });
  assert.equal(json.workflow.status, 'deferred');
  assert.deepEqual(lastEvent(h), { type: 'choice', option: 'defer' });
});

test('full loop: approve → started → completed → verified, with the executor protocol unchanged', async t => {
  const { h, session } = await setup();
  t.after(h.restore);
  const options = JSON.parse(liveFixtures().Gameshed.issues[2].body.split('\n').slice(1).join('\n')).options;
  const chosen = await h.request('/api/workflows/4/choice', { method: 'POST', session, body: { option: options[0].id, label: options[0].label, detail: options[0].detail } });
  const decisionId = chosen.json.workflow.decisionId;
  // Simulate the scheduled executor posting its usual events.
  h.comments(4).push({ id: decisionId + 10, body: EVENT + JSON.stringify({ type: 'started', decisionId }), created_at: '2026-11-11T10:00:00Z' });
  h.comments(4).push({ id: decisionId + 11, body: EVENT + JSON.stringify({ type: 'completed', decisionId, result: 'Wording tightened in a draft PR. Regression checks pass.' }), created_at: '2026-11-11T10:30:00Z' });
  let state = (await h.request('/api/workspace', { session })).json.workflows.find(w => w.number === 4);
  assert.equal(state.status, 'completed');

  const verify = await h.request('/api/workflows/4/verify', { method: 'POST', session, body: { verdict: 'verified' } });
  assert.equal(verify.status, 200);
  assert.equal(verify.json.workflow.status, 'verified');
  assert.deepEqual(lastEvent(h), { type: 'verified', decisionId, by: 'owner' });
  assert.deepEqual(verify.json.workflow.events.map(e => e.type), ['choice', 'started', 'completed', 'verified']);
  // Idempotent.
  const repeat = await h.request('/api/workflows/4/verify', { method: 'POST', session, body: { verdict: 'verified' } });
  assert.equal(repeat.status, 200);
  assert.equal(h.comments(4).filter(c => c.body.includes('"verified"')).length, 1);
  state = (await h.request('/api/workspace', { session })).json.workflows.find(w => w.number === 4);
  assert.equal(state.verification.by, 'owner');
});

test('sending a result back needs a note, records it, and rework can restart', async t => {
  const { h, session } = await setup();
  t.after(h.restore);
  const noNote = await h.request('/api/workflows/3/verify', { method: 'POST', session, body: { verdict: 'verification_failed' } });
  assert.equal(noNote.status, 400);
  const sent = await h.request('/api/workflows/3/verify', { method: 'POST', session, body: { verdict: 'verification_failed', note: 'The iPhone check is still missing.' } });
  assert.equal(sent.json.workflow.status, 'verification_failed');
  assert.equal(sent.json.workflow.verification.note, 'The iPhone check is still missing.');
  const decisionId = 6772342268;
  h.comments(3).push({ id: 7_100_000_000, body: EVENT + JSON.stringify({ type: 'started', decisionId }), created_at: '2026-11-12T08:00:00Z' });
  const state = (await h.request('/api/workspace', { session })).json.workflows.find(w => w.number === 3);
  assert.equal(state.status, 'running');
});

test('an executor-side check (verifying → verified) is understood', async t => {
  const { h, session } = await setup();
  t.after(h.restore);
  const decisionId = 6772342268;
  h.comments(3).push({ id: 7_100_000_001, body: EVENT + JSON.stringify({ type: 'verifying', decisionId }), created_at: '2026-11-11T09:00:00Z' });
  let state = (await h.request('/api/workspace', { session })).json.workflows.find(w => w.number === 3);
  assert.equal(state.status, 'verifying');
  h.comments(3).push({ id: 7_100_000_002, body: EVENT + JSON.stringify({ type: 'verified', decisionId, result: 'Re-ran the curriculum checks: all pass.' }), created_at: '2026-11-11T09:05:00Z' });
  state = (await h.request('/api/workspace', { session })).json.workflows.find(w => w.number === 3);
  assert.equal(state.status, 'verified');
  assert.equal(state.verification.by, 'alfred');
});

test('verification is refused unless a result is waiting, and ignores forged or out-of-order events', async t => {
  const { h, session } = await setup();
  t.after(h.restore);
  const early = await h.request('/api/workflows/4/verify', { method: 'POST', session, body: { verdict: 'verified' } });
  assert.equal(early.status, 409);
  // Event from another account and an event for the wrong decision are ignored.
  h.comments(3).push({ id: 7_100_000_003, user: { id: 1, login: 'someone' }, body: EVENT + JSON.stringify({ type: 'verified', decisionId: 6772342268 }) });
  h.comments(3).push({ id: 7_100_000_004, body: EVENT + JSON.stringify({ type: 'verified', decisionId: 123 }) });
  const state = (await h.request('/api/workspace', { session })).json.workflows.find(w => w.number === 3);
  assert.equal(state.status, 'completed');
});

test('closed workflows appear in history but cannot be changed', async t => {
  const repos = liveFixtures();
  repos.Gameshed.issues[1].state = 'closed';
  const { h, session } = await setup({ repos });
  t.after(h.restore);
  const workflow = (await h.request('/api/workspace', { session })).json.workflows.find(w => w.number === 3);
  assert.equal(workflow.open, false);
  const verify = await h.request('/api/workflows/3/verify', { method: 'POST', session, body: { verdict: 'verified' } });
  assert.equal(verify.status, 404);
});

test('writes are protected: wrong origin, wrong content type, signed out', async t => {
  const { h, session } = await setup();
  t.after(h.restore);
  assert.equal((await h.request('/api/workflows/3/verify', { method: 'POST', session, body: { verdict: 'verified' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await h.request('/api/workflows/3/verify', { method: 'POST', session, body: { verdict: 'verified' }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await h.request('/api/workflows/3/verify', { method: 'POST', body: { verdict: 'verified' } })).status, 401);
  assert.equal(h.comments(3).length, 4);
});

test('legacy project decisions still record YES / NO / DEFER', async t => {
  const { h, session } = await setup();
  t.after(h.restore);
  const { status, json } = await h.request('/api/decisions/songbook-hold', { method: 'POST', session, body: { choice: 'DEFER' } });
  assert.equal(status, 200);
  assert.equal(json.decision.choice, 'DEFER');
  assert.match(h.repos['risk-assessment-songbook'].issues[0].body, /^Answer: DEFER$/m);
});

test('the ChatGPT chat endpoint still requires OAuth', async t => {
  const { h } = await setup();
  t.after(h.restore);
  const response = await h.request('/mcp', { method: 'POST', body: {} });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
});

test('no outbound request leaves the harness and Claude is never called without a key', async t => {
  const { h, session } = await setup();
  t.after(h.restore);
  await h.request('/api/workspace', { session });
  const ask = await h.request('/api/ask', { method: 'POST', session, body: { question: 'What next?' } });
  assert.equal(ask.status, 503);
  assert.deepEqual(h.blocked, []);
  assert.deepEqual(h.anthropicCalls, []);
});
