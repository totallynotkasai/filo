/**
 * A disk change read while another program is still writing the file can show
 * an opening frontmatter fence with no closing one. Taking that read would
 * drop the note's frontmatter, so the note store re-reads it after 500, 1500
 * and 3000 ms. The retries are bounded: after the last one the file is taken
 * as it is, and nothing keeps polling. A retry still pending when the vault
 * is swapped never changes the new vault's same-named note.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore, setNotePromptHandlers } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const FULL = '---\ntitle: Notes\ntags: [a]\n---\n# Big\n' + 'x'.repeat(2000) + '\n';
const TORN = '---\ntitle: Notes\nta';
const REWRITTEN = '---\ntitle: Notes\ntags: [a, b]\n---\n# Rewritten\n';

let vault: MemoryVault;
const prompts = { conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), writeTargetMissing: vi.fn(), reloadShrank: vi.fn(), reloadedOverTyping: vi.fn(), confirmReloadWithoutCopy: vi.fn(async () => false), dismiss: vi.fn() };

function readsOf(rel: string): number {
  return vi.mocked(window.filo.invoke).mock.calls
    .filter((c) => c[0] === 'vault:read-file-text' && String(c[2]).toLowerCase() === rel.toLowerCase())
    .length;
}

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({ 'Notes.md': FULL });
  vaultIndexStore.clear();
  noteStore.__resetForTests();
  for (const fn of Object.values(prompts)) fn.mockReset();
  setNotePromptHandlers(prompts);
});

afterEach(() => {
  vi.useRealTimers();
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('a torn read is retried, boundedly', () => {
  it('keeps the loaded note while the file looks torn, then takes the finished file', async () => {
    const m = noteStore.acquire('Notes.md', 'tile');
    await m.loaded;
    vi.useFakeTimers();
    vault.writeExternally('Notes.md', TORN);
    await noteStore.onDiskChanged('Notes.md');
    expect(m.body).toContain('x'.repeat(2000));
    expect(m.frontmatter.tags).toEqual(['a']);

    // The other program finishes before the first retry.
    vault.writeExternally('Notes.md', REWRITTEN);
    await vi.advanceTimersByTimeAsync(500);
    expect(m.body).toBe('# Rewritten\n');
    expect(m.frontmatter.tags).toEqual(['a', 'b']);
  });

  it('re-reads after 500 / 1500 / 3000 ms, then takes the file as it is and stops', async () => {
    const m = noteStore.acquire('Notes.md', 'tile');
    await m.loaded;
    vi.useFakeTimers();
    vault.writeExternally('Notes.md', TORN);
    const before = readsOf('Notes.md');

    await noteStore.onDiskChanged('Notes.md');
    expect(readsOf('Notes.md') - before).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(readsOf('Notes.md') - before).toBe(2);
    expect(m.body).toContain('x'.repeat(2000));
    await vi.advanceTimersByTimeAsync(1500);
    expect(readsOf('Notes.md') - before).toBe(3);
    expect(m.body).toContain('x'.repeat(2000));
    await vi.advanceTimersByTimeAsync(3000);
    // Initial read + 3 retries; the last is taken as the file's content.
    expect(readsOf('Notes.md') - before).toBe(4);
    expect(m.body).toBe(TORN);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(readsOf('Notes.md') - before).toBe(4);
  });

  it('a retry pending across a vault swap reads nothing once no note is open', async () => {
    const m = noteStore.acquire('Notes.md', 'tile');
    await m.loaded;
    vi.useFakeTimers();
    vault.writeExternally('Notes.md', TORN);
    await noteStore.onDiskChanged('Notes.md');

    await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault', nextVault: '/other', saveOutgoing: true });
    beginVaultGeneration('/other');
    setActiveVaultPath('/other');
    const before = readsOf('Notes.md');
    await vi.advanceTimersByTimeAsync(5000);
    expect(readsOf('Notes.md')).toBe(before);
  });

  it('a retry pending across a vault swap leaves the new vault\'s same-named note as it is', async () => {
    const m = noteStore.acquire('Notes.md', 'tile');
    await m.loaded;
    vi.useFakeTimers();
    vault.writeExternally('Notes.md', TORN);
    await noteStore.onDiskChanged('Notes.md');

    await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault', nextVault: '/other', saveOutgoing: true });
    beginVaultGeneration('/other');
    setActiveVaultPath('/other');
    const otherText = '---\ntitle: Other vault\n---\nOther body\n';
    vault.writeExternally('Notes.md', otherText);
    const next = noteStore.acquire('Notes.md', 'new-tile');
    await next.loaded;
    noteStore.setBody('Notes.md', 'typing in the new vault', 'new-tile');
    const revision = next.bodyRevision;

    await vi.advanceTimersByTimeAsync(5000);
    expect(next.body).toBe('typing in the new vault');
    expect(next.bodyRevision).toBe(revision);
    expect(next.status).toBe('ready');
    expect(prompts.conflict).not.toHaveBeenCalled();
    expect(prompts.reloadShrank).not.toHaveBeenCalled();
  });
});
