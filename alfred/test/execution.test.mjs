import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHarness, liveFixtures } from './harness.mjs';
import { executionSpec, safePath } from '../public/execution-policy.js';
import { generate, run, verifyInContainer } from '../runner/run.mjs';

const EVENT = '<!-- alfred-workflow-event:v1 -->\n';
const PROPOSAL = '<!-- alfred-workflow:v1 -->\n';
const SPEC = { repo: 'Gameshed', sha: 'b'.repeat(40), paths: ['value.js'], profile: 'node-tests', maxMicrousd: 200000 };
const NEXT = { title: 'Choose the next check', summary: 'The small draft fix passed its checks. Choose what to review next.',
  options: [{ id: 'review', label: 'Review the draft', detail: 'Recommended. Inspect the draft before any release.' }, { id: 'extend', label: 'Extend the test', detail: 'Prepare a broader test before considering release.' }] };
async function setup(t, { spec = SPEC, enabled = true } = {}) {
  const repos = liveFixtures();
  repos.Gameshed.sources = { 'value.js': 'export const value = 1;\n' };
  const issue = repos.Gameshed.issues[2];
  const proposal = JSON.parse(issue.body.slice(PROPOSAL.length));
  proposal.project = 'Alfred';
  proposal.title = 'Fix the synthetic test value';
  proposal.options[0].execution = spec;
  issue.body = PROPOSAL + JSON.stringify(proposal);
  const h = await createHarness({ repos, execution: enabled });
  t.after(h.restore);
  const session = await h.signIn();
  const option = proposal.options[0];
  const approve = () => h.request('/api/workflows/4/choice', { method: 'POST', session,
    body: { option: option.id, label: option.label, detail: option.detail, execution: option.execution, confirmCostMicrousd: spec.maxMicrousd } });
  const api = async (path, body, claims = {}) => {
    const r = await h.request('/api/executor' + path, { method: 'POST', body, headers: { Authorization: 'Bearer ' + await h.runnerToken(claims) } });
    if (r.status !== 200) throw Object.assign(new Error(r.json?.error), { status: r.status });
    return r.json;
  };
  return { h, session, approve, option, api };
}
function provider(output, calls) {
  return async (url, init) => {
    calls.push(url);
    if (url.endsWith('/count_tokens')) return Response.json({ input_tokens: 1000 });
    assert.equal(JSON.parse(init.body).model, 'claude-haiku-4-5-20251001');
    return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }], usage: { input_tokens: 1000, output_tokens: 500 } });
  };
}

test('complete real HTTP path: approve → runner claim → Claude adapter → checks → GitHub read-back → verified → next decision', async t => {
  const { h, session, approve, api } = await setup(t);
  const accepted = await approve();
  assert.equal(accepted.status, 200);
  const id = accepted.json.workflow.decisionId;
  const calls = [], checks = [];
  const output = { result: 'Corrected the synthetic value in a draft. The owner still needs to review it.', files: [{ path: 'value.js', content: 'export const value = 2;\n' }], nextDecision: NEXT };
  const result = await run({ decisionId: id, api, apiKey: 'fake', provider: provider(output, calls), checkout: '/synthetic',
    verify: async (root, spec, files, result) => { assert.equal(spec.sha, SPEC.sha); checks.push(result.files[0].content); } });
  assert.equal(result.status, 'verified');
  assert.equal(calls.length, 2, 'one count and exactly one inference');
  assert.equal(checks.length, 2, 'baseline before spend, then independent output check');
  const state = (await h.request('/api/workspace', { session })).json.workflows;
  const completed = state.find(w => w.number === 4);
  assert.equal(completed.status, 'verified');
  assert.match(completed.result, /isolated review branch/);
  assert.deepEqual(completed.events.map(e => e.type), ['choice', 'started', 'checking', 'completed', 'verifying', 'verified']);
  const next = state.find(w => w.number > 4);
  assert.equal(next.title, NEXT.title);
  assert.equal(next.status, 'decision');
  assert.ok(next.options.every(o => !o.execution), 'no model-issued spending authority');
  await assert.rejects(api('/claim', { decisionId: id }), /already been consumed/);
  await api('/finish', { decisionId: id, phase: 'result', output, evidence: result.evidence });
  assert.equal(h.repos.Gameshed.issues.filter(i => i.title === '[Alfred workflow] ' + NEXT.title).length, 1);
  assert.equal(h.comments(4).filter(c => c.body.includes('"type":"completed"')).length, 1);
  assert.deepEqual(h.blocked, []);
});

