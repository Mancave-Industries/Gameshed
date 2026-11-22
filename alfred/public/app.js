// Alfred's calm home screen.
// The primary experience is: see what is happening, handle one item, move on.
// Conversation, project records and technical evidence remain available on demand.

import { projectBrief, reportSummary } from './project-brief.js';

const $ = selector => document.querySelector(selector);
const sessionPanel = $('#session-panel');
const sessionMessage = $('#session-message');
const login = $('#login');
const retry = $('#retry');
const workspaceEl = $('#workspace');
const freshness = $('#freshness');
const refreshButton = $('#refresh');
const doingCard = $('#doing-card');
const doingCount = $('#doing-count');
const attentionCard = $('#attention-card');
const waitingCount = $('#waiting-count');
const recentSection = $('#recent-section');
const recentList = $('#recent-list');
const recentCount = $('#recent-count');
const projectList = $('#project-list');
const projectsCount = $('#projects-count');
const inboxList = $('#inbox-list');
const inboxCount = $('#inbox-count');
const homeStatus = $('#home-status');
const askDialog = $('#ask');
const thread = $('#thread');
const composer = $('#composer');
const say = $('#say');

const POLL_MS = 60_000;
const signInMessages = {
  denied: 'Sign in with the Mancave Industries GitHub account.',
  expired: 'Sign-in expired. Start again.',
  failed: 'GitHub could not complete sign-in. Try again.',
};
const STATUS = {
  decision: 'Needs your decision',
  deferred: 'Waiting for you',
  queued: 'Queued · waiting for Claude',
  running: 'Running · Claude is working',
  checking: 'Checking the result',
  blocked: 'Blocked',
  completed: 'Completed · result available',
  verifying: 'Being checked',
  verified: 'Verified · checks passed',
  verification_failed: 'Sent back',
  rejected: 'Rejected',
};
const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', day: 'numeric', month: 'short',
});

let data = null;
let loading = false;
let awaitingNote = null;
let knownAttention = null;
let selectedAttention = null;
let renderedData = null;

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
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    const error = new Error(payload?.error || 'Alfred is unavailable right now.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function post(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function when(iso) {
  if (!iso) return '';
  const value = new Date(iso);
  return new Date().toDateString() === value.toDateString()
    ? 'today at ' + timeFormat.format(value)
    : dateFormat.format(value);
}

function optionLabel(workflow, id = workflow.choice) {
  return workflow.options.find(option => option.id === id)?.label ?? null;
}

function workflows() {
  return data?.workflows ?? [];
}

function openWorkflows() {
  return workflows().filter(item => item.open).sort((a, b) => a.number - b.number);
}

function pendingDecisions() {
  return openWorkflows()
    .filter(item => item.status === 'decision')
    .map(workflow => ({ key: 'wf-' + workflow.number, kind: 'workflow', workflow }));
}

function pendingChecks() {
  return openWorkflows()
    .filter(item => ['completed', 'verifying'].includes(item.status))
    .map(workflow => ({ key: 'wf-' + workflow.number, kind: 'check', workflow }));
}

function requiresClaude(workflow) {
  return Boolean(workflow?.options?.find(option => option.id === workflow.choice)?.execution);
}

function inProgress() {
  return openWorkflows().filter(item =>
    ['running', 'checking', 'blocked', 'verification_failed'].includes(item.status) ||
    (item.status === 'queued' && requiresClaude(item)));
}

function attention() {
  return [...pendingChecks(), ...pendingDecisions()].sort((a, b) =>
    Number(b.workflow.project === data?.focusProject) - Number(a.workflow.project === data?.focusProject));
}

function focus() {
  return attention().find(item => item.key === selectedAttention) ?? attention()[0] ?? null;
}

function findWorkflow(number) {
  return workflows().find(item => item.number === number) ?? null;
}

function statusLine() {
  return el('p', { class: 'card-status', role: 'status' });
}

function cardShell(key, eyebrow, title, ...body) {
  return el('article', { class: 'focus-card', 'data-card': key },
    el('p', { class: 'eyebrow', text: eyebrow }),
    el('h3', { text: title }),
    ...body);
}

function executionSummary(option) {
  if (!option.execution) return null;
  return el('details', { class: 'evidence' },
    el('summary', { text: 'What Alfred will do' }),
    el('p', { text: 'Work only in ' + option.execution.repo + ', run the named checks and return a review branch.' }),
    el('p', { text: 'Maximum approved model cost: US$' + (option.execution.maxMicrousd / 1_000_000).toFixed(2) + '. No merge or deployment.' }));
}

