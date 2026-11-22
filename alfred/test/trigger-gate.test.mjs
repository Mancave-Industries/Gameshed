import test from 'node:test';
import assert from 'node:assert/strict';
import { executableChoice } from '../runner/trigger-gate.mjs';

const OWNER_ID = 287470662;
const PROPOSAL = '<!-- alfred-workflow:v1 -->\n';
const EVENT = '<!-- alfred-workflow-event:v1 -->\n';
const execution = {
  repo: 'Gameshed', sha: 'a'.repeat(40), paths: ['alfred/runner/README.md'],
  profile: 'source-review', maxMicrousd: 100000,
};
const options = [
  { id: 'run', label: 'Run the bounded check', detail: 'One approved request.', execution },
  { id: 'publish', label: 'Publish the tested fix', detail: 'Merge and publish without inference.' },
];

function payload(option = options[0], changes = {}) {
  const base = {
    repository: { full_name: 'Mancave-Industries/Gameshed' },
    issue: {
      state: 'open', user: { id: OWNER_ID },
      body: PROPOSAL + JSON.stringify({ project: 'Alfred', title: 'Choose', summary: 'Choose safely.', options }),
    },
    comment: {
      id: 123, user: { id: OWNER_ID },
      body: EVENT + JSON.stringify({ type: 'choice', option: option.id, label: option.label, detail: option.detail }),
    },
  };
  return {
    ...base, ...changes,
    issue: { ...base.issue, ...changes.issue },
    comment: { ...base.comment, ...changes.comment },
  };
}

test('only an exact owner choice with a valid execution grant starts the runner', () => {
  assert.equal(executableChoice(payload()), true);
  assert.equal(executableChoice(payload(options[1])), false, 'ordinary publish choice is a successful no-op');
  assert.equal(executableChoice(payload(options[0], { comment: {
    body: EVENT + JSON.stringify({ type: 'choice', option: 'run', label: options[0].label, detail: 'Changed scope.' }),
  } })), false);
  assert.equal(executableChoice(payload(options[0], { issue: { state: 'closed' } })), false);
  assert.equal(executableChoice(payload(options[0], { comment: { user: { id: 1 } } })), false);
  assert.equal(executableChoice(payload(options[0], { comment: { body: EVENT + JSON.stringify({ type: 'choice', option: 'defer' }) } })), false);
});

test('malformed proposals and invalid execution scopes fail closed', () => {
  assert.equal(executableChoice(payload(options[0], { issue: { body: 'not a proposal' } })), false);
  const invalid = options.map(option => option.id === 'run'
    ? { ...option, execution: { ...option.execution, paths: ['.github/workflows/unsafe.yml'] } }
    : option);
  const bad = payload();
  bad.issue.body = PROPOSAL + JSON.stringify({ project: 'Alfred', title: 'Choose', summary: 'Choose safely.', options: invalid });
  assert.equal(executableChoice(bad), false);
});
