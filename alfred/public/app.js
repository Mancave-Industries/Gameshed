// Alfred conversational workspace.
// REVIEW → RECOMMEND → APPROVE → EXECUTE → VERIFY → REPORT → REPEAT
// All state comes from /api/workspace (GitHub records). Writes go through the
// existing decision endpoints plus /verify. Typed messages are understood locally
// at no cost; Claude is only asked when the owner taps "Ask Claude".

const $ = selector => document.querySelector(selector);
const sessionPanel = $('#session-panel');
const sessionMessage = $('#session-message');
const login = $('#login');
const retry = $('#retry');
const workspaceEl = $('#workspace');
const composer = $('#composer');
const say = $('#say');
const thread = $('#thread');
const nowList = $('#now-list');
const freshness = $('#freshness');
const refreshButton = $('#refresh');
const moreButton = $('#open-more');
const moreDialog = $('#more');

const POLL_MS = 60_000;
const signInMessages = {
  denied: 'Sign in with the Mancave Industries GitHub account.',
  expired: 'Sign-in expired. Start again.',
  failed: 'GitHub could not complete sign-in. Try again.',
};
const STATUS = {
  decision: 'Needs your decision',
  deferred: 'Deferred',
  queued: 'Approved · waiting to start',
  running: 'In progress',
  checking: 'Checking the result',
  blocked: 'Blocked',
  completed: 'Done · needs checking',
  verifying: 'Being checked',
  verified: 'Verified',
  verification_failed: 'Sent back',
};
const STAGES = ['Recommend', 'Approve', 'Execute', 'Verify', 'Report'];
const STAGE_OF = {
  decision: 1, deferred: 1, queued: 2, running: 2, blocked: 2, checking: 3,
  completed: 3, verifying: 3, verification_failed: 3, verified: 4,
};
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let data = null;
let loading = false;
let awaitingNote = null; // workflow number whose "what's wrong" note is expected next
let knownAttention = null;

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

async function api(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    const error = new Error(payload?.error || 'Alfred is unavailable right now.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function post(path, body) {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today ? 'today ' + timeFormat.format(date) : dateFormat.format(date);
}

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
}

function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}

function optionLabel(workflow, id = workflow.choice) {
  return workflow.options.find(option => option.id === id)?.label ?? null;
}

// ---------- derived state ----------

function workflows() {
  return data?.workflows ?? [];
}

function openWorkflows() {
  return workflows().filter(item => item.open).sort((a, b) => a.number - b.number);
}

function pendingDecisions() {
  const flows = openWorkflows().filter(item => item.status === 'decision')
    .map(workflow => ({ key: 'wf-' + workflow.number, kind: 'workflow', workflow }));
  const projects = (data?.projects ?? []).filter(project => project.decision?.ready && !project.decision.choice)
    .map(project => ({ key: 'pd-' + project.id, kind: 'project', project }));
  return [...flows, ...projects];
}

function pendingChecks() {
  return openWorkflows().filter(item => ['completed', 'verifying'].includes(item.status))
    .map(workflow => ({ key: 'wf-' + workflow.number, kind: 'check', workflow }));
}

function inProgress() {
  return openWorkflows().filter(item => ['queued', 'running', 'checking', 'blocked', 'verification_failed'].includes(item.status));
}

function attention() {
  return [...pendingChecks(), ...pendingDecisions()];
}

function focus() {
  return attention()[0] ?? null;
}

function findWorkflow(number) {
  return workflows().find(item => item.number === number) ?? null;
}

// ---------- cards ----------

function stepper(status) {
  const stage = STAGE_OF[status] ?? 0;
  return el('ol', { class: 'stepper', 'aria-label': 'Stage: ' + STAGES[stage] },
    STAGES.map((name, index) => el('li', {
      class: index < stage ? 'done' : index === stage ? 'current' : '',
      'aria-current': index === stage ? 'step' : null,
      text: name,
    })));
}

function cardShell(key, eyebrow, title, ...body) {
  return el('article', { class: 'card', 'data-card': key },
    el('p', { class: 'eyebrow', text: eyebrow }),
    el('h3', { text: title }),
    ...body);
}

function statusLine() {
  return el('p', { class: 'card-status', role: 'status' });
}

