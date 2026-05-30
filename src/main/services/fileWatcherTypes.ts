/**
 * File change categories for vault watching.
 * The renderer handles each type differently.
 *
 * Kept in a standalone module so the pure correlation helper can import it
 * without pulling in `electron`/`fs` (Vitest jsdom environment can't load
 * those).
 *
 * Phase 3 / 3.2 — `config` is split into three granular subtypes (tags /
 * theme / template) so the renderer's exhaustive `dispatchExternalChange`
 * can drive a dedicated reconciler per file kind. The bare `config` kind
 * is retained for `.filo/` files that have no dedicated reconciler today
 * (e.g. `appearance.json`, `workspace.json`); the dispatcher routes those
 * through a no-op path so adding a new `.filo/` file doesn't silently
 * break the watcher contract.
 */
export type FileChangeType =
  | 'document'        // .md file changed
  | 'board'           // .board.json file changed
  | 'config'          // .filo/*.json changed (generic / un-routed)
  | 'config-tags'     // .filo/tags.json changed
  | 'config-theme'    // .filo/themes/*.json changed
  | 'config-template' // .filo/templates/*.template.json changed
  | 'attachment'      // file in attachments/ changed
  | 'tree'            // general tree structure changed (fallback)
  ;

export interface FileChangeEvent {
  type: FileChangeType;
  filename: string;        // relative to vault root
  eventType: string;       // 'rename' or 'change'
}
