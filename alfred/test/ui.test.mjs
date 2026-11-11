// Browser tests of the conversational workspace on an emulated iPhone, against the real
// Worker running offline (see harness.mjs). Skipped when Playwright is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { createHarness } from './harness.mjs';
import { liveFixtures } from './harness.mjs';
import { run } from '../runner/run.mjs';

let playwright = null;
try { playwright = createRequire(import.meta.url)('playwright'); } catch {}
const shots = process.env.ALFRED_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });

let port = 8790;
async function open(t, options = {}) {
  const origin = 'http://localhost:' + port++;
  const h = await createHarness({ origin, ...options });
  const server = await h.serve();
  t.after(async () => { server.close(); h.restore(); });
  const browser = await playwright.chromium.launch({ executablePath: process.env.ALFRED_CHROMIUM || undefined, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); });
  const session = await h.signIn();
  // Browsers refuse a Secure __Host- cookie over plain local HTTP, so the test sends
  // the session cookie as a header instead.
  const context = await browser.newContext({
    ...playwright.devices['iPhone 13'],
    extraHTTPHeaders: { Cookie: '__Host-alfred_session=' + session },
  });
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(origin + '/');
  await page.locator('#brief').waitFor();
  return { h, page, errors };
}

const shot = (page, name) => shots ? page.screenshot({ path: shots + '/' + name + '.png', fullPage: true }) : null;
async function sayText(page, text) {
  await page.fill('#say', text);
  await page.press('#say', 'Enter');
}

test('mobile workspace: brief, check card, next decision, no overflow, no errors', { skip: !playwright }, async t => {
  const { h, page, errors } = await open(t);
  const brief = page.locator('#brief');
  await assert.doesNotReject(brief.getByText('You have 1 result to check and 2 decisions for you.').waitFor());
  await brief.getByRole('heading', { name: 'Choose the first Biology lesson to review' }).waitFor();
  await brief.getByRole('heading', { name: 'Choose the next Osmosis readiness step' }).waitFor();
  assert.equal(await brief.getByText('1 more decision after this one.').count(), 1);
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(width <= 0, 'no horizontal scroll (overflow ' + width + 'px)');
  await shot(page, '1-brief');
  assert.deepEqual(errors, []);
  assert.deepEqual(h.blocked, []);
});

test('verify a result with one tap, then the next decision leads', { skip: !playwright }, async t => {
  const { h, page } = await open(t);
  await page.locator('#brief').getByRole('button', { name: 'Looks right' }).click();
  await page.getByText('Marked “Choose the first Biology lesson to review” as verified.').waitFor();
  await page.locator('#brief').getByText('You have 2 decisions for you.').waitFor();
  assert.match(h.comments(3).at(-1).body, /"type":"verified","decisionId":6772342268,"by":"owner"/);
  await shot(page, '2-verified');
});

test('natural language: "go with the practical flow" asks to confirm, then approves', { skip: !playwright }, async t => {
  const { h, page } = await open(t);
  await sayText(page, 'go with the practical flow');
  const confirm = page.locator('.message.alfred').last();
  await confirm.getByText('Just to confirm — approve “Test the practical flow first” for Science Buddy?').waitFor();
  assert.equal(h.comments(4).length, 0, 'typing alone records nothing');
  await shot(page, '3-confirm');
  await confirm.getByRole('button', { name: 'Approve: Test the practical flow first' }).click();
  await page.getByText(/Approved “Test the practical flow first”. It’s queued/).waitFor();
  assert.match(h.comments(4).at(-1).body, /"option":"test-osmosis-practical"/);
  await page.locator('#now-list').getByText('Approved · waiting to start').waitFor();
  await shot(page, '4-approved');
});

test('"yes" targets the first item; "what\'s wrong" sends a result back with a note', { skip: !playwright }, async t => {
  const { h, page } = await open(t);
  await sayText(page, 'no');
  await page.getByText('Okay — what’s wrong with it?').waitFor();
  await sayText(page, 'The iPhone Safari check is still missing.');
  const reply = page.locator('.message.alfred').last();
  await reply.getByRole('button', { name: 'Send it back' }).click();
  await page.getByText(/Sent “Choose the first Biology lesson to review” back/).waitFor();
  assert.match(h.comments(3).at(-1).body, /"type":"verification_failed".*"result":"The iPhone Safari check is still missing."/);
  await page.locator('#now-list').getByText('Your note: The iPhone Safari check is still missing.').waitFor();
});