function decisionCard(workflow, preselect) {
  const key = 'wf-' + workflow.number;
  const status = statusLine();
  const options = el('div', { class: 'options' });
  const all = [...workflow.options.map((option, index) => ({ ...option, recommended: index === 0 })),
    { id: 'defer', label: 'Decide later' }];
  for (const option of all) {
    const isDefer = option.id === 'defer';
    const button = el('button', {
      type: 'button',
      class: isDefer ? 'button subtle-button' : option.recommended ? 'button approve' : 'button',
      'aria-describedby': option.detail ? key + '-' + option.id : null,
      text: isDefer ? 'Decide later' : 'Approve: ' + option.label + (option.execution ? ' · US$' + (option.execution.maxMicrousd / 1000000).toFixed(2) + ' max' : ''),
    });
    if (preselect && preselect === option.id) button.classList.add('highlight');
    button.addEventListener('click', () => choose(workflow, option, status, options));
    options.append(el('div', { class: 'option' },
      option.recommended ? el('span', { class: 'tag', text: 'Recommended' }) : null,
      button,
      option.detail ? el('p', { class: 'detail', id: key + '-' + option.id, text: option.detail.replace(/^Recommended\.\s*/, '') }) : null,
      option.execution ? el('p', { class: 'detail', text: 'Claude will work on ' + option.execution.repo + ', run the named checks and return a review branch. This approval permits one API request up to the displayed US dollar ceiling. It does not permit merge or deployment.' }) : null));
  }
  return cardShell(key, workflow.project + ' · Decision', workflow.title,
    stepper(workflow.status),
    el('p', { class: 'summary', text: workflow.summary }),
    workflow.status === 'deferred' ? el('p', { class: 'muted', text: 'You deferred this earlier. It is still open.' }) : null,
    options, status);
}

function projectDecisionCard(project, preselect) {
  const key = 'pd-' + project.id;
  const status = statusLine();
  const buttons = el('div', { class: 'choices' });
  for (const [value, label, cls] of [['YES', 'Yes', 'button approve'], ['NO', 'No', 'button'], ['DEFER', 'Later', 'button']]) {
    const button = el('button', { type: 'button', class: cls + (preselect === value ? ' highlight' : ''), text: label, 'aria-label': label + ' — ' + project.question });
    button.addEventListener('click', () => recordProjectDecision(project, value, status, buttons));
    buttons.append(button);
  }
  return cardShell(key, project.name + ' · Project decision', project.question,
    el('p', { class: 'summary', text: project.status }), buttons, status);
}

function reportText(text) {
  if (text.length <= 700) return el('p', { class: 'report prewrap', text });
  return el('div', {},
    el('p', { class: 'report prewrap', text: text.slice(0, 600).replace(/\s+\S*$/, '') + '…' }),
    el('details', { class: 'more-report' }, el('summary', { text: 'Read the full report' }), el('p', { class: 'report prewrap', text })));
}

function checkCard(workflow) {
  const key = 'wf-' + workflow.number;
  const status = statusLine();
  const note = el('textarea', { rows: '3', maxlength: '1000', placeholder: 'What needs fixing?', 'aria-label': 'What needs fixing?' });
  const sendBack = el('button', { type: 'button', class: 'button action-required', text: 'Send back with this note' });
  const wrongForm = el('div', { class: 'wrong-form', hidden: true }, note, sendBack);
  const right = el('button', { type: 'button', class: 'button approve', text: 'Looks right' });
  const wrong = el('button', { type: 'button', class: 'button', text: 'Something’s wrong' });
  const actions = el('div', { class: 'choices two' }, right, wrong);
  right.addEventListener('click', () => verify(workflow, 'verified', '', status, actions));
  wrong.addEventListener('click', () => { wrongForm.hidden = false; note.focus(); });
  sendBack.addEventListener('click', () => verify(workflow, 'verification_failed', note.value, status, actions, wrongForm));
  return cardShell(key, workflow.project + ' · Result to check', workflow.title,
    stepper(workflow.status),
    el('p', { class: 'muted', text: 'You chose “' + optionLabel(workflow) + '”. Alfred reported back ' + when(workflow.events.find(e => e.type === 'completed')?.at) + '.' }),
    reportText(workflow.result ?? ''),
    el('p', { class: 'question', text: 'Does this look right to you?' }),
    actions, wrongForm, status,
    el('a', { class: 'record-link', href: workflow.url, text: 'Open the record ↗' }));
}

