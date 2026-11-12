// Offline harness: runs the real Worker against an in-memory D1 database and a fake
// GitHub API. Any other outbound request fails the test, so nothing reaches GitHub,
// Cloudflare or Anthropic, and no credits can be spent.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { webcrypto, createHash } from 'node:crypto';
import worker from '../public/_worker.js';

export const OWNER_ID = 287470662;
const OWNER = { login: 'Mancave-Industries', id: OWNER_ID };
const PUBLIC = new URL('../public/', import.meta.url);
const encoder = new TextEncoder();

const b64url = bytes => Buffer.from(bytes).toString('base64url');
const sha256 = async value => b64url(new Uint8Array(await webcrypto.subtle.digest('SHA-256', encoder.encode(value))));

function d1(db) {
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => { db.prepare(sql).run(...params); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    _exec: () => /\breturning\b|^\s*select/i.test(sql) ? db.prepare(sql).all(...params) : db.prepare(sql).run(...params),
  });
  return {
    prepare: sql => statement(sql),
    batch: async statements => {
      db.exec('BEGIN');
      try {
        const results = statements.map(item => item._exec());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

// Live Gameshed records as of 11 November 2026 (issues #3 and #4), used as fixtures.
export const ISSUE_3_BODY = '<!-- alfred-workflow:v1 -->\n' + JSON.stringify({
  project: 'Science Buddy', title: 'Choose the first Biology lesson to review',
  summary: 'The draft supports 97 Biology sections. Start with one lesson so we can check its teaching and tests before preparing a phone trial.',
  options: [
    { id: 'osmosis', label: 'Review Osmosis', detail: 'Recommended. This is the most developed starter lesson, so it gives us the clearest test of the tutoring flow.' },
    { id: 'diffusion', label: 'Review Diffusion', detail: 'This is a shorter starter lesson. It helps check whether a less developed topic can work as a first lesson.' },
  ],
}, null, 2);
export const ISSUE_4_BODY = '<!-- alfred-workflow:v1 -->\n' + JSON.stringify({
  project: 'Science Buddy', title: 'Choose the next Osmosis readiness step',
  summary: 'The Osmosis review is complete. Existing automated checks passed, but lesson wording and marking criteria need tightening, and practical marking needs stronger test coverage. Real-model teaching and a physical iPhone trial remain unverified.',
  options: [
    { id: 'tighten-osmosis', label: 'Tighten Osmosis wording first', detail: 'Recommended. Prepare a reversible draft-only fix for net movement in marking criteria, example-specific membrane and solute wording, the dead-potato probe and matching evaluation text. Add focused no-cost regression checks and report the result.' },
    { id: 'test-osmosis-practical', label: 'Test the practical flow first', detail: 'Add draft-only scripted tests for percentage-change calculations, negative mass changes and graph zero-crossing feedback through the normal tutoring API.' },
  ],
}, null, 2);
const EVENT = '<!-- alfred-workflow-event:v1 -->\n';
export const OSMOSIS_RESULT = 'Reviewed Osmosis in Science_Budy draft PR 18. Verified four learning goals, nine misconception entries and nine authored questions. GitHub Actions run 42412729209 succeeded at this exact commit.\n\nReview findings: the definition\'s marking points omit the word net; generic sugar/salt wording needs narrowing. Still required: a recorded scientific review, real-model transcript and testing in Safari on a physical iPhone. '.repeat(2);

export function liveFixtures() {
  const decisionBody = (id, question, answer) => '<!-- alfred-decision:' + id + ':v1 -->\n\n' + question +
    (answer ? '\n\nAnswer: ' + answer + '\nRecorded by: Mancave-Industries\nRecorded at: 2026-11-09T10:00:00.000Z' : '');
  return {
    Gameshed: {
      issues: [
        { number: 1, title: 'ALFRED CONTROL CENTRE — live project status and decisions', body: '# Alfred — Project Control Centre', state: 'open' },
        { number: 3, title: '[Alfred workflow] Choose the first Biology lesson to review', body: ISSUE_3_BODY, state: 'open', created_at: '2026-11-09T20:59:39Z' },
        { number: 4, title: '[Alfred workflow] Choose the next Osmosis readiness step', body: ISSUE_4_BODY, state: 'open', created_at: '2026-11-11T08:23:35Z' },
      ],
      comments: {
        3: [
          { id: 6751368872, body: 'Workflow prepared. Awaiting a selection in Alfred.', created_at: '2026-11-09T21:01:56Z' },
          { id: 6772342268, body: EVENT + JSON.stringify({ type: 'choice', option: 'osmosis', label: 'Review Osmosis', detail: 'Recommended. This is the most developed starter lesson, so it gives us the clearest test of the tutoring flow.' }), created_at: '2026-11-10T16:04:13Z' },
          { id: 6790875594, body: EVENT + JSON.stringify({ type: 'started', decisionId: 6772342268 }), created_at: '2026-11-11T08:21:41Z' },
          { id: 6790896314, body: EVENT + JSON.stringify({ type: 'completed', decisionId: 6772342268, result: OSMOSIS_RESULT }), created_at: '2026-11-11T08:22:49Z' },
        ],
        4: [],
      },
    },
    Deceivers: { issues: [{ number: 17, title: 'Alfred decision', body: decisionBody('deceivers-audit', 'Approve a read-only release audit?', 'YES'), state: 'open' }] },
    Science_Budy: { issues: [{ number: 19, title: 'Alfred decision', body: decisionBody('science-mvp', 'Prioritise a usable first release over full curriculum coverage?', 'YES'), state: 'open' }] },
    'MANCAVE-INDUSTRIES.github.io': { issues: [{ number: 1, title: 'Alfred decision', body: decisionBody('mci-freeze', 'Freeze optional stall features until after the festival?', 'NO'), state: 'open' }] },
    'risk-assessment-songbook': { issues: [{ number: 1, title: 'Alfred decision', body: decisionBody('songbook-hold', 'Hold new feature development while the priority releases are reviewed?', null), state: 'open' }] },
  };
}

function fakeGithub(repos, log) {
  let nextComment = 7_000_000_000;
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const issueJson = (issue) => ({ user: OWNER, comments: 0, updated_at: '2026-11-11T09:00:00Z', created_at: '2026-11-08T00:00:00Z', ...issue });
  const refs = new Map();
  const commits = new Map();
  return async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    log.push(method + ' ' + url.pathname + url.search);
    if (url.pathname === '/user') return reply({ ...OWNER });
    const runMatch = /^\/repos\/Mancave-Industries\/Gameshed\/actions\/runs\/(\d+)$/.exec(url.pathname);
    if (runMatch) return reply({ id: Number(runMatch[1]), head_sha: 'a'.repeat(40), path: '.github/workflows/alfred-execute.yml', event: repos.Gameshed.runEvent ?? 'issue_comment' }, repos.Gameshed.runStatus ?? 200);
    const git = /^\/repos\/Mancave-Industries\/([^/]+)\/git\/(.+)$/.exec(url.pathname);
    if (git) {
      const [, repoName, path] = git;
      const sources = repos[repoName]?.sources ?? {};
      const digest = x => createHash('sha1').update(x).digest('hex');
      if (path.startsWith('commits/')) return reply(commits.get(path.slice(8)) ?? { sha: path.slice(8), tree: { sha: 'base-tree' }, parents: [] });
      if (path.startsWith('trees/') && method === 'GET') return reply({ truncated: false, tree: Object.entries(sources).map(([path, content]) => ({ path, type: 'blob', mode: '100644', sha: digest(content), size: Buffer.byteLength(content) })) });
      if (path.startsWith('blobs/')) {
        const content = Object.values(sources).find(c => digest(c) === path.slice(6));
        return content === undefined ? reply({}, 404) : reply({ encoding: 'base64', content: Buffer.from(content).toString('base64') });
      }
      if (path === 'trees' && method === 'POST') return reply({ sha: digest(init.body) });
      if (path === 'commits' && method === 'POST') {
        const data = JSON.parse(init.body), sha = digest(init.body);
        commits.set(sha, { sha, tree: { sha: data.tree }, parents: data.parents.map(sha => ({ sha })) });
        return reply({ sha });
      }
      if (path === 'refs' && method === 'POST') {
        const data = JSON.parse(init.body); refs.set(data.ref.replace(/^refs\//, ''), data.sha); return reply({ ref: data.ref, object: { sha: data.sha } });
      }
      if (path.startsWith('ref/')) return refs.has(path.slice(4)) ? reply({ object: { sha: refs.get(path.slice(4)) } }) : reply({}, 404);
      return reply({}, 404);
    }
    const match = /^\/repos\/Mancave-Industries\/([^/]+)\/(issues|pulls)(?:\/(\d+))?(?:\/(comments))?$/.exec(url.pathname);
    if (!match) return reply({ message: 'Not Found' }, 404);
    const [, repoName, kind, number, comments] = match;
    const repo = repos[repoName];
    if (!repo) return reply({ message: 'Not Found' }, 404);
    if (kind === 'pulls') return reply([]);
    if (!number) {
      if (method === 'POST') {
        const data = JSON.parse(init.body);
        const number = Math.max(...repo.issues.map(i => i.number)) + 1;
        const issue = issueJson({ ...data, number, state: 'open' }); repo.issues.push(issue);
        return reply(issue, 201);
      }
      const state = url.searchParams.get('state') ?? 'open';
      return reply(repo.issues.filter(issue => state === 'all' || issue.state === state).map(issueJson));
    }
    const issue = repo.issues.find(item => item.number === Number(number));
    if (!issue) return reply({ message: 'Not Found' }, 404);
    if (comments) {
      repo.comments ??= {};
      const list = repo.comments[number] ??= [];
      if (method === 'POST') {
        const body = JSON.parse(init.body).body;
        // Like GitHub, a new comment always has a higher ID than every earlier one.
        nextComment = Math.max(nextComment, ...list.map(item => item.id + 1));
        const comment = { id: nextComment++, body, created_at: new Date().toISOString() };
        list.push(comment);
        return reply({ ...comment, user: OWNER }, 201);
      }
      return reply(list.map(comment => ({ user: OWNER, ...comment })));
    }
    if (method === 'PATCH') {
      Object.assign(issue, JSON.parse(init.body));
      return reply(issueJson(issue));
    }
    return reply(issueJson(issue));
  };
}

export async function createHarness({ repos = liveFixtures(), anthropic = null, origin = 'http://localhost:8787', execution = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const sessionKey = b64url(webcrypto.getRandomValues(new Uint8Array(32)));
  const githubLog = [];
  const blocked = [];
  const anthropicCalls = [];
  const github = fakeGithub(repos, githubLog);
  const env = {
    ALFRED_ORIGIN: origin,
    ALFRED_DB: d1(db),
    ALFRED_SESSION_KEY: sessionKey,
    GITHUB_APP_CLIENT_ID: 'Iv1.test',
    GITHUB_APP_CLIENT_SECRET: 'test-secret',
    ALFRED_DECISION_ISSUES: JSON.stringify({ 'deceivers-audit': 17, 'science-mvp': 19, 'mci-freeze': 1, 'songbook-hold': 1 }),
    ...(anthropic ? { ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key' } : {}),
    ...(execution ? { ALFRED_EXECUTOR_SHA: 'a'.repeat(40), ALFRED_EXECUTOR_REF: 'refs/heads/main' } : {}),
    ASSETS: {
      fetch: async request => {
        const path = new URL(request.url).pathname;
        const file = path === '/' ? 'index.html' : path.slice(1);
        const types = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css' };
        return new Response(readFileSync(new URL(file, PUBLIC)), { headers: { 'Content-Type': types[file.split('.').pop()] } });
      },
    },
  };

  const realFetch = globalThis.fetch;
  const signingKey = execution ? await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) : null;
  const jwk = signingKey ? { ...await webcrypto.subtle.exportKey('jwk', signingKey.publicKey), kid: 'test-key' } : null;
  const runnerToken = async (overrides = {}) => {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'test-key' }));
    const claims = b64url(JSON.stringify({ iss: 'https://token.actions.githubusercontent.com', aud: origin,
      repository_id: '1395042959', repository_owner_id: String(OWNER_ID),
      workflow_ref: 'Mancave-Industries/Gameshed/.github/workflows/alfred-execute.yml@refs/heads/main', sha: 'a'.repeat(40),
      event_name: 'issue_comment', run_id: '12345', run_attempt: '1', exp: Math.floor(Date.now() / 1000) + 300,
      nbf: Math.floor(Date.now() / 1000) - 30, ...overrides }));
    return head + '.' + claims + '.' + b64url(await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey.privateKey, encoder.encode(head + '.' + claims)));
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'api.github.com') return github(url, init);
    if (url.hostname === 'token.actions.githubusercontent.com' && execution) return Response.json({ keys: [jwk] });
    if (url.hostname === 'api.anthropic.com' && anthropic) {
      anthropicCalls.push(JSON.parse(init.body));
      return anthropic(JSON.parse(init.body));
    }
    blocked.push(url.href);
    throw new Error('Blocked outbound request in test: ' + url.href);
  };

  async function signIn() {
    const sessionId = b64url(webcrypto.getRandomValues(new Uint8Array(32)));
    const id = await sha256(sessionId);
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(sessionKey, 'base64url'), 'AES-GCM', false, ['encrypt']);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const cipher = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, key, encoder.encode('ghu_testtoken'));
    db.prepare('INSERT INTO sessions (id, token, expires_at) VALUES (?, ?, ?)').run(id, b64url(iv) + '.' + b64url(new Uint8Array(cipher)), Date.now() + 3600_000);
    return sessionId;
  }

  async function request(path, { method = 'GET', body, session, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (session) init.headers.Cookie = '__Host-alfred_session=' + session;
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] ??= 'application/json';
    }
    if (method === 'POST') init.headers.Origin ??= env.ALFRED_ORIGIN;
    const response = await worker.fetch(new Request(env.ALFRED_ORIGIN + path, init), env, { waitUntil() {} });
    return { status: response.status, headers: response.headers, json: await response.clone().json().catch(() => null), text: await response.text() };
  }

  async function serve() {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      const response = await worker.fetch(new Request(env.ALFRED_ORIGIN + req.url, {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      }), env, { waitUntil() {} });
      const out = {};
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') out[key] = value; });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies;
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    const port = Number(new URL(env.ALFRED_ORIGIN).port);
    await new Promise(resolve => server.listen(port, 'localhost', resolve));
    return server;
  }

  return {
    env, repos, db, githubLog, blocked, anthropicCalls, signIn, request, serve, runnerToken,
    comments: number => repos.Gameshed.comments[number],
    restore: () => { globalThis.fetch = realFetch; },
  };
}
