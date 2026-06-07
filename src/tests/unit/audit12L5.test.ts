/**
 * L5 (Audit-12) — two cosmetic/responsiveness fixes, pinned by source scan
 * (both live inside a component's `onMount` hydrate / a module-private
 * reconciler, which this suite pins structurally — cf.
 * `characterization/externalEditReconciliation.test.ts`):
 *
 *   (a) Adopt-sibling hydrate: when a TextTile adopts a sibling view's docId
 *       WITHOUT a disk read (`!isHydrated`), it now sniffs the eol from the
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

describe('Audit-12 L5(a) — TextTile adopt-sibling sniffs eol from the body', () => {
  const src = blankComments(
    fs.readFileSync(
      path.join(ROOT, 'src', 'renderer', 'components', 'tiles', 'TextTile.svelte'),
      'utf8',
    ),
  );

  it('both !isHydrated adopt branches thread a sniffed eol into markHydrated', () => {
    // Two adopt branches (findByFilename + in-memory body): each sniffs CRLF
    // from `parsed.body` and threads it as the 5th markHydrated arg.
    const sniffs = src.match(/parsed\.body\.includes\('\\r\\n'\) \? '\\r\\n' : undefined/g) ?? [];
    expect(sniffs.length).toBe(2);
    const threaded =
      src.match(/markHydrated\(relPath, false, undefined, undefined, adoptEol\)/g) ?? [];
    expect(threaded.length).toBe(2);
  });

  it('no longer makes a bare 2-arg markHydrated(relPath, false) adopt call', () => {
    // The old eol-less adopt call. The disk-read / fallback paths use
    // `markHydrated(relPath, parsed.hadBom)`, which this regex does not match.
    expect(src).not.toMatch(/markHydrated\(relPath,\s*false\)/);
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
