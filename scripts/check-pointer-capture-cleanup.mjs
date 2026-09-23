/**
 * Audit-16 7.5 / 6.1 — `ci:pointer-capture-cleanup`.
 *
 * 6.1's bug: Frame.svelte's inline drag/resize captured the pointer
 * (`setPointerCapture`) and opened a spatial batch (`spatialStore.beginBatch()`)
 * but bound only `onpointerup`. A native `pointercancel` mid-drag (touch/pen OS
 * gesture, fullscreen switch) ended the interaction WITHOUT the up event, so the
 * batch stayed open forever — the spatial revision froze, viewport-culled
 * rendering stopped updating (looks like data loss) — and the stuck `isDragging`
 * made the next hover move the frame with NO undo command, persisted to disk.
 * `lib/canvas/tileDrag.ts` had the D.4 teardown; Frame's inline drag did not.
 *
 * ── Why the sweep is NARROW (capture + spatial batch, not capture alone) ──
 * The Audit-16 plan's 7.5 sketch ("any component-scope setPointerCapture
 * requires a pointercancel binding") was surveyed first, as it instructed:
 * 21 component capture sites exist, and 10 of them (the style popups' drag-to-
 * move headers, side toolbars, ConnectionLabel) bind no cancel — but a missed
 * cancel there leaves at worst a stale local drag flag that self-heals on the
 * next pointerdown; there is no open batch, no frozen rendering, no disk write.
 * Gating those would mean a 10-entry allowlist of "doesn't actually matter"
 * components that every new popup trips — exactly the false-positive-heavy
 * outcome the plan said to skip. The DATA-shaped hazard is the combination:
 * a captured pointer driving an OPEN `spatialStore.beginBatch()`. That sweep
 * has ZERO exemptions today (Frame.svelte + tileDrag.ts, both compliant) and
 * any future spatial-batch drag surface is caught by construction.
 *
 * ── What it enforces ──
 * Part 1 (sweep): every file under src/renderer whose code contains BOTH
 * `setPointerCapture(` and `beginBatch(` must also reference `pointercancel`
 * or `lostpointercapture` (markup binding `onpointercancel={…}` or an
 * `addEventListener('pointercancel', …)` — strings count, comments don't).
 * Part 2 (named anchor, Frame.svelte): the 6.1 fix's distinctive shapes must
 * survive —
 *   (a) an `onpointercancel={` binding AND an `onlostpointercapture={` binding
 *       (both cancel signals routed; lostpointercapture also covers
 *       Element.releasePointerCapture paths pointercancel misses), and
 *   (b) at least TWO `spatialStore.endBatch(` call sites: the drag-end handler
 *       AND the unmount teardown (the cleanup-only `$effect` that closes the
 *       batch when the frame is destroyed mid-drag by an external reload /
 *       board switch). One call site means the teardown was dropped.
 *
 * Comment-stripped (JS line/block + HTML comments) but STRING-PRESERVING scan:
 * the lib evidence for a cancel binding IS a string literal
 * (`addEventListener('pointercancel', …)`), so strings must stay visible; a
 * doc-comment merely describing the bug can't satisfy the check.
 *
 * Escape hatch for a genuinely batch-free capture surface that trips the sweep:
 * `// allow-pointer-capture-leak: <reason>` anywhere in the file.
 *
 * Tripwires: the collectors fail loud if the codebase shape drifts under the
 * patterns (capture sites disappearing wholesale ⇒ the regexes went stale, not
 * the hazard).
 *
 * Behavioral note: the unit suite has no Svelte component-mount harness (the
 * 3.7 source-shape pin has the same constraint), so this gate pins the
 * MECHANISM in source; the idempotence of the end handlers
 * (`if (!isDragging) return`) is what makes routing both cancel signals safe.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIR = 'src/renderer';
const FRAME_FILE = 'src/renderer/components/frames/Frame.svelte';
const ESCAPE = /\/\/\s*allow-pointer-capture-leak:\s*\S+/;

function toPosix(p) {
  return p.split(sep).join('/');
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (s.isFile() && (entry.endsWith('.ts') || entry.endsWith('.svelte'))) out.push(full);
  }
}

/**
 * Strip JS block + line comments and HTML comments, PRESERVING strings (the
 * `'pointercancel'` addEventListener literal is load-bearing evidence). The
 * line-comment strip guards against eating `://` inside a URL string, same as
 * check-no-silent-write-abort.mjs.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const CAPTURE = /setPointerCapture\s*\(/;
const BATCH = /\bbeginBatch\s*\(/;
const CANCEL = /pointercancel|lostpointercapture/i;

const files = [];
walk(join(ROOT, SCAN_DIR), files);
files.sort();

const failures = [];
let captureFiles = 0;
let comboFiles = 0;

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    failures.push(`${rel} — cannot read: ${err.message}`);
    continue;
  }
  const code = stripComments(raw);
  if (!CAPTURE.test(code)) continue;
  captureFiles++;
  if (!BATCH.test(code)) continue;
  comboFiles++;
  if (ESCAPE.test(raw)) continue;
  if (!CANCEL.test(code)) {
    failures.push(
      `${rel} — captures the pointer AND opens a spatial batch (beginBatch) but binds no ` +
        '`pointercancel`/`lostpointercapture`. A native pointercancel mid-drag (touch/pen OS ' +
        'gesture) ends the interaction without pointerup, leaving the batch open forever ' +
        '(spatial revision frozen → viewport-culled rendering stops updating) and the drag flag ' +
        'stuck (the next hover mutates geometry with NO undo command, persisted to disk). Route ' +
        'both cancel signals through the same idempotent end handler — see Frame.svelte ' +
        '(Audit-16 6.1) / lib/canvas/tileDrag.ts (D.4).',
    );
  }
}

// Tripwires — the collectors must keep seeing the real codebase shape.
if (captureFiles < 10) {
  failures.push(
    `tripwire — only ${captureFiles} setPointerCapture file(s) found under ${SCAN_DIR} ` +
      '(expected ≥10). The capture pattern went stale; fix the regex, do not delete the gate.',
  );
}
if (comboFiles < 2) {
  failures.push(
    `tripwire — only ${comboFiles} capture+beginBatch file(s) found (expected ≥2: ` +
      'Frame.svelte + lib/canvas/tileDrag.ts). Either the batch pattern went stale or a ' +
      'spatial-batch drag surface moved — re-point the gate at it, do not let coverage lapse.',
  );
}

// ── Part 2 — Frame.svelte named anchor (the 6.1 fix's distinctive shapes) ──
let frameRaw = '';
try {
  frameRaw = readFileSync(join(ROOT, FRAME_FILE), 'utf8');
} catch (err) {
  failures.push(`${FRAME_FILE} — cannot read (REQUIRED file): ${err.message}`);
}
const frameCode = stripComments(frameRaw);
if (!/onpointercancel\s*=\s*\{/.test(frameCode)) {
  failures.push(
    `${FRAME_FILE} — missing an \`onpointercancel={…}\` binding (Audit-16 6.1): a native ` +
      'pointercancel mid-drag/resize must route through the idempotent end handler.',
  );
}
if (!/onlostpointercapture\s*=\s*\{/.test(frameCode)) {
  failures.push(
    `${FRAME_FILE} — missing an \`onlostpointercapture={…}\` binding (Audit-16 6.1): ` +
      'lostpointercapture covers capture-release paths pointercancel misses; the end handlers ' +
      'are idempotent, so the one following a normal pointerup is a no-op.',
  );
}
const endBatchCount = (frameCode.match(/spatialStore\.endBatch\s*\(/g) ?? []).length;
if (endBatchCount < 2) {
  failures.push(
    `${FRAME_FILE} — only ${endBatchCount} \`spatialStore.endBatch(\` call site(s), expected ≥2 ` +
      '(the drag-end handler AND the unmount teardown). Dropping the unmount teardown re-opens ' +
      'the frozen-batch leak when a frame is destroyed mid-drag (external reload / board switch).',
  );
}

if (failures.length > 0) {
  console.error('[check-pointer-capture-cleanup] FAILED — pointer-capture teardown regressed:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(
  `[check-pointer-capture-cleanup] OK — ${captureFiles} capture file(s), ${comboFiles} ` +
    'capture+batch file(s) all bind a cancel signal; Frame.svelte 6.1 anchors present.',
);
process.exit(0);
