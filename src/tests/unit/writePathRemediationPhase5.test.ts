import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { UpdatePropertiesCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Command/popup → write round-trips that assert the *bytes on disk*, the
 * layer the engine corpus/fuzz suites structurally cannot reach (they drive
 * the engine with pre-cleaned objects).
 *
 * Two write sources reach the note writer:
 *   - a Properties edit is a frontmatter delta, applied to a fresh read;
 *   - a body save carries the body only, and the frontmatter comes from the
 *     fresh read with any queued delta laid over it.
 * Either way every untouched key — an empty `aliases:`, a full datetime, a
 * comment, key order, a key another program added — must survive on disk,
 * and a malformed block is never replaced. (The Kanban field-edit seam is in
 * writePathRemediationPhase4.test.ts.)
 */

let vault: MemoryVault;

beforeEach(() => {
  // Runs the test-reset callbacks, which clear the active vault path.
  __resetDirtyTrackingForTests();
  vaultStore.setPath('/vault');
  noteStore.__resetForTests();
  boardCacheStore.clear();
  boardStore.clearBoard();
  vaultIndexStore.clear();
  vault = installMemoryVault();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  noteStore.__resetForTests();
  restoreFiloDefault();
  __resetDirtyTrackingForTests();
  boardCacheStore.clear();
  boardStore.clearBoard();
  vaultIndexStore.clear();
  vaultStore.setPath('');
  vi.restoreAllMocks();
});

describe('Properties apply → write round-trip (untouched keys survive bytes on disk)', () => {
  /** A single Properties edit on a note no view has open. */
  async function applyPropertyEdit(
    relPath: string,
    beforeFm: Record<string, unknown>,
    afterFm: Record<string, unknown>,
  ): Promise<void> {
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath, fm: beforeFm },
      { kind: 'frontmatter', relPath, fm: afterFm },
    );
    await cmd.execute();
    await noteStore.flushAll();
  }

  it('preserves a present-but-empty disk key (aliases:) when a different property is edited', async () => {
    vault.writeExternally('Note.md', '---\naliases:\npriority: low\n---\nbody\n');

    await applyPropertyEdit('Note.md', { priority: 'low' }, { priority: 'high' });

    expect(vault.read('Note.md')).toBe('---\naliases:\npriority: high\n---\nbody\n');
  });

  it('preserves a full datetime on an untouched key', async () => {
    vault.writeExternally('Event.md', '---\ncreated: 2025-01-15T10:30:00Z\npriority: low\n---\nbody\n');

    await applyPropertyEdit('Event.md', { priority: 'low' }, { priority: 'high' });

    expect(vault.read('Event.md')).toBe('---\ncreated: 2025-01-15T10:30:00Z\npriority: high\n---\nbody\n');
  });

  it('preserves a comment + key order on untouched keys', async () => {
    vault.writeExternally('Doc.md', '---\n# important note\nzeta: 1\npriority: low\nalpha: 2\n---\nbody\n');

    await applyPropertyEdit('Doc.md', { priority: 'low' }, { priority: 'high' });

    expect(vault.read('Doc.md')).toBe('---\n# important note\nzeta: 1\npriority: high\nalpha: 2\n---\nbody\n');
  });

  it('preserves an externally-added key the command never saw', async () => {
    vault.writeExternally('Ext.md', '---\npriority: low\nreviewed: true\n---\nbody\n');

    await applyPropertyEdit('Ext.md', { priority: 'low' }, { priority: 'high' });

    expect(vault.read('Ext.md')).toBe('---\npriority: high\nreviewed: true\n---\nbody\n');
  });

  it('does NOT destroy a malformed frontmatter block on a property edit', async () => {
    // Tab indentation + duplicate keys → the YAML parser refuses the block, so
    // it is kept verbatim rather than replaced by a dump of just the new key.
    const bad = '---\n\tbad: yaml\n  dup: 1\n  dup: 2\n---\nbody\n';
    vault.writeExternally('Bad.md', bad);

    await applyPropertyEdit('Bad.md', {}, { priority: 'high' });

    expect(vault.read('Bad.md')).toBe(bad);
  });
});

describe('body save → write round-trip (untouched keys survive bytes on disk)', () => {
  it('a body-only save emits the FM block verbatim (empty + datetime + comment) and lands the new body', async () => {
    const relPath = 'Notes/Body.md';
    vault.writeExternally(relPath, '---\n# top comment\naliases:\ncreated: 2025-01-15T10:30:00Z\nstatus: draft\n---\nold body\n');
    const m = noteStore.acquire(relPath, 'editor');
    await m.loaded;

    noteStore.setBody(relPath, 'edited body text\n', 'editor');
    expect(await noteStore.flush(relPath)).toBe(true);

    expect(vault.read(relPath)).toBe(
      '---\n# top comment\naliases:\ncreated: 2025-01-15T10:30:00Z\nstatus: draft\n---\nedited body text\n',
    );
  });

  it('a body save with one frontmatter edit queued preserves the OTHER untouched keys', async () => {
    const relPath = 'Notes/Mixed.md';
    vault.writeExternally(relPath, '---\n# keep me\naliases:\ncreated: 2025-01-15T10:30:00Z\n---\nold body\n');
    const m = noteStore.acquire(relPath, 'editor');
    await m.loaded;

    // One field changes (a Properties edit) and the body is edited; both land
    // in one write on the file's own bytes.
    noteStore.patchFrontmatter(relPath, { set: { status: 'done' }, unset: [] });
    noteStore.setBody(relPath, 'new body content\n', 'editor');
    expect(await noteStore.flush(relPath)).toBe(true);

    const written = vault.read(relPath) ?? '';
    expect(written).toContain('status: done'); // the edit landed
    expect(written).toContain('# keep me'); // untouched comment survived
    expect(written).toContain('aliases:'); // untouched empty key survived
    expect(written).toContain('created: 2025-01-15T10:30:00Z'); // untouched datetime survived
    expect(written).toContain('new body content');
    expect(written).not.toContain('old body');
  });
});
