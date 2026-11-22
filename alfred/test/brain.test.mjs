import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';

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

test('existing projects no longer claim to be paused while Alfred is built', async t => {
  const h = await createHarness();
  t.after(h.restore);
  const session = await h.signIn();
  const res = await h.request('/api/workspace', { session });
  const science = res.json.projects.find(p => p.name === 'Science Buddy');
  assert.equal(science.paused, false);
  assert.notEqual(science.status, 'Paused while Alfred is finished.');
});
