import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBrief, reportSummary } from '../public/project-brief.js';

test('empty approvals explain unfinished work and the next project step', () => {
  const brief = projectBrief({ projects: [{ id: 'alfred', next: 'Connect the result handoff.' }], workflows: [] });
  assert.equal(brief.headline, 'Projects still have work to do');
  assert.match(brief.progress, /does not mean your projects are finished/);
  assert.equal(brief.next, 'Connect the result handoff.');
});

test('blocked work stays visible without claiming execution', () => {
  const brief = projectBrief({ workflows: [{ open: true, status: 'blocked', title: 'Fix', result: 'Runner credential expired.' }] });
  assert.equal(brief.headline, 'Work is blocked');
  assert.match(brief.progress, /Fix\. Open Blocked work/);
});

test('suspended project blockers and closed attempts cannot dominate Alfred status', () => {
  const brief = projectBrief({ focusProject: 'Alfred', workflows: [
    { open: false, project: 'Alfred', status: 'blocked', title: 'Old failed proof' },
    { open: true, project: 'Science Buddy', status: 'blocked', title: 'Paused lesson' },
    { open: true, project: 'Alfred', status: 'decision', number: 40, title: 'Finish the dashboard' },
  ] });
  assert.equal(brief.headline, 'Projects still have work to do');
  assert.equal(brief.next, 'Your next decision: Finish the dashboard');
});

test('home report gives a short lead without exposing commit IDs or evidence URLs', () => {
  const result = 'Accepted the exact wording in draft PR #37 and verified it remains unmerged at commit ' + 'a'.repeat(40) + '. The source is saved. Evidence: https://github.com/example/repo/commit/' + 'b'.repeat(40);
  const summary = reportSummary(result);
  assert.equal(summary, 'Accepted the exact wording in draft PR #37 and verified it remains unmerged.');
  assert.ok(reportSummary('A long finding '.repeat(100)).length <= 180);
});

test('closed history and non-executing choices never count as running', () => {
  const brief = projectBrief({ workflows: [
    { open: false, status: 'running' },
    { open: true, status: 'queued', choice: 'keep', options: [{ id: 'keep' }] },
  ] });
  assert.equal(brief.headline, 'Projects still have work to do');
});
