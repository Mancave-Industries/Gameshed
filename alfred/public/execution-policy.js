// Shared by the approval API and the credential-free runner. No shell instructions
// from GitHub or the model are executable configuration.
export const MODEL = 'claude-haiku-4-5-20251001';
export const MAX_OUTPUT = 8192;
export const MAX_SOURCE_BYTES = 60000;
export const REPOS = new Set(['Gameshed', 'Deceivers', 'Science_Budy', 'MANCAVE-INDUSTRIES.github.io', 'risk-assessment-songbook']);
export const PROFILES = new Set(['alfred-node', 'node-tests', 'source-review']);
export function safePath(path) {
  return typeof path === 'string' && /^[A-Za-z0-9_/-][A-Za-z0-9_. /-]{0,179}$/.test(path) &&
    !path.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.')) &&
    !/(^|\/)(node_modules|vendor|package-lock\.json|package\.json|deploy[^/]*|.*\.pem|.*\.key|.*\.env)$/i.test(path);
}
export function executionSpec(value) {
  if (!value || !REPOS.has(value.repo) || !/^[a-f0-9]{40}$/.test(value.sha ?? '') ||
      !Array.isArray(value.paths) || !value.paths.length || value.paths.length > 20 ||
      !value.paths.every(safePath) || new Set(value.paths).size !== value.paths.length ||
      !PROFILES.has(value.profile) || (value.profile === 'alfred-node' && value.repo !== 'Gameshed') ||
      !Number.isSafeInteger(value.maxMicrousd) || value.maxMicrousd < 0 || value.maxMicrousd > 750000) return null;
  return { repo: value.repo, sha: value.sha, paths: [...value.paths].sort(), profile: value.profile, maxMicrousd: value.maxMicrousd };
}
export function validateOutput(output, spec) {
  if (!output || typeof output.result !== 'string' || !output.result.trim() || output.result.length > 2400 ||
      !Array.isArray(output.files) || output.files.length > 20) throw new Error('Claude returned an incomplete result.');
  if (/sk-ant-[A-Za-z0-9_-]{20}|gh[pousr]_[A-Za-z0-9]{20}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(JSON.stringify(output))) throw new Error('Generated output may contain a credential and cannot be published.');
  const seen = new Set();
  for (const f of output.files) {
    if (!safePath(f.path) || !spec.paths.includes(f.path) || seen.has(f.path) ||
        typeof f.content !== 'string' || new TextEncoder().encode(f.content).length > MAX_SOURCE_BYTES ||
        spec.profile === 'source-review') throw new Error('Claude tried to change a file outside the approved scope.');
    seen.add(f.path);
  }
  if (spec.profile !== 'source-review' && !output.files.length) throw new Error('Claude did not produce the approved change.');
  return output;
}
export function nextProposal(value, project, context) {
  const short = (x, n) => typeof x === 'string' && x.trim() && x.length <= n;
  if (!value || !short(value.title, 140) || !short(value.summary, 900) ||
      !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 3 ||
      !value.options.every(o => /^[a-z][a-z0-9-]{0,31}$/.test(o.id) && o.id !== 'defer' && short(o.label, 80) && short(o.detail, 500)) ||
      new Set(value.options.map(o => o.id)).size !== value.options.length) return null;
  // Suggestions may offer another bounded task, but only within the same file
  // scope. Each one requires a fresh owner click and cost consent in Alfred.
  return { project, title: value.title, summary: value.summary,
    options: value.options.map(({ id, label, detail, action }) => ({ id, label, detail,
      ...(context && ['source-review', 'draft-change'].includes(action) ? { execution: {
        ...context.spec, sha: context.sha,
        profile: action === 'source-review' ? 'source-review' : context.spec.profile,
      } } : {}),
    })) };
}
