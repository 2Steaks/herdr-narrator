import test from 'node:test';
import assert from 'node:assert/strict';
import { createHerdrAppClient } from '../lib/herdr-app.mjs';

const ls = (focusTab, terms) => JSON.stringify({ spaces: [{ id: 's1', active: true, tabs: [
  { id: 'tbA', name: '1', active: focusTab === 'tbA', terminals: terms.filter((t) => t.tab === 'tbA').map(({ tab, ...t }) => t) },
  { id: 'tbB', name: 'docs', active: focusTab === 'tbB', terminals: terms.filter((t) => t.tab === 'tbB').map(({ tab, ...t }) => t) },
] }] });

function fake() {
  const w = { focusTab: 'tbA', focusedPane: 'pa', terms: [
    { tab: 'tbA', terminal: 't1', pane: 'pa', status: 'working', app: 'claude-code' },
    { tab: 'tbB', terminal: 't2', pane: 'pb', status: 'idle', app: 'claude-code' },
    { tab: 'tbB', terminal: 't3', pane: 'pc', status: 'idle', app: 'shell' },
  ] };
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'herdr-app' && args[0] === 'ls') return ls(w.focusTab, w.terms);
    if (cmd === 'herdr-app' && args[0] === 'status') return JSON.stringify({ tab: w.focusTab, focused_pane: w.focusedPane });
    if (cmd === 'hc') return 'pane text';
    throw new Error('unexpected');
  };
  return { w, calls, client: createHerdrAppClient({ run, pollMs: 5 }) };
}

test('pane.current is the focused terminal, shells are not agents', async () => {
  const { client, w } = fake();
  assert.equal((await client.request('pane.current')).pane.pane_id, 't1');
  w.focusedPane = 'pc';
  const cur = (await client.request('pane.current')).pane;
  assert.equal(cur.pane_id, 't3');
  assert.equal(cur.agent, undefined);
  assert.deepEqual((await client.request('agent.list')).agents.map((a) => a.pane_id), ['t1', 't2']);
});

test('snapshot gives tab labels, pane.read goes through hc', async () => {
  const { client, calls } = fake();
  const { snapshot } = await client.request('session.snapshot');
  assert.deepEqual(snapshot.tabs.map((t) => t.label), ['1', 'docs']);
  assert.equal((await client.request('pane.read', { pane_id: 't1', lines: 7 })).read.text, 'pane text');
  assert.deepEqual(calls.at(-1), ['hc', 'read', 't1', '--lines', '7']);
});

test('focus, tab, status and lifecycle events come from diffs', async () => {
  const { client, w } = fake();
  const got = [];
  await client.subscribe([{ type: 'pane.focused' }, { type: 'tab.focused' }, { type: 'pane.created' }, { type: 'pane.closed' }], (m) => got.push(`${m.event}:${m.data.pane_id ?? m.data.tab_id ?? m.data.pane?.pane_id}`));
  const status = [];
  await client.subscribe([{ type: 'pane.agent_status_changed', pane_id: 't1' }], (m) => status.push(m.data.agent_status));
  assert.deepEqual(got, [], 'the first look is a baseline, not an event');
  w.focusTab = 'tbB'; w.focusedPane = 'pb';
  w.terms[0].status = 'blocked';
  w.terms.push({ tab: 'tbB', terminal: 't9', pane: 'pz', status: 'idle', app: 'codex' });
  await new Promise((r) => setTimeout(r, 40));
  w.terms.splice(1, 1);
  await new Promise((r) => setTimeout(r, 40));
  client.close();
  assert.ok(got.includes('tab.focused:tbB'));
  assert.ok(got.includes('pane.focused:t2'));
  assert.ok(got.includes('pane.created:t9'));
  assert.ok(got.includes('pane.closed:t2'));
  assert.deepEqual(status, ['blocked']);
});
