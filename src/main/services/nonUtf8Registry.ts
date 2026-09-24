/**
 * Files whose bytes are NOT valid UTF-8 (a Windows-1252 note, a UTF-16
 * "Unicode" Notepad file).
 *
 * A UTF-8 decode silently replaces invalid sequences with U+FFFD, so the
 * FIRST write of any kind — a body save, a field edit, even a vault-wide tag
 * rename on a note the user never opened — would persist the replacement
 * characters, destroying every non-ASCII byte. `vault:read-file-text`
 * validates the bytes and records an invalid file here; the generic text write channels REFUSE to overwrite a recorded
 * path (`NOT_UTF8`) so a renderer bug that forgets the read-only state can't
 * corrupt it either. Only the explicit `vault:convert-to-utf8` action rewrites
 * such a file (after backing up the original bytes).
 *
 * Keyed by absolute path (case-folded on Windows); a later VALID read clears
 * the entry (the file was fixed / replaced externally).
 */
const registry = new Set<string>();
const MAX_ENTRIES = 10_000;

function key(absPath: string): string {
  return process.platform === 'win32' ? absPath.toLowerCase() : absPath;
}

export function noteReadEncoding(absPath: string, valid: boolean): void {
  if (valid) {
    registry.delete(key(absPath));
    return;
  }
  if (registry.size >= MAX_ENTRIES) registry.clear();
  registry.add(key(absPath));
}

export function isRegisteredNonUtf8(absPath: string): boolean {
  return registry.has(key(absPath));
}

export function clearNonUtf8(absPath: string): void {
  registry.delete(key(absPath));
}

/** Test-only. */
export function __resetNonUtf8RegistryForTests(): void {
  registry.clear();
}

/**
 * Re-keys a recorded path (and, for a folder, its descendants) after an
 * in-app rename, so the write refusal follows the file to its new name.
 */
export function renameNonUtf8(oldAbs: string, newAbs: string): void {
  const oldKey = key(oldAbs);
  const newKey = key(newAbs);
  if (registry.delete(oldKey)) registry.add(newKey);
  for (const sep of ['/', '\\']) {
    const prefix = oldKey + sep;
    for (const entry of [...registry]) {
      if (entry.startsWith(prefix)) {
        registry.delete(entry);
        registry.add(newKey + sep + entry.slice(prefix.length));
      }
    }
  }
}
