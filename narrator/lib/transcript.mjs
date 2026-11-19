// Reads the tail of a Claude Code transcript (JSONL) and returns what the last turn said.
// The text goes to the model and nowhere else: callers must never log it.
import fs from 'node:fs/promises';

const isToolResultOnly = (content) =>
  Array.isArray(content) && content.length > 0 && content.every((b) => b?.type === 'tool_result');

/**
 * { text, lastTool } for the last turn: every main-thread assistant text block after the last real user prompt
 * (tool results do not start a turn), and the name of the last tool call. null when there is nothing to say.
 */
export async function readLastTurn(file, { maxBytes = 64 * 1024, maxChars = 4000 } = {}) {
  let tail;
  let truncatedStart = false;
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    truncatedStart = start > 0;
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    tail = buf.toString('utf8');
  } catch {
    return null;
  } finally {
    await fh?.close();
  }

  const lines = tail.split('\n');
  if (truncatedStart) lines.shift(); // the first line is usually cut in half

  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* partial or garbage line */ }
  }

  const texts = [];
  let lastTool = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.isSidechain) continue;
    const content = e?.message?.content;
    if (e?.type === 'user' && !isToolResultOnly(content)) break; // start of this turn
    if (e?.type !== 'assistant' || !Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j];
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.unshift(b.text.trim());
      else if (b?.type === 'tool_use' && !lastTool && typeof b.name === 'string') lastTool = b.name;
    }
  }
  if (texts.length === 0) return null;
  let text = texts.join('\n\n');
  if (text.length > maxChars) text = text.slice(-maxChars);
  return { text, lastTool };
}
