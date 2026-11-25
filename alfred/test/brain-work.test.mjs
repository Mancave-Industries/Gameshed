import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

test('captured work produces a private, saved Claude work product exactly once', async t => {
  const h = await createHarness({ anthropic: async () => Response.json({
    content: [{ type: 'text', text: JSON.stringify({ status: 'ready', result: 'Drafted poster copy for the festival.', nextStep: '' }) }],
    usage: { input_tokens: 500, output_tokens: 100 },
    stop_reason: 'end_turn',
  }) });
  t.after(h.restore);
  const session = await h.signIn();
  const capture = await h.request('/api/brain/capture', { method: 'POST', session,
    body: { title: 'Draft a short poster tagline for a candle market stall' } });
  assert.equal(capture.status, 201);
  const id = capture.json.item.id;
  assert.equal((await h.request('/api/brain/items/' + id + '/work', { method: 'POST', session,
    body: { confirmCostMicrousd: 1 } })).status, 400, 'No call without the exact cost approval');
  assert.equal(h.anthropicCalls.length, 0);
  const worked = await h.request('/api/brain/items/' + id + '/work', { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } });
  assert.equal(worked.status, 200);
  assert.equal(worked.json.work.status, 'ready');
  assert.match(worked.json.work.result, /Drafted poster copy/);
  assert.equal(h.anthropicCalls.length, 1);
  const inbox = (await h.request('/api/workspace', { session })).json.inbox;
  assert.equal(inbox[0].work.status, 'ready', 'Saved result persists into workspace');
  assert.equal(h.db.prepare('SELECT committed_microusd FROM ask_alfred_budget WHERE id=1').get().committed_microusd, 1000);
  const again = await h.request('/api/brain/items/' + id + '/work', { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } });
  assert.equal(again.json.work.status, 'ready');
  assert.equal(h.anthropicCalls.length, 1, 'A second click must not spend again');
  assert.ok(!h.githubLog.some(x => x.startsWith('POST /repos/')), 'User notes and results stay out of public GitHub issues');
});

test('captured work accepts a valid JSON result wrapped by Claude in Markdown', async t => {
  const h = await createHarness({ anthropic: async () => Response.json({
    content: [{ type: 'text', text: 'Here is the completed work:\n```json\n' + JSON.stringify({
      status: 'ready', result: 'A concise project update.', nextStep: '',
    }) + '\n```' }],
    usage: { input_tokens: 200, output_tokens: 60 },
    stop_reason: 'end_turn',
  }) });
  t.after(h.restore);
  const session = await h.signIn();
  const capture = await h.request('/api/brain/capture', { method: 'POST', session,
    body: { title: 'Write a concise project update.' } });
  const path = '/api/brain/items/' + capture.json.item.id + '/work';
  const worked = await h.request(path, { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } });
  assert.equal(worked.json.work.status, 'ready');
  assert.equal(worked.json.work.result, 'A concise project update.');
  const again = await h.request(path, { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } });
  assert.equal(again.json.work.status, 'ready');
  assert.equal(h.anthropicCalls.length, 1, 'Recovered output must still be charged and saved only once');
});

test('invalid model text remains locked and is never submitted twice', async t => {
  const h = await createHarness({ anthropic: async () => Response.json({
    content: [{ type: 'text', text: 'I could not produce the requested object.' }],
    usage: { input_tokens: 100, output_tokens: 20 },
    stop_reason: 'end_turn',
  }) });
  t.after(h.restore);
  const session = await h.signIn();
  const capture = await h.request('/api/brain/capture', { method: 'POST', session,
    body: { title: 'Write a concise project update.' } });
  const path = '/api/brain/items/' + capture.json.item.id + '/work';
  const first = await h.request(path, { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } });
  assert.equal(first.json.work.status, 'unconfirmed');
  const second = await h.request(path, { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } });
  assert.equal(second.json.work.status, 'unconfirmed');
  assert.equal(h.anthropicCalls.length, 1);
});

