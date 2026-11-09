const OWNER = 'Mancave-Industries';
const OWNER_ID = 287470662;
const CHOICES = new Set(['YES', 'NO', 'DEFER']);
const SESSION_COOKIE = '__Host-alfred_session';
const STATE_COOKIE = '__Host-alfred_oauth';
const SETUP_COOKIE = '__Host-alfred_github_setup';
const OAUTH_TTL = 600;
const SESSION_TTL = 6 * 60 * 60;
const ASSETS = new Set(['/', '/index.html', '/app.js', '/styles.css']);
const encoder = new TextEncoder();

const PROJECTS = [
  {
    id: 'deceivers-audit', name: 'The Deceivers', repo: 'Deceivers', priority: '01 / Release',
    status: 'Six-narrator cast merged on 5 November.',
    blocker: 'The full narration test was blocked at Chromium installation in the release PR. Four portraits are provisional.',
    next: 'Run the release audit for gameplay, narration and portraits.',
    question: 'Approve a read-only release audit?',
    references: [{ path: 'pull/14', title: 'Narrator release and test evidence' }],
  },
  {
    id: 'science-mvp', name: 'Science Buddy', repo: 'Science_Budy', priority: '02 / Build',
    status: 'Biology coverage, AQA source staging and the extraction pipeline are in review.',
    blocker: 'The first usable release and its curriculum coverage are still to be agreed.',
    next: 'Compare the draft builds and choose the first release scope.',
    question: 'Prioritise a usable first release over full curriculum coverage?',
    references: [
      { path: 'pull/18', title: 'Biology coverage' },
      { path: 'pull/16', title: 'AQA sources' },
      { path: 'pull/15', title: 'Extraction pipeline' },
    ],
  },
  {
    id: 'mci-freeze', name: 'ManCave Industries', repo: 'MANCAVE-INDUSTRIES.github.io', priority: '03 / 28 November',
    status: 'Festival of Light preparations are the immediate priority.',
    blocker: 'Stock, signage, payments and stall equipment readiness need confirming.',
    next: 'Check essentials against the 28 November stall deadline.',
    question: 'Freeze optional stall features until after the festival?',
    references: [{ repo: 'Gameshed', path: 'issues/1', title: 'Festival preparation brief' }],
  },
  {
    id: 'songbook-hold', name: 'Risk Assessment Songbook', repo: 'risk-assessment-songbook', priority: '04 / Scope',
    status: 'Existing app source is backed up in GitHub.',
    blocker: 'Songs and annotations are device-local. Cloud storage is pending.',
    next: 'Retain the master song library, set builder and transpose work in the backlog.',
    question: 'Hold new feature development while the priority releases are reviewed?',
    references: [{ path: 'blob/main/README.md', title: 'Source and storage notes' }],
  },
];

class GitHubError extends Error {
  constructor(status) {
    super('GitHub request failed');
    this.status = status;
  }
}

function secure(response) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self' https://github.com; frame-ancestors 'none'");
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function cookie(name, value, maxAge) {
  return name + '=' + value + '; Path=/; Max-Age=' + maxAge + '; Secure; HttpOnly; SameSite=Lax';
}

