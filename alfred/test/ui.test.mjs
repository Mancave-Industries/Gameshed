// Mobile browser tests for Alfred's calm home screen, against the real Worker
// running entirely offline (see harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { createHarness, liveFixtures } from './harness.mjs';
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
  const browser = await playwright.chromium.launch({
    executablePath: process.env.ALFRED_CHROMIUM || undefined,
    args: ['--no-sandbox'],
  });
  t.after(async () => { await browser.close(); });
  const session = await h.signIn();
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
  await page.locator('#attention-card .focus-card').waitFor();
  return { h, page, errors };
}

const shot = (page, name) => shots
  ? page.screenshot({ path: shots + '/' + name + '.png', fullPage: true })
  : null;

test('another decision is reachable without accepting a result; unchanged polls preserve controls', { skip: !playwright }, async t => {
  const { page } = await open(t);
  const picker = page.getByLabel('Choose another item', { exact: true });
  const options = await picker.locator('option').evaluateAll(nodes => nodes.map(n => ({ value: n.value, text: n.textContent })));
  assert.ok(options.length > 1);
  await picker.selectOption(options.at(-1).value);
  const card = page.locator('#attention-card .focus-card');
  assert.equal(await card.getAttribute('data-card'), options.at(-1).value);
  await page.evaluate(() => { window.originalCard = document.querySelector('#attention-card .focus-card'); });
  const refresh = page.waitForResponse(response => response.url().endsWith('/api/workspace'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await refresh;
  await page.waitForFunction(() => document.querySelector('#freshness').textContent.startsWith('Checked'));
  assert.equal(await page.evaluate(() => window.originalCard === document.querySelector('#attention-card .focus-card')), true);
  await shot(page, 'choose-another-item');
});

async function ask(page, text) {
  await page.getByRole('button', { name: 'Ask Alfred' }).click();
  await page.fill('#say', text);
  await page.press('#say', 'Enter');
}

test('mobile home shows one current item, one action and collapsed secondary information', { skip: !playwright }, async t => {
  const { h, page, errors } = await open(t);
  await page.getByRole('heading', { name: 'Doing now' }).waitFor();
  await page.getByRole('heading', { name: 'Needs you' }).waitFor();
  const attention = page.locator('#attention-card');
  await attention.getByRole('heading', { name: 'Choose the first Biology lesson to review' }).waitFor();
  assert.equal(await attention.getByRole('heading', { name: 'Choose the next Osmosis readiness step' }).count(), 0);
  await attention.getByRole('button', { name: 'Accept result' }).waitFor();
  await attention.getByRole('button', { name: 'Send back' }).waitFor();
  assert.equal(await page.locator('#recent-section').evaluate(node => node.open), false);
  assert.equal(await page.locator('#projects-section').evaluate(node => node.open), false);
  assert.equal(await page.locator('.stepper').count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot(page, '1-simple-home');
  assert.deepEqual(errors, []);
  assert.deepEqual(h.blocked, []);
});

test('accepting a result reveals the next decision with three plain actions', { skip: !playwright }, async t => {
  const { h, page } = await open(t);
  await page.getByRole('button', { name: 'Accept result' }).click();
  await page.getByText('Result accepted. That loop is closed.').waitFor();
  const attention = page.locator('#attention-card');
  await attention.getByRole('heading', { name: 'Choose the next Osmosis readiness step' }).waitFor();
  await attention.getByRole('button', { name: /Do it: Tighten Osmosis wording first/ }).waitFor();
  await attention.getByText('Other options', { exact: true }).waitFor();
  await attention.getByRole('button', { name: /Decide later/ }).waitFor();
  assert.match(h.comments(3).at(-1).body, /"type":"verified","decisionId":6772342268,"by":"owner"/);
  await shot(page, '2-next-decision');
});

test('Other options reveals trade-offs and an alternate choice', { skip: !playwright }, async t => {
  const { h, page } = await open(t);
  await page.getByRole('button', { name: 'Accept result' }).click();
  const attention = page.locator('#attention-card');
  await attention.getByText('Other options', { exact: true }).click();
  await attention.getByRole('heading', { name: 'Test the practical flow first' }).waitFor();
  await attention.getByRole('button', { name: 'Choose Test the practical flow first' }).click();
  await page.getByText('Approved “Test the practical flow first”. Alfred will report back here.').waitFor();
  assert.match(h.comments(4).at(-1).body, /"option":"test-osmosis-practical"/);
  await page.locator('#doing-card').getByText('Science Buddy · Test the practical flow first').waitFor();
  await shot(page, '3-approved');
});

test('Ask Alfred stays secondary and typed approval still requires confirmation', { skip: !playwright }, async t => {
  const { h, page } = await open(t);
  await page.getByRole('button', { name: 'Accept result' }).click();
  await ask(page, 'go with the practical flow');
  const dialog = page.locator('#ask');
  await dialog.getByText('Confirm this choice:', { exact: true }).waitFor();
  assert.equal(h.comments(4).length, 0, 'typing alone records nothing');
  await dialog.getByRole('button', { name: 'Confirm: Test the practical flow first' }).click();
  await dialog.getByText('Approved “Test the practical flow first”. Alfred will report back here.').waitFor();
  assert.match(h.comments(4).at(-1).body, /"option":"test-osmosis-practical"/);
});

test('a result can be sent back only with a note', { skip: !playwright }, async t => {
  const { h, page } = await open(t);
  const attention = page.locator('#attention-card');
  await attention.getByRole('button', { name: 'Send back' }).click();
  await attention.getByRole('button', { name: 'Send back with note' }).click();
  await attention.getByText('Say briefly what needs fixing.').waitFor();
  await attention.getByLabel('What needs fixing?').fill('The physical iPhone check is still missing.');
  await attention.getByRole('button', { name: 'Send back with note' }).click();
  await page.getByText('Sent back with your note.').waitFor();
  assert.match(h.comments(3).at(-1).body, /"type":"verification_failed".*"result":"The physical iPhone check is still missing."/);
  await page.locator('#doing-card').getByText('Sent back').waitFor();
});

test('projects and conversation remain available on demand', { skip: !playwright }, async t => {
  const { page } = await open(t);
  await page.locator('#projects-section > summary').click();
  await page.locator('#project-list').getByText('Science Buddy', { exact: true }).click();
  await page.getByText('Review one existing Biology topic, then validate it on iPhone as the first pilot.').waitFor();
  await ask(page, 'how is science buddy doing?');
  const reply = page.locator('.message.alfred').last();
  await reply.getByText('Science Buddy', { exact: true }).waitFor();
  await shot(page, '4-projects-and-ask');
});

test('Later advances the queue and keeps the deferred choice available without reviving old project approvals', { skip: !playwright }, async t => {
  const { h, page } = await open(t);
  await page.getByRole('button', { name: 'Accept result' }).click();
  await page.locator('#attention-card').getByRole('button', { name: /Decide later/ }).click();
  await page.getByText('Saved for later.', { exact: true }).waitFor();
  await page.locator('#attention-card').getByText('Nothing needs you', { exact: true }).waitFor();
  assert.equal(h.repos['risk-assessment-songbook'].issues[0].body.includes('Answer:'), false);
  await page.locator('#later-section > summary').click();
  await page.locator('#later-list > li > details > summary').click();
  await page.locator('#later-list').getByRole('button', { name: 'Do it: Tighten Osmosis wording first' }).click();
  await page.getByText('Approved “Tighten Osmosis wording first”. Alfred will report back here.', { exact: true }).waitFor();
  assert.match(h.comments(4).at(-1).body, /"option":"tighten-osmosis"/);
});

test('background refresh preserves a note and unreadable workflows never claim an empty queue', { skip: !playwright }, async t => {
  const { page } = await open(t);
  await page.getByRole('button', { name: 'Send back', exact: true }).click();
  const note = page.getByLabel('What needs fixing?');
  await note.fill('Keep this unfinished note');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForResponse(response => response.url().endsWith('/api/workspace'));
  assert.equal(await note.inputValue(), 'Keep this unfinished note');
  await page.route('**/api/workspace', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.workflows = null;
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.locator('#attention-card').getByText('Couldn’t read your decisions. Refresh to try again.', { exact: true }).waitFor();
  assert.equal(await page.locator('#attention-card').getByText('Nothing needs you', { exact: true }).count(), 0);
});

test('unknown questions offer Claude only on request', { skip: !playwright }, async t => {
  const anthropic = () => new Response(JSON.stringify({
    content: [{ type: 'text', text: 'Science Buddy is the only active workflow.' }],
    usage: { input_tokens: 900, output_tokens: 20 },
    stop_reason: 'end_turn',
  }), { headers: { 'Content-Type': 'application/json' } });
  const { h, page } = await open(t, { anthropic });
  await ask(page, 'Which project has the most risk this month?');
  const offer = page.locator('.message.alfred').last();
  await offer.getByRole('button', { name: 'Ask Claude' }).waitFor();
  assert.equal(h.anthropicCalls.length, 0);
  await offer.getByRole('button', { name: 'Ask Claude' }).click();
  await page.getByText('Science Buddy is the only active workflow.').waitFor();
  assert.equal(h.anthropicCalls.length, 1);
  assert.deepEqual(h.blocked, []);
});

test('signed-out visitors see one clear sign-in action', { skip: !playwright }, async t => {
  const origin = 'http://localhost:' + port++;
  const h = await createHarness({ origin });
  const server = await h.serve();
  t.after(async () => { server.close(); h.restore(); });
  const browser = await playwright.chromium.launch({
    executablePath: process.env.ALFRED_CHROMIUM || undefined,
    args: ['--no-sandbox'],
  });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage();
  await page.goto(origin + '/');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).waitFor();
  assert.equal(await page.locator('#workspace').isHidden(), true);
});

test('automatic loop keeps cost, execution, checked result and next decision intact', { skip: !playwright }, async t => {
  const repos = liveFixtures();
  repos.Gameshed.comments[3].push({
    id: 6900000000,
    body: '<!-- alfred-workflow-event:v1 -->\n' + JSON.stringify({
      type: 'verified', decisionId: 6772342268, by: 'owner',
    }),
  });
  repos.Gameshed.sources = { 'README.md': '# Synthetic source\n' };
  const marker = '<!-- alfred-workflow:v1 -->\n';
  const proposal = JSON.parse(repos.Gameshed.issues[2].body.slice(marker.length));
  proposal.options[0].execution = {
    repo: 'Gameshed',
    sha: 'b'.repeat(40),
    paths: ['README.md'],
    profile: 'source-review',
    maxMicrousd: 200000,
  };
  repos.Gameshed.issues[2].body = marker + JSON.stringify(proposal);
  const { h, page } = await open(t, { repos, execution: true });
  await page.locator('#attention-card').getByText('One model request · US$0.20 maximum', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Do it: Tighten Osmosis wording first · US$0.20 max' }).click();
  await page.getByText('Approved “Tighten Osmosis wording first”. Alfred will report back here.').waitFor();
  const decisionId = h.comments(4)[0].id;
  const executorApi = async (path, body) => {
    const response = await h.request('/api/executor' + path, {
      method: 'POST',
      body,
      headers: { Authorization: 'Bearer ' + await h.runnerToken() },
    });
    assert.equal(response.status, 200, response.text);
    return response.json;
  };
  const nextDecision = {
    title: 'Choose the next synthetic review',
    summary: 'The source check is complete; accuracy remains a human check.',
    options: [
      { id: 'check', label: 'Check the result', detail: 'Recommended. Read the result before another task.' },
      { id: 'wait', label: 'Wait for more evidence', detail: 'Make no release changes.' },
    ],
  };
  await run({
    decisionId,
    api: executorApi,
    apiKey: 'fake',
    provider: async url => url.endsWith('/count_tokens')
      ? Response.json({ input_tokens: 1000 })
      : Response.json({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({
          result: 'The synthetic source review finished. Factual accuracy remains unverified.',
          files: [],
          nextDecision,
        }) }],
      }),
  });
  await page.reload();
  await page.getByRole('heading', { name: nextDecision.title }).waitFor();
  assert.equal(await page.locator('.stepper').count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot(page, '5-automatic-loop');
});
