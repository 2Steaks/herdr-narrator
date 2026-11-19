// The Narrator's small persistent state: ~/.narrator/state.json, today just NARRATOR_MUTED (the one mute, spec decision 8).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_STATE_FILE = process.env.NARRATOR_STATE ?? path.join(os.homedir(), '.narrator', 'state.json');

function read(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // missing or corrupt: start from nothing
  }
}

export function createState({ file = DEFAULT_STATE_FILE, log = () => {} } = {}) {
  let muted = read(file).NARRATOR_MUTED === true;
  return {
    get muted() { return muted; },
    /** Flips NARRATOR_MUTED, writes it through, returns the new value. A failed write is logged and the flip still holds in memory. */
    toggleMuted() {
      muted = !muted;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ ...read(file), NARRATOR_MUTED: muted }, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch (err) {
        log({ level: 'error', msg: 'could not write state file', err: err.message });
      }
      return muted;
    },
  };
}
