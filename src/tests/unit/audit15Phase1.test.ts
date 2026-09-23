import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { scanBoardFiles } from '../../main/vault/boardFileOps';
import { classifyChange } from '../../main/services/fileWatcherClassify';
import { installPermissionHandlers } from '../../main/utils/permissionPolicy';

import {
  writeMarkdownFile,
  markHydrated,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import {
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-15 Phase 1 — the sibling-parity MEDIUM fixes that need a unit guard.
 *
 *   P1.3  `.board.json` enumeration (`scanBoardFiles`) + classification
 *         (`classifyChange`) now case-fold the extension, so an externally
 *         case-mangled board isn't silently dropped from the project / routed
 *         past the board reconciler.
 *   P1.4  the gateway delta write sources the body from FRESH disk when there is
 *         no live editor for the docId (orphan / card-only file), so a Properties
 *         field save can't revert an external body edit `fs.watch` missed.
 *   P1.5  a deny-by-default permission handler is installable on the session.
 *
 * P1.1 (scheduler parked early-return) lives in `audit14Phase1.test.ts` beside
 * its 1.1 siblings; P1.2 is CSS-only (no unit cover — see P0.1).
 */

describe('Audit-15 P1.3 — .board.json enumeration + classification case-fold', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-p13-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('scanBoardFiles includes boards whose extension casing diverged', async () => {
    await fs.writeFile(join(dir, 'Plan.Board.json'), '{}', 'utf8');
    await fs.writeFile(join(dir, 'normal.board.json'), '{}', 'utf8');
    await fs.mkdir(join(dir, 'sub'));
    await fs.writeFile(join(dir, 'sub', 'Deep.BOARD.JSON'), '{}', 'utf8');
    // A non-board file must NOT be picked up.
    await fs.writeFile(join(dir, 'notes.md'), '# x', 'utf8');

    const found = await scanBoardFiles(dir);

    expect(found).toContain('Plan.Board.json'); // case-mangled root board
    expect(found).toContain('normal.board.json'); // ordinary board (regression)
    expect(found).toContain('sub/Deep.BOARD.JSON'); // case-mangled nested board
    expect(found).not.toContain('notes.md');
  });

  it('classifyChange routes a case-variant .board.json to "board"', () => {
    expect(classifyChange('My.BOARD.JSON')).toBe('board');
    expect(classifyChange('Folder/Plan.Board.json')).toBe('board');
    // Regression: ordinary lowercase board + a non-board still classify correctly.
    expect(classifyChange('notes/x.board.json')).toBe('board');
    expect(classifyChange('notes/Note.md')).toBe('document');
  });
});

describe('Audit-15 P1.4 — delta write sources the body from fresh disk when no editor is open', () => {
  interface Captured {
    channel: string;
    args: unknown[];
  }
  let captured: Captured[];

  function lastWrite(): string | undefined {
    for (let i = captured.length - 1; i >= 0; i--) {
      const c = captured[i];
      if (c && c.channel === 'vault:write-existing-file-text') return c.args[2] as string;
    }
    return undefined;
  }

  function installDisk(content: string): void {
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content, mtimeMs: 7, size: content.length };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 7, size: content.length };
      return { success: true };
    });
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetBaselinesForTests();
    __resetMarkdownFileWriterForTests();
    documentStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    __resetMarkdownFileWriterForTests();
    documentStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  it('writes the FRESH disk body, not the stale caller snapshot, for a never-opened file', async () => {
    const fresh = '---\ncompleted: false\n---\nFRESH external body\n';
    installDisk(fresh);
    // Baseline matches the current disk stat → no drift prompt fires.
    markHydrated('Card.md', false, 7, fresh.length);
    // No documentStore.loadDocument → getDocument('doc1') is undefined → no live editor.

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath: 'Card.md',
      body: 'STALE snapshot body', // what a Properties popup passes from the watcher index
      callerId: 'props-1',
      docId: 'doc1',
      frontmatterDelta: patchToFrontmatterDelta({ completed: true }),
    });

    const written = lastWrite();
    expect(written).toBeDefined();
    expect(written).toContain('FRESH external body'); // disk body preserved
    expect(written).not.toContain('STALE snapshot body'); // stale snapshot NOT written
    expect(written).toContain('completed: true'); // the field delta still applied
  });

  it('keeps the LIVE editor body when an editor IS open for the docId (N2 invariant)', async () => {
    const disk = '---\ncompleted: false\n---\nold disk body\n';
    installDisk(disk);
    markHydrated('Open.md', false, 7, disk.length);
    documentStore.loadDocument({
      docId: 'doc2',
      filename: 'Open.md',
      title: 'Open',
      body: 'LIVE editor body',
      htmlContent: '',
      richText: [],
    });

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath: 'Open.md',
      body: 'LIVE editor body', // the live, un-debounced editor text the caller hands in
      callerId: 'props-2',
      docId: 'doc2',
      frontmatterDelta: patchToFrontmatterDelta({ completed: true }),
    });

    const written = lastWrite();
    expect(written).toBeDefined();
    expect(written).toContain('LIVE editor body'); // live body wins over disk
    expect(written).not.toContain('old disk body');
    expect(written).toContain('completed: true');
  });
});

describe('Audit-15 P1.5 — deny-by-default permission handlers', () => {
  it('registers both handlers and denies every request + check', () => {
    type RequestHandler = (
      wc: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: unknown,
    ) => void;
    type CheckHandler = (wc: unknown, permission: string, origin: string, details: unknown) => boolean;

    let requestHandler: RequestHandler | undefined;
    let checkHandler: CheckHandler | undefined;
    const fakeSession = {
      setPermissionRequestHandler: (h: RequestHandler) => {
        requestHandler = h;
      },
      setPermissionCheckHandler: (h: CheckHandler) => {
        checkHandler = h;
      },
    };

    installPermissionHandlers(fakeSession as unknown as Parameters<typeof installPermissionHandlers>[0]);

    expect(typeof requestHandler).toBe('function');
    expect(typeof checkHandler).toBe('function');

    // Every permission REQUEST is denied via callback(false).
    let granted: boolean | undefined;
    requestHandler!({}, 'geolocation', (g) => {
      granted = g;
    }, {});
    expect(granted).toBe(false);

    // Every permission CHECK returns false.
    for (const perm of ['media', 'notifications', 'clipboard-read', 'geolocation', 'midi']) {
      expect(checkHandler!({}, perm, 'https://embedded.example', {})).toBe(false);
    }
  });
});
