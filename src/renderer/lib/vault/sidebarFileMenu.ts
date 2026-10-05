import type { ContextMenuItem } from '../../stores/ui.svelte';
import { MENU_LABEL, copyLinkLabel } from '../../constants/menuVocabulary';

/** The sidebar's two ways to make something in a folder. */
interface MakeInFolder {
  /** A note in the folder, opened with its title ready to type. */
  onNewNote: () => void;
  /** A folder in the folder, with its name ready to type. */
  onNewFolder: () => void;
}

interface SidebarFileMenuOpts extends Partial<MakeInFolder> {
  isDirectory: boolean;
  /** A Markdown note, which can be renamed to match its title. */
  isNote: boolean;
  /** A note or a board: puts a link to it on the clipboard. */
  copyLink?: { what: 'note' | 'board'; action: () => void };
  onTags: () => void;
  onRename: () => void;
  onRenameToTitle: () => void;
  onReveal: () => void;
  /** Asks first, then moves the file or folder to Filo's trash. */
  onDelete: () => void;
}

function makeItems(opts: MakeInFolder): ContextMenuItem[] {
  return [
    { id: 'new-note', label: 'New note', action: opts.onNewNote },
    { id: 'new-folder', label: 'New folder', action: opts.onNewFolder },
  ];
}

/**
 * The sidebar's menu on a file or folder. A folder has no tags of its own,
 * and offers a new note or folder inside it.
 */
export function buildSidebarFileMenu(opts: SidebarFileMenuOpts): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (opts.isDirectory && opts.onNewNote && opts.onNewFolder) {
    items.push(...makeItems({ onNewNote: opts.onNewNote, onNewFolder: opts.onNewFolder }), { id: 'sep-new', divider: true, label: '' });
  }
  if (opts.copyLink) items.push({ id: 'copy-link', label: copyLinkLabel(opts.copyLink.what), action: opts.copyLink.action });
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

/** The sidebar's menu on its empty space: a new note or folder at the vault's top. */
export function buildSidebarSpaceMenu(opts: MakeInFolder): ContextMenuItem[] {
  return makeItems(opts);
}
