import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * The 30 s reconcile walk must not report Filo's own moves (a rename, a move
 * into its trash and back) as moves by another program. Before the walk's
 * record moved with the files, the first walk after the 5 s suppression
 * window reported every file of a renamed folder as renamed elsewhere: one
 * rename cascade per file in the renderer's queue.
 */

const sentEvents: Array<{ channel: string; payload: unknown[] }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (channel: string, ...payload: unknown[]) => { sentEvents.push({ channel, payload }); } } },
    ],
  },
}));

import { FileWatcher } from '../../main/services/fileWatcher';
import { retryOnWindowsLock } from '../../main/vault/filenameUtils';

const N = 40;
let dir = '';
let watcher: FileWatcher;

/** Every event the watcher sent: renames and changes, as `kind path`. */
function reported(): string[] {
  const out: string[] = [];
  for (const e of sentEvents) {
    if (e.channel === 'vault:file-renamed') out.push(`renamed ${JSON.stringify(e.payload[0])}`);
    if (e.channel === 'vault:files-changed') {
      for (const c of e.payload[0] as Array<{ filename: string; eventType: string }>) out.push(`${c.eventType} ${c.filename}`);
    }
  }
  return out;
}

/** What `vault:rename` does: suppress both sides for 5 s, move, and note the move once it succeeded. */
async function renameInApp(from: string, to: string): Promise<void> {
  watcher.suppressTree(from, 5000);
  watcher.suppressTree(to, 5000);
  const done = watcher.beginOwnMove();
  try {
    // As `renameItem`: on Windows the walk's open files briefly lock the folder.
    await retryOnWindowsLock(() => fs.rename(join(dir, ...from.split('/')), join(dir, ...to.split('/'))));
    watcher.noteOwnMove(from, to);
  } finally {
    done();
  }
}

/** Runs the next walk as if the 5 s suppression window had passed. */
async function walkAfterWindow(): Promise<void> {
  const realNow = Date.now.bind(Date);
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6000);
  try {
    await watcher.reconcileNow();
    await new Promise((r) => setTimeout(r, 1200)); // the notify debounce and the missing-note hold
  } finally {
    spy.mockRestore();
  }
}

beforeEach(async () => {
  sentEvents.length = 0;
  dir = await fs.mkdtemp(join(tmpdir(), 'filo-ownmoves-'));
  await fs.mkdir(join(dir, 'Notes', 'Deep'), { recursive: true });
  for (let i = 0; i < N; i++) await fs.writeFile(join(dir, 'Notes', 'Deep', `n${i}.md`), `note ${i} body text`, 'utf-8');
  watcher = new FileWatcher(dir);
  await watcher.reconcileNow({ seedOnly: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await watcher.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the reconcile walk and Filo's own moves", () => {
  it('an in-app rename of a 40-file folder is not reported by the next walk', async () => {
    await renameInApp('Notes/Deep', 'Notes/Deeper');
    await walkAfterWindow();
    expect(reported()).toEqual([]);
  });

  it('a rename made while a walk is running is not reported either', async () => {
    const walking = watcher.reconcileNow();
    await renameInApp('Notes/Deep', 'Notes/Deeper');
    await walking;
    await walkAfterWindow();
    expect(reported()).toEqual([]);
  });

  it('a walk that finishes reading while a move is out waits for it', async () => {
    watcher.suppressTree('Notes/Deep', 5000);
    watcher.suppressTree('Notes/Deeper', 5000);
    const done = watcher.beginOwnMove();
    await fs.rename(join(dir, 'Notes', 'Deep'), join(dir, 'Notes', 'Deeper'));
    // The walk reads the moved folder before the move is noted.
    const walking = watcher.reconcileNow();
    await new Promise((r) => setTimeout(r, 300));
    watcher.noteOwnMove('Notes/Deep', 'Notes/Deeper');
    done();
    await walking;
    await walkAfterWindow();
    expect(reported()).toEqual([]);
  });

  it('a rename by another program is still reported', async () => {
    await fs.rename(join(dir, 'Notes', 'Deep'), join(dir, 'Notes', 'Deeper'));
    await walkAfterWindow();
    expect(reported().length).toBeGreaterThan(0);
  });

  it("a folder moved into Filo's trash and back is not reported", async () => {
    watcher.suppressTree('Notes/Deep', 5000);
    await fs.mkdir(join(dir, '.filo', 'trash', 't1', 'files', 'Notes'), { recursive: true });
    let done = watcher.beginOwnMove();
    await fs.rename(join(dir, 'Notes', 'Deep'), join(dir, '.filo', 'trash', 't1', 'files', 'Notes', 'Deep'));
    watcher.noteOwnTrash('Notes/Deep', 't1');
    done();
    await walkAfterWindow();
    expect(reported()).toEqual([]);

    done = watcher.beginOwnMove();
    await fs.rename(join(dir, '.filo', 'trash', 't1', 'files', 'Notes', 'Deep'), join(dir, 'Notes', 'Deep'));
    watcher.noteOwnRestore('Notes/Deep', 't1');
    done();
    await walkAfterWindow();
    expect(reported()).toEqual([]);
  });

  it('an edit by another program after an in-app rename is still reported', async () => {
    await renameInApp('Notes/Deep', 'Notes/Deeper');
    await fs.writeFile(join(dir, 'Notes', 'Deeper', 'n3.md'), 'note 3 changed by another program', 'utf-8');
    await walkAfterWindow();
    expect(reported()).toEqual(['change Notes/Deeper/n3.md']);
  });
});
