import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executionSpec } from '../public/execution-policy.js';

const OWNER_ID = 287470662;
const REPOSITORY = 'Mancave-Industries/Gameshed';
const PROPOSAL = '<!-- alfred-workflow:v1 -->\n';
const EVENT = '<!-- alfred-workflow-event:v1 -->\n';

function markedJson(body, marker) {
  if (typeof body !== 'string' || !body.startsWith(marker)) return null;
  try { return JSON.parse(body.slice(marker.length)); } catch { return null; }
}

// GitHub starts this workflow for every matching owner comment. Only an exact
// executable option is authority to expose the model key or enter the runner.
export function executableChoice(payload) {
  if (payload?.repository?.full_name !== REPOSITORY || payload?.issue?.state !== 'open' ||
      payload?.issue?.user?.id !== OWNER_ID || payload?.comment?.user?.id !== OWNER_ID) return false;
  const proposal = markedJson(payload.issue.body, PROPOSAL);
  const event = markedJson(payload.comment.body, EVENT);
  if (!proposal || !Array.isArray(proposal.options) || !event ||
      event.type !== 'choice' || event.option === 'defer') return false;
  const option = proposal.options.find(candidate =>
    candidate?.id === event.option && candidate?.label === event.label && candidate?.detail === event.detail);
  return Boolean(option && executionSpec(option.execution));
}

async function main() {
  const payload = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const executable = executableChoice(payload);
  if (!process.env.GITHUB_OUTPUT) throw new Error('GitHub output path unavailable.');
  await appendFile(process.env.GITHUB_OUTPUT, `executable=${executable}\n`);
  console.log(executable
    ? 'Exact executable owner grant confirmed.'
    : 'This choice is a decision only; no runner or model call will start.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Approval gate stopped safely; no runner or model call was started.');
    process.exitCode = 1;
  });
}
