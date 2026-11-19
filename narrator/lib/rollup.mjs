// The Rollup: one short line about every agent in a tab, built from states and cached Summaries.
// Pure functions. No model call: an agent without a cached Summary is counted by state only.

const ORDER = ['blocked', 'working', 'done', 'idle']; // what needs the user first
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * agents: [{ status, summary? }]. "One blocked, two done." When exactly one agent is blocked and its Summary is
 * cached, the Summary follows as the reason. Returns null when there is nothing to say.
 */
export function buildRollup(agents) {
  const counts = new Map();
  for (const a of agents) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  const parts = ORDER.filter((s) => counts.get(s)).map((s) => `${WORDS[counts.get(s)] ?? counts.get(s)} ${s}`);
  if (!parts.length) return null;
  const head = parts.join(', ');
  let line = `${head[0].toUpperCase()}${head.slice(1)}.`;
  const blocked = agents.filter((a) => a.status === 'blocked');
  if (blocked.length === 1 && blocked[0].summary) line += ` ${blocked[0].summary}`;
  return line;
}

/** Same inputs, same signature, whatever the order: used to stay quiet about a tab whose Rollup has not changed. */
export function rollupSignature(agents) {
  return agents.map((a) => `${a.paneId}:${a.status}:${a.revision ?? 0}`).sort().join('|');
}