function settledCard(key, text) {
  return el('article', { class: 'card settled', 'data-card': key }, el('p', { text }));
}

function liveCard(key, preselect) {
  if (key.startsWith('wf-')) {
    const workflow = findWorkflow(Number(key.slice(3)));
    if (!workflow) return settledCard(key, 'This item is no longer open.');
    if (['decision', 'deferred'].includes(workflow.status) && workflow.open) return decisionCard(workflow, preselect);
    if (['completed', 'verifying'].includes(workflow.status) && workflow.open) return checkCard(workflow);
    return settledCard(key, workflow.title + ' — ' + STATUS[workflow.status] +
      (workflow.choice ? ' (“' + optionLabel(workflow) + '”)' : '') + '.');
  }
  const project = data?.projects?.find(item => 'pd-' + item.id === key);
  if (!project) return settledCard(key, 'This decision is no longer available.');
  if (project.decision?.ready && !project.decision.choice) return projectDecisionCard(project, preselect);
  return settledCard(key, project.name + ': recorded ' + project.decision?.choice + '.');
}

// force: re-render even where the owner is interacting (used after their own action).
// Background refreshes leave a card alone while it has focus, so a half-typed note survives.
function refreshCards(force) {
  for (const node of thread.querySelectorAll('.message:not(.brief) [data-card]')) {
    if (!force && node.contains(document.activeElement)) continue;
    node.replaceWith(liveCard(node.dataset.card));
  }
}

// ---------- messages ----------

function message(from, ...content) {
  const item = el('li', { class: 'message ' + from },
    el('span', { class: 'visually-hidden', text: from === 'me' ? 'You said:' : 'Alfred:' }),
    ...content.map(part => typeof part === 'string' ? el('p', { text: part }) : part));
  thread.append(item);
  item.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return item;
}

function quickReplies(...buttons) {
  return el('div', { class: 'quick' }, buttons.map(([label, handler, cls]) =>
    el('button', { type: 'button', class: cls ?? 'chip', text: label, onclick: handler })));
}

function renderBrief(force) {
  const checks = pendingChecks();
  const decisions = pendingDecisions();
  const running = inProgress();
  const parts = [];
  if (checks.length) parts.push(plural(checks.length, 'result') + ' to check');
  if (decisions.length) parts.push(plural(decisions.length, 'decision') + ' for you');
  const summary = parts.length
    ? 'You have ' + parts.join(' and ') + '.'
    : 'Nothing needs you right now. The next decision will appear here as soon as it is ready.';
  const working = running.length
    ? ' ' + plural(running.length, 'item') + ' in progress — see Happening now.'
    : '';
  const cards = [...checks.map(item => liveCard(item.key))];
  if (decisions.length) {
    cards.push(liveCard(decisions[0].key));
    if (decisions.length > 1) cards.push(el('p', { class: 'muted', text: plural(decisions.length - 1, 'more decision') + ' after this one.' }));
  }
  if (data.workflows === null) cards.unshift(el('p', { class: 'error', text: 'I couldn’t read the workflow records just now. Tap ↻ to try again.' }));
  const brief = el('li', { class: 'message alfred brief', id: 'brief' },
    el('span', { class: 'visually-hidden', text: 'Alfred:' }),
    el('p', { class: 'lead', text: greeting() + ' ' + summary + working }),
    ...cards);
  const existing = $('#brief');
  if (existing) {
    if (!force && existing.contains(document.activeElement)) return;
    existing.replaceWith(brief);
  } else thread.prepend(brief);
}

function renderNow() {
  const items = inProgress();
  const entries = items.map(workflow => {
    const event = [...workflow.events].reverse()[0];
    return el('li', { class: 'now-item ' + workflow.status },
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('div', {},
        el('p', { class: 'now-title', text: workflow.project + ' · ' + (optionLabel(workflow) ?? workflow.title) }),
        el('p', { class: 'muted', text: STATUS[workflow.status] + (event?.at ? ' · ' + when(event.at) : '') }),
        workflow.status === 'blocked' && workflow.result ? el('p', { class: 'blocked-reason', text: workflow.result }) : null,
        workflow.status === 'verification_failed' && workflow.verification?.note
          ? el('p', { class: 'blocked-reason', text: 'Your note: ' + workflow.verification.note }) : null));
  });
  if (!entries.length) entries.push(el('li', { class: 'now-item idle' }, el('p', { class: 'muted', text: 'Nothing running. Approved work starts on Alfred’s next scheduled run.' })));
  nowList.replaceChildren(...entries);
}

