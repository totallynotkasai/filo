import { samePath } from '../utils/path';

/**
 * The items a drag that started in the vault sidebar carries, from its
 * dragstart until it ends (VaultSidebar ends it on any drop or dragend).
 *
 * A drag's data can't be read before the drop, so this is how a row tells,
 * while a drag is over it, that it is one of the items being dragged. An item
 * picked up and put back down on its own row is no drop: it must neither move
 * (the tree's own drop would have moved it to the vault root) nor highlight
 * anything as a target.
 */
let carried: readonly string[] = [];

export function startSidebarDrag(paths: readonly string[]): void {
  carried = paths;
}

export function endSidebarDrag(): void {
  carried = [];
}

/** Whether the sidebar drag in progress carries `path` (case-folded, as the vault compares paths). */
export function isCarriedPath(path: string | undefined): boolean {
  return path !== undefined && carried.some((p) => samePath(p, path));
}
