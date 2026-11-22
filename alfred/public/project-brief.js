// Evidence only: an empty approval queue never establishes project completion.
export function projectBrief(data) {
  const projects = data?.projects ?? [];
  const flows = (data?.workflows ?? []).filter(w => w.open);
  const active = flows.filter(w => ['running', 'checking', 'verifying'].includes(w.status));
  const blocked = flows.filter(w => ['blocked', 'verification_failed'].includes(w.status));
  const queued = flows.filter(w => w.status === 'queued' && w.options?.find(o => o.id === w.choice)?.execution);
  const decisions = flows.filter(w => w.status === 'decision');
  const project = projects.find(p => p.id === 'alfred') ?? projects[0];
  return {
    headline: active.length ? 'Work is in progress' : blocked.length ? 'Work is blocked' : queued.length ? 'Approved work is waiting to start' : 'Projects still have work to do',
    progress: active.length ? active.map(w => w.project + ': ' + w.title).join('; ') : blocked.length ? blocked[0].result || blocked[0].title : queued.length ? queued[0].title : 'No execution is currently recorded. This does not mean your projects are finished.',
    next: decisions.length ? 'Your next decision: ' + [...decisions].sort((a, b) => (a.project === 'Alfred' ? 0 : 1) - (b.project === 'Alfred' ? 0 : 1) || b.number - a.number)[0].title : project?.next || 'Establish the next task and who can carry it out.',
  };
}
