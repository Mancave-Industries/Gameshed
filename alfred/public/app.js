const panel = document.querySelector('#session-panel');
const message = document.querySelector('#session-message');
const login = document.querySelector('#login');
const logout = document.querySelector('#logout');
const retry = document.querySelector('#retry');
const portfolio = document.querySelector('#portfolio');
const projects = document.querySelector('#projects');
const refresh = document.querySelector('#refresh');
const freshness = document.querySelector('#freshness');
const claudeRehearsal = document.querySelector('#claude-rehearsal');
const claudePilotStatus = document.querySelector('#claude-pilot-status');
const claudeHandoff = document.querySelector('#claude-handoff');
const nextActions = document.querySelector('#next-actions');
const nextEmpty = document.querySelector('#next-empty');
const cardTemplate = document.querySelector('#card');
const signInResult = new URLSearchParams(location.search).get('sign-in');
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short',
});
let saving = 0;

const signInMessages = {
  denied: 'Sign in with the Mancave Industries GitHub account.',
  expired: 'Sign-in expired. Start again.',
  failed: 'GitHub could not complete sign-in. Try again.',
};

function showConnection(text, options = {}) {
  panel.hidden = false;
  message.textContent = text;
  login.hidden = !options.login;
  retry.hidden = !options.retry;
}

async function api(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    const error = new Error(payload?.error || 'Alfred’s preview service is unavailable.');
    error.status = response.status;
    throw error;
  }
  return payload;
}

function appendLink(list, text, url) {
  const entry = document.createElement('li');
  const link = document.createElement('a');
  link.textContent = text;
  link.href = url;
  entry.append(link);
  list.append(entry);
}

function nextStep(project, choice) {
  return choice === 'DEFER'
    ? 'Revisit the deferred decision before changing the plan.'
    : project.afterDecision?.[choice]?.next ?? project.next;
}

function renderWorkstack(projectList) {
  const entries = [];
  for (const project of projectList) {
    const decision = project.decision;
    if (!decision || decision.choice === 'DEFER' || (!decision.choice && !decision.ready)) continue;
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = '#project-' + project.id;
    link.textContent = project.name;
    const action = document.createElement('p');
    action.textContent = decision.choice ? nextStep(project, decision.choice) : project.question;
    item.append(link, action);
    entries.push(item);
  }
  nextActions.replaceChildren(...entries);
  nextEmpty.hidden = entries.length > 0;
}