function historyEntry(workflow) {
  const events = workflow.events.map(event => {
    const label = {
      choice: 'Approved “' + event.label + '”', deferred: 'Deferred', started: 'Work started',
      completed: 'Reported back', blocked: 'Blocked', verifying: 'Check started',
      verified: 'Checked and accepted' + (event.by === 'owner' ? ' by you' : ''),
      verification_failed: 'Sent back' + (event.by === 'owner' ? ' by you' : ''),
    }[event.type];
    return el('li', {}, el('span', { class: 'muted', text: when(event.at) + ' · ' }), label,
      event.result ? el('p', { class: 'prewrap small', text: event.result }) : null);
  });
  return el('li', {}, el('details', {},
    el('summary', {}, el('span', { class: 'eyebrow', text: workflow.project + ' · ' + STATUS[workflow.status] }), el('br'), workflow.title),
    stepper(workflow.status),
    el('p', { class: 'small', text: workflow.summary }),
    events.length ? el('ol', { class: 'timeline' }, events) : el('p', { class: 'muted small', text: 'No activity yet.' }),
    el('a', { href: workflow.url, class: 'record-link', text: 'Open the record ↗' })));
}

function projectEntry(project) {
  const decision = project.decision;
  const status = statusLine();
  const buttons = el('div', { class: 'choices' });
  for (const [value, label] of [['YES', 'Yes'], ['NO', 'No'], ['DEFER', 'Later']]) {
    const button = el('button', { type: 'button', class: 'button' + (value === decision?.choice ? ' highlight' : ''), text: label,
      'aria-pressed': String(value === decision?.choice), disabled: !decision?.ready });
    button.addEventListener('click', () => recordProjectDecision(project, value, status, buttons));
    buttons.append(button);
  }
  return el('li', {}, el('details', {},
    el('summary', {}, el('span', { class: 'eyebrow', text: project.priority }), el('br'), project.name),
    el('p', { class: 'small', text: project.status }),
    el('dl', { class: 'facts' },
      el('dt', { text: 'Blocker' }), el('dd', { text: project.blocker }),
      el('dt', { text: 'Next' }), el('dd', { text: project.next })),
    project.review ? el('p', { class: 'small', text: project.review.summary + ' ' + project.review.next }) : null,
    project.tasks.length ? el('ul', { class: 'links' }, project.tasks.map(task =>
      el('li', {}, el('a', { href: task.url, text: task.kind + ' #' + task.number + ' · ' + task.title })))) : null,
    el('p', { class: 'small' }, el('strong', { text: 'Earlier decision: ' }), project.question + ' ',
      el('span', { class: 'muted', text: decision?.choice ? '(' + decision.choice + (decision.recordedAt ? ', ' + when(decision.recordedAt) : '') + ')' : decision?.ready ? '(waiting for you)' : '(record unavailable)' })),
    buttons, status,
    decision?.url ? el('a', { href: decision.url, class: 'record-link', text: 'Decision record ↗' }) : null));
}

function renderMore() {
  const history = [...workflows()].sort((a, b) => b.number - a.number);
  $('#history-list').replaceChildren(...(history.length ? history.map(historyEntry) : [el('li', { class: 'muted', text: 'No workflows yet.' })]));
  $('#project-list').replaceChildren(...(data.projects ?? []).map(projectEntry));
  const pilot = data.claude?.pilot;
  const rehearsal = data.claude?.latestRehearsal;
  $('#claude-status').textContent = [
    pilot ? 'Deceivers release audit: ' + pilot.status + '.' : data.claude?.pilotReady ? 'The live Deceivers pilot has not been run.' : 'The live Deceivers pilot is waiting for an Anthropic credential.',
    rehearsal ? 'Latest £0 rehearsal: Deceivers #' + rehearsal.issueNumber + ', ' + when(new Date(rehearsal.completedAt).toISOString()) + '.' : '',
  ].filter(Boolean).join(' ');
  $('#claude-result').textContent = pilot?.result ?? '';
  $('#claude-findings').hidden = !pilot?.result;
}

