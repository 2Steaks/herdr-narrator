// The voice arbiter: what may speak when. Tested with a fake sidecar whose lines can be held "playing".
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVoice } from '../lib/voice.mjs';
import { createState } from '../lib/state.mjs';
import { createFakeSidecar } from './fake-sidecar.mjs';

const tick = () => new Promise((r) => setImmediate(r));
let sidecar, state, voice, stateFile;

beforeEach(() => {
  sidecar = createFakeSidecar();
  stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-')), 'state.json');
  state = createState({ file: stateFile });
  voice = createVoice({ sidecar, state });
});

test('a line for a pane speaks once per revision: refocusing an unchanged pane is silent', async () => {
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'First.' });
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'First.' });
  assert.deepEqual(sidecar.spoken, ['First.']);
  await voice.say({ paneId: 'p1', key: 'p1#2', text: 'Second.' });
  assert.deepEqual(sidecar.spoken, ['First.', 'Second.'], 'a new revision speaks');
  await voice.say({ paneId: 'p2', key: 'p2#1', text: 'Other pane.' });
  await voice.say({ paneId: 'p1', key: 'p1#2', text: 'Second.' });
  assert.equal(sidecar.spoken.length, 3, 'going elsewhere and back does not repeat it either');
});

test('a line cut off while it plays still counts as spoken: refocusing is silent, replay plays it', async () => {
  sidecar.holdLines = true;
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'First.' });
  voice.cancel(); // the next focus event cuts it off
  await tick();
  const again = await voice.say({ paneId: 'p1', key: 'p1#1', text: 'First.' });
  assert.deepEqual(again, { spoken: false, reason: 'repeat' });
  assert.deepEqual(sidecar.spoken, ['First.']);
  await voice.replay(async () => null);
  assert.deepEqual(sidecar.spoken, ['First.', 'First.'], 'replay still plays the cut-off line');
});

test('muted: nothing speaks and nothing counts as spoken', async () => {
  voice.toggleMute();
  const r = await voice.say({ paneId: 'p1', key: 'p1#1', text: 'First.' });
  assert.equal(r.spoken, false);
  assert.deepEqual(sidecar.spoken, []);
  voice.toggleMute();
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'First.' });
  assert.deepEqual(sidecar.spoken, ['First.'], 'after unmuting the line was never heard, so it speaks');
});

test('the mute toggle chimes, cuts the current line, and persists', async () => {
  sidecar.holdLines = true;
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'First.' });
  assert.equal(voice.toggleMute(), true);
  assert.deepEqual(sidecar.calls.filter((c) => c.op === 'chime'), [{ op: 'chime', kind: 'muted' }]);
  assert.equal(sidecar.playing, false, 'the line was cut off');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).NARRATOR_MUTED, true);
  assert.equal(createVoice({ sidecar, state: createState({ file: stateFile }) }).muted, true, 'a restarted the Narrator is still muted');
  voice.toggleMute();
  assert.deepEqual(sidecar.calls.filter((c) => c.op === 'chime').map((c) => c.kind), ['muted', 'unmuted']);
});

test('an alert never interrupts a line in progress and plays when the line ends', async () => {
  sidecar.holdLines = true;
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'Long line.' });
  const r = voice.alert({ key: 'a1', text: 'Alert one.' });
  assert.equal(r, 'held');
  await tick();
  assert.deepEqual(sidecar.spoken, ['Long line.']);
  sidecar.endCurrent();
  await tick();
  assert.deepEqual(sidecar.spoken, ['Long line.', 'Alert one.']);
});

test('an alert on an idle voice plays at once', async () => {
  assert.equal(voice.alert({ key: 'a1', text: 'Alert one.' }), 'playing');
  await tick();
  assert.deepEqual(sidecar.spoken, ['Alert one.']);
});

test('at most one alert is held: a second one while one waits is dropped', async () => {
  sidecar.holdLines = true;
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'Long line.' });
  assert.equal(voice.alert({ key: 'a1', text: 'Alert one.' }), 'held');
  assert.equal(voice.alert({ key: 'a2', text: 'Alert two.' }), 'dropped');
  sidecar.endCurrent();
  await tick();
  sidecar.endCurrent();
  await tick();
  assert.deepEqual(sidecar.spoken, ['Long line.', 'Alert one.']);
});

test('onIdle fires once the voice is idle with a free slot, so a dropped alert can be offered again', async () => {
  let idles = 0;
  voice = createVoice({ sidecar, state, onIdle: () => { idles++; } });
  sidecar.holdLines = true;
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'Long line.' });
  voice.alert({ key: 'a1', text: 'Alert one.' });
  assert.equal(voice.alert({ key: 'a2', text: 'Alert two.' }), 'dropped');
  sidecar.endCurrent(); // the long line ends: a1 starts, the voice is not idle yet
  await tick();
  assert.equal(idles, 0);
  sidecar.endCurrent(); // a1 ends: idle, slot free
  await tick();
  assert.equal(idles, 1);
});