test('simultaneous approvals and competing runner claims spend only once', async t => {
  const { approve, api } = await setup(t);
  const results = await Promise.all([approve(), approve()]);
  const id = results[0].json.workflow.decisionId;
  const claims = await Promise.allSettled([api('/claim', { decisionId: id }), api('/claim', { decisionId: id })]);
  assert.equal(claims.filter(x => x.status === 'fulfilled').length, 1);
});

test('startup probe diagnoses an expired blocked grant without consuming or reviving it', async t => {
  const { h, approve, api } = await setup(t);
  const id = (await approve()).json.workflow.decisionId;
  h.db.prepare('UPDATE executions SET status = ?, expires_at = ? WHERE decision_id = ?').run('blocked', 1, id);
  h.repos.Gameshed.runEvent = 'workflow_dispatch';
  const before = h.db.prepare('SELECT * FROM executions').all();
  const comments = JSON.stringify(h.comments(4));
  const logStart = h.githubLog.length;
  const result = await api('/probe', { decisionId: id }, { event_name: 'workflow_dispatch' });
  assert.deepEqual(result, { status: 'diagnosed', queueStatus: 'blocked', expired: true, alreadyClaimed: false, sourceFiles: 1, inferenceStarted: false });
  assert.deepEqual(h.db.prepare('SELECT * FROM executions').all(), before);
  assert.equal(JSON.stringify(h.comments(4)), comments);
  assert.ok(h.githubLog.slice(logStart).every(line => line.startsWith('GET ')));
  assert.deepEqual(h.anthropicCalls, []);
  assert.deepEqual(h.blocked, []);
  await assert.rejects(api('/claim', { decisionId: id }), /consumed/);
});

test('startup probe rejects unsigned and automatic requests and localises missing Actions access', async t => {
  const { h, approve, api } = await setup(t);
  const id = (await approve()).json.workflow.decisionId;
  const unsigned = await h.request('/api/executor/probe', { method: 'POST', body: { decisionId: id } });
  assert.equal(unsigned.status, 403);
  await assert.rejects(api('/probe', { decisionId: id }), e => e.status === 403);
  h.repos.Gameshed.runEvent = 'workflow_dispatch';
  h.repos.Gameshed.runStatus = 403;
  const rejected = await h.request('/api/executor/probe', { method: 'POST', body: { decisionId: id },
    headers: { Authorization: 'Bearer ' + await h.runnerToken({ event_name: 'workflow_dispatch' }) } });
  assert.deepEqual(rejected.json, { code: 'probe-actions-read-http-403' });
  assert.equal(h.db.prepare('SELECT status FROM executions').get().status, 'queued');
  assert.equal(h.comments(4).length, 1);
});