function renderCard(project, projectList) {
  const card = cardTemplate.content.firstElementChild.cloneNode(true);
  const query = selector => card.querySelector(selector);
  card.id = 'project-' + project.id;
  query('.priority').textContent = project.priority;
  query('h3').textContent = project.name;
  const repo = query('.repo-link');
  repo.href = project.repositoryUrl;
  repo.setAttribute('aria-label', project.name + ' repository');
  const projectStatus = query('.project-status');
  const blocker = query('.blocker');
  const next = query('.next');
  const question = query('.question');
  question.textContent = project.question;

  const activity = query('.activity');
  if (project.activity === 'unavailable') {
    activity.textContent = 'GitHub activity unavailable. Check repository access.';
  } else if (project.activity === 'partial') {
    activity.textContent = 'Partial GitHub activity. Some items could not be loaded.';
  } else if (!project.tasks.length) {
    activity.textContent = 'No open work found in the checked GitHub results.';
  } else {
    activity.hidden = true;
  }
  for (const task of project.tasks) {
    appendLink(query('.tasks'), task.kind + ' #' + task.number + ' · ' + task.title, task.url);
  }
  for (const ref of project.references) appendLink(query('.references'), ref.title, ref.url);

  const choices = query('.choices');
  const buttons = [...choices.querySelectorAll('button')];
  const decisionPanel = query('.decision');
  const decisionHeading = query('.decision h4');
  const history = query('.decision-history');
  const changeDecision = query('.change-decision');
  const decisionStatus = query('.decision-status');
  const decisionLink = query('.decision-link');
  let decision = project.decision;
  let editing = false;

  function displayDecision() {
    decisionStatus.classList.remove('error');
    const recorded = Boolean(decision?.choice);
    const followUp = project.afterDecision?.[decision?.choice];
    projectStatus.textContent = followUp?.status ?? project.status;
    blocker.textContent = followUp?.blocker ?? project.blocker;
    next.textContent = nextStep(project, decision?.choice);
    if (recorded && decisionPanel.parentElement !== history) history.append(decisionPanel);
    history.hidden = !recorded;
    decisionHeading.textContent = recorded ? 'Recorded decision' : 'Decision';
    question.hidden = recorded && !editing;
    choices.hidden = recorded && !editing;
    changeDecision.hidden = !recorded || !decision.ready;
    changeDecision.textContent = editing ? 'Cancel change' : 'Change decision';
    changeDecision.setAttribute('aria-expanded', String(editing));
    if (recorded) {
      const date = decision.recordedAt ? ' · ' + dateFormat.format(new Date(decision.recordedAt)) : '';
      decisionStatus.textContent = 'Recorded in GitHub · ' + decision.choice + date;
    } else {
      decisionStatus.textContent = decision?.ready ? 'Awaiting your decision.' : 'Decision issue unavailable.';
    }
    decisionLink.hidden = !decision?.url;
    if (decision?.url) decisionLink.href = decision.url;
    for (const button of buttons) {
      button.disabled = !decision?.ready;
      button.setAttribute('aria-pressed', String(button.value === decision?.choice));
    }
  }

  changeDecision.addEventListener('click', () => {
    editing = !editing;
    displayDecision();
  });

  for (const button of buttons) {
    button.setAttribute('aria-label', button.value + ' for ' + project.name);
    button.addEventListener('click', async () => {
      saving += 1;
      refresh.disabled = true;
      for (const option of buttons) option.disabled = true;
      changeDecision.disabled = true;
      decisionStatus.classList.remove('error');
      decisionStatus.textContent = 'Saving to GitHub…';
      try {
        const saved = await api('/api/decisions/' + project.id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ choice: button.value }),
        });
        if (saved.decision?.choice !== button.value) throw new Error('GitHub did not confirm the decision. Refresh to check.');
        decision = saved.decision;
        project.decision = decision;
        editing = false;
        displayDecision();
        history.open = false;
        history.querySelector('summary').focus();
        renderWorkstack(projectList);
      } catch (error) {
        displayDecision();
        decisionStatus.classList.add('error');
        decisionStatus.textContent = error.message;
        if (error.status === 401) showConnection(error.message, { login: true });
      } finally {
        changeDecision.disabled = false;
        saving -= 1;
        refresh.disabled = saving > 0;
      }
    });
  }

  displayDecision();
  return card;
}

async function loadDashboard() {
  refresh.disabled = true;
  retry.disabled = true;
  projects.inert = true;
  freshness.textContent = 'Checking GitHub…';
  try {
    const data = await api('/api/dashboard');
    const cards = data.projects.map(project => renderCard(project, data.projects));
    projects.replaceChildren(...cards);
    renderWorkstack(data.projects);
    const pilot = data.claudePilot;
    const needsApproval = Boolean(pilot?.ready && !pilot.run);
    claudePilotStatus.classList.toggle('action-required', needsApproval);
    claudeHandoff.classList.toggle('button', needsApproval);
    claudeHandoff.classList.toggle('action-required', needsApproval);
    claudePilotStatus.textContent = pilot?.run
      ? 'Live Deceivers pilot · ' + pilot.run.status
      : pilot?.ready ? 'Live Deceivers pilot ready for your approval.' : 'Live Deceivers pilot is waiting for the Anthropic API credential.';
    const rehearsal = data.latestRehearsal;
    claudeRehearsal.textContent = rehearsal
      ? 'Latest £0 rehearsal completed for Deceivers #' + rehearsal.issueNumber +
        ' · ' + dateFormat.format(new Date(rehearsal.completedAt))
      : rehearsal === null ? 'No rehearsal approvals recorded yet.' : 'Rehearsal history unavailable.';
    freshness.textContent = 'GitHub checked ' + dateFormat.format(new Date(data.checkedAt)) +
      ' · Brief reviewed ' + data.briefDate;
    panel.hidden = true;
    logout.hidden = false;
    portfolio.hidden = false;
  } catch (error) {
    projects.replaceChildren();
    portfolio.hidden = true;
    logout.hidden = true;
    showConnection(
      error.status === 401 ? signInMessages[signInResult] || error.message : error.message,
      { login: error.status === 401, retry: error.status !== 401 },
    );
  } finally {
    refresh.disabled = saving > 0;
    retry.disabled = false;
    projects.inert = false;
  }
}

refresh.addEventListener('click', loadDashboard);
retry.addEventListener('click', loadDashboard);
loadDashboard();