function decisionCard(workflow, preselect) {
  const key = 'wf-' + workflow.number;
  const recommended = workflow.options[0];
  const selected = workflow.options.find(option => option.id === preselect) ?? recommended;
  const status = statusLine();
  const doIt = el('button', {
    type: 'button',
    class: 'button primary-action',
    text: (preselect ? 'CONFIRM' : 'APPROVE') + (selected.execution
      ? ' · US$' + (selected.execution.maxMicrousd / 1_000_000).toFixed(2) + ' max' : ''),
    'aria-label': (preselect ? 'Confirm: ' : 'Approve: ') + selected.label +
      (selected.execution ? ' · US$' + (selected.execution.maxMicrousd / 1_000_000).toFixed(2) + ' max' : ''),
  });
  const reject = el('button', {
    type: 'button',
    class: 'button danger-action',
    text: 'REJECT',
    'aria-label': 'Reject: ' + workflow.title,
  });
  const discussionBody = el('div', { class: 'discussion-body' },
    el('p', { class: 'discussion-intro', text: 'Choose another route, or talk it through with Alfred.' }),
    el('button', { type: 'button', class: 'button', text: 'Talk this through', onclick: () => {
      selectedAttention = key; openAsk();
      message('alfred', 'Let’s discuss “' + workflow.title + '”. ' + workflow.summary + ' What would you like to change?');
    } }));
  for (const option of workflow.options.filter(option => option.id !== selected.id)) {
    const choose = el('button', {
      type: 'button',
      class: 'button option-action',
      text: 'Choose ' + option.label,
    });
    discussionBody.append(el('div', { class: 'other-option' },
      el('h4', { text: option.label }),
      el('p', { text: option.detail.replace(/^Recommended\.\s*/, '') }),
      option.execution ? el('p', { class: 'cost', text: 'One model request · US$' + (option.execution.maxMicrousd / 1_000_000).toFixed(2) + ' maximum' }) : null,
      choose));
    choose.addEventListener('click', () => chooseWorkflow(workflow, option, status, card));
  }
  const discuss = el('details', { class: 'discussion' },
    el('summary', { class: 'button discuss-action', text: 'DISCUSS' }),
    discussionBody);
  const actions = el('div', { class: 'decision-actions' }, doIt, discuss, reject);
  const card = cardShell(key, workflow.project + ' · Decision', workflow.title,
    el('div', { class: 'recommendation' },
      el('p', { class: 'recommendation-label', text: preselect ? 'You selected' : 'Alfred recommends' }),
      el('h4', { text: selected.label }),
      el('p', { text: selected.detail.replace(/^Recommended\.\s*/, '') }),
      selected.execution ? el('p', { class: 'cost', text: 'One model request · US$' + (selected.execution.maxMicrousd / 1_000_000).toFixed(2) + ' maximum' }) : null,
      executionSummary(selected)),
    workflow.status === 'deferred'
      ? el('p', { class: 'muted small', text: 'You put this off earlier. It is still waiting.' })
      : null,
    actions,
    status,
    el('details', { class: 'evidence' },
      el('summary', { text: 'Why this decision?' }),
      el('p', { class: 'summary', text: workflow.summary }),
      el('a', { href: workflow.url, class: 'record-link', text: 'Open the workflow record ↗' })));
  doIt.addEventListener('click', () => chooseWorkflow(workflow, selected, status, card));
  reject.addEventListener('click', async () => {
    card.inert = true;
    status.textContent = 'Rejecting recommendation…';
    try {
      const saved = await post('/api/workflows/' + workflow.number + '/reject', {});
      replaceWorkflow(saved.workflow); render(); announce('Recommendation rejected. No work was approved.');
    } catch (error) { card.inert = false; status.classList.add('error'); status.textContent = error.message; }
  });
  return card;
}

function projectDecisionCard(project, preselect) {
  const key = 'pd-' + project.id;
  const status = statusLine();
  const yes = el('button', { type: 'button', class: 'button primary-action', text: preselect === 'NO' ? 'Confirm no' : 'Yes' });
  const later = el('button', { type: 'button', class: 'button quiet-action', text: 'Later' });
  const no = el('button', { type: 'button', class: 'button option-action', text: 'No' });
  const discuss = el('details', { class: 'discussion' },
    el('summary', { class: 'button discuss-action', text: 'Discuss' }),
    el('div', { class: 'discussion-body' },
      el('p', { text: project.status }),
      el('p', {}, el('strong', { text: 'Current blocker: ' }), project.blocker),
      el('p', {}, el('strong', { text: 'Next step: ' }), project.next),
      no));
  const card = cardShell(key, project.name + ' · Decision', project.question,
    el('p', { class: 'summary', text: project.status }),
    el('div', { class: 'decision-actions' }, yes, discuss, later),
    status,
    el('details', { class: 'evidence' },
      el('summary', { text: 'Details' }),
      el('a', { href: project.decision.url, class: 'record-link', text: 'Open the decision record ↗' })));
  const primaryChoice = preselect === 'NO' ? 'NO' : 'YES';
  yes.addEventListener('click', () => recordProjectDecision(project, primaryChoice, status, card));
  no.addEventListener('click', () => recordProjectDecision(project, 'NO', status, card));
  later.addEventListener('click', () => recordProjectDecision(project, 'DEFER', status, card));
  return card;
}

function reportPreview(text) {
  const result = text ?? '';
  const short = reportSummary(result);
  if (short === result) return el('p', { class: 'result-text prewrap', text: result });
  return el('div', {},
    el('p', { class: 'result-text prewrap', text: short }),
    el('details', { class: 'evidence' },
      el('summary', { text: 'Read the full result' }),
      el('p', { class: 'prewrap', text: result })));
}