test('actual manual runner entry point stops after read-only probe without a model key', async t => {
  const root = await mkdtemp(join(tmpdir(), 'alfred-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const event = join(root, 'event.json');
  await writeFile(event, JSON.stringify({ inputs: { mode: 'startup-probe', decision_id: '123' } }));
  const bootstrap = `globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://identity.test/')) return Response.json({value:'fake-oidc'});
    if (url === 'https://alfred.test/api/executor/probe' && init.method === 'POST' && JSON.parse(init.body).decisionId === 123)
      return Response.json({status:'diagnosed',queueStatus:'blocked',expired:true,alreadyClaimed:false,sourceFiles:1,inferenceStarted:false});
    throw new Error('Unexpected outbound request');
  };`;
  const stdout = execFileSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(bootstrap),
    new URL('../runner/run.mjs', import.meta.url).pathname], { encoding: 'utf8', env: { ...process.env,
    ALFRED_ORIGIN: 'https://alfred.test', GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'workflow_dispatch',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://identity.test/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake', ANTHROPIC_API_KEY: '' } });
  assert.match(stdout, /Startup probe:.*"inferenceStarted":false/);
  assert.ok(!stdout.includes('fake-oidc'));
});

test('no activation, missing cost consent, changed scope and unsigned callbacks cannot start Claude', async t => {
  const { h, session, approve, option } = await setup(t, { enabled: false });
  assert.equal((await approve()).status, 409);
  assert.equal(h.comments(4).length, 0);
  h.env.ALFRED_EXECUTOR_SHA = 'a'.repeat(40); h.env.ALFRED_EXECUTOR_REF = 'refs/heads/main';
  const noConsent = await h.request('/api/workflows/4/choice', { method: 'POST', session, body: { option: option.id, label: option.label, detail: option.detail } });
  assert.equal(noConsent.status, 409);
  const unsigned = await h.request('/api/executor/claim', { method: 'POST', body: { decisionId: 1 } });
  assert.equal(unsigned.status, 403);
});

test('runner OIDC rejects wrong audience, repository, revision, expiry and paid reruns', async t => {
  const { approve, api } = await setup(t);
  const id = (await approve()).json.workflow.decisionId;
  for (const claims of [{ aud: 'https://other.test' }, { repository_id: '1' }, { sha: 'c'.repeat(40) },
    { exp: 1 }, { run_attempt: '2' }, { workflow_ref: 'Mancave-Industries/Gameshed/.github/workflows/evil.yml@refs/heads/main' }]) {
    await assert.rejects(api('/claim', { decisionId: id }, claims), e => e.status === 403);
  }
});

test('scope mutation after approval and an earlier external start prevent a runner claim', async t => {
  const { h, approve, api } = await setup(t);
  const id = (await approve()).json.workflow.decisionId;
  const issue = h.repos.Gameshed.issues[2], original = issue.body;
  issue.body += ' ';
  await assert.rejects(api('/claim', { decisionId: id }), /scope changed/);
  issue.body = original;
  h.comments(4).push({ id: id + 1, body: EVENT + JSON.stringify({ type: 'started', decisionId: id }) });
  await assert.rejects(api('/claim', { decisionId: id }), /already started/);
});

test('failed checks report a blocker and never publish or create a next decision', async t => {
  const { h, session, approve, api } = await setup(t);
  const id = (await approve()).json.workflow.decisionId;
  const calls = [];
  const output = { result: 'A draft', files: [{ path: 'value.js', content: 'broken' }], nextDecision: NEXT };
  let checks = 0;
  await assert.rejects(run({ decisionId: id, api, apiKey: 'fake', provider: provider(output, calls),
    verify: async () => { if (++checks === 2) throw new Error('regression'); } }), /regression/);
  const state = (await h.request('/api/workspace', { session })).json.workflows.find(w => w.number === 4);
  assert.equal(state.status, 'blocked');
  assert.ok(!h.githubLog.some(l => l.startsWith('POST') && l.includes('/git/')));
  assert.equal(h.repos.Gameshed.issues.length, 3);
  await assert.rejects(api('/claim', { decisionId: id }), /already been consumed/);
});

test('runner loss is surfaced, not silently retried or called complete', async t => {
  const { h, session, approve, api } = await setup(t);
  const id = (await approve()).json.workflow.decisionId;
  await api('/claim', { decisionId: id });
  h.db.prepare('UPDATE executions SET heartbeat_at = ?').run(Date.now() - 21 * 60000);
  const state = (await h.request('/api/workspace', { session })).json.workflows.find(w => w.number === 4);
  assert.equal(state.status, 'blocked');
  assert.match(state.result, /charge/);
});

test('budget preflight, truncation and malformed output stop without inference retry', async () => {
  const task = { spec: { ...SPEC, maxMicrousd: 1 } };
  const calls = [];
  await assert.rejects(generate(task, [], 'fake', provider({}, calls)), /ceiling/);
  assert.equal(calls.length, 1);
  let inference = 0;
  await assert.rejects(generate({ spec: SPEC }, [], 'fake', async url => {
    if (url.endsWith('/count_tokens')) return Response.json({ input_tokens: 1000 });
    inference++; throw new Error('unknown transport result');
  }), /transport/);
  assert.equal(inference, 1);
});

test('paths, repository and verification profile cannot escape the approved sandbox', () => {
  for (const p of ['../escape', '/etc/passwd', 'a/../x', '.github/workflows/x.yml', 'secrets.env', 'package.json', 'a//b']) assert.equal(safePath(p), false, p);
  assert.equal(executionSpec({ ...SPEC, repo: 'other' }), null);
  assert.equal(executionSpec({ ...SPEC, profile: 'bash -c anything' }), null);
});

test('container verifier runs original and changed code, with network and credentials isolated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'alfred-fixture-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'value.js'), 'export const value = 1;\n');
  const commands = [];
  await verifyInContainer(root, SPEC, [{ path: 'value.js', content: 'export const value = 1;\n' }],
    { result: 'Draft', files: [{ path: 'value.js', content: 'export const value = 2;\n' }] }, async (bin, args, opts) => {
      assert.equal(bin, 'docker'); assert.ok(args.includes('--network=none')); assert.ok(args.includes('--read-only'));
      assert.ok(!args.includes('-e')); assert.ok(opts.timeout > 0); commands.push(args);
      return { stdout: '# tests 1\n# pass 1\n# fail 0\n' };
    });
  assert.equal(commands.length, 2);
});

