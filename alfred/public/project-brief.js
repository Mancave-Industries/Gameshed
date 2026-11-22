// Evidence only: an empty approval queue never establishes project completion.
export function projectBrief(data) {
  const projects = data?.projects ?? [];
  const flows = (data?.workflows ?? []).filter(w => w.open &&
    (!data?.focusProject || w.project === data.focusProject));
  const active = flows.filter(w => ['running', 'checking', 'verifying'].includes(w.status));
  const blocked = flows.filter(w => ['blocked', 'verification_failed'].includes(w.status));
  const queued = flows.filter(w => w.status === 'queued' && w.options?.find(o => o.id === w.choice)?.execution);
  const decisions = flows.filter(w => w.status === 'decision');
  const project = projects.find(p => p.id === 'alfred') ?? projects[0];
  return {
    headline: active.length ? 'Work is in progress' : blocked.length ? 'Work is blocked' : queued.length ? 'Approved work is waiting to start' : 'Projects still have work to do',
    progress: active.length ? active.map(w => w.project + ': ' + w.title).join('; ') : blocked.length ? blocked[0].title + '. Open Blocked work for the reason and next step.' : queued.length ? queued[0].title : 'No execution is currently recorded. This does not mean your projects are finished.',
    next: decisions.length ? 'Your next decision: ' + [...decisions].sort((a, b) => (a.project === 'Alfred' ? 0 : 1) - (b.project === 'Alfred' ? 0 : 1) || b.number - a.number)[0].title : project?.next || 'Establish the next task and who can carry it out.',
  };
}

// Keep the full record intact; the home screen needs only a readable lead.
export function reportSummary(text) {
  const clean = (text ?? '').replace(/https?:\/\/\S+/g, '')
    .replace(/\b[0-9a-f]{40}\b/gi, '')
    .replace(/\s+(?:at commit|commit)\s*(?=[.,]|$)/g, '')
    .replace(/\s+([.,;])/g, '$1').replace(/\s+/g, ' ').trim();
  const sentence = clean.match(/^.{1,180}?[.!?](?:\s|$)/)?.[0]?.trim();
  if (sentence) return sentence;
  return clean.length <= 180 ? clean : clean.slice(0, 175).replace(/\s+\S*$/, '') + '…';
}
