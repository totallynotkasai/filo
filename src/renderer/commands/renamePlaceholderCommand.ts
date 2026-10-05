import { Command } from './Command';
import { vaultStore } from '../stores/vault.svelte';
import { uiStore } from '../stores/ui.svelte';
import { normalizePath } from '../lib/utils/path';
import { rebasePath } from '../lib/vault/renamePathKeys';
import { vaultPath } from '@shared/vaultPath';

/**
 * Renames a note Filo made under a placeholder name ("New Card (3).md") after
 * the title it was just given. It runs inside that title edit's undo step, so
 * one undo puts back the file's name, then the title. Goes through the vault
 * rename: pending writes land first, the note's write queue is held while the
 * file moves, and every board follows the new path.
 *
 * A rename that can't happen (the file is locked, the name was taken
 * meanwhile) leaves the file as it is and says so; the title still changes,
 * and the next title edit tries again.
 */
// allow-own-board-only: renames one file; the rename cascade reads the boards as they are, it holds no board snapshot
export class RenamePlaceholderCommand extends Command {
  description: string;
  /** Vault-wide: the rename cascade updates every board, not one. */
  readonly targetBoardId: string;
  private fromPath: string;
  private toPath: string;
  private readonly vaultRoot: string;
  /** True while the file is at `toPath` by this command's own rename. */
  private moved = false;

  constructor(fromPath: string, toPath: string) {
    super();
    this.targetBoardId = '';
    this.fromPath = fromPath;
    this.toPath = toPath;
    this.vaultRoot = vaultStore.path;
    this.description = `Rename "${fromPath}" to "${toPath}"`;
  }

  /**
   * A later rename of the file (or a folder above either end) moves the ends
   * with it. The rename this command itself makes, in either direction, is
   * not one of those: following it would collapse both ends into one.
   */
  renamePath(oldRel: string, newRel: string): void {
    const own = (a: string, b: string): boolean => vaultPath(oldRel) === vaultPath(a) && vaultPath(newRel) === vaultPath(b);
    if (own(this.fromPath, this.toPath) || own(this.toPath, this.fromPath)) return;
    this.fromPath = rebasePath(this.fromPath, oldRel, newRel) ?? this.fromPath;
    this.toPath = rebasePath(this.toPath, oldRel, newRel) ?? this.toPath;
  }

  async execute(): Promise<void> {
    this.moved = await this.move(this.fromPath, this.toPath, 'rename');
  }

  async undo(): Promise<void> {
    if (!this.moved) return;
    if (await this.move(this.toPath, this.fromPath, 'undo')) this.moved = false;
  }

  private async move(from: string, to: string, verb: 'rename' | 'undo'): Promise<boolean> {
    // A different vault is open: its same-named file isn't the one renamed.
    if (!this.vaultRoot || vaultStore.path !== this.vaultRoot) return false;
    const base = normalizePath(this.vaultRoot);
    const result = await vaultStore.rename(`${base}/${from}`, `${base}/${to}`);
    if (result.success) return true;
    const name = from.split('/').pop() ?? from;
    const target = to.split('/').pop() ?? to;
    const why = result.code === 'TARGET_EXISTS'
      ? `"${target}" exists now`
      : result.code === 'ENOENT'
        ? `"${name}" is no longer on disk`
        : 'the file is in use or can\'t be changed';
    uiStore.toast(
      verb === 'rename'
        ? `"${name}" keeps its name: ${why}. Its title changed.`
        : `Couldn't rename "${name}" back: ${why}.`,
      'warning',
      5000,
    );
    return false;
  }
}
