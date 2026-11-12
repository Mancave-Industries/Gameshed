import { executionSpec, nextProposal, validateOutput, MAX_SOURCE_BYTES } from './execution-policy.js';

const OWNER = 'Mancave-Industries';
const OWNER_ID = 287470662;
const ROOT = '/repos/' + OWNER + '/Gameshed/issues';
const MARKER = '<!-- alfred-workflow-event:v1 -->\n';
const PROPOSAL = '<!-- alfred-workflow:v1 -->\n';
const enc = new TextEncoder();
const decode = s => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const parse = (body, marker) => { try { return body?.startsWith(marker) ? JSON.parse(body.slice(marker.length)) : null; } catch { return null; } };
const response = (data, status = 200) => Response.json(data, { status });

// GitHub's short-lived, audience-bound job identity replaces a shared callback
// secret. A token from another repository, workflow revision or rerun is rejected.
export async function runnerIdentity(request, env) {
  if (!env.ALFRED_EXECUTOR_SHA || !env.ALFRED_EXECUTOR_REF) throw new Error('Runner activation is pending.');
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (token.length > 16000) throw new Error('Invalid runner identity.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid runner identity.');
  // Errors from native crypto/fetch must never expose token or provider text.
  const step = async (message, operation) => {
    try { return await operation(); } catch { throw new Error(message); }
  };
  const [header, claims] = await step('Invalid runner identity.', () =>
    [JSON.parse(new TextDecoder().decode(decode(parts[0]))), JSON.parse(new TextDecoder().decode(decode(parts[1]))) ]);
  if (!header || !claims || typeof claims !== 'object' || Array.isArray(claims) ||
      header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Invalid runner signature.');
  const jwks = await step('Runner signing-key request failed.', () =>
    // Workers supports manual/follow only. Manual plus the !ok check below
    // rejects redirects without following them or weakening identity checks.
    fetch('https://token.actions.githubusercontent.com/.well-known/jwks', { redirect: 'manual', signal: AbortSignal.timeout(8000) }));
  if (!jwks.ok) throw new Error('GitHub identity verification is unavailable.');
  const keys = await step('Runner signing-key response is invalid.', async () => {
    const body = await jwks.json();
    if (!Array.isArray(body?.keys)) throw new Error();
    return body.keys;
  });
  const jwk = keys.find(k => k?.kid === header.kid && k.kty === 'RSA');
  if (!jwk) throw new Error('Unknown runner signing key.');
  const key = await step('Runner signing-key import failed.', () =>
    crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  const valid = await step('Runner signature verification failed.', () =>
    crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), enc.encode(parts[0] + '.' + parts[1])));
  if (!valid) throw new Error('Invalid runner signature.');
  const now = Date.now() / 1000;
  const workflow = OWNER + '/Gameshed/.github/workflows/alfred-execute.yml@' + env.ALFRED_EXECUTOR_REF;
  if (claims.iss !== 'https://token.actions.githubusercontent.com' || claims.aud !== env.ALFRED_ORIGIN ||
      claims.repository_id !== '1395042959' || claims.repository_owner_id !== String(OWNER_ID) ||
      claims.workflow_ref !== workflow || claims.sha !== env.ALFRED_EXECUTOR_SHA ||
      !['issue_comment', 'workflow_dispatch', 'schedule'].includes(claims.event_name) ||
      !Number.isFinite(claims.exp) || claims.exp <= now || claims.nbf > now + 30 ||
      !/^\d+$/.test(claims.run_id) || claims.run_attempt !== '1') throw new Error('Runner scope or revision does not match activation.');
  return claims;
}

