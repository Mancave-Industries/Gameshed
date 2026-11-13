import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProvider } from '../runner/provider-preflight.mjs';
const task = { spec: { repo: 'Gameshed', sha: 'a'.repeat(40), paths: ['value.js'], profile: 'source-review', maxMicrousd: 100000 } };
test('free provider check forwards only token counting and blocks all inference', async () => {
  const calls = [];
  const result = await checkProvider(task, [], 'fake', async (url, init) => {
    calls.push(url); assert.equal(init.method, 'POST');
    assert.equal(url, 'https://api.anthropic.com/v1/messages/count_tokens');
    return Response.json({ input_tokens: 1000 });
  });
  assert.deepEqual(result, { status: 'ready-for-inference', inferenceStarted: false });
  assert.equal(calls.length, 1);
});
test('free check localises key and budget failures without printing provider text', async () => {
  let calls = 0;
  assert.equal((await checkProvider(task, [], '', async () => { calls++; })).code, 'provider-key-missing');
  assert.equal(calls, 0);
  const denied = await checkProvider(task, [], 'fake', async () => new Response('secret-provider-body', { status: 401 }));
  assert.equal(denied.code, 'token-count-http-401');
  assert.ok(!JSON.stringify(denied).includes('secret-provider-body'));
  const budget = await checkProvider(task, [], 'fake', async () => Response.json({ input_tokens: 999999 }));
  assert.equal(budget.code, 'budget-preflight');
  assert.equal(budget.inferenceStarted, false);
});