function checkCard(workflow) {
  const key = 'wf-' + workflow.number;
  const status = statusLine();
  const accept = el('button', { type: 'button', class: 'button primary-action', text: 'Accept result' });
  const sendBack = el('button', { type: 'button', class: 'button send-back-action', text: 'Send back' });
  const note = el('textarea', {
    rows: '3',
    maxlength: '1000',
    placeholder: 'What needs fixing?',
    'aria-label': 'What needs fixing?',
  });
  const submitNote = el('button', { type: 'button', class: 'button danger-action', text: 'Send back with note' });
  const cancel = el('button', { type: 'button', class: 'button quiet-action', text: 'Cancel' });
  const noteForm = el('div', { class: 'note-form', hidden: true }, note, el('div', { class: 'note-actions' }, submitNote, cancel));
  const card = cardShell(key, workflow.project + ' · Result ready', workflow.title,
    reportPreview(workflow.result),
    el('div', { class: 'result-actions' }, accept, sendBack),
    noteForm,
    status,
    el('details', { class: 'evidence' },
      el('summary', { text: 'Evidence' }),
      el('p', { text: 'You chose “' + optionLabel(workflow) + '”. Alfred reported back ' +
        when(workflow.events.find(event => event.type === 'completed')?.at) + '.' }),
      el('a', { href: workflow.url, class: 'record-link', text: 'Open the workflow record ↗' })));
  accept.addEventListener('click', () => verify(workflow, 'verified', '', status, card));
  sendBack.addEventListener('click', () => {
    noteForm.hidden = false;
    note.focus();
  });
  submitNote.addEventListener('click', () =>
    verify(workflow, 'verification_failed', note.value, status, card, noteForm));
  cancel.addEventListener('click', () => {
    note.value = '';
    noteForm.hidden = true;
    status.textContent = '';
  });
  return card;
}

function settledCard(key, text) {
  return el('article', { class: 'focus-card settled', 'data-card': key },
    el('p', { text }));
}

function liveCard(key, preselect) {
  if (key.startsWith('wf-')) {
    const workflow = findWorkflow(Number(key.slice(3)));
    if (!workflow) return settledCard(key, 'This item is no longer available.');
    if (['decision', 'deferred'].includes(workflow.status) && workflow.open) return decisionCard(workflow, preselect);
    if (['completed', 'verifying'].includes(workflow.status) && workflow.open) return checkCard(workflow);
    return settledCard(key, workflow.title + ' — ' + STATUS[workflow.status] + '.');
  }
  const project = data?.projects?.find(item => 'pd-' + item.id === key);
  if (!project) return settledCard(key, 'This decision is no longer available.');
  if (project.decision?.ready && !project.decision.choice) return projectDecisionCard(project, preselect);
  return settledCard(key, project.name + ': ' + (project.decision?.choice ?? 'decision unavailable') + '.');
}

function refreshConversationCards() {
  for (const node of thread.querySelectorAll('[data-card]')) {
    if (node.contains(document.activeElement)) continue;
    node.replaceWith(liveCard(node.dataset.card));
  }
}

function renderDoing() {
  const rank = { running: 0, checking: 1, queued: 2, verification_failed: 3, blocked: 4 };
  const items = inProgress().filter(w => ['running', 'checking', 'queued'].includes(w.status)).sort((a, b) => rank[a.status] - rank[b.status]);
  doingCount.textContent = items.length > 1 ? String(items.length) : '';
  if (!items.length) {
    const brief = projectBrief(data);
    doingCard.replaceChildren(el('div', { class: 'doing-card idle' },
      el('span', { class: 'state-dot', 'aria-hidden': 'true' }),
      el('div', {},
        el('p', { class: 'doing-title', text: brief.headline }),
        el('p', { class: 'muted', text: brief.progress }),
        el('p', { text: brief.next }))));
    return;
  }
  const entry = workflow => el('details', { class: 'doing-card ' + workflow.status },
    el('summary', {},
      el('span', { class: 'state-dot', 'aria-hidden': 'true' }),
      el('span', {},
        el('strong', { class: 'doing-title', text: workflow.project + ' · ' + (optionLabel(workflow) ?? workflow.title) }),
        el('span', { class: 'list-subtitle', text: STATUS[workflow.status] }))),
    workflow.result ? el('p', { class: 'prewrap', text: workflow.result }) : null,
    workflow.verification?.note ? el('p', { class: 'prewrap', text: 'Your note: ' + workflow.verification.note }) : null,
    el('a', { href: workflow.url, class: 'record-link', text: 'Open the record ↗' }));
  doingCard.replaceChildren(entry(items[0]), ...(items.length > 1 ? [
    el('details', { class: 'other-work' },
      el('summary', { text: (items.length - 1) + ' more item' + (items.length === 2 ? '' : 's') }),
      ...items.slice(1).map(entry)),
  ] : []));
}