function render(force = true) {
  renderNow();
  renderBrief(force);
  refreshCards(force);
  renderMore();
  freshness.textContent = 'Checked ' + timeFormat.format(new Date(data.checkedAt));
}

// ---------- actions ----------

function replaceWorkflow(workflow) {
  data.workflows = workflows().map(item => item.number === workflow.number ? workflow : item);
}

async function choose(workflow, option, status, controls) {
  controls.inert = true;
  status.classList.remove('error');
  status.textContent = 'Recording your choice…';
  try {
    const saved = await post('/api/workflows/' + workflow.number + '/choice',
      { option: option.id, label: option.label, detail: option.detail,
        ...(option.execution ? { execution: option.execution, confirmCostMicrousd: option.execution.maxMicrousd } : {}) });
    if (!saved.workflow) throw new Error('Refresh to check whether your choice was saved.');
    replaceWorkflow(saved.workflow);
    const accepted = option.id === 'defer' ? saved.workflow.status === 'deferred' : saved.workflow.choice === option.id;
    render();
    const next = focus();
    if (!accepted) {
      message('alfred', 'Another choice was already recorded for “' + workflow.title + '”: ' + (optionLabel(saved.workflow) ?? STATUS[saved.workflow.status]) + '.');
    } else if (option.id === 'defer') {
      message('alfred', 'Deferred “' + workflow.title + '”. It stays open; just tell me when you want to pick it up.',
        next ? 'Next up: ' + nextLabel(next) + '.' : 'Nothing else needs you right now.');
    } else {
      message('alfred', 'Approved “' + option.label + '”. ' + (option.execution
        ? 'The runner will start automatically and report its checks here. No merge or deployment is authorised.'
        : 'It is queued for the existing reviewer. This option does not authorise paid Claude execution.'),
        next ? 'Next up: ' + nextLabel(next) + '.' : 'Nothing else needs you right now. I’ll show the next decision as soon as it’s ready.');
    }
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
    controls.inert = false;
    if (error.status === 401) signedOut(error.message);
  }
}

async function verify(workflow, verdict, note, status, controls, form) {
  note = note.trim();
  if (verdict === 'verification_failed' && !note) {
    status.classList.add('error');
    status.textContent = 'Say briefly what’s wrong so it can be fixed.';
    return;
  }
  controls.inert = true;
  if (form) form.inert = true;
  status.classList.remove('error');
  status.textContent = 'Saving your check…';
  try {
    const saved = await post('/api/workflows/' + workflow.number + '/verify', note ? { verdict, note } : { verdict });
    replaceWorkflow(saved.workflow);
    render();
    const next = focus();
    message('alfred', verdict === 'verified'
      ? 'Marked “' + workflow.title + '” as verified. That closes the loop on this one.'
      : 'Sent “' + workflow.title + '” back with your note. It’s recorded on the workflow so the fix is tracked.',
    next ? 'Next up: ' + nextLabel(next) + '.' : 'Nothing else needs you right now.');
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
    controls.inert = false;
    if (form) form.inert = false;
    if (error.status === 401) signedOut(error.message);
  }
}

async function recordProjectDecision(project, choice, status, controls) {
  controls.inert = true;
  status.classList.remove('error');
  status.textContent = 'Saving to GitHub…';
  try {
    const saved = await post('/api/decisions/' + project.id, { choice });
    if (saved.decision?.choice !== choice) throw new Error('GitHub did not confirm the decision. Refresh to check.');
    await load(true);
    message('alfred', 'Recorded ' + choice + ' for ' + project.name + '.');
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
    controls.inert = false;
    if (error.status === 401) signedOut(error.message);
  }
}

function nextLabel(item) {
  if (item.kind === 'check') return 'check the result of “' + item.workflow.title + '”';
  if (item.kind === 'workflow') return item.workflow.project + ' — ' + item.workflow.title;
  return item.project.name + ' — ' + item.project.question;
}

// ---------- understanding typed messages (no cost) ----------

const PROJECT_WORDS = [
  [/deceiver|narrat|portrait/, 'deceivers-audit', 'The Deceivers'],
  [/science|buddy|biology|osmosis|diffusion|lila|lesson/, 'science-mvp', 'Science Buddy'],
  [/man ?cave|festival|stall|stock|signage/, 'mci-freeze', 'ManCave Industries'],
  [/song|transpose|setlist|set list/, 'songbook-hold', 'Risk Assessment Songbook'],
];

