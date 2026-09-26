/**
 * L5 (Audit-12) — attachment-delete grace, pinned by source scan (it lives in
 * a module-private reconciler, which this suite pins structurally — cf.
 * `contracts/externalEditReconciliation.test.ts`):
 *
 *   The attachment reconciler is fire-and-forget so its 500 ms grace deferral
 *   runs OUTSIDE the shared rename queue the batch dispatch is awaited inside —
 *   it no longer stalls unrelated .md / .board.json reconciles for the grace
 *   window.
 *
 * Bite: revert the fix → the assertions go red.
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
