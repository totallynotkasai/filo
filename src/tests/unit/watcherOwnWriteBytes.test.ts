import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * A note write hides only its own echo: while its window is open, an event
 * is dropped only when the file holds the bytes Filo wrote. A sync client or
 * editor saving the note inside the window (the window lasts seconds, to
 * outlast a Windows lock) is still reported, and so is one putting back an
 * earlier version of ours once a later write has landed.
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
import { SuppressionWindows, ownBytesOf, type FileProbe } from '../../main/services/watcherSuppression';

function changedNames(): string[] {
  return sentEvents
    .filter((e) => e.channel === 'vault:files-changed')
    .flatMap((e) => (e.payload[0] as Array<{ filename: string }>).map((c) => c.filename));
}

describe('SuppressionWindows: a write window covers only the bytes written', () => {
  const probeOf = (text: string | null): FileProbe => () =>
    text === null ? null : { size: ownBytesOf(text).size, sha1: () => ownBytesOf(text).sha1 };

  it('drops an event while the file holds our bytes, and reports one that holds other bytes', () => {
    const w = new SuppressionWindows();
    w.suppressWrite('Note.md', 7000, 'ours');
    expect(w.isSuppressed('Note.md', true, probeOf('ours'))).toBe(true);
    expect(w.isSuppressed('note.MD', true, probeOf('ours'))).toBe(true);
    expect(w.isSuppressed('Note.md', true, probeOf('theirs, longer'))).toBe(false);
    // Same size, different bytes.
    expect(w.isSuppressed('Note.md', true, probeOf('ourz'))).toBe(false);
  });

  it('any of the last few writes counts as ours (a burst of saves)', () => {
    const w = new SuppressionWindows();
    w.suppressWrite('Note.md', 7000, 'first');
    w.recordOwnBytes('Note.md', ownBytesOf('second'));
    expect(w.isSuppressed('Note.md', true, probeOf('first'))).toBe(true);
    expect(w.isSuppressed('Note.md', true, probeOf('second'))).toBe(true);
  });

  it('once a later write has landed, an earlier write\'s bytes are someone else\'s restore', () => {
    const w = new SuppressionWindows();
    w.suppressWrite('Note.md', 7000, 'first');
    w.recordLandedBytes('Note.md', ownBytesOf('first'));
    w.suppressWrite('Note.md', 7000, 'second');
    // While the second write is out, the first is still what an echo finds.
    expect(w.isSuppressed('Note.md', true, probeOf('first'))).toBe(true);
    w.recordLandedBytes('Note.md', ownBytesOf('second'));
    expect(w.isSuppressed('Note.md', true, probeOf('second'))).toBe(true);
    expect(w.isSuppressed('Note.md', true, probeOf('first'))).toBe(false);
  });

  it('a window whose bytes aren\'t known, or a file that can\'t be read, keeps the old rule', () => {
    const w = new SuppressionWindows();
    w.suppressWrite('Blind.md', 7000);
    expect(w.isSuppressed('Blind.md', true, probeOf('anything'))).toBe(true);
    w.suppressWrite('Note.md', 7000, 'ours');
    expect(w.isSuppressed('Note.md', true, probeOf(null))).toBe(true);
    // A missing file is never covered by a write window.
    expect(w.isSuppressed('Note.md', false, probeOf('ours'))).toBe(false);
  });

  it('a plain suppress of the path still wins', () => {
    const w = new SuppressionWindows();
    w.suppressWrite('Note.md', 7000, 'ours');
    w.suppress('Note.md', 7000);
    expect(w.isSuppressed('Note.md', true, probeOf('theirs'))).toBe(true);
  });
});

describe('FileWatcher: another program saving a note just after Filo wrote it', () => {
  let dir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    sentEvents.length = 0;
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-ownbytes-'));
    watcher = new FileWatcher(dir);
  });

  afterEach(async () => {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is reported when its bytes differ from ours', async () => {
    await fs.writeFile(join(dir, 'Note.md'), 'before', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    const ours = '---\ntitle: Note\n---\nours\n';
    watcher.suppressWrite('Note.md', 7000, ours);
    await fs.writeFile(join(dir, 'Note.md'), ours, 'utf-8');
    watcher.recordOwnWrite('Note.md', Buffer.from(ours, 'utf-8'));
    // A second later a sync client writes its version.
    await new Promise((r) => setTimeout(r, 1100));
    await fs.writeFile(join(dir, 'Note.md'), '---\ntitle: Note\n---\ntheirs, from another device\n', 'utf-8');
    await watcher.reconcileNow();
    await new Promise((r) => setTimeout(r, 400));
    expect(changedNames()).toContain('Note.md');
  });

  it('stays hidden while the file holds exactly our bytes', async () => {
    await fs.writeFile(join(dir, 'Note.md'), 'before', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    const ours = '---\ntitle: Note\n---\nours\n';
    watcher.suppressWrite('Note.md', 7000, ours);
    await fs.writeFile(join(dir, 'Note.md'), ours, 'utf-8');
    watcher.recordOwnWrite('Note.md', Buffer.from(ours, 'utf-8'));
    await watcher.reconcileNow();
    await new Promise((r) => setTimeout(r, 400));
    expect(changedNames()).not.toContain('Note.md');
  });

  it('is reported when another program puts back an earlier version of ours', async () => {
    await fs.writeFile(join(dir, 'Note.md'), 'before', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    const first = '---\ntitle: Note\n---\nfirst\n';
    const second = '---\ntitle: Note\n---\nsecond, longer\n';
    for (const text of [first, second]) {
      watcher.suppressWrite('Note.md', 7000, text);
      await fs.writeFile(join(dir, 'Note.md'), text, 'utf-8');
      watcher.recordOwnWrite('Note.md', Buffer.from(text, 'utf-8'));
    }
    await fs.writeFile(join(dir, 'Note.md'), first, 'utf-8');
    await watcher.reconcileNow();
    await new Promise((r) => setTimeout(r, 400));
    expect(changedNames()).toContain('Note.md');
  });
});
