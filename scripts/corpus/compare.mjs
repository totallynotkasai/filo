/**
 * Compares two corpus results (`npm run corpus:run`), the old one first.
 *
 *   node scripts/corpus/compare.mjs <old.json> <new.json> [<diff.json>]
 *
 * Prints the counts; with a third path, also writes the notes behind them.
 * A note whose body differs between the runs (edited in between) is counted
 * apart and left out of the rest. Exits 1 when an output changed, a note
 * became read-only or a note newly failed to load, so it can gate a script;
 * unlocked notes don't count.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [oldPath, newPath, diffPath] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error('Usage: node scripts/corpus/compare.mjs <old.json> <new.json> [<diff.json>]');
  process.exit(2);
}

// Results written before the runner moved into the repo are a bare path map.
const notesOf = (file) => {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return data.notes ?? data;
};
const oldR = notesOf(oldPath);
const newR = notesOf(newPath);
const clip = (text) => text?.slice(0, 400);

const stats = {
  compared: 0,
  onlyOld: 0,
  onlyNew: 0,
  inputChanged: 0,
  skipped: 0,
  failedBefore: 0,
  newlyFailed: 0,
  bothEditable: 0,
  bothReadOnly: 0,
  newlyReadOnly: 0,
  changed: 0,
  changedTowardFile: 0,
  unlocked: 0,
  unlockedExact: 0,
};
const lists = {
  newlyFailed: [],
  newlyReadOnly: [],
  changed: [],
  changedTowardFile: [],
  unlocked: [],
  inputChanged: [],
  failedBefore: [],
  skipped: [],
};

for (const [path, o] of Object.entries(oldR)) {
  const n = newR[path];
  if (!n) {
    stats.onlyOld++;
    continue;
  }
  stats.compared++;
  if (o.bodyHash && n.bodyHash && o.bodyHash !== n.bodyHash) {
    stats.inputChanged++;
    lists.inputChanged.push(path);
  } else if (o.skipped || n.skipped) {
    stats.skipped++;
    lists.skipped.push({ path, old: o.skipped, new: n.skipped });
  } else if (n.error && !o.error) {
    stats.newlyFailed++;
    lists.newlyFailed.push({ path, error: n.error });
  } else if (o.error) {
    stats.failedBefore++;
    lists.failedBefore.push({ path, old: o.error, new: n.error });
  } else compareNote(path, o, n);
}
for (const path of Object.keys(newR)) if (!oldR[path]) stats.onlyNew++;

function compareNote(path, o, n) {
  if (!o.lossy && !n.lossy) {
    stats.bothEditable++;
    if (o.hash === n.hash) return;
    stats.changed++;
    const entry = { path, old: clip(o.out), new: clip(n.out) };
    if (n.same) {
      stats.changedTowardFile++;
      lists.changedTowardFile.push(entry);
    } else lists.changed.push(entry);
  } else if (o.lossy && n.lossy) stats.bothReadOnly++;
  else if (o.lossy) {
    stats.unlocked++;
    if (n.same) stats.unlockedExact++;
    lists.unlocked.push({ path, exact: !!n.same, new: n.same ? undefined : clip(n.out) });
  } else {
    stats.newlyReadOnly++;
    lists.newlyReadOnly.push({ path, old: clip(o.out), new: clip(n.out) });
  }
}

if (diffPath) writeFileSync(diffPath, JSON.stringify({ stats, ...lists }, null, 1));
console.log(JSON.stringify(stats, null, 1));
const moved = stats.changed + stats.newlyReadOnly + stats.newlyFailed;
console.log(
  moved === 0
    ? 'Same: no output changed, no note became read-only and none newly failed to load.'
    : `Different: ${stats.changed} output(s) changed (${stats.changedTowardFile} toward the file's own text), ` +
        `${stats.newlyReadOnly} newly read-only, ${stats.newlyFailed} newly failed to load.`,
);
if (stats.inputChanged || stats.onlyOld || stats.onlyNew) {
  console.log(
    `Not compared: ${stats.inputChanged} edited between the runs, ${stats.onlyOld} only in the old run, ` +
      `${stats.onlyNew} only in the new one. Use the same list, and re-run both when files changed.`,
  );
}
process.exit(moved === 0 ? 0 : 1);
