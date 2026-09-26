import type { ContextMenuItem } from '../../stores/ui.svelte';
import { MENU_LABEL } from '../../constants/menuVocabulary';

interface SidebarFileMenuOpts {
  isDirectory: boolean;
  /** A Markdown note, which can be renamed to match its title. */
  isNote: boolean;
  onTags: () => void;
  onRename: () => void;
  onRenameToTitle: () => void;
  onReveal: () => void;
  /** Asks first, then moves the file or folder to Filo's trash. */
  onDelete: () => void;
}

/** The sidebar's menu on a file or folder. A folder has no tags of its own. */
export function buildSidebarFileMenu(opts: SidebarFileMenuOpts): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (!opts.isDirectory) items.push({ id: 'edit-tags', label: MENU_LABEL.tags, action: opts.onTags });
  items.push({ id: 'rename', label: 'Rename', action: opts.onRename });
  if (opts.isNote) items.push({ id: 'rename-to-title', label: 'Rename file to match title', action: opts.onRenameToTitle });
  items.push(
    { id: 'reveal', label: 'Reveal in File Explorer', action: opts.onReveal },
    { id: 'sep', divider: true, label: '' },
    { id: 'delete', label: MENU_LABEL.deleteFromVault, danger: true, action: opts.onDelete },
  );
  return items;
}