test('project status and architecture requests are delivered locally without another model call', async t => {
  const h = await createHarness({ anthropic: async () => { throw new Error('Local work must not call Claude'); } });
  t.after(h.restore);
  const session = await h.signIn();
  const statusCapture = await h.request('/api/brain/capture', { method: 'POST', session,
    body: { title: 'List my projects and their status' } });
  const status = await h.request('/api/brain/items/' + statusCapture.json.item.id + '/work', { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } });
  assert.equal(status.json.work.status, 'ready');
  assert.match(status.json.work.result, /Alfred/);
  assert.match(status.json.work.result, /The Deceivers — Development paused/);

  await h.request('/api/brain/capture', { method: 'POST', session,
    body: { title: '<script>alert("not visual content")</script>' } });

  const mapCapture = await h.request('/api/brain/capture', { method: 'POST', session,
    body: { title: 'Present a mind map of all my projects, the architecture and the API connectors' } });
  const map = await h.request('/api/brain/items/' + mapCapture.json.item.id + '/work', { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } });
  assert.equal(map.json.work.status, 'ready');
  assert.match(map.json.work.result, /alfred-mindmap:v1/);
  assert.match(map.json.work.result, /GitHub OAuth/);
  assert.match(map.json.work.result, /Anthropic Messages API/);
  assert.match(map.json.work.result, /Cloudflare Pages, Workers and D1/);
  const visualPath = '/deliverables/mind-map/' + mapCapture.json.item.id + '.svg';
  const signedOutVisual = await h.request(visualPath);
  assert.equal(signedOutVisual.status, 401, 'Private visual requires the owner session');
  const visual = await h.request(visualPath, { session });
  assert.equal(visual.status, 200);
  assert.match(visual.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(visual.headers.get('content-disposition'), /inline; filename="alfred-mind-map\.svg"/);
  assert.match(visual.text, /<svg/);
  assert.match(visual.text, /<path/);
  assert.match(visual.text, /Your Alfred map/);
  assert.match(visual.text, /GitHub OAuth and REST API/);
  assert.doesNotMatch(visual.text, /<script>/i);
  assert.match(visual.text, /&lt;script&gt;/);
  assert.equal(h.anthropicCalls.length, 0);
  assert.equal(h.db.prepare('SELECT committed_microusd FROM ask_alfred_budget WHERE id=1').get().committed_microusd, 0);
});

test('an Alfred build sentence creates one exact bounded runner proposal without spending', async t => {
  const h = await createHarness({ anthropic: async () => { throw new Error('A build request must use the runner'); } });
  t.after(h.restore);
  const session = await h.signIn();
  const capture = await h.request('/api/brain/capture', { method: 'POST', session,
    body: { title: 'Build a new Alfred voice mode feature in the app' } });
  const worked = await h.request('/api/brain/items/' + capture.json.item.id + '/work', { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } });
  assert.equal(worked.status, 200);
  assert.equal(worked.json.work.status, 'ready');
  assert.match(worked.json.work.result, /prepared build request/);
  assert.match(worked.json.work.result, /No code changed and no paid call started/);
  const issue = h.repos.Gameshed.issues.at(-1);
  assert.match(issue.title, /^\[Alfred workflow\] Build Alfred:/);
  const proposal = JSON.parse(issue.body.split('\n').slice(1).join('\n'));
  assert.equal(proposal.project, 'Alfred');
  assert.equal(proposal.options[0].execution.repo, 'Gameshed');
  assert.equal(proposal.options[0].execution.sha, 'a'.repeat(40));
  assert.deepEqual(proposal.options[0].execution.paths, ['alfred/public/app.js']);
  assert.equal(proposal.options[0].execution.profile, 'alfred-node');
  assert.equal(proposal.options[0].execution.maxMicrousd, 200000);
  assert.equal(h.anthropicCalls.length, 0);
  assert.equal(h.db.prepare('SELECT committed_microusd FROM ask_alfred_budget WHERE id=1').get().committed_microusd, 0);
  const again = await h.request('/api/brain/items/' + capture.json.item.id + '/work', { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } });
  assert.equal(again.json.work.status, 'ready');
  assert.equal(h.repos.Gameshed.issues.filter(candidate => candidate.title === issue.title).length, 1);
});

test('existing failed status and mind-map captures recover on refresh without inference', async t => {
  const h = await createHarness({ anthropic: async () => { throw new Error('Recovery must not call Claude'); } });
  t.after(h.restore);
  const session = await h.signIn();
  await h.request('/api/workspace', { session });
  const now = new Date().toISOString();
  for (const [id, title] of [
    ['failed-status', 'List my projects and their status'],
    ['failed-map', 'I need you to present a mind map of all my projects all of the architecture and the api connectors etc'],
  ]) {
    h.db.prepare("INSERT INTO brain_items (id,kind,title,detail,project_id,status,created_at) VALUES (?,'note',?,'',NULL,'open',?)")
      .run(id, title, now);
    h.db.prepare("INSERT INTO brain_work (note_id,status,result,next_step,updated_at) VALUES (?,'unconfirmed','','Claude returned no valid work product.',?)")
      .run(id, now);
  }
  h.db.prepare("INSERT INTO brain_items (id,kind,title,detail,project_id,status,created_at) VALUES (?,'note',?,'',NULL,'open',?)")
    .run('blocked-map', 'Mind map visual for all of this so I can avoid forgetting my ideas', now);
  h.db.prepare("INSERT INTO brain_work (note_id,status,result,next_step,updated_at) VALUES (?,'blocked',?,?,?)")
    .run('blocked-map', '', 'Share the ideas or content you want organised.', now);
  const inbox = (await h.request('/api/workspace', { session })).json.inbox;
  assert.equal(inbox.length, 3);
  assert.ok(inbox.every(item => item.work.status === 'ready'));
  assert.match(inbox.find(item => item.id === 'failed-status').work.result, /Science Buddy/);
  assert.match(inbox.find(item => item.id === 'failed-map').work.result, /GitHub Actions OIDC/);
  assert.match(inbox.find(item => item.id === 'blocked-map').work.result, /alfred-mindmap:v1/);
  assert.equal(h.anthropicCalls.length, 0);
});

