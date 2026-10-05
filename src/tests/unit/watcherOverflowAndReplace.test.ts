/**
 * The watcher, driven through its own `fs.watch` listener (captured here, so
 * the events are exactly the ones a test sends):
 *
 * - an event with no file name (Windows' change buffer overflowed) runs a
 *   walk soon, which reports what the overflow dropped;
 * - a file renamed over an existing one is that file changed and the other
 *   gone, never a move: pairing them handed the replaced note's typing to
 *   the moved one's text;
 * - a rename the watcher sent, or a folder move the renderer followed, isn't
 *   reported once more by the next walk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, renameSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

type WatchListener = (eventType: string, filename: string | null) => void;
const { sentEvents, listeners } = vi.hoisted(() => ({
  sentEvents: [] as Array<{ channel: string; payload: unknown[] }>,
  listeners: [] as WatchListener[],
}));

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

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  // The real handle is opened (and closed by stop()), but the events the
  // watcher sees are the ones the test sends to its listener.
  const watch = (path: string, opts: object, listener: WatchListener): ReturnType<typeof real.watch> => {
    listeners.push(listener);
    return real.watch(path, opts, () => {});
  };
  return { ...real, default: { ...real, watch }, watch };
});

const { FileWatcher, OVERFLOW_RECONCILE_DELAY_MS, MISSING_NOTE_HOLD_MS } = await import('../../main/services/fileWatcher');

function changed(): Array<{ filename: string; eventType: string }> {
  return sentEvents
    .filter((e) => e.channel === 'vault:files-changed')
    .flatMap((e) => e.payload[0] as Array<{ filename: string; eventType: string }>);
}

function renames(): Array<{ oldPath: string; newPath: string }> {
  return sentEvents.filter((e) => e.channel === 'vault:file-renamed').map((e) => e.payload[0] as { oldPath: string; newPath: string });
}

function send(eventType: string, filename: string | null): void {
  for (const l of listeners) l(eventType, filename);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A rename by "another program", retried while Windows (an indexer, a scanner) holds the file a moment. */
async function renameOnDisk(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 40) throw err;
      await sleep(50);
    }
  }
}

/** Long enough for the debounce, a held missing note's wait and the notify pass. */
const NOTIFY_SETTLE_MS = MISSING_NOTE_HOLD_MS + 700;

const A_BODY = `---\ntitle: A\n---\n${'Alpha paragraph that only note A holds. '.repeat(12)}\n`;
const B_BODY = `---\ntitle: B\n---\n${'Bravo paragraph that only note B holds. '.repeat(12)}\n`;

describe('the watcher', () => {
  let dir: string;
  let watcher: InstanceType<typeof FileWatcher>;

  beforeEach(async () => {
    sentEvents.length = 0;
    listeners.length = 0;
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-watcher-overflow-'));
  });

  afterEach(async () => {
    await watcher?.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A watcher whose first walk has recorded the vault. */
  async function started(): Promise<void> {
    watcher = new FileWatcher(dir);
    watcher.start();
    // start() runs the first walk itself; a rename while it still reads the
    // files would meet Windows' EPERM. Wait for it.
    await (watcher as unknown as { reconcileInFlightPromise: Promise<void> | null }).reconcileInFlightPromise;
    await sleep(50);
  }

  it('an overflowed change buffer (no file name) runs a walk soon, which reports what it dropped', async () => {
    writeFileSync(join(dir, 'Old.md'), 'old\n');
    await started();
    writeFileSync(join(dir, 'Delivered.md'), 'from the phone\n');
    send('rename', null);
    send('rename', null);
    await sleep(OVERFLOW_RECONCILE_DELAY_MS + NOTIFY_SETTLE_MS);
    expect(changed().map((c) => c.filename)).toEqual(['Delivered.md']);
  });

  it('a file renamed over an existing one is that file changed and the other gone, not a move', async () => {
    writeFileSync(join(dir, 'A.md'), A_BODY);
    writeFileSync(join(dir, 'B.md'), B_BODY);
    await started();
    await renameOnDisk(join(dir, 'A.md'), join(dir, 'B.md'));
    send('rename', 'A.md');
    send('rename', 'B.md');
    await sleep(NOTIFY_SETTLE_MS);
    expect(renames()).toEqual([]);
    expect(changed().map((c) => c.filename).sort()).toEqual(['A.md', 'B.md']);
  });

  it('a file renamed to a free name is still a move, and the next walk reports nothing more', async () => {
    writeFileSync(join(dir, 'A.md'), A_BODY);
    await started();
    await renameOnDisk(join(dir, 'A.md'), join(dir, 'C.md'));
    send('rename', 'A.md');
    send('rename', 'C.md');
    await sleep(NOTIFY_SETTLE_MS);
    expect(renames()).toEqual([{ oldPath: 'A.md', newPath: 'C.md' }]);
    sentEvents.length = 0;
    await watcher.reconcileNow();
    await sleep(NOTIFY_SETTLE_MS);
    expect(renames()).toEqual([]);
    expect(changed()).toEqual([]);
  });

  it('a name freed by a delete takes a move again', async () => {
    writeFileSync(join(dir, 'A.md'), A_BODY);
    writeFileSync(join(dir, 'B.md'), B_BODY);
    await started();
    await fs.rm(join(dir, 'B.md'));
    send('rename', 'B.md');
    await sleep(NOTIFY_SETTLE_MS);
    await renameOnDisk(join(dir, 'A.md'), join(dir, 'B.md'));
    send('rename', 'A.md');
    send('rename', 'B.md');
    await sleep(NOTIFY_SETTLE_MS);
    expect(renames()).toEqual([{ oldPath: 'A.md', newPath: 'B.md' }]);
  });

  it('a folder move the renderer followed is not reported again, file by file, by the next walk', async () => {
    mkdirSync(join(dir, 'Notes'));
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, 'Notes', `n${i}.md`), `note ${i} ${'x'.repeat(300 + i)}\n`);
    await started();
    await renameOnDisk(join(dir, 'Notes'), join(dir, 'Chapters'));
    expect(watcher.noteFollowedMove('Notes', 'Chapters')).toBe(true);
    await watcher.reconcileNow();
    await sleep(NOTIFY_SETTLE_MS);
    expect(renames()).toEqual([]);
    expect(changed()).toEqual([]);
  });

  it('without the follow, that walk reports each file as moved (the control)', async () => {
    mkdirSync(join(dir, 'Notes'));
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, 'Notes', `n${i}.md`), `note ${i} ${'x'.repeat(300 + i)}\n`);
    await started();
    await renameOnDisk(join(dir, 'Notes'), join(dir, 'Chapters'));
    await watcher.reconcileNow();
    await sleep(NOTIFY_SETTLE_MS);
    expect(renames()).toHaveLength(3);
  });

  it('a followed move is taken only while the disk agrees', async () => {
    mkdirSync(join(dir, 'Notes'));
    mkdirSync(join(dir, 'Chapters'));
    await started();
    // The old folder is still there.
    expect(watcher.noteFollowedMove('Notes', 'Chapters')).toBe(false);
    await fs.rm(join(dir, 'Notes'), { recursive: true });
    // The new one isn't a folder.
    writeFileSync(join(dir, 'Plan.md'), 'x');
    expect(watcher.noteFollowedMove('Notes', 'Plan.md')).toBe(false);
    expect(watcher.noteFollowedMove('Notes', 'Chapters')).toBe(true);
  });
});
