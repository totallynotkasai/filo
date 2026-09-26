/**
 * The note writer never turns a frontmatter block that parses into one that
 * doesn't. A queued change whose assembled bytes would break it stays queued
 * and failed with a toast; a generated `transform` is refused the same way.
 * The raw view (the user's own whole file) is the one exception.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import type { NoteWriter } from '@renderer/lib/notes/noteWriter';
import type { DiskSnapshot } from '@renderer/lib/notes/noteFile';
import type { ReportedError } from '@renderer/lib/utils/errorBus';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';
import { TEST_MACHINE_IDENTITY } from '../helpers/testMachine';

const breakNext = vi.hoisted(() => ({ on: false }));

vi.mock('@renderer/lib/notes/noteFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/notes/noteFile')>();
  return {
    ...actual,
    // Stands in for any assembler gap: the frontmatter it emits no longer parses.
    assembleNoteText: (...args: Parameters<typeof actual.assembleNoteText>): string => {
      const text = actual.assembleNoteText(...args);
      return breakNext.on ? text.replace(/^---\n/, '---\ntags: [a, b\n') : text;
    },
  };
});

// The shared test setup has already loaded the writer with the real
// noteFile; load a fresh copy that sees the mock.
vi.resetModules();
(await import('@renderer/lib/vault/machineIdentity')).__setMachineIdentityForTests(TEST_MACHINE_IDENTITY);
const { createNoteWriter, FrontmatterBreakError } = await import('@renderer/lib/notes/noteWriter');
const { readNoteText, snapshotOf } = await import('@renderer/lib/notes/noteFile');
const { beginVaultGeneration, __resetVaultIdentityForTests } = await import('@renderer/lib/vault/vaultIdentity');
const { __resetDirtyTrackingForTests, unsavedWork } = await import('@renderer/lib/boards/writeStateTracking');
const { onError } = await import('@renderer/lib/utils/errorBus');

let vault: MemoryVault;
let writer: NoteWriter;
let bases: Map<VaultPath, DiskSnapshot>;
let errors: ReportedError[];
let unsubscribe: () => void;

const ORIGINAL = '---\ntitle: A\n---\nOne\n';

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  vault = installMemoryVault({ 'A.md': ORIGINAL });
  bases = new Map([[vaultPath('A.md'), snapshotOf(readNoteText(ORIGINAL))]]);
  errors = [];
  unsubscribe = onError((e) => errors.push(e));
  breakNext.on = false;
  writer = createNoteWriter({
    vaultRoot: () => vault.root,
    baseOf: (p) => bases.get(p),
    hadFrontmatter: () => true,
    canWriteBody: () => true,
    onBodyConflict: () => undefined,
    onTargetMissing: () => undefined,
    onWritten: (p, _rel, _text, snapshot) => { bases.set(p, snapshot); },
  });
});

afterEach(() => {
  unsubscribe();
  writer.reset();
  restoreFiloDefault();
});

describe('noteWriter — frontmatter parse guard', () => {
  it('refuses a queued change whose assembled frontmatter would not parse', async () => {
    breakNext.on = true;
    writer.queueDelta('A.md', { set: { status: 'open' }, unset: [] });
    const result = await writer.flush('A.md');
    expect(result.ok).toBe(false);
    expect(vault.read('A.md')).toBe(ORIGINAL);
    expect(writer.isQueued('A.md')).toBe(true);
    expect(unsavedWork().failed).toContain(vaultPath('A.md'));
    expect(errors.some((e) => /would have broken the properties of "A\.md"/.test(e.message ?? ''))).toBe(true);
  });

  it('lets the same change through once the assembler behaves', async () => {
    writer.queueDelta('A.md', { set: { status: 'open' }, unset: [] });
    expect((await writer.flush('A.md')).ok).toBe(true);
    expect(vault.read('A.md')).toBe('---\ntitle: A\nstatus: open\n---\nOne\n');
  });

  it('refuses a generated transform that would break the block', async () => {
    await expect(
      writer.transform('A.md', (fresh) => fresh.raw.replace('title: A', 'title: [A')),
    ).rejects.toBeInstanceOf(FrontmatterBreakError);
    expect(vault.read('A.md')).toBe(ORIGINAL);
  });

  it('writes the raw view\'s own text even when its frontmatter is broken', async () => {
    const out = await writer.transform(
      'A.md',
      () => '---\ntitle: [A\n---\nOne\n',
      undefined,
      { userAuthored: true },
    );
    expect(out).toBe('---\ntitle: [A\n---\nOne\n');
    expect(vault.read('A.md')).toBe('---\ntitle: [A\n---\nOne\n');
  });

  it('a block that was already broken is not its concern', async () => {
    vault = installMemoryVault({ 'A.md': '---\ntitle: [A\n---\nOne\n' });
    const out = await writer.transform('A.md', (fresh) => fresh.raw.replace('One', 'Two'));
    expect(out).toBe('---\ntitle: [A\n---\nTwo\n');
  });
});
