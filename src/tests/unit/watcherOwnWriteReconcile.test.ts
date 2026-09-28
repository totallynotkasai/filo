import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * The 30 s reconcile scan diffs against its previous snapshot. A file Filo
 * wrote in between must not come back as a change by another program: for a
 * board that meant a false "changed outside Filo" prompt, or a silent reload.
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

function changedNames(): string[] {
  return sentEvents
    .filter((e) => e.channel === 'vault:files-changed')
    .flatMap((e) => (e.payload[0] as Array<{ filename: string }>).map((c) => c.filename));
}

/** What a board save does: write the file, then tell the watcher the bytes. */
async function ownWrite(watcher: FileWatcher, dir: string, rel: string, text: string): Promise<void> {
  await fs.writeFile(join(dir, rel), text, 'utf-8');
  watcher.recordOwnWrite(rel, Buffer.from(text, 'utf-8'));
}

describe('FileWatcher reconcile scan after Filo\'s own write', () => {
  let dir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    sentEvents.length = 0;
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-own-reconcile-'));
    watcher = new FileWatcher(dir);
  });

  afterEach(async () => {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a board Filo saved is not reported by the next scan', async () => {
    await fs.writeFile(join(dir, 'Plan.board.json'), '{"v":1}', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await ownWrite(watcher, dir, 'Plan.board.json', '{"v":2,"more":"bytes"}');
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(changedNames()).not.toContain('Plan.board.json');
  });

  it('matches the snapshot entry case-insensitively (the renderer\'s spelling may differ)', async () => {
    await fs.writeFile(join(dir, 'Plan.board.json'), '{"v":1}', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await fs.writeFile(join(dir, 'Plan.board.json'), '{"v":2,"x":1}', 'utf-8');
    watcher.recordOwnWrite('plan.BOARD.json', Buffer.from('{"v":2,"x":1}', 'utf-8'));
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(changedNames()).toEqual([]);
  });

  it('another program\'s edit after Filo\'s save is still reported', async () => {
    await fs.writeFile(join(dir, 'Plan.board.json'), '{"v":1}', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await ownWrite(watcher, dir, 'Plan.board.json', '{"v":2}');
    await fs.writeFile(join(dir, 'Plan.board.json'), '{"v":3,"theirs":true}', 'utf-8');
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(changedNames()).toContain('Plan.board.json');
  });

  it('a different size on disk than Filo wrote (a write in the gap) leaves the snapshot alone', async () => {
    await fs.writeFile(join(dir, 'Plan.board.json'), '{"v":1}', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await fs.writeFile(join(dir, 'Plan.board.json'), '{"v":3,"theirs":true}', 'utf-8');
    watcher.recordOwnWrite('Plan.board.json', Buffer.from('{"v":2}', 'utf-8'));
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(changedNames()).toContain('Plan.board.json');
  });
});
