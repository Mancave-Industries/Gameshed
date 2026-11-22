import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBrief } from '../public/project-brief.js';

test('empty approvals explain unfinished work and the next project step', () => {
  const brief = projectBrief({ projects: [{ id: 'alfred', next: 'Connect the result handoff.' }], workflows: [] });
  assert.equal(brief.headline, 'Projects still have work to do');
  assert.match(brief.progress, /does not mean your projects are finished/);
  assert.equal(brief.next, 'Connect the result handoff.');
});

test('blocked work stays visible without claiming execution', () => {
  const brief = projectBrief({ workflows: [{ open: true, status: 'blocked', title: 'Fix', result: 'Runner credential expired.' }] });
  assert.equal(brief.headline, 'Work is blocked');
  assert.equal(brief.progress, 'Runner credential expired.');
});

test('closed history and non-executing choices never count as running', () => {
  const brief = projectBrief({ workflows: [
    { open: false, status: 'running' },
    { open: true, status: 'queued', choice: 'keep', options: [{ id: 'keep' }] },
  ] });
  assert.equal(brief.headline, 'Projects still have work to do');
});
