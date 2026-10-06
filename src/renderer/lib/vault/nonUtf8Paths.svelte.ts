/**
 * Vault-relative paths whose bytes are not valid UTF-8, as
 * reported by `vault:read-file-text`'s `encoding` field.
 *
 * Such a note is shown (its text is decoded with U+FFFD for the bad bytes) but
 * is NON-editable: any write would persist the replacement characters and
 * destroy every non-ASCII byte. The only way out is the explicit "Convert to
 * UTF-8…" action (main backs the original up first). Main also refuses the
 * text write channels for a recorded path, so this set is the UX half of a
 * belt-and-braces guard.
 *
 * Reactive (`SvelteSet`) so an open editor's banner / read-only state updates
 * when a read reports the encoding. Re-keyed on rename, cleared on vault swap.
 *
 * The same holds for a note that is a symbolic link (the read's `link`
 * flag): Filo doesn't follow links, and an atomic write would replace the
 * link with a regular file, so the note is shown read-only ("edit the
 * original") and main refuses its writes with `NOTE_IS_LINK`.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { onVaultSwap } from '../../core/vaultLifecycle';
import { rebasePath, registerPathRenamable } from './renamePathKeys';

const nonUtf8 = new SvelteSet<VaultPath>();
const linked = new SvelteSet<VaultPath>();
/**
 * Notes being converted to UTF-8, by hold: still read-only until the converted
 * text is loaded, so nothing typed between the conversion and that load is
 * built on the old decode. Keyed by hold so each conversion releases its own.
 */
const converting = new SvelteMap<number, VaultPath>();
let nextHold = 1;

onVaultSwap('pre-swap', 'nonUtf8Paths', () => {
  nonUtf8.clear();
  linked.clear();
  converting.clear();
}, { runAfter: ['leftBehind'] });

/**
 * Keeps `relPath` read-only, as a non-UTF-8 note, until the returned
 * function is called (it follows a rename meanwhile).
 */
export function holdReadOnlyWhileConverting(relPath: string): () => void {
  const hold = nextHold++;
  converting.set(hold, vaultPath(relPath));
  return () => {
    converting.delete(hold);
  };
}

/** Records whether a read found `relPath` to be a symbolic link. */
export function noteReadLink(relPath: string, link: boolean | undefined): void {
  if (!relPath) return;
  const key = vaultPath(relPath);
  if (link) linked.add(key);
  else linked.delete(key);
}

/** True when the last read of `relPath` found a symbolic link. */
export function isLinkedNote(relPath: string | null | undefined): boolean {
  return !!relPath && linked.has(vaultPath(relPath));
}

/** Records the encoding a read reported for `relPath` (absent → UTF-8). */
export function noteReadEncoding(relPath: string, encoding: 'utf-8' | 'invalid-utf-8' | undefined): void {
  if (!relPath) return;
  const key = vaultPath(relPath);
  if (encoding === 'invalid-utf-8') nonUtf8.add(key);
  else nonUtf8.delete(key);
}

export function isNonUtf8(relPath: string | null | undefined): boolean {
  if (!relPath) return false;
  const key = vaultPath(relPath);
  if (nonUtf8.has(key)) return true;
  for (const held of converting.values()) if (held === key) return true;
  return false;
}

function renameIn(set: SvelteSet<VaultPath>, oldRel: string, newRel: string): void {
  const oldKey = vaultPath(oldRel);
  const newKey = vaultPath(newRel);
  if (set.delete(oldKey)) set.add(newKey);
  const oldPrefix = `${oldKey}/`;
  for (const key of [...set]) {
    if (key.startsWith(oldPrefix)) {
      set.delete(key);
      set.add(vaultPath(`${newKey}/${key.slice(oldPrefix.length)}`));
    }
  }
}

function renameNonUtf8Path(oldRel: string, newRel: string): void {
  if (!oldRel || !newRel || oldRel === newRel) return;
  renameIn(nonUtf8, oldRel, newRel);
  renameIn(linked, oldRel, newRel);
  for (const [hold, key] of [...converting]) {
    const next = rebasePath(key, oldRel, newRel);
    if (next !== null) converting.set(hold, vaultPath(next));
  }
}

registerPathRenamable('nonUtf8Paths', renameNonUtf8Path);

/** Test-only. */
export function __resetNonUtf8PathsForTests(): void {
  nonUtf8.clear();
  linked.clear();
  converting.clear();
}