export function executor(helpers) {
  const { github, encryptToken, decryptToken, workflowState, workflowProposal, sha256 } = helpers;
  const db = env => env.ALFRED_DB;
  async function event(token, number, value) {
    const body = MARKER + JSON.stringify(value);
    const comments = await github(token, ROOT + '/' + number + '/comments?per_page=100');
    if (comments.length === 100) throw new Error('Workflow history requires review.');
    if (comments.some(c => c.user?.id === OWNER_ID && c.body === body)) return;
    const added = await github(token, ROOT + '/' + number + '/comments', 'POST', { body });
    const read = await github(token, ROOT + '/' + number + '/comments?per_page=100');
    if (!read.some(c => c.id === added.id && c.user?.id === OWNER_ID && c.body === body)) throw new Error('GitHub did not confirm the status event.');
  }
  async function current(token, number) {
    const issue = await github(token, ROOT + '/' + number);
    const p = workflowProposal(issue);
    if (!p?.open) throw new Error('The approved issue is no longer open.');
    return { issue, state: await workflowState(token, p) };
  }
  async function queue(env, token, issue, state, option) {
    const spec = executionSpec(option.execution);
    if (!spec || !state.decisionId) return;
    const snapshot = JSON.stringify({ body: issue.body, spec, option: option.id, label: option.label, detail: option.detail, project: state.project, title: state.title });
    const id = String(state.decisionId);
    await db(env).prepare('INSERT OR IGNORE INTO executions (decision_id, issue_number, snapshot, credential, status, expires_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(state.decisionId, state.number, snapshot, await encryptToken(env, token, 'execution:' + id), 'queued', Date.now() + 6 * 3600000, Date.now()).run();
  }
  async function source(token, spec) {
    const base = '/repos/' + OWNER + '/' + spec.repo;
    const commit = await github(token, base + '/git/commits/' + spec.sha);
    const tree = await github(token, base + '/git/trees/' + commit.tree.sha + '?recursive=1');
    if (tree.truncated) throw new Error('Source tree is too large for this bounded task.');
    const files = [];
    let bytes = 0;
    for (const path of spec.paths) {
      const entry = tree.tree.find(x => x.path === path);
      if (!entry || entry.type !== 'blob' || entry.mode !== '100644' || entry.size > MAX_SOURCE_BYTES) throw new Error('Approved source file is missing, oversized or not a regular text file.');
      const blob = await github(token, base + '/git/blobs/' + entry.sha);
      if (blob.encoding !== 'base64') throw new Error('Source encoding is unsupported.');
      const raw = decode(blob.content.replace(/\s/g, ''));
      bytes += raw.length;
      if (bytes > MAX_SOURCE_BYTES || raw.includes(0)) throw new Error('Approved source exceeds the text limit.');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      if (/sk-ant-|-----BEGIN .*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20}/.test(content)) throw new Error('Source may contain a credential; remove it before running.');
      files.push({ path, content });
    }
    return files;
  }
  async function claim(env, claims, input) {
    const id = input.decisionId;
    if (!Number.isSafeInteger(id)) return response({ error: 'A recorded decision is required.' }, 400);
    let row = await db(env).prepare('SELECT * FROM executions WHERE decision_id = ?').bind(id).first();
    if (!row) return response({ error: 'The approval has not reached the queue yet.' }, 409);
    if (row.run_id || row.status !== 'queued') return response({ error: 'This approval has already been consumed.' }, 409);
    if (row.expires_at < Date.now()) return response({ error: 'Approval expired. Sign in and approve a fresh proposal.' }, 409);
    const token = await decryptToken(env, row.credential, 'execution:' + id);
    const snapshot = JSON.parse(row.snapshot);
    const { issue, state } = await current(token, row.issue_number);
    if (issue.body !== snapshot.body || state.decisionId !== id || state.choice !== snapshot.option || state.status !== 'queued') return response({ error: 'Approval scope changed or work was already started.' }, 409);
    // Authenticate the triggering GitHub event, not a caller-supplied issue ID.
    const run = await github(token, '/repos/' + OWNER + '/Gameshed/actions/runs/' + claims.run_id);
    if (run.head_sha !== claims.sha || run.path !== '.github/workflows/alfred-execute.yml' || run.event !== claims.event_name) throw new Error('GitHub run evidence does not match.');
    const files = await source(token, snapshot.spec);
    const consumed = await db(env).prepare('UPDATE executions SET status = ?, run_id = ?, attempt = 1, heartbeat_at = ? WHERE decision_id = ? AND status = ? AND run_id IS NULL RETURNING decision_id')
      .bind('running', claims.run_id, Date.now(), id, 'queued').first();
    if (!consumed) return response({ error: 'This approval was consumed by another runner.' }, 409);
    await event(token, row.issue_number, { type: 'started', decisionId: id });
    return response({ decisionId: id, task: snapshot, files });
  }
  // Read-only startup inspection. It never claims work, refreshes a grant,
  // writes status events, returns source/credentials or invokes a model.
  async function probe(env, claims, input) {
    if (claims.event_name !== 'workflow_dispatch') return response({ code: 'probe-manual-only' }, 403);
    if (!Number.isSafeInteger(input.decisionId) || input.decisionId < 1) return response({ code: 'decision-invalid' }, 400);
    let phase = 'queue';
    try {
      const row = await db(env).prepare('SELECT * FROM executions WHERE decision_id = ?').bind(input.decisionId).first();
      if (!row) return response({ code: 'queue-missing' }, 409);
      phase = 'credential';
      const token = await decryptToken(env, row.credential, 'execution:' + input.decisionId);
      const snapshot = JSON.parse(row.snapshot);
      phase = 'approval';
      const { issue, state } = await current(token, row.issue_number);
      if (issue.body !== snapshot.body || state.decisionId !== input.decisionId || state.choice !== snapshot.option) {
        return response({ code: 'approval-scope-changed' }, 409);
      }
      phase = 'actions-read';
      const run = await github(token, '/repos/' + OWNER + '/Gameshed/actions/runs/' + claims.run_id);
      if (run.head_sha !== claims.sha || run.path !== '.github/workflows/alfred-execute.yml' || run.event !== claims.event_name) {
        return response({ code: 'run-mismatch' }, 403);
      }
      phase = 'source';
      const files = await source(token, snapshot.spec);
      return response({ status: 'diagnosed', queueStatus: row.status, expired: row.expires_at < Date.now(),
        alreadyClaimed: Boolean(row.run_id), sourceFiles: files.length, inferenceStarted: false });
    } catch (error) {
      const status = [401, 403, 404].includes(error?.status) ? '-http-' + error.status : '-failed';
      return response({ code: 'probe-' + phase + status }, 403);
    }
  }
  async function publish(token, row, output) {
    const { spec } = JSON.parse(row.snapshot);
    const base = '/repos/' + OWNER + '/' + spec.repo;
    if (!output.files.length) return { sha: spec.sha, url: 'https://github.com/' + OWNER + '/' + spec.repo + '/commit/' + spec.sha };
    const branch = 'alfred/work-' + row.decision_id;
    const parent = await github(token, base + '/git/commits/' + spec.sha);
    const tree = await github(token, base + '/git/trees', 'POST', { base_tree: parent.tree.sha,
      tree: output.files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) });
    const commit = await github(token, base + '/git/commits', 'POST', { message: 'Alfred approved task ' + row.decision_id, tree: tree.sha, parents: [spec.sha] });
    // Deterministic branch and read-back make a lost callback safe to replay.
    let existing = null;
    try { existing = await github(token, base + '/git/ref/heads/' + branch); } catch (e) { if (e.status !== 404) throw e; }
    if (existing) {
      const prior = await github(token, base + '/git/commits/' + existing.object.sha);
      if (prior.tree.sha !== tree.sha || prior.parents?.[0]?.sha !== spec.sha) throw new Error('The review branch changed; owner review is required.');
    } else await github(token, base + '/git/refs', 'POST', { ref: 'refs/heads/' + branch, sha: commit.sha });
    const ref = await github(token, base + '/git/ref/heads/' + branch);
    const read = await github(token, base + '/git/commits/' + ref.object.sha);
    if (read.tree.sha !== tree.sha) throw new Error('GitHub did not confirm the generated files.');
    // Use a draft PR only when the approved source is a branch tip. Commit URLs
    // remain durable evidence for tasks based on an older immutable revision.
    return { sha: ref.object.sha, url: 'https://github.com/' + OWNER + '/' + spec.repo + '/tree/' + branch };
  }
  async function next(token, env, row, output, publication) {
    const snapshot = JSON.parse(row.snapshot);
    const p = nextProposal(output.nextDecision, snapshot.project, { spec: snapshot.spec, sha: publication.sha });
    if (!p || row.next_issue) return;
    const issueList = await github(token, ROOT + '?state=all&per_page=100&sort=updated');
    if (issueList.length === 100) throw new Error('Next-decision history requires review.');
    const duplicate = issueList.find(i => i.user?.id === OWNER_ID && parse(i.body, PROPOSAL)?.project === p.project && parse(i.body, PROPOSAL)?.title === p.title);
    const issue = duplicate ?? await github(token, ROOT, 'POST', { title: '[Alfred workflow] ' + p.title, body: PROPOSAL + JSON.stringify(p, null, 2) });
    const read = await github(token, ROOT + '/' + issue.number);
    if (read.user?.id !== OWNER_ID || !parse(read.body, PROPOSAL)) throw new Error('Next decision was not confirmed.');
    await db(env).prepare('UPDATE executions SET next_issue = ? WHERE decision_id = ?').bind(issue.number, row.decision_id).run();
  }
  async function finish(env, claims, input) {
    const row = await db(env).prepare('SELECT * FROM executions WHERE decision_id = ?').bind(input.decisionId).first();
    if (!row || row.run_id !== claims.run_id) return response({ error: 'Runner does not own this decision.' }, 403);
    if (row.status === 'verified') return response({ status: 'verified', nextIssue: row.next_issue });
    if (!['running', 'verifying'].includes(row.status)) return response({ error: 'Run is no longer active.' }, 409);
    const token = await decryptToken(env, row.credential, 'execution:' + row.decision_id);
    if (input.phase === 'heartbeat') {
      await db(env).prepare('UPDATE executions SET heartbeat_at = ? WHERE decision_id = ?').bind(Date.now(), row.decision_id).run();
      return response({ status: row.status });
    }
    if (input.phase === 'checking') {
      await event(token, row.issue_number, { type: 'checking', decisionId: row.decision_id });
      return response({ status: 'checking' });
    }
    if (input.phase === 'blocked') {
      const result = 'Automatic execution stopped. ' + String(input.result || 'The runner did not complete its checks.').slice(0, 1000) + ' No automatic paid retry will run; review the blocker before a new approval.';
      await event(token, row.issue_number, { type: 'blocked', decisionId: row.decision_id, result });
      await db(env).prepare('UPDATE executions SET status = ?, result = ? WHERE decision_id = ?').bind('blocked', result, row.decision_id).run();
      return response({ status: 'blocked' });
    }
    if (input.phase !== 'result') return response({ error: 'Unknown runner phase.' }, 400);
    const snapshot = JSON.parse(row.snapshot);
    const { issue, state } = await current(token, row.issue_number);
    if (issue.body !== snapshot.body || state.decisionId !== row.decision_id || !['running', 'checking', 'completed', 'verifying', 'verified'].includes(state.status)) throw new Error('Scope changed during the run.');
    const output = validateOutput(input.output, snapshot.spec);
    if (!input.evidence || input.evidence.profile !== snapshot.spec.profile || input.evidence.sourceSha !== snapshot.spec.sha ||
        input.evidence.passed !== true || !/^[A-Za-z0-9_-]{43}$/.test(input.evidence.outputHash ?? '') ||
        input.evidence.outputHash !== await sha256(JSON.stringify(output))) throw new Error('Independent verification evidence is missing.');
    if (row.output && row.output !== JSON.stringify(output)) throw new Error('A retry changed the generated output.');
    const locked = await db(env).prepare('UPDATE executions SET status = ?, output = ?, heartbeat_at = ? WHERE decision_id = ? AND (status = ? OR (status = ? AND heartbeat_at < ?)) RETURNING decision_id')
      .bind('verifying', JSON.stringify(output), Date.now(), row.decision_id, 'running', 'verifying', Date.now() - 60000).first();
    if (!locked) return response({ error: 'Result delivery is already being checked. Retry delivery after one minute; do not rerun Claude.' }, 409);
    const publication = await publish(token, row, output);
    const result = (output.result + '\n\nChecked against source ' + snapshot.spec.sha + '. ' +
      (snapshot.spec.profile === 'source-review' ? 'Source and report format checked; factual accuracy still needs human review.' : 'The original and changed code passed the approved checks in a network-disabled container. Changes are on an isolated review branch.') +
      '\nEvidence: ' + publication.url + '\nRunner: https://github.com/' + OWNER + '/Gameshed/actions/runs/' + claims.run_id +
      '\nNext: review the result and the suggested next decision in Alfred. Nothing was merged or deployed.').slice(0, 4000);
    await event(token, row.issue_number, { type: 'completed', decisionId: row.decision_id, result });
    await event(token, row.issue_number, { type: 'verifying', decisionId: row.decision_id });
    await event(token, row.issue_number, { type: 'verified', decisionId: row.decision_id, by: 'alfred', result: 'Runner checks and GitHub read-back passed. This verifies only the approved automated checks; owner acceptance remains separate.' });
    await next(token, env, row, output, publication);
    await db(env).prepare('UPDATE executions SET status = ?, result = ?, published_sha = ? WHERE decision_id = ?')
      .bind('verified', result, publication.sha, row.decision_id).run();
    return response({ status: 'verified' });
  }
  async function monitor(env, token) {
    const rows = (await db(env).prepare("SELECT * FROM executions WHERE status IN ('queued', 'running', 'verifying')").all()).results;
    for (const row of rows) {
      const elapsed = Date.now() - row.heartbeat_at;
      if (elapsed < (row.status === 'queued' ? 10 : 20) * 60000) continue;
      const result = row.status === 'queued'
        ? 'The approved task did not reach the runner. Check that the execution workflow is installed on the default branch and the GitHub App can read Actions. No Claude request has been authorised by a runner.'
        : 'The runner stopped reporting progress. Inspect its GitHub run before approving any retry; a Claude request may already have incurred a charge.';
      await event(token, row.issue_number, { type: 'blocked', decisionId: row.decision_id, result });
      await db(env).prepare('UPDATE executions SET status = ?, result = ? WHERE decision_id = ? AND status = ?')
        .bind('blocked', result, row.decision_id, row.status).run();
    }
  }
  async function route(request, env) {
    let diagnostic = 'identity';
    try {
      const claims = await runnerIdentity(request, env);
      diagnostic = 'request';
      const input = await request.json();
      if (JSON.stringify(input).length > 150000) return response({ error: 'Runner result exceeds the limit.' }, 413);
      if (new URL(request.url).pathname.endsWith('/probe')) return await probe(env, claims, input);
      if (new URL(request.url).pathname.endsWith('/source')) {
        const row = await db(env).prepare('SELECT * FROM executions WHERE decision_id = ?').bind(input.decisionId).first();
        if (!row || row.run_id !== claims.run_id || row.status !== 'running') return response({ error: 'No active source grant.' }, 403);
        const { spec } = JSON.parse(row.snapshot);
        const token = await decryptToken(env, row.credential, 'execution:' + row.decision_id);
        const archive = await fetch('https://api.github.com/repos/' + OWNER + '/' + spec.repo + '/tarball/' + spec.sha, {
          redirect: 'manual', signal: AbortSignal.timeout(15000),
          headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'Alfred-Control-Centre', Accept: 'application/vnd.github+json' },
        });
        const location = new URL(archive.headers.get('Location') ?? 'https://invalid.test');
        if (archive.status !== 302 || location.hostname !== 'codeload.github.com' || location.protocol !== 'https:' || !location.pathname.startsWith('/' + OWNER + '/' + spec.repo + '/')) throw new Error('Source archive redirect rejected.');
        // Never forward the GitHub credential to the archive host.
        const downloaded = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!downloaded.ok) throw new Error('Source archive unavailable.');
        return new Response(downloaded.body, { headers: { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store' } });
      }
      diagnostic = new URL(request.url).pathname.endsWith('/claim') ? 'claim' : 'finish';
      return await (new URL(request.url).pathname.endsWith('/claim') ? claim(env, claims, input) : finish(env, claims, input));
    } catch (error) {
      // Only locally authored messages are public; never relay provider errors.
      const known = new Map([
        ['Runner activation is pending.', 'activation-pending'],
        ['Invalid runner identity.', 'identity-invalid'],
        ['Invalid runner signature.', 'signature-invalid'],
        ['GitHub identity verification is unavailable.', 'identity-service-unavailable'],
        ['Unknown runner signing key.', 'signing-key-unknown'],
        ['Runner signing-key request failed.', 'signing-key-fetch-failed'],
        ['Runner signing-key response is invalid.', 'signing-key-response-invalid'],
        ['Runner signing-key import failed.', 'signing-key-import-failed'],
        ['Runner signature verification failed.', 'signature-verification-failed'],
        ['Runner scope or revision does not match activation.', 'activation-mismatch'],
        ['GitHub run evidence does not match.', 'run-mismatch'],
        ['The approved issue is no longer open.', 'issue-closed'],
        ['Approved source file is missing, oversized or not a regular text file.', 'source-file-invalid'],
        ['Source may contain a credential; remove it before running.', 'source-credential-detected'],
      ]);
      return response({ error: 'Runner request could not be verified. No automatic retry is authorised.', code: known.get(error?.message) ?? diagnostic + '-failed' }, 403);
    }
  }
  return { queue, route, monitor, source, claim, finish };
}
