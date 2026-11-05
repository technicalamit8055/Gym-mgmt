import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Finding the notes Note 3 exported for the class that just ended.
 *
 * Note 3 writes its PDF into a folder the institute chooses (set once on the
 * board, see main.js). The class's export is the newest PDF there written
 * since the class started — anything older is an earlier lecture's. Exports
 * sometimes land in a dated subfolder, so the search goes two levels down.
 *
 * A PDF that is still growing is not returned: the size and modified time
 * have to hold still across `settleMs`, or the upload would be half a file.
 */

/** Allowance for the board's clock and the file system's timestamps disagreeing a little. */
const CLOCK_SLACK_MS = 5_000;

async function pdfsIn(dir, depth) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) found.push(...(await pdfsIn(full, depth - 1)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) found.push(full);
  }
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} dir Note 3's export folder.
 * @param {object} opts
 * @param {number} opts.since When the class started (epoch ms).
 * @param {number} [opts.settleMs] How long the file must stay unchanged.
 * @returns {Promise<{path: string, name: string, size: number, modified: number} | null>}
 */
export async function findClassNotes(dir, { since, settleMs = 750 }) {
  if (!dir) return null;
  const candidates = [];
  for (const file of await pdfsIn(dir, 2)) {
    try {
      const stat = await fs.stat(file);
      if (stat.size > 0 && stat.mtimeMs >= since - CLOCK_SLACK_MS) candidates.push({ file, stat });
    } catch {
      // gone between listing and stat — not ours
    }
  }
  if (!candidates.length) return null;
  const newest = candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];

  await sleep(settleMs);
  let again;
  try {
    again = await fs.stat(newest.file);
  } catch {
    return null;
  }
  if (again.size !== newest.stat.size || again.mtimeMs !== newest.stat.mtimeMs) return null;
  return { path: newest.file, name: path.basename(newest.file), size: again.size, modified: again.mtimeMs };
}
