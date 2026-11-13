import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generate } from './run.mjs';

// Run the exact generation preflight, but NEVER forward an inference request.
export async function checkProvider(task, files, apiKey, provider = fetch) {
  if (!apiKey) return { status: 'blocked', code: 'provider-key-missing', inferenceStarted: false };
  const stopped = new Error('Free preflight finished before inference.');
  let ready = false;
  try {
    await generate(task, files, apiKey, async (url, init) => {
      if (url === 'https://api.anthropic.com/v1/messages/count_tokens' && init.method === 'POST') return provider(url, init);
      if (url === 'https://api.anthropic.com/v1/messages') { ready = true; throw stopped; }
      throw new Error('Preflight endpoint rejected.');
    });
  } catch (error) {
    if (ready && error === stopped) return { status: 'ready-for-inference', inferenceStarted: false };
    return { status: 'blocked', code: error.alfredGeneration?.code ?? 'preflight-failed', inferenceStarted: false };
  }
  return { status: 'blocked', code: 'preflight-did-not-stop', inferenceStarted: false };
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
  const task = { title: 'Prove Claude execution after the free review', project: 'Alfred',
    label: 'Run the US$0.10 live proof',
    detail: "Recommended. Make one read-only Claude request to review Alfred's execution guide, report key controls and remaining limits, and propose one genuine next decision. Change no files. US$0.10 maximum for this single request; report under 1,800 characters. This proves the live reporting path, not readiness for every development task.",
    spec: { repo: 'Gameshed', sha: 'e0c30363b6e71fbf264960e30fcd44487464469a', paths: ['alfred/runner/README.md'], profile: 'source-review', maxMicrousd: 100000 } };
  const content = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  const result = await checkProvider(task, [{ path: 'alfred/runner/README.md', content }], process.env.ANTHROPIC_API_KEY);
  console.log('Free provider preflight: ' + JSON.stringify(result));
  if (result.status !== 'ready-for-inference') process.exitCode = 1;
}
