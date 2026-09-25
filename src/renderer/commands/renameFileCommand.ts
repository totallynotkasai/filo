import { Command } from './Command';
import { vaultStore } from '../stores/vault.svelte';
import { uiStore } from '../stores/ui.svelte';
import { normalizePath } from '../lib/utils/path';

/**
 * Undo for "Rename file to match title": the reverse rename, through the same
 * vault rename as the original (it drains pending writes, holds the note's
 * write queue while the file moves, and every board follows the new path).
 * Nothing is rewritten; the file only moves.
 *
 * Pushed after the rename has happened (`pushWithoutExecute`), so `execute`
 * is only ever a redo.
 */
export class RenameFileCommand extends Command {
  description: string;
  /** Vault-wide: the rename cascade updates every board, not one. */
  readonly targetBoardId: string;
  private readonly fromPath: string;
  private readonly toPath: string;
  private readonly vaultRoot: string;

  constructor(fromPath: string, toPath: string) {
    super();
    this.targetBoardId = '';
    this.fromPath = fromPath;
    this.toPath = toPath;
    this.vaultRoot = vaultStore.path;
    this.description = `Rename "${fromPath}" to "${toPath}"`;
  }

  async execute(): Promise<void> {
    await this.move(this.fromPath, this.toPath, 'redo');
  }

  async undo(): Promise<void> {
    await this.move(this.toPath, this.fromPath, 'undo');
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