test('Panini-Me plugin task reports unsupported external modification without pretending to execute', async t => {
  const h = await createHarness({ anthropic: async () => { throw new Error('This must never run'); } });
  t.after(h.restore);
  const session = await h.signIn();
  const capture = await h.request('/api/brain/capture', { method: 'POST', session,
    body: { title: 'Panini me - last few EFL updates' } });
  const id = capture.json.item.id;
  const done = await h.request('/api/brain/items/' + id + '/work', { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } });
  assert.equal(done.status, 200);
  assert.equal(done.json.work.status, 'blocked');
  assert.match(done.json.work.result, /has not changed/);
  assert.match(done.json.work.nextStep, /Plugin Creator/);
  assert.equal(h.anthropicCalls.length, 0);
  const workspace = (await h.request('/api/workspace', { session })).json;
  assert.equal(workspace.projects.filter(x => x.name === 'Panini-Me').length, 1);
  assert.equal(workspace.inbox[0].work.status, 'blocked');
  assert.equal(workspace.inbox[0].projectId, workspace.projects.find(x => x.name === 'Panini-Me').id);
});

test('task work requires owner session, same-origin request and exact approval', async t => {
  const h = await createHarness();
  t.after(h.restore);
  const session = await h.signIn();
  const cap = await h.request('/api/brain/capture', { method: 'POST', session, body: { title: 'Write a greeting.' } });
  const path = '/api/brain/items/' + cap.json.item.id + '/work';
  assert.equal((await h.request(path, { method: 'POST', body: { confirmCostMicrousd: 30000 } })).status, 401);
  assert.equal((await h.request(path, { method: 'POST', session, headers: { Origin: 'https://evil.test' },
    body: { confirmCostMicrousd: 30000 } })).status, 403);
  assert.equal((await h.request(path, { method: 'POST', session, body: {} })).status, 400);
  assert.equal((await h.request('/api/brain/items/00000000-0000-0000-0000-000000000000/work', { method: 'POST', session,
    body: { confirmCostMicrousd: 30000 } })).status, 404);
  assert.equal(h.blocked.length, 0);
});

test('unknown Claude outcome locks task rather than silently charging a second attempt', async t => {
  const h = await createHarness({ anthropic: async () => { throw new Error('Provider unavailable'); } });
  t.after(h.restore);
  const session = await h.signIn();
  const cap = await h.request('/api/brain/capture', { method: 'POST', session, body: { title: 'Write a greeting.' } });
  const path = '/api/brain/items/' + cap.json.item.id + '/work';
  const first = await h.request(path, { method: 'POST', session, body: { confirmCostMicrousd: 30000 } });
  assert.equal(first.status, 200);
  assert.equal(first.json.work.status, 'unconfirmed');
  assert.match(first.json.work.nextStep, /Check usage/);
  const second = await h.request(path, { method: 'POST', session, body: { confirmCostMicrousd: 30000 } });
  assert.equal(second.json.work.status, 'unconfirmed');
  assert.equal(h.anthropicCalls.length, 1);
});


test('stale pending request becomes visibly unconfirmed without triggering another model call', async t => {
  const h = await createHarness();
  t.after(h.restore);
  const session = await h.signIn();
  const cap = await h.request('/api/brain/capture', { method: 'POST', session, body: { title: 'Make a fresh draft.' } });
  const id = cap.json.item.id;
  await h.request('/api/workspace', { session });
  h.db.prepare("INSERT INTO brain_work (note_id,status,result,next_step,updated_at) VALUES (?,'working','','',?)")
    .run(id, new Date(Date.now() - 180000).toISOString());
  const inbox = (await h.request('/api/workspace', { session })).json.inbox;
  assert.equal(inbox[0].work.status, 'unconfirmed');
  assert.match(inbox[0].work.nextStep, /Check provider usage/);
  assert.equal(h.anthropicCalls.length, 0);
});
