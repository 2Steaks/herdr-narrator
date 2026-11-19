// Fake sidecar: same interface as lib/sidecar.mjs, records calls, makes no sound.
// By default a line ends the moment it starts. Set `holdLines = true` to keep each line "playing" until
// `endCurrent()` or the next cancel/speak, as a real line of audio would. `ended` resolves 'done' or 'cancelled'.
export function createFakeSidecar() {
  let current = null; // { end } of the line that is "playing"
  let starting = null; // a speak that has not "started" yet (still rendering): { resolve, end }
  const cut = () => {
    current?.end('cancelled');
    current = null;
    if (starting) { starting.end('cancelled'); starting.resolve({ cancelled: true }); starting = null; }
  };
  const fake = {
    calls: [], // { op: 'speak' | 'cancel' | 'chime' | ..., ... } in order
    holdLines: false,
    holdStart: false, // speak() stays pending (as while Kokoro renders) until startPending() or a cancel
    speak(job) {
      cut(); // a new speak cuts the old line off, as the real sidecar does
      fake.calls.push({ op: 'speak', ...job });
      let end;
      const ended = new Promise((r) => { end = r; });
      const res = { renderMs: 0, cached: false, cancelled: false, ended };
      if (fake.holdStart) {
        return new Promise((resolve) => {
          starting = { resolve: () => resolve({ cancelled: true, ended: Promise.resolve('cancelled') }), end, go: () => { starting = null; if (fake.holdLines) current = { end }; else end('done'); resolve(res); } };
        });
      }
      if (fake.holdLines) current = { end }; else end('done');
      return Promise.resolve(res);
    },
    chime(kind) {
      cut();
      fake.calls.push({ op: 'chime', kind });
      return Promise.resolve({ cancelled: false, ended: Promise.resolve('done') });
    },
    render(job) {
      fake.calls.push({ op: 'render', ...job });
      return Promise.resolve({ renderMs: 0 });
    },
    prerender(job) {
      fake.calls.push({ op: 'prerender', ...job });
    },
    evict(key) {
      fake.calls.push({ op: 'evict', key });
    },
    cancel() {
      fake.calls.push({ op: 'cancel' });
      cut();
    },
    /** The pending speak finishes rendering and starts. */
    startPending() { starting?.go(); },
    get rendering() { return starting !== null; },
    /** The playing line finishes on its own. */
    endCurrent() {
      current?.end('done');
      current = null;
    },
    get playing() {
      return current !== null;
    },
    get spoken() {
      return fake.calls.filter((c) => c.op === 'speak').map((c) => c.text);
    },
    async close() {},
  };
  return fake;
}