const STOP_WORDS = new Set(['with', 'that', 'this', 'them', 'then', 'first', 'second', 'third', 'option', 'choice',
  'approve', 'choose', 'please', 'want', 'what', 'about', 'lets', 'let\'s', 'yeah', 'okay', 'sure', 'think', 'should', 'would']);

function matchOption(text, workflow) {
  // Label words win over ordinals, so "test the practical flow first" is not read as "the first option".
  const words = text.split(/[^a-z0-9']+/).filter(word => word.length > 3 && !STOP_WORDS.has(word));
  const scores = workflow.options.map(option => {
    const label = option.label.toLowerCase().split(/[^a-z0-9']+/);
    return words.filter(word => label.some(part => part.startsWith(word) || word.startsWith(part) && part.length > 3)).length;
  });
  const top = Math.max(...scores);
  if (top > 0 && scores.filter(score => score === top).length === 1) return workflow.options[scores.indexOf(top)];
  const ordinal = text.match(/\b(?:option|choice|number)\s*(\d)\b|^\s*(\d)\s*$|\b(first|second|third|1st|2nd|3rd)\b/);
  if (ordinal) {
    const word = ordinal[3];
    const index = word ? { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2 }[word] : Number(ordinal[1] ?? ordinal[2]) - 1;
    if (workflow.options[index]) return workflow.options[index];
  }
  return null;
}

function confirmDecision(item, option) {
  if (item.kind === 'project') {
    const choice = option ?? 'YES';
    message('alfred', 'Just to confirm — record ' + choice + ' for “' + item.project.question + '”?', liveCard(item.key, choice));
    return;
  }
  const workflow = item.workflow;
  const chosen = option ?? workflow.options[0];
  message('alfred',
    'Just to confirm — approve “' + chosen.label + '” for ' + workflow.project + '?' + (option ? '' : ' That’s the recommended option.'),
    liveCard(item.key, chosen.id));
}

function describeNow() {
  const running = inProgress();
  if (!running.length) return 'Nothing is running right now. Approved work starts on Alfred’s next scheduled run.';
  return running.map(item => '• ' + item.project + ': ' + (optionLabel(item) ?? item.title) + ' — ' + STATUS[item.status].toLowerCase() + '.').join('\n');
}

function describeResults() {
  const done = workflows().filter(item => ['completed', 'verifying', 'verified', 'verification_failed'].includes(item.status))
    .sort((a, b) => b.number - a.number).slice(0, 3);
  if (!done.length) return null;
  return done;
}

function respond(raw) {
  const text = raw.toLowerCase().replace(/[’']/g, '\'').trim();
  const current = focus();
  const decisions = pendingDecisions();
  const checks = pendingChecks();

  if (awaitingNote !== null) {
    const workflow = findWorkflow(awaitingNote);
    awaitingNote = null;
    if (workflow && ['completed', 'verifying'].includes(workflow.status)) {
      const status = statusLine();
      const holder = el('div');
      const controls = quickReplies(
        ['Send it back', () => verify(workflow, 'verification_failed', raw, status, controls), 'button action-required'],
        ['Cancel', () => { controls.inert = true; status.textContent = 'Cancelled.'; }, 'button']);
      holder.append(controls, status);
      message('alfred', 'I’ll send “' + workflow.title + '” back with this note:', el('blockquote', { text: raw }), holder);
      return;
    }
  }

  if (/^(help|\?|what can you do)/.test(text)) {
    message('alfred', 'I can tell you what’s next, what’s happening and what finished recently. You can approve a decision by saying “yes”, “go with option 2” or naming the option, put it off with “later”, and tell me if a result “looks right” or what’s wrong with it. Anything else, I can pass to Claude if you ask.');
    return;
  }

  const wantsCheckVerdict = checks.length && (/(looks (good|right|fine|great)|verified|that's right|correct|accept|all good|happy with)/.test(text));
  const isQuestion = /\?$|^(what|why|how|when|where|which|who|is|are|does|do|can)\b/.test(text);
  const reportsProblem = checks.length && !isQuestion &&
    /(wrong|not right|incorrect|problem|isn't right|doesn't look|mistake|send (it )?back)/.test(text);
  if (wantsCheckVerdict && !reportsProblem) {
    const item = checks[0];
    const status = statusLine();
    const controls = quickReplies(
      ['Yes, mark verified', () => verify(item.workflow, 'verified', '', status, controls), 'button approve'],
      ['Not yet', () => { controls.inert = true; status.textContent = 'Left unchecked.'; }, 'button']);
    message('alfred', 'Mark the result of “' + item.workflow.title + '” as verified?', controls, status);
    return;
  }
  if (reportsProblem) {
    awaitingNote = checks[0].workflow.number;
    message('alfred', 'What’s wrong with “' + checks[0].workflow.title + '”? Tell me in a sentence and I’ll send it back with your note.');
    return;
  }

  if (decisions.length && /\b(later|defer|not now|skip|park|another time|wait)\b/.test(text)) {
    const item = decisions[0];
    if (item.kind === 'workflow') {
      const status = statusLine();
      const controls = quickReplies(
        ['Yes, decide later', () => choose(item.workflow, { id: 'defer' }, status, controls), 'button'],
        ['No, keep it', () => { controls.inert = true; status.textContent = 'Kept open.'; }, 'button']);
      message('alfred', 'Put off “' + item.workflow.title + '” for now?', controls, status);
    } else {
      confirmDecision(item, 'DEFER');
    }
    return;
  }

  const decisionItem = decisions[0];
  if (decisionItem?.kind === 'workflow') {
    const option = matchOption(text, decisionItem.workflow);
    if (option && /\b(approve|go|choose|pick|option|choice|do|yes|let's|first|second|third|\d)\b/.test(text)) {
      confirmDecision(decisionItem, option);
      return;
    }
  }
  if (/^(yes|yeah|yep|yup|approve|approved|go ahead|go for it|do it|ok|okay|sure|sounds good|agreed|let's do it|crack on|proceed)\b/.test(text)) {
    if (!current) {
      message('alfred', 'There’s nothing waiting for a yes right now. I’ll show the next decision here as soon as it’s ready.');
    } else if (current.kind === 'check') {
      respond('looks right');
    } else if (current.kind === 'project') {
      confirmDecision(current, /^no\b/.test(text) ? 'NO' : 'YES');
    } else {
      confirmDecision(current, null);
    }
    return;
  }
  if (/^(no|nope|nah)\b/.test(text) && current) {
    if (current.kind === 'project') confirmDecision(current, 'NO');
    else message('alfred', current.kind === 'check'
      ? 'Okay — what’s wrong with it? Tell me in a sentence and I’ll send it back.'
      : 'Okay. Pick one of the other options on the card, or say “later” to put it off.');
    if (current.kind === 'check') awaitingNote = current.workflow.number;
    return;
  }

  // A named project wins over generic questions ("how is Science Buddy doing?").
  for (const [pattern, id, name] of PROJECT_WORDS) {
    if (!pattern.test(text)) continue;
    const project = data.projects?.find(item => item.id === id);
    const flows = openWorkflows().filter(item => item.project.toLowerCase() === name.toLowerCase());
    const lines = [];
    if (project) lines.push(project.status, 'Blocker: ' + project.blocker, 'Next: ' + project.next);
    for (const flow of flows) lines.push('• ' + flow.title + ' — ' + STATUS[flow.status].toLowerCase() + '.');
    message('alfred', el('p', { class: 'lead', text: name }), el('p', { class: 'prewrap', text: lines.join('\n') }));
    return;
  }
  if (/(happening|in progress|progress|working on|running|doing|busy|underway)/.test(text)) {
    message('alfred', el('p', { class: 'prewrap', text: describeNow() }));
    return;
  }
  if (/(result|report|finished|completed|done|history|recent|what happened)/.test(text)) {
    const done = describeResults();
    if (!done) {
      message('alfred', 'Nothing has reported back yet.');
      return;
    }
    message('alfred', 'Most recent results:', el('ul', { class: 'compact' }, done.map(item =>
      el('li', {}, el('strong', { text: item.project + ' — ' + item.title }), el('br'),
        el('span', { class: 'muted', text: STATUS[item.status] + ' · ' }), (item.result ?? '').slice(0, 220) + ((item.result ?? '').length > 220 ? '…' : '')))),
    quickReplies(['Open full history', () => openMore()]));
    return;
  }
  if (/(next|needs? me|for me|waiting|todo|to do|brief|update|summary|morning|afternoon|evening|^hi\b|^hello|^hey)/.test(text)) {
    if (!current) {
      message('alfred', 'Nothing needs you right now. ' + describeNow());
    } else {
      message('alfred', current.kind === 'check'
        ? 'First, a result to check:' : 'Here’s the next decision:', liveCard(current.key));
    }
    return;
  }

  offerClaude(raw);
}

function offerClaude(question) {
  if (!data.claude?.askReady) {
    message('alfred', 'I can’t answer that one on my own yet. Try “what’s next”, “what’s happening”, “recent results” or a project name.');
    return;
  }
  const status = statusLine();
  const controls = quickReplies(
    ['Ask Claude', () => askClaude(question, status, controls), 'button primary'],
    ['No thanks', () => { controls.inert = true; status.textContent = 'Okay.'; }, 'button']);
  message('alfred', 'I don’t know that from the records alone. Want me to ask Claude? It reads the same records and uses the small, capped trial budget.', controls, status);
}

async function askClaude(question, status, controls) {
  controls.inert = true;
  status.textContent = 'Asking Claude…';
  try {
    const result = await post('/api/ask', { question });
    status.textContent = '';
    message('alfred', el('p', { class: 'prewrap', text: result.answer }),
      el('p', { class: 'muted small', text: 'Answered by Claude from Alfred’s records.' + (result.truncated ? ' Ask about one project at a time for more detail.' : '') }));
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
    if (error.status === 401) signedOut(error.message);
  }
}

// ---------- loading ----------

function signedOut(text) {
  sessionPanel.hidden = false;
  sessionMessage.textContent = text;
  login.hidden = false;
  retry.hidden = true;
}

async function load(force = false) {
  if (loading) return;
  loading = true;
  refreshButton.disabled = true;
  freshness.textContent = 'Checking…';
  try {
    data = await api('/api/workspace');
    sessionPanel.hidden = true;
    workspaceEl.hidden = false;
    composer.hidden = false;
    refreshButton.hidden = false;
    moreButton.hidden = false;
    render(force === true);
    const keys = attention().map(item => item.key);
    if (knownAttention) {
      const fresh = attention().filter(item => !knownAttention.includes(item.key));
      for (const item of fresh) {
        message('alfred', item.kind === 'check' ? 'New result in: ' + item.workflow.title + '. It’s waiting for your check above.'
          : 'New decision ready: ' + nextLabel(item) + '.', liveCard(item.key));
      }
    }
    knownAttention = keys;
  } catch (error) {
    if (data && error.status !== 401) {
      freshness.textContent = 'Couldn’t refresh · ' + error.message;
    } else {
      workspaceEl.hidden = true;
      composer.hidden = true;
      sessionPanel.hidden = false;
      const params = new URLSearchParams(location.search).get('sign-in');
      sessionMessage.textContent = error.status === 401 ? signInMessages[params] || error.message : error.message;
      login.hidden = error.status !== 401;
      retry.hidden = error.status === 401;
      freshness.textContent = error.status === 401 ? 'Signed out' : 'Offline';
    }
  } finally {
    loading = false;
    refreshButton.disabled = false;
  }
}

function openMore() {
  if (typeof moreDialog.showModal === 'function') moreDialog.showModal();
  else moreDialog.setAttribute('open', '');
}

composer.addEventListener('submit', event => {
  event.preventDefault();
  const text = say.value.trim();
  if (!text || !data) return;
  say.value = '';
  say.style.height = '';
  message('me', text);
  respond(text);
});
say.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
say.addEventListener('input', () => {
  say.style.height = '';
  say.style.height = Math.min(say.scrollHeight, 160) + 'px';
});
for (const chip of document.querySelectorAll('[data-say]')) {
  chip.addEventListener('click', () => {
    if (!data) return;
    message('me', chip.dataset.say);
    respond(chip.dataset.say);
  });
}
refreshButton.addEventListener('click', load);
retry.addEventListener('click', load);
moreButton.addEventListener('click', openMore);
$('#close-more').addEventListener('click', () => moreDialog.close());
moreDialog.addEventListener('click', event => { if (event.target === moreDialog) moreDialog.close(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && data) load(); });
setInterval(() => { if (document.visibilityState === 'visible' && data && !moreDialog.open) load(); }, POLL_MS);
load();
