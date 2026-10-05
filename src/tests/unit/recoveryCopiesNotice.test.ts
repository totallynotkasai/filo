/**
 * The copies in `.filo/recovery` as the Recovery tab and the vault-open
 * notice show them. The notice names only load-failure snapshots this open
 * made that no other notice named: a kept version or rescue copy was
 * announced when it was made, and naming them at every open (as Filo did)
 * taught the user to ignore the warning.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  announceNewLoadFailureSnapshots,
  copyDisplayName,
  newLoadFailureSnapshots,
  parseRecoveryTimestamp,
  sizeLabel,
  type RecoveryCopy,
} from '@renderer/lib/vault/recoveryCopies';
import { uiStore } from '@renderer/stores/ui.svelte';
import { captureVaultIdentity } from '@renderer/lib/vault/vaultIdentity';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const OPENED_AT = Date.parse('2026-10-05T12:00:00.000Z');

function copy(relPath: string, kind: RecoveryCopy['kind']): RecoveryCopy {
  const parts = relPath.split('/');
  return { relPath, basename: parts[parts.length - 1]!, timestamp: parts[kind === 'orphan-tmp' ? 3 : 2]!, kind, size: 120 };
}

describe('a copy as the user reads it', () => {
  it('reads the folder timestamp (UTC), with or without -keep / -unsaved', () => {
    expect(parseRecoveryTimestamp('2026-10-05T12-00-00.000')).toBe(OPENED_AT);
    expect(parseRecoveryTimestamp('2026-10-05T12-00-00.000-keep')).toBe(OPENED_AT);
    expect(parseRecoveryTimestamp('2026-10-05T12-00-00.250-unsaved')).toBe(OPENED_AT + 250);
    expect(parseRecoveryTimestamp('photos')).toBeNull();
  });

  it('shows its size in bytes, KB or MB', () => {
    expect(sizeLabel(1)).toBe('1 byte');
    expect(sizeLabel(812)).toBe('812 bytes');
    expect(sizeLabel(3 * 1024 + 300)).toBe('3.3 KB');
    expect(sizeLabel(48 * 1024)).toBe('48 KB');
    expect(sizeLabel(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('names a copy after the path it came from', () => {
    expect(copyDisplayName('Notes__Draft.md')).toBe('Notes/Draft.md');
    expect(copyDisplayName('_filo__tags.json')).toBe('.filo/tags.json');
    expect(copyDisplayName('Journal.md')).toBe('Journal.md');
  });
});

describe('newLoadFailureSnapshots', () => {
  const copies = [
    copy('.filo/recovery/2026-10-05T12-00-01.000/Plan.board.json', 'snapshot'),
    copy('.filo/recovery/2026-10-05T12-00-02.000/Named.board.json', 'snapshot'),
    copy('.filo/recovery/2026-10-04T09-00-00.000/Old.board.json', 'snapshot'),
    copy('.filo/recovery/2026-10-05T12-00-03.000-keep/Journal.md', 'keep'),
    copy('.filo/recovery/2026-10-05T12-00-03.000-unsaved/Draft.md', 'unsaved'),
    copy('.filo/recovery/orphan-tmp/2026-10-05T12-00-04.000/x.md.tmp', 'orphan-tmp'),
  ];

  it('keeps only snapshots this open made that no notice named', () => {
    const fresh = newLoadFailureSnapshots(copies, 'C:/Vault', OPENED_AT, ['C:\\Vault\\.filo\\recovery\\2026-10-05T12-00-02.000\\Named.board.json']);
    expect(fresh.map((c) => c.basename)).toEqual(['Plan.board.json']);
  });
});

describe('the vault-open notice', () => {
  beforeEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });
  afterEach(() => {
    restoreFiloDefault();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });

  it('is silent when .filo/recovery holds only older copies and kept versions', async () => {
    installFiloMock({
      'recovery:list': () => [
        copy('.filo/recovery/2026-10-01T10-00-00.000-keep/Journal.md', 'keep'),
        copy('.filo/recovery/2026-10-01T10-00-00.000/Plan.board.json', 'snapshot'),
      ],
    });
    await announceNewLoadFailureSnapshots('C:/Vault', captureVaultIdentity(), { openedAt: OPENED_AT, announcedSnapshots: [] });
    expect(uiStore.toasts).toEqual([]);
  });

  it('names a new, unnamed snapshot, with Show in folder and Open Recovery', async () => {
    installFiloMock({ 'recovery:list': () => [copy('.filo/recovery/2026-10-05T12-00-01.000/Work__Plan.board.json', 'snapshot')] });
    await announceNewLoadFailureSnapshots('C:/Vault', captureVaultIdentity(), { openedAt: OPENED_AT, announcedSnapshots: [] });
    expect(uiStore.toasts).toHaveLength(1);
    expect(uiStore.toasts[0]?.text).toBe(
      "Filo couldn't load a file, so it kept a copy in .filo/recovery before anything could write over it:\n• Work/Plan.board.json\nSettings → Recovery lists every copy Filo keeps.",
    );
    expect(uiStore.toasts[0]?.actions?.map((a) => a.label)).toEqual(['Show in folder', 'Open Recovery']);
  });
});
