import { describe, it, expect, beforeEach } from 'vitest';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { renameVaultIndexUnderPrefix } from '@renderer/stores/vaultFolderOps';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';

/**
 * Audit 1.3 — REFUTED claim, pinned as a regression guard.
 *
 * The audit claimed that renaming a folder whose name contains an uppercase
 * letter (e.g. `Projects`) leaves its descendants' full-text-search keys stale,
 * on the premise that "VaultIndex/MiniSearch keys are stored lowercased" while
 * `renameVaultIndexUnderPrefix` derives a case-preserved prefix.
 *
 * That premise is false. `VaultIndex` keys every entry via `toPosix(...)`
 * (separators only — never lowercased), and `renameVaultIndexUnderPrefix`
 * derives `oldKey`/`childPrefix` from the same case-preserving `normalizePath`.
 * So `"Projects/Note.md".startsWith("Projects/")` already matches and the
 * descendant rebind already works. (The case-insensitive `normalizeVaultRelative`
 * fold the audit pointed at is used only for the `knownPaths` set and the
 * branded `VaultPath` keys, NOT for the search index.)
 *
 * Applying the audit's proposed fix (lowercasing the keys via
 * `normalizeVaultRelative`) would in fact REGRESS this: `childPrefix` would
 * become `"projects/"`, which fails the case-sensitive `startsWith` against the
 * case-preserved `"Projects/Note.md"`, and `index.renameKey` (which looks up by
 * the case-preserved key) would miss. This test locks in the correct behaviour.
 */

function md(path: string): FileMetadata {
  return {
    path,
    title: path.split('/').pop()?.replace(/\.md$/, '') ?? path,
    tags: [],
    frontmatter: {},
    content: 'body text',
    lastModified: 0,
    rawFrontmatter: '',
  };
}

describe('renameVaultIndexUnderPrefix — uppercase folder rename (Audit 1.3)', () => {
  beforeEach(() => {
    vaultIndexStore.clear();
  });

  it('rebinds descendant index keys when an uppercase-named folder is renamed', () => {
    vaultIndexStore.restoreMetadata('Projects/Note.md', md('Projects/Note.md'));
    vaultIndexStore.restoreMetadata('Projects/Sub/Deep.md', md('Projects/Sub/Deep.md'));
    vaultIndexStore.restoreMetadata('Other/Keep.md', md('Other/Keep.md'));

    renameVaultIndexUnderPrefix('Projects', 'Archive');

    // Descendants rebind to the new prefix (search resolves the new paths)...
    expect(vaultIndexStore.getMetadata('Archive/Note.md')).not.toBeNull();
    expect(vaultIndexStore.getMetadata('Archive/Sub/Deep.md')).not.toBeNull();

    // ...and the stale keys are gone.
    expect(vaultIndexStore.getMetadata('Projects/Note.md')).toBeNull();
    expect(vaultIndexStore.getMetadata('Projects/Sub/Deep.md')).toBeNull();

    // An unrelated sibling folder is untouched.
    expect(vaultIndexStore.getMetadata('Other/Keep.md')).not.toBeNull();
  });

  it('also handles a lowercase folder rename (control case)', () => {
    vaultIndexStore.restoreMetadata('notes/daily.md', md('notes/daily.md'));

    renameVaultIndexUnderPrefix('notes', 'journal');

    expect(vaultIndexStore.getMetadata('journal/daily.md')).not.toBeNull();
    expect(vaultIndexStore.getMetadata('notes/daily.md')).toBeNull();
  });
});