let docker = false;
try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 }); docker = true; } catch {}
test('real sandbox accepts a correct change and rejects an actual regression', { skip: !docker && !process.env.ALFRED_REQUIRE_DOCKER }, async t => {
  assert.ok(docker, 'Docker is mandatory in GitHub CI');
  execFileSync('docker', ['pull', 'node:24-bookworm-slim'], { stdio: 'ignore', timeout: 120000 });
  const root = await mkdtemp(join(tmpdir(), 'alfred-real-sandbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'value.js'), 'export const value = 1;\n');
  await writeFile(join(root, 'test/value.test.mjs'), "import {value} from '../value.js'; import assert from 'node:assert/strict'; assert.ok(value > 0); assert.equal(process.env.ANTHROPIC_API_KEY, undefined);\n");
  const files = [{ path: 'value.js', content: 'export const value = 1;\n' }];
  await verifyInContainer(root, SPEC, files, { result: 'Draft', files: [{ path: 'value.js', content: 'export const value = 2;\n' }] });
  await assert.rejects(verifyInContainer(root, SPEC, files, { result: 'Broken', files: [{ path: 'value.js', content: 'export const value = -1;\n' }] }));
  await rm(join(root, 'test'), { recursive: true });
  await assert.rejects(verifyInContainer(root, SPEC, files, { result: 'No tests', files: [{ path: 'value.js', content: 'export const value = 2;\n' }] }), /passing tests/);
});


test('runner rejection reports a safe diagnostic without echoing a credential', async t => {
  const { h } = await setup(t);
  const r = await h.request('/api/executor/claim', { method: 'POST', body: { decisionId: 1 }, headers: { Authorization: 'Bearer secret-do-not-log' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'identity-invalid');
  assert(!JSON.stringify(r.json).includes('secret-do-not-log'));
});

test('identity failures identify the exact phase without disclosing native errors or consuming approval', async t => {
  const { h, approve } = await setup(t);
  const id = (await approve()).json.workflow.decisionId;
  const token = await h.runnerToken({ event_name: 'workflow_dispatch' });
  const baseline = JSON.stringify(h.db.prepare('SELECT * FROM executions').all());
  const comments = JSON.stringify(h.comments(4));
  const realFetch = globalThis.fetch;
  const subtle = globalThis.crypto.subtle;
  const nativeVerify = subtle.verify;
  const nativeImport = subtle.importKey;
  const secret = 'synthetic-private-error-do-not-disclose';
  const cases = [
    ['signing-key-fetch-failed', async () => { throw new Error(secret); }],
    ['identity-service-unavailable', async () => new Response(secret, { status: 403 })],
    ['signing-key-response-invalid', async () => new Response(secret)],
    ['signing-key-response-invalid', async () => Response.json({ keys: null })],
    ['signing-key-unknown', async () => Response.json({ keys: [] })],
    ['signing-key-import-failed', realFetch, 'import'],
    ['signature-verification-failed', realFetch, 'verify'],
  ];
  try {
    for (const [code, fetcher, brokenCrypto] of cases) {
      globalThis.fetch = fetcher;
      subtle.importKey = brokenCrypto === 'import' ? async () => { throw new Error(secret); } : nativeImport;
      subtle.verify = brokenCrypto === 'verify' ? async () => { throw new Error(secret); } : nativeVerify;
      const r = await h.request('/api/executor/probe', { method: 'POST', body: { decisionId: id }, headers: { Authorization: 'Bearer ' + token } });
      assert.equal(r.status, 403);
      assert.equal(r.json.code, code);
      assert.ok(!JSON.stringify(r.json).includes(secret));
      assert.ok(!JSON.stringify(r.json).includes(token));
      assert.equal(JSON.stringify(h.db.prepare('SELECT * FROM executions').all()), baseline);
      assert.equal(JSON.stringify(h.comments(4)), comments);
    }
  } finally { globalThis.fetch = realFetch; subtle.verify = nativeVerify; subtle.importKey = nativeImport; }
  const malformed = await h.request('/api/executor/probe', { method: 'POST', body: { decisionId: id }, headers: { Authorization: 'Bearer e30.invalid.signature' } });
  assert.equal(malformed.json.code, 'identity-invalid');
  const parts = token.split('.'); parts[1] = Buffer.from(JSON.stringify({ aud: 'forged' })).toString('base64url');
  const tampered = await h.request('/api/executor/probe', { method: 'POST', body: { decisionId: id }, headers: { Authorization: 'Bearer ' + parts.join('.') } });
  assert.equal(tampered.json.code, 'signature-invalid');
  assert.deepEqual(h.anthropicCalls, []);
});