test('status questions, history sheet and project decisions', { skip: !playwright }, async t => {
  const { h, page } = await open(t);
  await page.getByRole('button', { name: 'What\'s happening?' }).click();
  await page.getByText('Nothing is running right now.').waitFor();
  await sayText(page, 'how is science buddy doing?');
  await page.locator('.message.alfred').last().getByText('Science Buddy', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'History, projects and settings' }).click();
  const sheet = page.locator('#more');
  await sheet.getByText('Choose the next Osmosis readiness step').waitFor();
  await sheet.getByText('Risk Assessment Songbook').click();
  await shot(page, '5-history');
  await sheet.locator('details[open]').getByRole('button', { name: 'Later' }).click();
  await page.getByText('Recorded DEFER for Risk Assessment Songbook.').waitFor();
  assert.match(h.repos['risk-assessment-songbook'].issues[0].body, /^Answer: DEFER$/m);
});

test('unknown questions offer Claude only on request, and a fake Claude answers without real calls', { skip: !playwright }, async t => {
  const anthropic = () => new Response(JSON.stringify({
    content: [{ type: 'text', text: 'Science Buddy is the only active workflow.' }],
    usage: { input_tokens: 900, output_tokens: 20 }, stop_reason: 'end_turn',
  }), { headers: { 'Content-Type': 'application/json' } });
  const { h, page } = await open(t, { anthropic });
  await sayText(page, 'Which project has the most risk this month?');
  const offer = page.locator('.message.alfred').last();
  await offer.getByRole('button', { name: 'Ask Claude' }).waitFor();
  assert.equal(h.anthropicCalls.length, 0, 'nothing is sent until the owner taps Ask Claude');
  await offer.getByRole('button', { name: 'Ask Claude' }).click();
  await page.getByText('Science Buddy is the only active workflow.').waitFor();
  assert.equal(h.anthropicCalls.length, 1);
  assert.deepEqual(h.blocked, []);
});

test('signed-out visitors see the sign-in button', { skip: !playwright }, async t => {
  const origin = 'http://localhost:' + port++;
  const h = await createHarness({ origin });
  const server = await h.serve();
  t.after(async () => { server.close(); h.restore(); });
  const browser = await playwright.chromium.launch({ executablePath: process.env.ALFRED_CHROMIUM || undefined, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage();
  await page.goto(origin + '/');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).waitFor();
  assert.equal(await page.locator('#workspace').isHidden(), true);
});

test('mobile automatic loop: show cost → approve → runner → checked result and next decision', { skip: !playwright }, async t => {
  const repos = liveFixtures();
  // Settle the earlier review, so the new runnable task leads the brief.
  repos.Gameshed.comments[3].push({ id: 6900000000, body: '<!-- alfred-workflow-event:v1 -->\n' + JSON.stringify({ type: 'verified', decisionId: 6772342268, by: 'owner' }) });
  repos.Gameshed.sources = { 'README.md': '# Synthetic source\n' };
  const marker = '<!-- alfred-workflow:v1 -->\n';
  const p = JSON.parse(repos.Gameshed.issues[2].body.slice(marker.length));
  p.options[0].execution = { repo: 'Gameshed', sha: 'b'.repeat(40), paths: ['README.md'], profile: 'source-review', maxMicrousd: 200000 };
  repos.Gameshed.issues[2].body = marker + JSON.stringify(p);
  const { h, page } = await open(t, { repos, execution: true });
  await page.getByRole('button', { name: 'Approve: Tighten Osmosis wording first · US$0.20 max', exact: true }).click();
  await page.getByText(/The runner will start automatically/).waitFor();
  const decisionId = h.comments(4)[0].id;
  const api = async (path, body) => {
    const r = await h.request('/api/executor' + path, { method: 'POST', body, headers: { Authorization: 'Bearer ' + await h.runnerToken() } });
    assert.equal(r.status, 200, r.text); return r.json;
  };
  const nextDecision = { title: 'Choose the next synthetic review', summary: 'The source check is complete; accuracy remains a human check.', options: [
    { id: 'check', label: 'Check the result', detail: 'Recommended. Read the result before another task.' },
    { id: 'wait', label: 'Wait for more evidence', detail: 'Keep the result available and make no release changes.' }] };
  await run({ decisionId, api, apiKey: 'fake', provider: async url => url.endsWith('/count_tokens')
    ? Response.json({ input_tokens: 1000 }) : Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ result: 'The synthetic source review finished. Factual accuracy remains unverified.', files: [], nextDecision }) }] }) });
  await page.reload();
  await page.getByRole('heading', { name: nextDecision.title }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve: Tighten Osmosis wording first · US$0.20 max', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await shot(page, '8-automatic-loop');
});