test('a held alert waits out a focus transition, and is dropped if it stopped being relevant', async () => {
  voice.setQuiet(true);
  assert.equal(voice.alert({ key: 'a1', text: 'Alert one.' }), 'held');
  voice.setQuiet(false);
  await tick();
  assert.deepEqual(sidecar.spoken, ['Alert one.']);

  voice.setQuiet(true);
  let relevant = true;
  voice.alert({ key: 'a2', text: 'Alert two.', relevant: () => relevant });
  relevant = false; // for example the pane got focus, or unblocked
  voice.setQuiet(false);
  await tick();
  assert.deepEqual(sidecar.spoken, ['Alert one.']);
});

test('an alert that gets cut off by a new focus line is held again, not lost', async () => {
  sidecar.holdLines = true;
  voice.alert({ key: 'a1', text: 'Alert one.' });
  await tick();
  voice.setQuiet(true);
  sidecar.cancel(); // focus moved: the cut-off alert goes back to the slot
  await tick();
  voice.setQuiet(false);
  await tick();
  assert.deepEqual(sidecar.spoken, ['Alert one.', 'Alert one.']);
});

test('muted: alerts are dropped, and a held alert is cleared by muting', async () => {
  sidecar.holdLines = true;
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'Long line.' });
  voice.alert({ key: 'a1', text: 'Alert one.' });
  voice.toggleMute();
  assert.equal(voice.alert({ key: 'a2', text: 'Alert two.' }), 'muted');
  voice.toggleMute();
  await tick();
  assert.deepEqual(sidecar.spoken, ['Long line.']);
});

test('replay speaks the last spoken line again, even for an unchanged pane', async () => {
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'First.' });
  await voice.replay(async () => ({ key: 'x', text: 'Fallback.' }));
  assert.deepEqual(sidecar.spoken, ['First.', 'First.']);
  assert.equal(sidecar.calls.filter((c) => c.op === 'speak')[1].key, 'p1#1', 'same key, so the cached audio plays');
});

test('replay with nothing spoken yet falls back to the focused pane Summary', async () => {
  await voice.replay(async () => ({ key: 'p9#4', text: 'Cached one.' }));
  assert.deepEqual(sidecar.spoken, ['Cached one.']);
  const quiet = createVoice({ sidecar: createFakeSidecar(), state });
  const r = await quiet.replay(async () => null);
  assert.equal(r.spoken, false, 'nothing to replay');
});

test('replay is silent while muted', async () => {
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'First.' });
  voice.toggleMute();
  await voice.replay(async () => null);
  assert.deepEqual(sidecar.spoken, ['First.']);
});

test('an alert cut off while its audio is still rendering goes back to the slot', async () => {
  sidecar.holdStart = true;
  voice.alert({ key: 'a1', text: 'Alert one.' });
  await tick();
  assert.equal(sidecar.rendering, true);
  voice.setQuiet(true); // a focus flick...
  sidecar.cancel(); // ...cuts it while Kokoro renders
  await tick();
  sidecar.holdStart = false;
  assert.equal(sidecar.spoken.length, 1, 'held, not replayed during the flick');
  voice.setQuiet(false);
  await tick();
  assert.deepEqual(sidecar.spoken, ['Alert one.', 'Alert one.'], 'spoken again once the voice was free');
});

test('while a line is still rendering the voice is busy: a second alert is held, not played over it', async () => {
  sidecar.holdStart = true;
  voice.alert({ key: 'a1', text: 'Alert one.' });
  await tick();
  assert.equal(voice.alert({ key: 'a2', text: 'Alert two.' }), 'held');
  assert.equal(sidecar.calls.filter((c) => c.op === 'speak').length, 1, 'the second did not replace the first');
  sidecar.holdStart = false;
  sidecar.startPending();
  await tick();
  await tick();
  assert.deepEqual(sidecar.spoken, ['Alert one.', 'Alert two.']);
});

test('a notice replaces a held alert instead of being dropped', async () => {
  sidecar.holdLines = true;
  await voice.say({ paneId: 'p1', key: 'p1#1', text: 'Long line.' });
  voice.alert({ key: 'a1', text: 'Alert one.' });
  assert.equal(voice.alert({ key: 'notice', text: 'Notice.', replace: true }), 'held');
  sidecar.endCurrent();
  await tick();
  assert.deepEqual(sidecar.spoken, ['Long line.', 'Notice.']);
});
