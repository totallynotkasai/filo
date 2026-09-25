/**
 * A note whose first read FAILED (a Windows file lock, OneDrive, antivirus)
 * must not be written from its blank editor: a keystroke into that
 * unexpectedly-empty view would otherwise truncate the real, unread file. The
 * note is `unreadable` and takes no body until a later read succeeds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const REAL = '---\ntitle: Real\n---\n\n# Real heading\n\nReal paragraph that must survive.\n';

let diskFiles: Map<string, string>;
let locked: boolean;
let writes: string[];

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  noteStore.__resetForTests();
  diskFiles = new Map([['Notes/Locked.md', REAL]]);
  locked = true;
  writes = [];
  installFiloMock((channel: string, ...args: unknown[]) => {
    const rel = args[1] as string;
    if (channel === 'vault:read-file-text') {
      if (locked) return { success: false, code: 'EBUSY', error: 'EBUSY: resource busy or locked' };
      const content = diskFiles.get(rel);
      if (content === undefined) return { success: false, code: 'ENOENT', error: 'ENOENT' };
      return { success: true, content, mtimeMs: 100, size: content.length, encoding: 'utf-8' };
    }
    if (channel === 'vault:write-existing-file-text' || channel === 'vault:write-file-text') {
      writes.push(rel);
      diskFiles.set(rel, args[2] as string);
      return { success: true };
    }
    if (channel === 'vault:stat') {
      const content = diskFiles.get(rel);
      return content === undefined
        ? { success: false, code: 'ENOENT', error: 'ENOENT' }
        : { success: true, mtimeMs: 100, size: content.length };
    }
    return { success: true };
  });
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('a failed first read blocks writes until a read succeeds', () => {
  it('the note is unreadable and a keystroke writes nothing', async () => {
    const m = noteStore.acquire('Notes/Locked.md', 'document-editor');
    await m.loaded;
    expect(m.status).toBe('unreadable');
    expect(m.body).toBe('');

    noteStore.setBody('Notes/Locked.md', 'x', 'document-editor');
    expect(m.hasUnsavedBody).toBe(false);
    await noteStore.flushAll();

    expect(writes.filter((w) => w.endsWith('.md'))).toEqual([]);
    expect(diskFiles.get('Notes/Locked.md')).toBe(REAL);
  });

  it('a later successful read resumes editing on the real content', async () => {
    const m = noteStore.acquire('Notes/Locked.md', 'document-editor');
    await m.loaded;
    expect(m.status).toBe('unreadable');

    locked = false;
    await noteStore.reload('Notes/Locked.md');
    expect(m.status).toBe('ready');
    expect(m.body).toContain('Real heading');

    noteStore.setBody('Notes/Locked.md', '# Real heading\n\nReal paragraph that must survive.\n\nAdded.', 'document-editor');
    await noteStore.flush('Notes/Locked.md');
    expect(diskFiles.get('Notes/Locked.md')).toContain('Real paragraph that must survive.');
    expect(diskFiles.get('Notes/Locked.md')).toContain('Added.');
    expect(diskFiles.get('Notes/Locked.md')?.startsWith('---\ntitle: Real\n---\n')).toBe(true);
  });
});
