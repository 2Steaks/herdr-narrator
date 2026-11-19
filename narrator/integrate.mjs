// Wires the Narrator into Herdr and Claude Code. Called by install.sh; every edit is idempotent and backs the file up first.
//   node integrate.mjs hook <claude settings.json> <path to narrator-stop-hook.sh>
//   node integrate.mjs keys <herdr config.toml>
//   node integrate.mjs appkeys <herdr-app keys.json>
// Each prints one line saying what it did ("added", "already there", "skipped: ...").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKUP_SUFFIX = '.bak-before-narrator';

function backup(file) {
  if (fs.existsSync(file) && !fs.existsSync(file + BACKUP_SUFFIX)) fs.copyFileSync(file, file + BACKUP_SUFFIX);
}

/** Adds the Stop hook to a Claude Code settings.json. Updates the path when an older Narrator hook is registered. */
export function addStopHook(file, hookPath) {
  const exists = fs.existsSync(file);
  const settings = exists ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {};
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  const ours = settings.hooks.Stop.flatMap((g) => g.hooks ?? []).filter((h) => /narrator-stop-hook\.sh$/.test(h.command ?? ''));
  if (ours.some((h) => h.command === hookPath)) return 'already there';
  backup(file);
  if (ours.length) {
    for (const h of ours) h.command = hookPath; // the checkout moved
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    return 'updated the path';
  }
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command: hookPath, timeout: 2 }] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return 'added';
}

export const KEY_BINDINGS = [
  { key: 'prefix+m', action: 'narrator.mute', description: 'narrator mute' },
  { key: 'prefix+a', action: 'narrator.replay', description: 'narrator replay (again)' },
  { key: 'prefix+u', action: 'narrator.start', description: 'narrator start' },
  { key: 'prefix+y', action: 'narrator.quit', description: 'narrator quit' },
];

/** Appends Herdr key bindings for the plugin actions, leaving alone any key that is already bound to something else. */
export function addHerdrKeys(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const out = [];
  const notes = [];
  for (const b of KEY_BINDINGS) {
    if (text.includes(`command = "${b.action}"`)) continue;
    if (text.includes(`key = "${b.key}"`)) { notes.push(`${b.key} is taken, so ${b.action} has no key`); continue; }
    out.push(`[[keys.command]]\nkey = "${b.key}"\ntype = "plugin_action"\ncommand = "${b.action}"\ndescription = "${b.description}"\n`);
  }
  if (!out.length) return notes.length ? `skipped: ${notes.join('; ')}` : 'already there';
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text + (text && !text.endsWith('\n\n') ? (text.endsWith('\n') ? '\n' : '\n\n') : '') + out.join('\n'));
  return `added ${out.length} key(s)${notes.length ? `; ${notes.join('; ')}` : ''}`;
}

/** Adds a Herdr app key that opens the Narrator overlay mod. */
export function addAppKey(file, key = 'cmd-shift-n') {
  if (!fs.existsSync(file)) return 'skipped: no Herdr app keys file';
  const keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  keys.global ??= {};
  if (Object.values(keys.global).includes('mod.open:narrator')) return 'already there';
  if (keys.global[key]) return `skipped: ${key} is taken, bind mod.open:narrator yourself`;
  backup(file);
  keys.global[key] = 'mod.open:narrator';
  fs.writeFileSync(file, JSON.stringify(keys, null, 2) + '\n');
  return `added ${key}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = { hook: () => addStopHook(args[0], args[1]), keys: () => addHerdrKeys(args[0]), appkeys: () => addAppKey(args[0]) }[cmd];
  if (!run) { console.error('usage: integrate.mjs hook|keys|appkeys ...'); process.exit(2); }
  try { console.log(run()); } catch (err) { console.log(`failed: ${err.message}`); process.exit(1); }
}