function renderAttention() {
  if (data.workflows === null) {
    attentionCard.replaceChildren(el('p', { class: 'error', text: 'Couldn’t read your decisions. Refresh to try again.' }));
    waitingCount.textContent = '';
    return;
  }
  const items = attention();
  const captured = (data?.inbox ?? []).filter(item => ['blocked', 'unconfirmed', 'ready'].includes(item.work?.status));
  waitingCount.textContent = items.length + captured.length > 1 ? (items.length + captured.length) + ' waiting' : '';
  const current = focus();
  attentionCard.replaceChildren(items.length
    ? liveCard(current.key)
    : captured.length ? el('div', { class: 'focus-card' },
      el('h3', { text: captured[0].work.status === 'ready' ? 'Work ready to review' : 'Work needs attention' }),
      el('p', { class: 'summary', text: captured[0].title }),
      el('p', { class: 'muted small', text: captured[0].work.nextStep || 'Open the result to review what Alfred prepared.' }),
      el('button', { type: 'button', class: 'button primary-action', text: 'OPEN TASK',
        onclick: () => { $('#inbox-drawer').open = true; $('#inbox-drawer').scrollIntoView({ behavior: 'smooth' }); } }))
    : el('div', { class: 'empty-state' },
      el('p', { class: 'doing-title', text: 'No decision waiting for you' }),
      el('p', { class: 'muted', text: projectBrief(data).next })));
  if (items.length > 1) {
    const picker = el('select', { id: 'attention-picker', 'aria-label': 'Choose another item' },
      items.map(item => el('option', { value: item.key, text: item.workflow.project + ' · ' + item.workflow.title })));
    picker.value = current.key;
    picker.addEventListener('change', () => { selectedAttention = picker.value; renderAttention(); });
    attentionCard.prepend(el('label', { for: 'attention-picker', text: 'Choose another item' }), picker);
  }
}

function recentWorkflows() {
  return [...workflows()].sort((a, b) => b.number - a.number);
}

function recentEntry(workflow) {
  return el('li', {},
    el('details', {},
      el('summary', {},
        el('span', {},
          el('strong', { text: workflow.project }),
          el('span', { class: 'list-subtitle', text: workflow.title })),
        el('span', { class: 'done-mark', text: STATUS[workflow.status] })),
      el('p', { class: 'prewrap', text: workflow.result || workflow.summary }),
      el('a', { href: workflow.url, class: 'record-link', text: 'Open the record ↗' })));
}

function renderRecent() {
  const recent = recentWorkflows().filter(w => ['completed', 'verifying', 'verified'].includes(w.status));
  recentCount.textContent = String(recent.length);
  recentList.replaceChildren(...(recent.length
    ? recent.map(recentEntry)
    : [el('li', { class: 'empty-list', text: 'No activity yet.' })]));
  const blocked = openWorkflows().filter(w => ['blocked', 'verification_failed'].includes(w.status) &&
    (!data?.focusProject || w.project === data.focusProject));
  $('#blocked-section').hidden = !blocked.length;
  $('#blocked-count').textContent = String(blocked.length);
  $('#blocked-list').replaceChildren(...blocked.map(recentEntry));
  $('#history-list').replaceChildren(...recentWorkflows().filter(w => !w.open || w.status === 'rejected').map(recentEntry));
  const deferred = openWorkflows().filter(item => item.status === 'deferred');
  $('#later-section').hidden = !deferred.length;
  $('#later-count').textContent = String(deferred.length);
  $('#later-list').replaceChildren(...deferred.map(workflow => el('li', {},
    el('details', {}, el('summary', { text: workflow.title }), decisionCard(workflow)))));
}

function projectEntry(project) {
  const links = [
    project.repositoryUrl ? { title: 'Repository', url: project.repositoryUrl } : null,
    ...(project.references ?? []),
    ...(project.tasks ?? []).map(task => ({ title: task.kind + ' #' + task.number + ' · ' + task.title, url: task.url })),
  ].filter(Boolean);
  return el('li', {},
    el('details', {},
      el('summary', {},
        el('span', {},
          el('strong', { text: project.name }),
          el('span', { class: 'list-subtitle', text: project.status }),
          el('span', { class: 'list-subtitle', text: 'Next: ' + project.next })),
        el('span', { class: 'chevron', 'aria-hidden': 'true', text: '›' })),
      el('dl', { class: 'project-facts' },
        el('dt', { text: 'Next' }), el('dd', { text: project.next }),
        el('dt', { text: 'Blocked by' }), el('dd', { text: project.blocker })),
      el('button', { type: 'button', class: 'button report-button', text: 'Progress report',
        'aria-label': 'Progress report: ' + project.name, onclick: () => projectReport(project) }),
      links.length ? el('details', { class: 'evidence' },
        el('summary', { text: 'Technical records' }),
        el('ul', { class: 'record-list' }, links.map(link =>
          el('li', {}, el('a', { href: link.url, text: link.title }))))) : null));
}

function projectReport(project) {
  openAsk();
  const flows = workflows().filter(w => w.project === project.name).sort((a, b) => b.number - a.number);
  const active = flows.filter(w => w.open && (['running', 'checking'].includes(w.status) || (w.status === 'queued' && requiresClaude(w))));
  const blocked = flows.filter(w => w.open && ['blocked', 'verification_failed'].includes(w.status));
  const finished = flows.find(w => ['verified', 'completed'].includes(w.status));
  const recorded = flows.filter(w => w.status === 'queued' && !requiresClaude(w));
  message('alfred', el('p', { class: 'message-title', text: project.name + ' — progress report' }),
    el('p', { text: project.status }),
    el('p', { text: active.length ? active.map(w => STATUS[w.status] + ': ' + (optionLabel(w) ?? w.title)).join('\n') : (recorded.length ? 'Last decision recorded; no Claude work was requested.' : 'Nothing is running for this project.') }),
    blocked.length ? el('p', { text: 'Blocked: ' + blocked.map(w => w.title).join('; ') }) : null,
    finished ? el('p', { text: 'Latest result: ' + finished.title + '. ' + STATUS[finished.status] + '.' }) : null,
    el('p', { text: 'Next: ' + project.next }),
    finished ? el('details', { class: 'evidence' }, el('summary', { text: 'Read the findings' }), reportPreview(finished.result)) : null,
    el('p', { class: 'muted small', text: 'Based on Alfred’s records, checked ' + when(data.checkedAt) + '. No model call needed.' }));
}


