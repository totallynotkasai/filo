/**
 * renameGrace — "is this note really gone?" checks that wait out a rename.
 *
 * A note whose file just vanished may be mid-rename by another program: the
 * rename arrives as its own event, after the note's write already failed on
 * the old path or its "missing" event was handled. A check waits
 * `NOTE_RENAME_GRACE_MS`, then asks only if the note is still in question and
 * the file is still gone.
 */
import { getActiveVaultPath } from '../vault/activeVaultPath';
import { captureVaultIdentity, isStillSameVault } from '../vault/vaultIdentity';
import { NOTE_RENAME_GRACE_MS } from '../vault/externalChangeWindows';

interface GraceCheck {
  timer: ReturnType<typeof setTimeout>;
  check: () => Promise<void>;
}

/** Checks waiting out the grace; dropped on a vault swap. */
// allow-module-state: cleared by the noteStore pre-swap handler and its test reset
const graceChecks = new Set<GraceCheck>();

/**
 * After the grace, runs `ask` only if `stillHere()` (the note hasn't been
 * re-keyed, discarded or saved) and the file is still gone; if it came back,
 * `onBack` runs instead.
 */
export function askUnlessMoved(relPath: string, stillHere: () => boolean, ask: () => void, onBack: () => void): void {
  const identity = captureVaultIdentity();
  const check = async (): Promise<void> => {
    if (!isStillSameVault(identity) || !stillHere()) return;
    const vaultRoot = getActiveVaultPath();
    if (!vaultRoot) return;
    let back = false;
    try {
      back = (await window.filo.invoke('vault:file-exists', vaultRoot, relPath)) === true;
    } catch {
      back = false;
    }
    if (!isStillSameVault(identity) || !stillHere()) return;
    if (back) onBack();
    else ask();
  };
  const entry: GraceCheck = {
    timer: setTimeout(() => {
      graceChecks.delete(entry);
      void check();
    }, NOTE_RENAME_GRACE_MS),
    check,
  };
  graceChecks.add(entry);
}

/** Drops every waiting check (vault swap). */
export function dropGraceChecks(): void {
  for (const e of graceChecks) clearTimeout(e.timer);
  graceChecks.clear();
}

/**
 * Runs every waiting check now instead of after the grace, and waits for the
 * ones a disk change or failed write is still about to start.
 */
export async function settleGraceChecksNow(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    await new Promise((r) => setTimeout(r, 0));
    const due = [...graceChecks];
    dropGraceChecks();
    await Promise.all(due.map((e) => e.check()));
  }
}
