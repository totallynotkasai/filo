/**
 * L5 (Audit-12) — two cosmetic/responsiveness fixes, pinned by source scan
 * (both live inside a component's `onMount` hydrate / a module-private
 * reconciler, which this suite pins structurally — cf.
 * `characterization/externalEditReconciliation.test.ts`):
 *
 *   (a) In-memory adopt hydrate: when a TextTile adopts the body a sibling
 *       view of the same note already loaded, WITHOUT a disk read
 *       (`!isHydrated`), it sniffs the eol from the
 *       body-only body so a single-line-CRLF FM file doesn't emit LF fences on
 *       the first gateway write (the A8-M1 hole on the adopt path). It pins
 *       only CRLF (leaves LF/unknown to write-time detection).
 *
 *   (b) Attachment-delete grace: the attachment reconciler is now
 *       fire-and-forget so its 500 ms grace deferral runs OUTSIDE the shared
 *       rename queue the batch dispatch is awaited inside — it no longer stalls
 *       unrelated .md / .board.json reconciles for the grace window.
 *
 * Bite: revert either fix → the corresponding assertions go red.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');
}

describe('Audit-12 L5(a) — TextTile in-memory adopt sniffs eol from the body', () => {
  const src = blankComments(
    fs.readFileSync(
      path.join(ROOT, 'src', 'renderer', 'components', 'tiles', 'TextTile.svelte'),
      'utf8',
    ),
  );

  it('the !isHydrated adopt branch threads a sniffed eol into markHydrated', () => {
    // The in-memory adopt branch (sibling views share the note's path key, so
    // there is one) sniffs CRLF from the body-only `body` and threads it as the
    // 5th markHydrated arg. The body is loaded verbatim, no `parsed.body`.
    const sniffs = src.match(/\bbody\.includes\('\\r\\n'\) \? '\\r\\n' : undefined/g) ?? [];
    expect(sniffs.length).toBe(1);
    const threaded =
      src.match(/markHydrated\(relPath, false, undefined, undefined, adoptEol\)/g) ?? [];
    expect(threaded.length).toBe(1);
  });

  it('the only bare markHydrated(relPath, false) is the Audit-18 H3 failed-read branch', () => {
    // The old eol-less ADOPT call must not return — the adopt branch uses
    // the 5-arg eol form (asserted above). The disk-read / fallback paths use
    // `markHydrated(relPath, parsed.hadBom)`, which this regex does not match.
    //
    // Audit-18 H3 introduced ONE legitimate bare 2-arg call: the non-ENOENT
    // failed-read branch, which has no body to sniff an eol from (the read
    // failed) and marks hydrated with no baseline so a later retry's disk read
    // re-seeds it (mirrors DocumentEditor's M1 `markHydrated(filename, false)`).
    // Pin it at exactly one occurrence, co-located with `hydrateReadFailed`, so
    // an adopt branch can't silently regress to the bare form.
    const bare = src.match(/markHydrated\(relPath,\s*false\)/g) ?? [];
    expect(bare.length).toBe(1);
    expect(src).toMatch(/hydrateReadFailed = true;[\s\S]*?markHydrated\(relPath, false\)/);
  });
});

describe('Audit-12 L5(b) — attachment reconciler is fire-and-forget', () => {
  const src = blankComments(
    fs.readFileSync(
      path.join(ROOT, 'src', 'renderer', 'stores', 'vaultExternalReconcilers.ts'),
      'utf8',
    ),
  );

  // Isolate the attachment reconciler object literal.
  const block = /const attachmentBatchedReconciler[\s\S]*?\n};/.exec(src)?.[0] ?? '';

  it('found the attachment reconciler block', () => {
    expect(block.length).toBeGreaterThan(0);
  });

  it('does NOT await handleExternalAttachmentChanges (would block the rename queue)', () => {
    expect(block).not.toMatch(/await\s+vaultStore\.handleExternalAttachmentChanges/);
  });

  it('fires handleExternalAttachmentChanges detached with its own error catch', () => {
    expect(block).toMatch(/void\s+vaultStore\.handleExternalAttachmentChanges\(paths\)\.catch\(/);
  });
});