async function markCapturedDone(id, button) {
  button.disabled = true;
  try {
    await post('/api/brain/items/' + encodeURIComponent(id) + '/done', {});
    await load(true);
  } catch (error) {
    button.disabled = false;
    $('#capture-status').textContent = error.message;
    $('#capture-status').classList.add('error');
  }
}

async function doCapturedWork(id, button) {
  const status = $('#capture-status');
  const wasDisabled = button?.disabled;
  if (button) button.disabled = true;
  status.classList.remove('error');
  status.textContent = 'Working on this task…';
  try {
    const result = await post('/api/brain/items/' + encodeURIComponent(id) + '/work', { confirmCostMicrousd: 30000 });
    await load(true);
    status.textContent = result.work?.status === 'ready' ? 'Draft finished. Open the result below.' :
      result.work?.status === 'blocked' ? 'Blocked — see what is needed below.' :
        result.work?.status === 'unconfirmed' ? 'Claude did not confirm a result. No automatic retry.' :
          'Work request recorded.';
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
  } finally {
    if (button) button.disabled = Boolean(wasDisabled);
  }
}

function renderInbox() {
  const items = data?.inbox ?? [];
  inboxCount.textContent = String(items.length);
  inboxList.replaceChildren(...(items.length ? items.map(item => {
    const projectName = data.projects?.find(project => project.id === item.projectId)?.name ?? 'Unsorted';
    const work = item.work;
    return el('li', { class: 'captured-item' },
      el('span', { class: 'capture-note', text: item.title }),
      el('span', { class: 'list-subtitle', text: projectName + ' · ' + when(item.createdAt) }),
      work?.status === 'ready'
        ? el('details', { class: 'work-result' }, el('summary', { text: 'Draft ready — review result' }),
          el('p', { class: 'prewrap', text: work.result }),
          el('p', { class: 'muted small', text: 'Prepared by Claude. No external app, source code or files were changed.' }))
        : work?.status === 'blocked' || work?.status === 'unconfirmed'
          ? el('p', { class: 'work-blocker', text: (work.result ? work.result + '\n' : '') + work.nextStep })
          : work?.status === 'working'
            ? el('p', { class: 'muted small', text: 'Claude request started; status not confirmed. No automatic retry.' })
            : el('button', { type: 'button', class: 'button primary', text: 'Work on it · max US$0.03',
                onclick: event => doCapturedWork(item.id, event.currentTarget) }),
      el('button', { type: 'button', class: 'quiet-button', text: 'Done', onclick: event => markCapturedDone(item.id, event.currentTarget) }));
  }) : [el('li', { class: 'empty-list', text: 'Nothing captured yet.' })]));
}

function renderProjects() {
  const projects = data?.projects ?? [];
  projectsCount.textContent = String(projects.length);
  projectList.replaceChildren(...(projects.length
    ? projects.map(projectEntry)
    : [el('li', { class: 'empty-list', text: 'No projects available.' })]));
}

function render(force = true) {
  // An unchanged poll must not detach controls, collapse evidence or lose notes.
  const signature = JSON.stringify({ workflows: data.workflows, projects: data.projects, inbox: data.inbox });
  if (!force && signature === renderedData) {
    freshness.textContent = 'Checked ' + timeFormat.format(new Date(data.checkedAt));
    return;
  }
  renderedData = signature;
  renderDoing();
  if (force || !attentionCard.contains(document.activeElement)) renderAttention();
  renderRecent();
  renderInbox();
  renderProjects();
  refreshConversationCards();
  freshness.textContent = 'Checked ' + timeFormat.format(new Date(data.checkedAt));
}

function replaceWorkflow(workflow) {
  data.workflows = workflows().map(item => item.number === workflow.number ? workflow : item);
}

function announce(text) {
  homeStatus.classList.remove('error');
  homeStatus.textContent = text;
  if (askDialog.open) message('alfred', text);
}

