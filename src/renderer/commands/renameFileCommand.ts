import { Command } from './Command';
import { vaultStore } from '../stores/vault.svelte';
import { uiStore } from '../stores/ui.svelte';
import { normalizePath } from '../lib/utils/path';
import { rebasePath } from '../lib/vault/renamePathKeys';
import { vaultPath } from '@shared/vaultPath';

/**
 * Undo for "Rename file to match title": the reverse rename, through the same
 * vault rename as the original (it drains pending writes, holds the note's
 * write queue while the file moves, and every board follows the new path).
 * Nothing is rewritten; the file only moves.
 *
 * Pushed after the rename has happened (`pushWithoutExecute`), so `execute`
 * is only ever a redo.
 */
// allow-own-board-only: re-runs the rename, whose cascade reads the boards as they are; it holds no board snapshot
export class RenameFileCommand extends Command {
  description: string;
  /** Vault-wide: the rename cascade updates every board, not one. */
  readonly targetBoardId: string;
  private fromPath: string;
  private toPath: string;
  private readonly vaultRoot: string;

  constructor(fromPath: string, toPath: string) {
    super();
    this.targetBoardId = '';
    this.fromPath = fromPath;
    this.toPath = toPath;
    this.vaultRoot = vaultStore.path;
    this.description = `Rename "${fromPath}" to "${toPath}"`;
  }

  /**
   * A later rename of the file (or a folder above either end) moves the
   * ends with it. The rename this command itself makes, in either direction,
   * is not one of those: following it would collapse both ends into one.
   */
  renamePath(oldRel: string, newRel: string): void {
    const own = (a: string, b: string): boolean => vaultPath(oldRel) === vaultPath(a) && vaultPath(newRel) === vaultPath(b);
    if (own(this.fromPath, this.toPath) || own(this.toPath, this.fromPath)) return;
    this.fromPath = rebasePath(this.fromPath, oldRel, newRel) ?? this.fromPath;
    this.toPath = rebasePath(this.toPath, oldRel, newRel) ?? this.toPath;
  }

  async execute(): Promise<void> {
    await this.move(this.fromPath, this.toPath, 'redo');
  }

  async undo(): Promise<void> {
    await this.move(this.toPath, this.fromPath, 'undo');
  }

  /** The rename's own follow-up marks every board whose paths it rewrites. */
  changesBoardFile(): boolean {
    return false;
  }

  private async move(from: string, to: string, verb: 'undo' | 'redo'): Promise<void> {
    // A different vault is open: its same-named file isn't the one renamed.
    if (!this.vaultRoot || vaultStore.path !== this.vaultRoot) {
      uiStore.toast(`Cannot ${verb} the rename: the vault has changed since it ran.`, 'warning', 5000);
      return;
    }
    const base = normalizePath(this.vaultRoot);
    const result = await vaultStore.rename(`${base}/${from}`, `${base}/${to}`);
    if (!result.success) {
      uiStore.toast(
        result.code === 'TARGET_EXISTS'
          ? `Cannot ${verb} the rename: "${to}" exists now.`
          : result.code === 'ENOENT'
            ? `Cannot ${verb} the rename: "${from}" is no longer on disk.`
            : `Cannot ${verb} the rename of "${from}".`,
        'warning',
        5000,
      );
    }
  }
}
