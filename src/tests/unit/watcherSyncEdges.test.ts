import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * What the watcher reports for a vault synced between machines (Syncthing):
 * its archive folder stays out, a moved file of any kind pairs as a rename
 * even after another program edited it, passes run one at a time, the 30 s
 * walk doesn't re-read unchanged files, and a file changed while the vault
 * was opening is still reported.
 */

const sentEvents: Array<{ channel: string; payload: unknown[] }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, ...payload: unknown[]) => {
            sentEvents.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

import { FileWatcher } from '../../main/services/fileWatcher';
import type { FileChangeEvent } from '../../main/services/fileWatcherTypes';
import { shouldIgnorePath, classifyChange } from '../../main/services/fileWatcherClassify';
import { vaultRegistry } from '../../main/services/vaultRegistry';

function changed(): FileChangeEvent[] {
  return sentEvents
    .filter((e) => e.channel === 'vault:files-changed')
    .flatMap((e) => e.payload[0] as FileChangeEvent[]);
}

function renames(): Array<{ oldPath: string; newPath: string }> {
  return sentEvents
    .filter((e) => e.channel === 'vault:file-renamed')
    .map((e) => e.payload[0] as { oldPath: string; newPath: string });
}

/** Queue an event as the live fs.watch callback would. */
function queue(w: FileWatcher, ev: FileChangeEvent): void {
  const pending: FileChangeEvent[] = w['pendingChanges'];
  pending.push(ev);
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A note body over the size the correlator pairs on size alone. */
const LONG = 'x'.repeat(400);

describe('watcher: Syncthing and other hidden folders', () => {
  it('ignores every hidden segment outside .filo, as the sidebar tree does', () => {
    expect(shouldIgnorePath('.stversions/Note~20260928-101112.md')).toBe(true);
    expect(shouldIgnorePath('.stfolder')).toBe(true);
    expect(shouldIgnorePath('Projects/.stversions/Plan~1.board.json')).toBe(true);
    expect(shouldIgnorePath('.obsidian/app.json')).toBe(true);
    expect(shouldIgnorePath('.filo/tags.json')).toBe(false);
    expect(shouldIgnorePath('.filo/themes/red.json')).toBe(false);
    expect(shouldIgnorePath('Notes/Note.md')).toBe(false);
  });
});

describe('watcher: which files are attachments', () => {
  it('any other file with an extension is an attachment, a name without one stays tree', () => {
    expect(classifyChange('Report.docx')).toBe('attachment');
    expect(classifyChange('Work/data.csv')).toBe('attachment');
    expect(classifyChange('photo.png')).toBe('attachment');
    expect(classifyChange('LICENSE')).toBe('tree');
    expect(classifyChange('Projects')).toBe('tree');
    expect(classifyChange('Note.md')).toBe('document');
    expect(classifyChange('Plan.board.json')).toBe('board');
  });
});

describe('vaultRegistry.armedAt', () => {
  afterEach(() => vaultRegistry.setCurrentVault(null));

  it('moves when a vault is armed, not when the same vault is re-armed', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'filo-armed-'));
    try {
      vaultRegistry.setCurrentVault(dir);
      const first = vaultRegistry.armedAt;
      expect(first).toBeGreaterThan(0);
      await wait(15);
      vaultRegistry.setCurrentVault(dir);
      expect(vaultRegistry.armedAt).toBe(first);
      vaultRegistry.setCurrentVault(null);
      await wait(15);
      vaultRegistry.setCurrentVault(dir);
      expect(vaultRegistry.armedAt).toBeGreaterThan(first);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('FileWatcher on a temp vault', () => {
  let dir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    sentEvents.length = 0;
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-sync-edges-'));
    watcher = new FileWatcher(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a file created under .stversions is never reported', async () => {
    await fs.writeFile(join(dir, 'Note.md'), LONG, 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await fs.mkdir(join(dir, '.stversions'));
    await fs.writeFile(join(dir, '.stversions', 'Note~20260928-101112.md'), 'old version', 'utf-8');
    await watcher.reconcileNow();
    await wait(400);
    expect(changed().map((c) => c.filename)).toEqual([]);
  });

  it('a note archived into .stversions is not paired as a rename into it', async () => {
    await fs.writeFile(join(dir, 'Note.md'), LONG, 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await fs.mkdir(join(dir, '.stversions'));
    await fs.rename(join(dir, 'Note.md'), join(dir, '.stversions', 'Note~20260928-101112.md'));
    await watcher.reconcileNow();
    await wait(2200); // past the missing-note hold
    expect(renames()).toEqual([]);
    expect(changed().map((c) => c.filename)).toEqual(['Note.md']);
  });

  it('an outside move of Report.docx pairs as a rename', async () => {
    await fs.writeFile(join(dir, 'Report.docx'), LONG, 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await fs.mkdir(join(dir, 'Work'));
    await fs.rename(join(dir, 'Report.docx'), join(dir, 'Work', 'Report.docx'));
    await watcher.reconcileNow();
    await wait(600);
    expect(renames()).toEqual([{ oldPath: 'Report.docx', newPath: 'Work/Report.docx' }]);
  });

  it('a folder whose name has a dot goes out as tree, not as an attachment', async () => {
    await fs.mkdir(join(dir, 'v1.2'));
    await watcher.reconcileNow({ seedOnly: true });
    await fs.rm(join(dir, 'v1.2'), { recursive: true });
    queue(watcher, { type: 'attachment', filename: 'v1.2', eventType: 'rename' });
    await watcher['notifyRenderers']();
    expect(changed()).toEqual([{ type: 'tree', filename: 'v1.2', eventType: 'rename' }]);
  });

  it('an attachment whose delete and create land in two passes still pairs', async () => {
    await fs.writeFile(join(dir, 'Report.docx'), LONG, 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await fs.mkdir(join(dir, 'Work'));
    await fs.rename(join(dir, 'Report.docx'), join(dir, 'Work', 'Report.docx'));
    queue(watcher, { type: 'attachment', filename: 'Report.docx', eventType: 'rename' });
    await watcher['notifyRenderers']();
    queue(watcher, { type: 'attachment', filename: 'Work/Report.docx', eventType: 'rename' });
    await watcher['notifyRenderers']();
    expect(renames()).toEqual([{ oldPath: 'Report.docx', newPath: 'Work/Report.docx' }]);
    expect(changed()).toEqual([]);
  });

  it('a small note edited by another program, then moved, pairs as a rename', async () => {
    await fs.writeFile(join(dir, 'Note.md'), 'short note\n', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    // Another program's save, reported live (no walk in between).
    await fs.writeFile(join(dir, 'Note.md'), 'short note, edited on the other machine\n', 'utf-8');
    queue(watcher, { type: 'document', filename: 'Note.md', eventType: 'change' });
    await watcher['notifyRenderers']();
    sentEvents.length = 0;

    await fs.mkdir(join(dir, 'Moved'));
    await fs.rename(join(dir, 'Note.md'), join(dir, 'Moved', 'Note.md'));
    queue(watcher, { type: 'document', filename: 'Note.md', eventType: 'rename' });
    queue(watcher, { type: 'document', filename: 'Moved/Note.md', eventType: 'rename' });
    await watcher['notifyRenderers']();
    expect(renames()).toEqual([{ oldPath: 'Note.md', newPath: 'Moved/Note.md' }]);
  });

  it('notify passes run one at a time', async () => {
    let running = 0;
    let most = 0;
    watcher['notifyRenderersImpl'] = async (): Promise<void> => {
      running += 1;
      most = Math.max(most, running);
      await wait(40);
      running -= 1;
    };
    await Promise.all([watcher['notifyRenderers'](), watcher['notifyRenderers'](), watcher['notifyRenderers']()]);
    expect(most).toBe(1);
  });

  it('the 30 s walk does not re-read a note whose stat has not changed', async () => {
    const note = join(dir, 'Old.md');
    await fs.writeFile(note, LONG, 'utf-8');
    const hourAgo = new Date(Date.now() - 3_600_000);
    await fs.utimes(note, hourAgo, hourAgo);
    await watcher.reconcileNow({ seedOnly: true });
    const reads = vi.spyOn(fs, 'readFile');
    await watcher.reconcileNow();
    expect(reads.mock.calls.filter((c) => String(c[0]).endsWith('Old.md'))).toEqual([]);
  });

  it('a young note is still re-read every walk', async () => {
    await fs.writeFile(join(dir, 'New.md'), LONG, 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    const reads = vi.spyOn(fs, 'readFile');
    await watcher.reconcileNow();
    expect(reads.mock.calls.filter((c) => String(c[0]).endsWith('New.md')).length).toBe(1);
  });

  it('a same-size rewrite that puts the old mtime back is still reported', async () => {
    const note = join(dir, 'Old.md');
    await fs.writeFile(note, LONG, 'utf-8');
    const hourAgo = new Date(Date.now() - 3_600_000);
    await fs.utimes(note, hourAgo, hourAgo);
    await watcher.reconcileNow({ seedOnly: true });
    await wait(20);
    await fs.writeFile(note, 'y'.repeat(400), 'utf-8');
    await fs.utimes(note, hourAgo, hourAgo);
    await watcher.reconcileNow();
    await wait(400);
    expect(changed().map((c) => c.filename)).toEqual(['Old.md']);
  });

  it('the first walk reports a board changed after the vault was armed, not one from before', async () => {
    await fs.writeFile(join(dir, 'Before.board.json'), '{"v":1}', 'utf-8');
    await fs.writeFile(join(dir, 'photo.png'), 'png', 'utf-8');
    await wait(30);
    const armedAt = Date.now();
    await wait(30);
    await fs.writeFile(join(dir, 'After.board.json'), '{"v":2}', 'utf-8');
    await fs.writeFile(join(dir, 'late.png'), 'png', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true, reportChangedSince: armedAt });
    // Polled: a fixed wait for the 300 ms notify debounce is flaky under load.
    await vi.waitFor(() => expect(changed()).toEqual([{ type: 'board', filename: 'After.board.json', eventType: 'change' }]), { timeout: 5000 });
  });

  it('without a start time the first walk reports nothing', async () => {
    await fs.writeFile(join(dir, 'After.board.json'), '{"v":2}', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await wait(400);
    expect(changed()).toEqual([]);
  });
});