async function chooseWorkflow(workflow, option, status, controls) {
  controls.inert = true;
  status.classList.remove('error');
  status.textContent = 'Saving your choice…';
  try {
    const saved = await post('/api/workflows/' + workflow.number + '/choice', {
      option: option.id,
      label: option.label,
      detail: option.detail,
      ...(option.execution
        ? { execution: option.execution, confirmCostMicrousd: option.execution.maxMicrousd }
        : {}),
    });
    if (!saved.workflow) throw new Error('Refresh to check whether the choice was saved.');
    replaceWorkflow(saved.workflow);
    const accepted = option.id === 'defer'
      ? saved.workflow.status === 'deferred'
      : saved.workflow.choice === option.id;
    render();
    if (!accepted) {
      announce('Another choice was already recorded: ' + (optionLabel(saved.workflow) ?? STATUS[saved.workflow.status]) + '.');
    } else if (option.id === 'defer') {
      announce('Saved for later.');
    } else {
      announce(option.execution ? 'Approved “' + option.label + '”. Alfred will report back here.' : 'Recorded “' + option.label + '”. No Claude task was started.');
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
    status.textContent = 'Say briefly what needs fixing.';
    return;
  }
  controls.inert = true;
  if (form) form.inert = true;
  status.classList.remove('error');
  status.textContent = 'Saving…';
  try {
    const saved = await post('/api/workflows/' + workflow.number + '/verify',
      note ? { verdict, note } : { verdict });
    replaceWorkflow(saved.workflow);
    render();
    announce(verdict === 'verified'
      ? 'Result accepted. That loop is closed.'
      : 'Sent back with your note.');
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
  status.textContent = 'Saving…';
  try {
    const saved = await post('/api/decisions/' + project.id, { choice });
    if (saved.decision?.choice !== choice) throw new Error('The decision was not confirmed. Refresh and try again.');
    await load(true);
    announce(choice === 'DEFER' ? 'Saved for later.' : 'Recorded ' + choice + ' for ' + project.name + '.');
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
    controls.inert = false;
    if (error.status === 401) signedOut(error.message);
  }
}

function nextLabel(item) {
  if (item.kind === 'check') return 'check “' + item.workflow.title + '”';
  if (item.kind === 'workflow') return item.workflow.project + ' — ' + item.workflow.title;
  return item.project.name + ' — ' + item.project.question;
}

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

const PROJECT_WORDS = [
  [/deceiver|narrat|portrait/, 'deceivers-audit', 'The Deceivers'],
  [/science|buddy|biology|osmosis|diffusion|lesson/, 'science-mvp', 'Science Buddy'],
  [/man ?cave|festival|stall|stock|signage/, 'mci-freeze', 'ManCave Industries'],
  [/song|transpose|setlist|set list/, 'songbook-hold', 'Risk Assessment Songbook'],
];
const STOP_WORDS = new Set([
  'with', 'that', 'this', 'them', 'then', 'first', 'second', 'third', 'option',
  'choice', 'approve', 'choose', 'please', 'want', 'what', 'about', 'lets',
  "let's", 'yeah', 'okay', 'sure', 'think', 'should', 'would',
]);

function matchOption(text, workflow) {
  const words = text.split(/[^a-z0-9']+/).filter(word => word.length > 3 && !STOP_WORDS.has(word));
  const scores = workflow.options.map(option => {
    const label = option.label.toLowerCase().split(/[^a-z0-9']+/);
    return words.filter(word => label.some(part =>
      part.startsWith(word) || (word.startsWith(part) && part.length > 3))).length;
  });
  const top = Math.max(...scores);
  if (top > 0 && scores.filter(score => score === top).length === 1) {
    return workflow.options[scores.indexOf(top)];
  }
  const ordinal = text.match(/\b(?:option|choice|number)\s*(\d)\b|^\s*(\d)\s*$|\b(first|second|third|1st|2nd|3rd)\b/);
  if (!ordinal) return null;
  const word = ordinal[3];
  const index = word
    ? { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2 }[word]
    : Number(ordinal[1] ?? ordinal[2]) - 1;
  return workflow.options[index] ?? null;
}

function confirmDecision(item, option) {
  if (item.kind === 'project') {
    const choice = option ?? 'YES';
    message('alfred', 'Confirm this choice:', liveCard(item.key, choice));
    return;
  }
  const chosen = option ?? item.workflow.options[0];
  message('alfred', 'Confirm this choice:', liveCard(item.key, chosen.id));
}

function describeNow() {
  const running = inProgress();
  if (!running.length) {
    const brief = projectBrief(data);
    return brief.headline + '. ' + brief.progress + '\n' + brief.next;
  }
  return running.map(item => '• ' + item.project + ': ' +
    (optionLabel(item) ?? item.title) + ' — ' + STATUS[item.status].toLowerCase() + '.').join('\n');
}

function describeResults() {
  return workflows()
    .filter(item => ['completed', 'verifying', 'verified', 'verification_failed'].includes(item.status))
    .sort((a, b) => b.number - a.number)
    .slice(0, 3);
}


async function saveFromConversation(text, project = false) {
  try {
    await post(project ? '/api/brain/projects' : '/api/brain/capture', { title: text });
    message('alfred', project
      ? 'Project saved: ' + text + '. Tell me what you need done.'
      : 'Captured and saved. This has not been sent to Claude or executed.');
    await load(true);
  } catch (error) {
    message('alfred', 'Could not save: ' + error.message);
  }
}

function respond(raw) {
  const text = raw.toLowerCase().replace(/[’']/g, "'").trim();
  const current = focus();
  const decisions = pendingDecisions();
  const checks = pendingChecks();

  if (awaitingNote !== null) {
    const workflow = findWorkflow(awaitingNote);
    awaitingNote = null;
    if (workflow && ['completed', 'verifying'].includes(workflow.status)) {
      const status = statusLine();
      const controls = quickReplies(
        ['Send it back', () => verify(workflow, 'verification_failed', raw, status, controls), 'button danger-action'],
        ['Cancel', () => { controls.inert = true; status.textContent = 'Cancelled.'; }, 'button quiet-action']);
      message('alfred', 'Send this note back?', el('blockquote', { text: raw }), controls, status);
      return;
    }
  }

  if (/^(help|\?|what can you do)/.test(text)) {
    message('alfred', 'Ask what is happening, what needs you, what finished, or how a project is doing. You can also say yes, later, looks right, or tell me what needs fixing.');
    return;
  }

  const accepts = checks.length && /(looks (good|right|fine)|verified|correct|accept|all good)/.test(text);
  const isQuestion = /\?$|^(what|why|how|when|where|which|who|is|are|does|do|can)\b/.test(text);
  const rejects = checks.length && !isQuestion && /(wrong|not right|incorrect|problem|mistake|send (it )?back)/.test(text);
  if (accepts && !rejects) {
    const item = checks[0];
    const status = statusLine();
    const controls = quickReplies(
      ['Accept result', () => verify(item.workflow, 'verified', '', status, controls), 'button primary-action'],
      ['Not yet', () => { controls.inert = true; status.textContent = 'Left open.'; }, 'button quiet-action']);
    message('alfred', 'Accept this result?', controls, status);
    return;
  }
  if (rejects) {
    awaitingNote = checks[0].workflow.number;
    message('alfred', 'What needs fixing? Tell me in one sentence.');
    return;
  }

  if (decisions.length && /\b(later|defer|not now|skip|park|wait)\b/.test(text)) {
    const item = decisions[0];
    if (item.kind === 'workflow') {
      const status = statusLine();
      const controls = quickReplies(
        ['Save for later', () => chooseWorkflow(item.workflow, { id: 'defer', label: 'Later' }, status, controls), 'button'],
        ['Cancel', () => { controls.inert = true; status.textContent = 'Kept open.'; }, 'button quiet-action']);
      message('alfred', 'Save “' + item.workflow.title + '” for later?', controls, status);
    } else {
      confirmDecision(item, 'DEFER');
    }
    return;
  }

  const firstDecision = current?.kind === 'workflow' ? current : decisions[0];
  if (firstDecision?.kind === 'workflow') {
    const option = matchOption(text, firstDecision.workflow);
    if (option && /\b(approve|go|choose|pick|option|choice|do|yes|let's|first|second|third|\d)\b/.test(text)) {
      confirmDecision(firstDecision, option);
      return;
    }
  }
  if (/^(yes|yeah|approve|go ahead|go for it|do it|ok|okay|sure|agreed|proceed)\b/.test(text)) {
    if (!current) message('alfred', 'Nothing is waiting for a yes right now.');
    else if (current.kind === 'check') respond('looks right');
    else confirmDecision(current, null);
    return;
  }
  if (/^(no|nope|nah)\b/.test(text) && current) {
    if (current.kind === 'project') confirmDecision(current, 'NO');
    else if (current.kind === 'check') {
      awaitingNote = current.workflow.number;
      message('alfred', 'What needs fixing? Tell me in one sentence.');
    } else {
      message('alfred', 'Use REJECT on the recommendation to decline it, or DISCUSS to choose another route.', liveCard(current.key));
    }
    return;
  }

  for (const [pattern, id, name] of PROJECT_WORDS) {
    if (!pattern.test(text)) continue;
    const project = data.projects?.find(item => item.id === id);
    if (project) { projectReport(project); return; }
    const flows = openWorkflows().filter(item => item.project.toLowerCase() === name.toLowerCase());
    const lines = [];
    if (project) lines.push(project.status, 'Next: ' + project.next, 'Blocked by: ' + project.blocker);
    for (const flow of flows) lines.push('• ' + flow.title + ' — ' + STATUS[flow.status].toLowerCase() + '.');
    message('alfred', el('p', { class: 'message-title', text: name }),
      el('p', { class: 'prewrap', text: lines.join('\n') }));
    return;
  }
  if (/alfred/.test(text) && /report|progress|status|how/.test(text)) {
    const project = data.projects?.find(item => item.id === 'alfred');
    if (project) { projectReport(project); return; }
  }
  if (/(happening|in progress|progress|working on|running|doing|busy)/.test(text)) {
    message('alfred', el('p', { class: 'prewrap', text: describeNow() }));
    return;
  }
  if (/(result|report|finished|completed|done|history|recent|what happened)/.test(text)) {
    const done = describeResults();
    if (!done.length) {
      message('alfred', 'Nothing has reported back yet.');
      return;
    }
    message('alfred', 'Recent results:', el('ul', { class: 'compact' }, done.map(item =>
      el('li', {}, el('strong', { text: item.project + ' — ' + item.title }), el('br'),
        (item.result ?? '').slice(0, 220) + ((item.result ?? '').length > 220 ? '…' : '')))),
    quickReplies(['Open finished work', () => {
      askDialog.close();
      recentSection.open = true;
      recentSection.scrollIntoView({ behavior: 'smooth' });
    }]));
    return;
  }
  if (/(next|needs? me|for me|waiting|todo|to do|brief|update|summary|^hi\b|^hello|^hey)/.test(text)) {
    if (!current) message('alfred', describeNow());
    else message('alfred', current.kind === 'check' ? 'This result needs your check:' : 'This is the next decision:', liveCard(current.key));
    return;
  }

  const newProject = /^(?:add|create|start)\s+(?:a\s+|new\s+)?project\s+(?:called\s+|named\s+)?(.+)$/i.exec(raw.trim());
  if (newProject) {
    saveFromConversation(newProject[1], true);
    return;
  }
  if (isQuestion) offerClaude(raw);
  else saveFromConversation(raw);
}

function offerClaude(question) {
  if (!data.claude?.askReady) {
    message('alfred', 'I cannot answer that from the records yet. Try asking what is next, what is happening, recent results, or a project name.');
    return;
  }
  const status = statusLine();
  const controls = quickReplies(
    ['Ask Claude', () => askClaude(question, status, controls), 'button primary-action'],
    ['Cancel', () => { controls.inert = true; status.textContent = 'Cancelled.'; }, 'button quiet-action']);
  message('alfred', 'That needs Claude. Ask once using Alfred’s capped trial budget?', controls, status);
}

async function askClaude(question, status, controls) {
  controls.inert = true;
  status.textContent = 'Asking…';
  try {
    const result = await post('/api/ask', { question });
    status.textContent = '';
    message('alfred', el('p', { class: 'prewrap', text: result.answer }),
      el('p', { class: 'muted small', text: 'Answered by Claude from Alfred’s records.' }));
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
    if (error.status === 401) signedOut(error.message);
  }
}

function signedOut(text) {
  workspaceEl.hidden = true;
  refreshButton.hidden = true;
  if (askDialog.open) askDialog.close();
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
    refreshButton.hidden = false;
    render(force === true);
    const keys = attention().map(item => item.key);
    if (knownAttention && force !== true) {
      const fresh = attention().filter(item => !knownAttention.includes(item.key));
      if (fresh.length) announce(fresh[0].kind === 'check' ? 'A new result is ready.' : 'A new decision is ready.');
    }
    knownAttention = keys;
  } catch (error) {
    if (data && error.status !== 401) {
      freshness.textContent = 'Couldn’t refresh';
      homeStatus.classList.add('error');
      homeStatus.textContent = error.message;
    } else {
      workspaceEl.hidden = true;
      sessionPanel.hidden = false;
      const params = new URLSearchParams(location.search).get('sign-in');
      sessionMessage.textContent = error.status === 401
        ? signInMessages[params] || error.message
        : error.message;
      login.hidden = error.status !== 401;
      retry.hidden = error.status === 401;
      freshness.textContent = error.status === 401 ? 'Signed out' : 'Offline';
    }
  } finally {
    loading = false;
    refreshButton.disabled = false;
  }
}

function openAsk() {
  if (!thread.children.length) {
    message('alfred', 'What would you like to know?');
  }
  if (typeof askDialog.showModal === 'function') askDialog.showModal();
  else askDialog.setAttribute('open', '');
  say.focus();
}

composer.addEventListener('submit', event => {
  event.preventDefault();
  const text = say.value.trim();
  if (!text || !data) return;
  say.value = '';
  message('me', text);
  respond(text);
});
say.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
for (const chip of document.querySelectorAll('[data-say]')) {
  chip.addEventListener('click', () => {
    if (!data) return;
    message('me', chip.dataset.say);
    respond(chip.dataset.say);
  });
}

$('#capture-form').addEventListener('submit', async event => {
  event.preventDefault();
  const field = $('#capture-text');
  const title = field.value.trim();
  if (!title || !data) return;
  const buttons = [...$('#capture-form').querySelectorAll('button')];
  const work = event.submitter?.dataset.mode === 'work';
  const status = $('#capture-status');
  buttons.forEach(button => { button.disabled = true; });
  status.classList.remove('error');
  status.textContent = 'Saving…';
  try {
    const saved = await post('/api/brain/capture', { title });
    field.value = '';
    status.textContent = 'Saved privately in Alfred.';
    if (work && saved.item?.id) {
      await doCapturedWork(saved.item.id);
    } else {
      await load(true);
    }
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
});

$('#add-project').addEventListener('click', () => {
  const form = $('#project-form');
  form.hidden = !form.hidden;
  if (!form.hidden) $('#project-name').focus();
});
$('#project-form').addEventListener('submit', async event => {
  event.preventDefault();
  const field = $('#project-name');
  const title = field.value.trim();
  if (!title || !data) return;
  const button = $('#project-form button');
  const status = $('#project-status');
  button.disabled = true;
  status.classList.remove('error');
  status.textContent = 'Saving…';
  try {
    await post('/api/brain/projects', { title });
    field.value = '';
    status.textContent = '';
    $('#project-form').hidden = true;
    await load(true);
    announce('Project added: ' + title + '. Capture tasks or ideas to track them.');
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

refreshButton.addEventListener('click', () => location.reload());
retry.addEventListener('click', () => load(true));
$('#open-ask').addEventListener('click', openAsk);
$('#home-composer').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#home-say');
  const text = input.value.trim();
  if (!text || !data) return;
  input.value = ''; openAsk(); message('me', text); respond(text);
});
$('#close-ask').addEventListener('click', () => askDialog.close());
askDialog.addEventListener('click', event => {
  if (event.target === askDialog) askDialog.close();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && data) load();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && data && !askDialog.open) load();
}, POLL_MS);
load();
