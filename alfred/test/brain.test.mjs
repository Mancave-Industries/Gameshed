import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, liveFixtures } from './harness.mjs';

test('owner can add a project and capture notes in a private D1 inbox', async t => {
  const h = await createHarness();
  t.after(h.restore);
  const session = await h.signIn();
  const before = await h.request('/api/workspace', { session });
  assert.equal(before.json.projects.length, 5);
  assert.deepEqual(before.json.inbox, []);

  const project = await h.request('/api/brain/projects', {
    method: 'POST', session, body: { title: 'Panini-Me' },
  });
  assert.equal(project.status, 201);
  assert.equal(project.json.item.kind, 'project');
  const projectId = project.json.item.id;

  const capture = await h.request('/api/brain/capture', {
    method: 'POST', session, body: { title: 'Panini-Me: make the club stickers shareable' },
  });
  assert.equal(capture.status, 201);
  assert.equal(capture.json.item.projectId, projectId, 'Recognise the project when named in a capture');

  const workspace = await h.request('/api/workspace', { session });
  assert.equal(workspace.json.projects.length, 6);
  assert.equal(workspace.json.projects.at(-1).name, 'Panini-Me');
  assert.equal(workspace.json.projects.at(-1).next, 'Panini-Me: make the club stickers shareable');
  assert.equal(workspace.json.inbox.length, 1);
  assert.ok(!h.githubLog.some(call => call.startsWith('POST /repos/')), 'No personal notes published to a GitHub issue');

  const done = await h.request('/api/brain/items/' + capture.json.item.id + '/done', {
    method: 'POST', session, body: {},
  });
  assert.equal(done.status, 200);
  assert.equal((await h.request('/api/workspace', { session })).json.inbox.length, 0);
  assert.equal(h.anthropicCalls.length, 0, 'Capture does not incur model charges');
});

test('capture is owner-only and rejects invalid data', async t => {
  const h = await createHarness();
  t.after(h.restore);
  const session = await h.signIn();
  assert.equal((await h.request('/api/brain/capture', { method: 'POST', body: { title: 'private note' } })).status, 401);
  assert.equal((await h.request('/api/brain/capture', { method: 'POST', session, headers: { Origin: 'https://attacker.example' }, body: { title: 'note' } })).status, 403);
  assert.equal((await h.request('/api/brain/capture', { method: 'POST', session, body: { title: '' } })).status, 400);
  assert.equal((await h.request('/api/brain/projects', { method: 'POST', session, body: { title: 'Alfred' } })).status, 409);
  assert.equal((await h.request('/api/brain/capture', { method: 'POST', session, body: { title: 'Note', projectId: 'made-up' } })).status, 400);
});

test('other projects show the owner’s development pause while Alfred stays active', async t => {
  const h = await createHarness();
  t.after(h.restore);
  const session = await h.signIn();
  const res = await h.request('/api/workspace', { session });
  const science = res.json.projects.find(p => p.name === 'Science Buddy');
  assert.equal(science.paused, true);
  assert.equal(science.next, 'Waiting for you to resume this project.');
  const alfred = res.json.projects.find(p => p.name === 'Alfred');
  assert.equal(alfred.paused, false);
  assert.equal(alfred.next, 'Check the end-to-end mobile workflow and close the remaining Alfred defects.');
});

test('an archived recommendation cannot remain the current Alfred action', async t => {
  const repos = liveFixtures();
  const marker = '<!-- alfred-workflow:v1 -->\n';
  const proposal = JSON.parse(repos.Gameshed.issues[2].body.slice(marker.length));
  proposal.project = 'Alfred';
  repos.Gameshed.issues.push({ number: 40, title: '[Alfred workflow] Superseded repair',
    body: marker + JSON.stringify(proposal), state: 'closed' });
  const h = await createHarness({ repos });
  t.after(h.restore);
  const session = await h.signIn();
  const res = await h.request('/api/workspace', { session });
  const alfred = res.json.projects.find(p => p.name === 'Alfred');
  assert.equal(alfred.latestWorkflow, null);
  assert.notEqual(alfred.status, 'A recommendation is ready.');
  assert.notEqual(alfred.next, proposal.options[0].label);
  assert.equal(res.json.workflows.find(w => w.number === 40).open, false,
    'Archived evidence remains available in history');
});


test('existing Panini me capture is organised into a project without the user retyping it', async t => {
  const h = await createHarness();
  t.after(h.restore);
  const session = await h.signIn();
  await h.request('/api/workspace', { session }); // initialise private table
  h.db.prepare("INSERT INTO brain_items (id,kind,title,detail,project_id,status,created_at) VALUES (?,'note',?,'',NULL,'open',?)")
    .run('saved-capture', 'Panini me - last few EFL updates', '2026-11-22T04:14:00.000Z');
  const workspace = (await h.request('/api/workspace', { session })).json;
  assert.equal(workspace.inbox.length, 1);
  assert.equal(workspace.inbox[0].title, 'Panini me - last few EFL updates');
  const project = workspace.projects.find(item => item.name === 'Panini-Me');
  assert.ok(project, 'A named project should be created');
  assert.equal(workspace.inbox[0].projectId, project.id, 'Existing note is filed without losing its text');
  const again = (await h.request('/api/workspace', { session })).json;
  assert.equal(again.projects.filter(item => item.name === 'Panini-Me').length, 1, 'No duplicate project on refresh');
  assert.equal(h.anthropicCalls.length, 0);
});
