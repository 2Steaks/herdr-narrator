// The voice arbiter: everything the Narrator says goes through here, so the etiquette lives in one place.
//
//   say()     a line about the pane the user is looking at (Summary, Rollup). Cuts off whatever is playing.
//             Silent when muted, and silent when that pane's revision was already spoken (no repeats).
//   alert()   a line the user did not ask for (Blocked alert, expired-login notice). Never interrupts a line in progress:
//             it waits in a single slot until the voice is idle and no focus change is settling. Muted drops it.
//             A second alert while the slot is full returns 'dropped'; onIdle() fires when the slot is free and the
//             voice is idle, so the caller can offer the dropped alert again.
//   replay()  the last line spoken, or a fallback, at the user's request.
//   toggleMute()  flips NARRATOR_MUTED, cuts playback, confirms with a chime.
//
// Text is never logged here.
export function createVoice({ sidecar, state, log = () => {}, onIdle = () => {} }) {
  const spoken = new Map(); // paneId -> key of the last revision spoken for it
  let lastLine = null; // { key, text }: what replay plays
  let playing = false;
  let starting = 0; // speaks sent to the sidecar that have not started yet (it is rendering): the voice is not idle
  let lineSeq = 0;
  let quiet = false; // a focus change is settling: hold alerts so they do not talk over or get cut by the new line
  let held = null; // the one alert waiting for the voice to go idle

  function track(res, entry) {
    const mine = ++lineSeq;
    playing = true;
    res.ended?.then((how) => {
      // An alert that was cut off (not finished) goes back to the slot so it is still heard.
      if (entry && how === 'cancelled' && !state.muted && !held) held = entry;
      if (mine !== lineSeq) return; // a newer line took over the voice
      playing = false;
      flush();
    });
  }

  async function start(line, entry) {
    starting++;
    let res;
    try {
      res = await sidecar.speak({ key: line.key, text: line.text });
    } finally {
      starting--;
    }
    if (res.cancelled) {
      // Cut off before its audio began (a newer line took the sidecar): an alert goes back to the slot.
      if (entry && !state.muted && !held) held = entry;
      flush();
      return { spoken: false, res };
    }
    lastLine = { key: line.key, text: line.text };
    track(res, entry);
    return { spoken: true, res };
  }

  function flush() {
    if (playing || starting || quiet || state.muted) return;
    if (!held) return onIdle(); // idle with a free slot: the caller may retry alerts that were dropped
    const entry = held;
    held = null;
    if (entry.relevant && !entry.relevant()) {
      log({ level: 'info', msg: 'held alert no longer relevant', key: entry.key });
      return onIdle();
    }
    start(entry, entry).catch((err) => log({ level: 'error', msg: 'alert failed', err: err.message }));
  }

  return {
    get muted() { return state.muted; },
    /** True while a line is audibly playing. */
    get busy() { return playing || starting > 0; },

    /** A focus transition is settling (true) or done (false). Alerts wait while it is. */
    setQuiet(value) {
      quiet = value;
      if (!value) flush();
    },

    /** Cut off the line that is playing (a new focus event). */
    cancel() {
      sidecar.cancel();
    },

    /**
     * Speak a line now. `paneId` plus `key` make it a once-per-revision line. Resolves { spoken, res? }.
     * Muted or already spoken: { spoken: false, reason }.
     */
    async say({ paneId, key, text }) {
      if (state.muted) return { spoken: false, reason: 'muted' };
      if (paneId && spoken.get(paneId) === key) return { spoken: false, reason: 'repeat' };
      const out = await start({ key, text }, null);
      // Once its audio has started it counts as spoken, even if a newer focus cuts it off: leaving a tab and coming
      // back does not repeat it. The user asks for it again with replay.
      if (out.spoken && paneId) spoken.set(paneId, key);
      return out;
    },

    /** Record that a pane's revision was spoken by another route (a streamed live line). */
    markSpoken(paneId, key, text) {
      spoken.set(paneId, key);
      if (text) lastLine = { key, text }; // replay plays the whole Summary, not just its last streamed sentence
    },

    forget(paneId) {
      spoken.delete(paneId);
    },

    /** Returns 'playing' | 'held' | 'dropped' | 'muted'. */
    alert({ key, text, relevant, replace = false }) {
      if (state.muted) return 'muted';
      const entry = { key, text, relevant };
      if (playing || starting || quiet) {
        if (held && replace) { log({ level: 'warn', msg: 'held alert replaced by a notice', key: held.key }); held = entry; return 'held'; }
        if (held) { log({ level: 'warn', msg: 'alert dropped: another is already held', key }); return 'dropped'; }
        held = entry;
        return 'held';
      }
      start(entry, entry).catch((err) => log({ level: 'error', msg: 'alert failed', err: err.message }));
      return 'playing';
    },

    /** The last spoken line again; with nothing spoken yet, whatever `fallback()` returns ({key, text} or null). */
    async replay(fallback) {
      if (state.muted) return { spoken: false, reason: 'muted' };
      let line = lastLine;
      if (!line) {
        try { line = await fallback(); } catch (err) { log({ level: 'error', msg: 'replay fallback failed', err: err.message }); }
      }
      if (!line) return { spoken: false, reason: 'nothing to replay' };
      return start(line, null);
    },

    /** Flips NARRATOR_MUTED. Muting cuts playback and clears the held alert. Always chimes. Returns the new value. */
    toggleMute() {
      const muted = state.toggleMuted();
      if (muted) held = null;
      lineSeq++; // whatever was playing no longer owns the voice
      playing = false;
      sidecar.cancel();
      Promise.resolve(sidecar.chime(muted ? 'muted' : 'unmuted')).catch((err) => log({ level: 'error', msg: 'chime failed', err: err.message }));
      return muted;
    },
  };
}