function getCookie(request, name) {
  const prefix = name + '=';
  const match = request.headers.get('Cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(prefix));
  return match?.slice(prefix.length);
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

function randomId() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function configured(env) {
  return Boolean(env.ALFRED_ORIGIN && env.ALFRED_DB && validId(env.ALFRED_SESSION_KEY));
}

async function githubApp(env) {
  if (env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET) {
    return { clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: env.GITHUB_APP_CLIENT_SECRET };
  }
  const row = await env.ALFRED_DB.prepare('SELECT credentials FROM github_app WHERE id = 1').first();
  return row ? JSON.parse(await decryptToken(env, row.credentials, 'github-app')) : null;
}

async function tokenKey(env) {
  return crypto.subtle.importKey('raw', decode(env.ALFRED_SESSION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptToken(env, token, id) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, await tokenKey(env), encoder.encode(token),
  );
  return base64url(iv) + '.' + base64url(new Uint8Array(ciphertext));
}

async function decryptToken(env, encrypted, id) {
  const [iv, ciphertext] = encrypted.split('.');
  const result = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(iv), additionalData: encoder.encode(id) }, await tokenKey(env), decode(ciphertext),
  );
  return new TextDecoder().decode(result);
}

async function github(token, path, method = 'GET', data) {
  const response = await fetch('https://api.github.com' + path, {
    method, redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': 'Alfred-Control-Centre',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!response.ok) throw new GitHubError(response.status);
  return response.json();
}

function callbackUrl(env) {
  return env.ALFRED_ORIGIN + '/auth/callback';
}

function htmlPage(content, cookies = [], title = 'Connect GitHub to Alfred', status = 200) {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response([
    '<!doctype html><html lang="en"><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + title + '</title><link rel="stylesheet" href="/styles.css">',
    '<main class="shell"><h1>' + title + '</h1>',
    content, '</main></html>',
  ].join(''), { headers, status });
}

async function startGithubSetup(env, app) {
  if (app) {
    const install = app.slug ? '<p><a class="button primary" href="https://github.com/apps/' + app.slug +
      '/installations/new">Install the GitHub App</a></p>' +
      '<p>Choose Only select repositories and select Deceivers, Science_Budy, MANCAVE-INDUSTRIES.github.io and risk-assessment-songbook.</p>' : '';
    return htmlPage(install + '<p><a href="/">Open Alfred</a> after installing the app.</p>');
  }
  const state = randomId();
  const now = Date.now();
  await env.ALFRED_DB.batch([
    env.ALFRED_DB.prepare('DELETE FROM oauth_attempts WHERE expires_at <= ?').bind(now),
    env.ALFRED_DB.prepare('INSERT INTO oauth_attempts (id, verifier, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256('setup:' + state), 'github-app', now + OAUTH_TTL * 1000),
  ]);
  const manifest = JSON.stringify({
    name: 'Alfred Control Centre Preview',
    url: env.ALFRED_ORIGIN,
    redirect_url: env.ALFRED_ORIGIN + '/setup/github/callback',
    callback_urls: [callbackUrl(env)],
    hook_attributes: { url: env.ALFRED_ORIGIN, active: false },
    public: false,
    default_permissions: { metadata: 'read', issues: 'write', pull_requests: 'read' },
    default_events: [],
  }).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  return htmlPage([
    '<p>Use the Mancave Industries GitHub account to register the private app.</p>',
    '<form method="post" action="https://github.com/settings/apps/new?state=' + state + '">',
    '<input type="hidden" name="manifest" value="' + manifest + '">',
    '<button class="button primary" type="submit">Set up GitHub</button></form>',
  ].join(''), [cookie(SETUP_COOKIE, state, OAUTH_TTL)]);
}

async function finishGithubSetup(request, env, url) {
  const clear = cookie(SETUP_COOKIE, '', 0);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!validId(state) || state !== getCookie(request, SETUP_COOKIE) ||
      !/^[a-zA-Z0-9_-]{10,512}$/.test(code ?? '')) {
    return htmlPage('<p>Setup expired. <a href="/setup/github">Start again</a>.</p>', [clear]);
  }
  const attempt = await env.ALFRED_DB.prepare(
    'DELETE FROM oauth_attempts WHERE id = ? AND expires_at > ? RETURNING verifier',
  ).bind(await sha256('setup:' + state), Date.now()).first();
  if (!attempt) return htmlPage('<p>Setup expired. <a href="/setup/github">Start again</a>.</p>', [clear]);

  const response = await fetch('https://api.github.com/app-manifests/' + code + '/conversions', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Alfred-Control-Centre',
      'X-GitHub-Api-Version': '2026-03-10',
    },
  });
  if (!response.ok) {
    return htmlPage('<p>GitHub did not complete registration. <a href="/setup/github">Start again</a>.</p>', [clear]);
  }
  const app = await response.json();
  const permissions = app.permissions ?? {};
  if (app.owner?.id !== OWNER_ID || app.external_url !== env.ALFRED_ORIGIN ||
      permissions.issues !== 'write' || permissions.pull_requests !== 'read' ||
      Object.keys(permissions).some(name => !['issues', 'pull_requests', 'metadata'].includes(name)) ||
      typeof app.slug !== 'string' || !/^[a-z0-9-]+$/.test(app.slug) ||
      typeof app.client_id !== 'string' || !app.client_id ||
      typeof app.client_secret !== 'string' || !app.client_secret) {
    return htmlPage('<p>Register the Alfred app under the Mancave Industries account. <a href="/setup/github">Start again</a>.</p>', [clear]);
  }
  const credentials = JSON.stringify({ clientId: app.client_id, clientSecret: app.client_secret, slug: app.slug });
  await env.ALFRED_DB.prepare('INSERT OR IGNORE INTO github_app (id, credentials) VALUES (1, ?)')
    .bind(await encryptToken(env, credentials, 'github-app')).run();
  return redirect('/setup/github', [clear]);
}

async function startLogin(env, app) {
  const state = randomId();
  const verifier = randomId();
  const now = Date.now();
  await env.ALFRED_DB.batch([
    env.ALFRED_DB.prepare('DELETE FROM oauth_attempts WHERE expires_at <= ?').bind(now),
    env.ALFRED_DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.ALFRED_DB.prepare('INSERT INTO oauth_attempts (id, verifier, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256(state), verifier, now + OAUTH_TTL * 1000),
  ]);
  const params = new URLSearchParams({
    client_id: app.clientId, redirect_uri: callbackUrl(env), state, login: OWNER,
    code_challenge: await sha256(verifier), code_challenge_method: 'S256', allow_signup: 'false',
    scope: 'offline_access',
  });
  return redirect('https://github.com/login/oauth/authorize?' + params, [cookie(STATE_COOKIE, state, OAUTH_TTL)]);
}

async function finishLogin(request, env, url, app) {
  const clearState = cookie(STATE_COOKIE, '', 0);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!validId(state) || state !== getCookie(request, STATE_COOKIE)) {
    return redirect('/?sign-in=expired', [clearState]);
  }
  const attempt = await env.ALFRED_DB.prepare(
    'DELETE FROM oauth_attempts WHERE id = ? AND expires_at > ? RETURNING verifier',
  ).bind(await sha256(state), Date.now()).first();
  if (!attempt || !code || code.length > 512) return redirect('/?sign-in=expired', [clearState]);

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: app.clientId, client_secret: app.clientSecret,
      redirect_uri: callbackUrl(env), code, code_verifier: attempt.verifier,
    }),
  });
  if (!response.ok) return redirect('/?sign-in=failed', [clearState]);
  const grant = await response.json();
  if (!/^ghu_[A-Za-z0-9]+$/.test(grant.access_token) || !(grant.expires_in > 0)) {
    return redirect('/?sign-in=failed', [clearState]);
  }

  const user = await github(grant.access_token, '/user');
  if (user.id !== OWNER_ID) return redirect('/?sign-in=denied', [clearState]);

  const sessionId = randomId();
  const id = await sha256(sessionId);
  const lifetime = Math.min(SESSION_TTL, grant.expires_in);
  const oldSession = getCookie(request, SESSION_COOKIE);
  if (validId(oldSession)) {
    await env.ALFRED_DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(oldSession)).run();
  }
  await env.ALFRED_DB.prepare('INSERT INTO sessions (id, token, expires_at) VALUES (?, ?, ?)')
    .bind(id, await encryptToken(env, grant.access_token, id), Date.now() + lifetime * 1000).run();
  return redirect('/', [clearState, cookie(SESSION_COOKIE, sessionId, lifetime)]);
}

