import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';

const token = process.env.CLOUDFLARE_API_TOKEN;
const projectName = 'alfred-control-centre-1395042959';
const productionBranch = 'alfred-production-disabled';
const previewBranch = 'review';
const databaseName = projectName + '-sessions';
const wrangler = process.argv[2];

async function api(path, method = 'GET', body, allowMissing = false) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (allowMissing && response.status === 404) return null;
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) {
    const codes = (result?.errors ?? []).map(error => error.code).filter(Number.isInteger);
    throw new Error(method + ' ' + path + ' failed (HTTP ' + response.status + ', codes ' + codes.join(',') + ').');
  }
  return result.result;
}

async function accountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) {
    if (!/^[a-f0-9]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID)) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID.');
    }
    return process.env.CLOUDFLARE_ACCOUNT_ID;
  }
  let accounts;
  try {
    accounts = await api('/accounts?per_page=2');
  } catch {
    throw new Error('Account discovery is unavailable. Set CLOUDFLARE_ACCOUNT_ID on the Alfred-preview environment.');
  }
  if (accounts.length !== 1 || !/^[a-f0-9]{32}$/i.test(accounts[0].id)) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID to the account that hosts ManCave Industries.');
  }
  return accounts[0].id;
}

async function deploy() {
  if (!token || !wrangler) throw new Error('The preview deployment requires a Cloudflare token and Wrangler.');
  const id = await accountId();
  const root = '/accounts/' + id;
  const projects = root + '/pages/projects';
  const target = projects + '/' + projectName;
  let project = await api(target, 'GET', undefined, true);
  if (!project) {
    project = await api(projects, 'POST', { name: projectName, production_branch: productionBranch });
  }
  if (project.name !== projectName || project.production_branch !== productionBranch ||
      project.source || !/^[a-z0-9-]+\.pages\.dev$/.test(project.subdomain) ||
      project.domains?.some(domain => domain !== project.subdomain)) {
    throw new Error('The target is outside the Alfred preview deployment scope.');
  }

  const databasePath = root + '/d1/database';
  const databases = await api(databasePath + '?name=' + databaseName);
  const matches = databases.filter(database => database.name === databaseName);
  if (matches.length > 1) throw new Error('More than one Alfred preview session database matched.');
  const database = matches[0] ?? await api(databasePath, 'POST', { name: databaseName });
  if (!/^[a-f0-9-]{36}$/i.test(database.uuid)) throw new Error('Invalid preview database ID.');
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.split(';').map(sql => sql.trim()).filter(Boolean)) {
    await api(databasePath + '/' + database.uuid + '/query', 'POST', { sql: statement });
  }

  const origin = 'https://' + previewBranch + '.' + project.subdomain;
  const envVars = {
    ALFRED_ORIGIN: { type: 'plain_text', value: origin },
    ALFRED_DECISION_ISSUES: { type: 'plain_text', value: JSON.stringify({
      'deceivers-audit': 17, 'science-mvp': 19, 'mci-freeze': 1, 'songbook-hold': 1,
    }) },
  };
  if (!project.deployment_configs?.preview?.env_vars?.ALFRED_SESSION_KEY) {
    envVars.ALFRED_SESSION_KEY = { type: 'secret_text', value: randomBytes(32).toString('base64url') };
  }
  await api(target, 'PATCH', { deployment_configs: { preview: {
    compatibility_date: '2026-10-01',
    d1_databases: { ALFRED_DB: { id: database.uuid } },
    env_vars: envVars,
  } } });

  execFileSync(wrangler, [
    'pages', 'deploy', 'alfred/public', '--project-name', projectName, '--branch', previewBranch,
  ], { stdio: 'inherit', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: id } });

  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(origin, { redirect: 'error', signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (response?.ok && (await response.text()).includes('<title>Alfred Control Centre</title>')) {
      console.log('Verified preview: ' + origin);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Alfred preview: ' + origin + '\n');
      return;
    }
    await wait(3000);
  }
  throw new Error('The Alfred preview did not return the expected page.');
}

deploy().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