async function session(request, env) {
  const value = getCookie(request, SESSION_COOKIE);
  if (!validId(value)) return null;
  const id = await sha256(value);
  const row = await env.ALFRED_DB.prepare('SELECT token FROM sessions WHERE id = ? AND expires_at > ?')
    .bind(id, Date.now()).first();
  return row ? decryptToken(env, row.token, id) : null;
}

async function signOut(request, env) {
  const value = getCookie(request, SESSION_COOKIE);
  if (validId(value)) {
    await env.ALFRED_DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256(value)).run();
  }
  return redirect('/', [cookie(SESSION_COOKIE, '', 0), cookie(STATE_COOKIE, '', 0)]);
}

function repositoryUrl(repo) {
  return 'https://github.com/' + OWNER + '/' + repo;
}

function apiRepo(project) {
  return '/repos/' + OWNER + '/' + project.repo;
}

function issueNumber(env, project) {
  try {
    const number = JSON.parse(env.ALFRED_DECISION_ISSUES || '{}')[project.id];
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

function marker(project) {
  return '<!-- alfred-decision:' + project.id + ':v1 -->';
}

function decisionRecord(issue, project, number) {
  if (issue.number !== number || issue.pull_request || !issue.body?.startsWith(marker(project) + '\n')) {
    return null;
  }
  const choice = issue.body.match(/^Answer: (YES|NO|DEFER)$/m)?.[1] ?? null;
  const recordedAt = issue.body.match(/^Recorded at: (\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/m)?.[1] ?? null;
  return {
    choice, recordedAt,
    ready: issue.state === 'open',
    url: repositoryUrl(project.repo) + '/issues/' + number,
  };
}

async function readDecision(token, env, project) {
  const number = issueNumber(env, project);
  if (!number) return null;
  const issue = await github(token, apiRepo(project) + '/issues/' + number);
  return decisionRecord(issue, project, number);
}

async function projectState(token, env, project) {
  const base = apiRepo(project);
  const [issues, pulls, decision] = await Promise.allSettled([
    github(token, base + '/issues?state=open&sort=updated&direction=desc&per_page=20'),
    github(token, base + '/pulls?state=open&sort=updated&direction=desc&per_page=10'),
    readDecision(token, env, project),
  ]);
  const issuesOk = issues.status === 'fulfilled';
  const pullsOk = pulls.status === 'fulfilled';
  const tasks = [
    ...(issuesOk ? issues.value.filter(item => !item.pull_request && !item.body?.startsWith('<!-- alfred-decision:'))
      .map(item => ({ ...item, kind: 'Issue', path: 'issues/' })) : []),
    ...(pullsOk ? pulls.value.map(item => ({ ...item, kind: item.draft ? 'Draft PR' : 'PR', path: 'pull/' })) : []),
  ].sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, 3);

  return {
    ...project,
    repositoryUrl: repositoryUrl(project.repo),
    references: project.references.map(ref => ({
      title: ref.title, url: repositoryUrl(ref.repo || project.repo) + '/' + ref.path,
    })),
    activity: issuesOk && pullsOk ? 'live' : issuesOk || pullsOk ? 'partial' : 'unavailable',
    tasks: tasks.map(item => ({
      title: item.title, kind: item.kind, number: item.number,
      url: repositoryUrl(project.repo) + '/' + item.path + item.number,
    })),
    decision: decision.status === 'fulfilled' ? decision.value : null,
  };
}

async function dashboard(token, env) {
  const user = await github(token, '/user');
  if (user.id !== OWNER_ID) return json({ error: 'GitHub sign-in is required.' }, 401);
  const projects = await Promise.all(PROJECTS.map(project => projectState(token, env, project)));
  return json({
    account: user.login,
    checkedAt: new Date().toISOString(),
    briefDate: '8 November 2026',
    projects,
  });
}

async function recordDecision(request, token, env, id) {
  const project = PROJECTS.find(item => item.id === id);
  if (!project) return json({ error: 'Decision not found.' }, 404);
  if (request.headers.get('Content-Type') !== 'application/json') {
    return json({ error: 'A JSON decision is required.' }, 415);
  }
  const input = await request.json().catch(() => null);
  if (!CHOICES.has(input?.choice) || Object.keys(input).length !== 1) {
    return json({ error: 'Choose YES, NO or DEFER.' }, 400);
  }
  const user = await github(token, '/user');
  if (user.id !== OWNER_ID) return json({ error: 'GitHub sign-in is required.' }, 401);
  const record = await readDecision(token, env, project);
  if (!record?.ready) return json({ error: 'The decision issue is unavailable.' }, 409);
  if (record.choice === input.choice) return json({ decision: record });

  const number = issueNumber(env, project);
  const body = [
    marker(project), '', project.question, '', 'Answer: ' + input.choice,
    'Recorded by: ' + user.login, 'Recorded at: ' + new Date().toISOString(), '',
    'This issue records a decision. It does not start work, dispatch Claude, merge or deploy.',
  ].join('\n');
  const issue = await github(token, apiRepo(project) + '/issues/' + number, 'PATCH', { body });
  return json({ decision: decisionRecord(issue, project, number) });
}

const CLAUDE_REPO = 'Deceivers';
const HANDOFF_TTL = 10 * 60 * 1000;

function handoffPage(content, status = 200) {
  return htmlPage(content + '<p><a href="/">Back to Alfred</a></p>', [], 'Claude handoff', status);
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function handoffIssue(token, number) {
  const issue = await github(token, '/repos/' + OWNER + '/' + CLAUDE_REPO + '/issues/' + number);
  if (issue.number !== number || issue.pull_request || issue.state !== 'open') return null;
  return {
    title: issue.title, body: issue.body ?? '',
    revision: await sha256(JSON.stringify([issue.title, issue.body ?? ''])),
  };
}

async function claudeHandoff(request, env, path, token) {
  if (path === '/handoff' && request.method === 'GET') {
    return handoffPage([
      '<p>Run a free rehearsal of the approval gate using an open Deceivers issue.</p>',
      '<p>Maximum cost £0. The rehearsal records an approval and makes zero Claude calls.</p>',
      '<form method="post" action="/handoff/review"><label>Deceivers issue number ',
      '<input type="number" name="issue" required min="1" inputmode="numeric"></label> ',
      '<button class="button primary" type="submit">Review rehearsal</button></form>',
    ].join(''));
  }
  if (request.method !== 'POST' ||
      !['/handoff/review', '/handoff/approve'].includes(path)) {
    return handoffPage('<p>Page not found.</p>', 404);
  }

  const form = await request.formData().catch(() => null);
  const db = env.ALFRED_DB;
  if (path === '/handoff/review') {
    const rawIssue = form?.get('issue');
    const issueNumber = Number(rawIssue);
    if (typeof rawIssue !== 'string' || !/^[1-9][0-9]*$/.test(rawIssue) ||
        !Number.isSafeInteger(issueNumber)) return handoffPage('<p>Enter a valid issue number.</p>', 400);
    const issue = await handoffIssue(token, issueNumber);
    if (!issue) return handoffPage('<p>Choose an open Deceivers issue.</p>', 409);
    const id = randomId();
    const now = Date.now();
    await db.batch([
      db.prepare('DELETE FROM claude_rehearsals WHERE expires_at <= ? AND used_at IS NULL').bind(now),
      db.prepare('INSERT INTO claude_rehearsals (id, issue_number, revision, expires_at) VALUES (?, ?, ?, ?)')
        .bind(id, issueNumber, issue.revision, now + HANDOFF_TTL),
    ]);
    return handoffPage([
      '<p>Deceivers #' + issueNumber + ' · ' + escapeHtml(issue.title) + '</p>',
      '<p>Scope: approval rehearsal only. Maximum cost £0. This approval expires in 10 minutes.</p>',
      '<details><summary>Review the issue text</summary><p>' +
      escapeHtml(issue.body).replaceAll('\n', '<br>') + '</p></details>',
      '<form method="post" action="/handoff/approve">',
      '<input type="hidden" name="proposal" value="' + id + '">',
      '<button class="button primary" type="submit">Approve £0 rehearsal</button></form>',
    ].join(''));
  }

  const id = form?.get('proposal');
  if (!validId(id)) return handoffPage('<p>Open a new rehearsal to continue.</p>', 400);
  const proposal = await db.prepare(
    'SELECT issue_number, revision FROM claude_rehearsals WHERE id = ? AND expires_at > ? AND used_at IS NULL',
  ).bind(id, Date.now()).first();
  const unavailable = '<p>This rehearsal expired or was already used. <a href="/handoff">Start again</a>.</p>';
  if (!proposal) return handoffPage(unavailable, 409);
  const issue = await handoffIssue(token, proposal.issue_number);
  if (!issue || issue.revision !== proposal.revision) {
    return handoffPage('<p>The issue changed. <a href="/handoff">Review it again</a>.</p>', 409);
  }
  const consumed = await db.prepare(
    'UPDATE claude_rehearsals SET used_at = ? WHERE id = ? AND expires_at > ? AND used_at IS NULL RETURNING id',
  ).bind(Date.now(), id, Date.now()).first();
  return consumed ? handoffPage([
    '<p>One-use approval recorded for Deceivers #' + proposal.issue_number + '.</p>',
    '<p>Rehearsal complete. Cost £0. Claude calls 0.</p>',
    '<p><a href="/handoff">Open another rehearsal</a></p>',
  ].join('')) : handoffPage(unavailable, 409);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (ASSETS.has(path) && (request.method === 'GET' || request.method === 'HEAD')) {
    return env.ASSETS.fetch(request);
  }
  const isSetup = path === '/setup/github' || path === '/setup/github/callback';
  const isHandoff = path === '/handoff' || path.startsWith('/handoff/');
  if (!path.startsWith('/api/') && !path.startsWith('/auth/') && !isSetup && !isHandoff) {
    return json({ error: 'Page not found.' }, 404);
  }
  if (!configured(env)) return json({ error: 'GitHub sign-in is awaiting preview configuration.' }, 503);
  if (url.origin !== env.ALFRED_ORIGIN) return json({ error: 'Open the configured Alfred preview address.' }, 421);

  const isRead = request.method === 'GET';
  const isWrite = request.method === 'POST';
  if (isWrite && request.headers.get('Origin') !== url.origin) {
    return json({ error: 'Request rejected.' }, 403);
  }
  const app = await githubApp(env);
  if (isSetup && isRead) {
    if (path === '/setup/github') return startGithubSetup(env, app);
    return app ? redirect('/setup/github') : finishGithubSetup(request, env, url);
  }
  if (!app) return json({ error: 'GitHub sign-in is awaiting preview configuration.' }, 503);
  if (isHandoff) {
    const token = await session(request, env);
    return token ? claudeHandoff(request, env, path, token) :
      handoffPage('<p>Sign in with GitHub from Alfred to open the handoff.</p>', 401);
  }
  if (path === '/auth/login' && isWrite) return startLogin(env, app);
  if (path === '/auth/callback' && isRead) return finishLogin(request, env, url, app);
  if (path === '/auth/logout' && isWrite) return signOut(request, env);
  if (path === '/api/dashboard' && isRead) {
    const token = await session(request, env);
    return token ? dashboard(token, env) : json({ error: 'Sign in to GitHub to see your projects.' }, 401);
  }
  const match = /^\/api\/decisions\/([a-z-]+)$/.exec(path);
  if (match && isWrite) {
    const token = await session(request, env);
    return token ? recordDecision(request, token, env, match[1]) : json({ error: 'Sign in to GitHub to record a decision.' }, 401);
  }
  return json({ error: 'Route not found.' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return secure(await route(request, env));
    } catch (error) {
      if (error instanceof GitHubError) {
        if (error.status === 401) return secure(json({ error: 'GitHub sign-in expired. Sign in again.' }, 401));
        if (error.status === 403 || error.status === 404) {
          return secure(json({ error: 'GitHub denied access. Check the app installation and repository permissions.' }, 502));
        }
      }
      return secure(json({ error: 'Alfred could not confirm the request. Refresh before retrying.' }, 502));
    }
  },
};
