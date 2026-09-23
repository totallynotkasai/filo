/**
 * IPC channel names used for communication between main and renderer processes.
 * All channels are namespaced by feature area.
 */
export type IpcChannel =
  // Vault file operations
  | 'vault:select'
  | 'vault:read-tree'
  | 'vault:create-folder'
  | 'vault:suggest-folder-name'
  | 'vault:rename'
  | 'vault:delete'
  | 'vault:watch'
  | 'vault:close'
  | 'vault:copy-file'
  // Audit-12 S1 — preload-internal one-way registration of an approved
  // vault:copy-file source (a real OS-dropped file path). Registered main-side
  // via ipcMain.on and fired ONLY by the preload getPathForFile through a
  // direct ipcRenderer.send. Deliberately absent from SendChannel so the
  // contextBridge-exposed api.send cannot reach it. The z.never() payload
  // schema is the runtime backstop. See services/approvedSources.ts.
  // (This comment avoids apostrophe and quote characters on purpose: the
  // ipc-parity scan harvests quoted literals from this union block, so a stray
  // one would be misread as a channel name.)
  | 'vault:register-source-path'
  | 'vault:read-file-text'
  | 'vault:write-file-text'
  | 'vault:write-existing-file-text'
  // Audit-19 BL-1 — create-exclusive new-file seed (O_EXCL), typed EEXIST on a clash.
  | 'vault:create-file-text'
  // Phase 2 / 2.5 — used by CascadeDeleteCommand.undo to restore captured
  // media bodies (base64-encoded). Atomic + size-capped at the handler.
  | 'vault:write-file-binary'
  | 'vault:file-exists'
  // Phase A.3 — returns stat shape with success, optional mtimeMs and size
  // for an external-edit guard during manual sync (syncTileMarkdown).
  | 'vault:stat'
  | 'vault:init-config'
  | 'vault:get-launch-preference'
  | 'vault:set-open-on-launch'
  | 'vault:list-recents'
  | 'vault:add-recent'
  | 'vault:remove-recent'
  | 'vault:pin-recent'
  | 'vault:clear-recents'
  | 'vault:reconcile'
  // Vault watcher events (main -> renderer)
  | 'vault:files-changed'
  | 'vault:tree-updated'
  | 'vault:file-renamed'
  | 'vault:watcher-failed'
  // Phase 3 / 3.1 — supervisor state machine. Payload carries the current
  // state (active/reconnecting/suspended), attempt counter, and a reason
  // string when transitioning to reconnecting. Renderer surfaces a toast.
  | 'vault:watcher-state'
  | 'vault:tree-too-large'
  // Board operations
  | 'board:list'
  | 'board:load'
  | 'board:save'
  | 'board:create'
  | 'board:delete'
  // Recovery snapshot (defensive backup of vault files before overwrite)
  | 'recovery:snapshot'
  // Recovery snapshot listing (surfaced to the user on vault open)
  | 'recovery:list'
  // Config operations (.filo/ directory)
  | 'config:load'
  | 'config:save'
  | 'config:load-all'
  | 'config:save-workspace'
  // Tags (`.filo/tags.json`)
  | 'tags:load'
  | 'tags:save'
  // Theme operations
  | 'theme:list'
  | 'theme:load'
  | 'theme:save'
  | 'theme:delete'
  // Layout Template operations (`.filo/templates/`)
  | 'templates:layout:list'
  | 'templates:layout:write'
  | 'templates:layout:rename'
  | 'templates:layout:delete'
  // Dialog operations
  | 'dialog:confirm'
  | 'dialog:choice'
  | 'dialog:open-file'
  // Media operations
  | 'media:save-audio'
  | 'media:read-file'
  | 'media:open-external'
  // Link metadata
  | 'link:fetch-metadata'
  // Export operations
  | 'export:save'
  // Font operations
  | 'font:list-system'
  | 'font:import'
  // Shell / OS operations
  | 'shell:show-item-in-folder'
  // App lifecycle (main -> renderer)
  | 'app:flush-and-quit'
  // App lifecycle (renderer -> main)
  | 'app:ready-to-quit'
  // 6.2.H4 — renderer-initiated quit cancellation. On a save-failure
  // confirm, the Stay-open-and-retry choice sends this so main clears
  // isFlushingForQuit and the flush-timeout timer, keeping the window
  // alive for retry instead of destroying it.
  | 'app:cancel-quit'
  // Audit-4 DI-04 — renderer heartbeat. Sent right before the open-ended
  // save-failure confirm so main clears its FLUSH_TIMEOUT_MS auto-destroy
  // timer and waits on the user reply (Quit-anyway / Stay-open) instead of
  // destroying the window out from under the dialog (and dropping the edits).
  | 'app:quit-awaiting-user'
  // Audit5 2.1 — renderer drain heartbeat. Beat immediately and then every
  // ~2s WHILE the quit flush drains, so main re-arms its FLUSH_TIMEOUT_MS
  // auto-destroy timer on each beat and an honest drain that runs longer than
  // the ceiling (large vault on a contended volume such as OneDrive) does not
  // destroy the window mid-write. The ceiling then bounds inter-beat silence
  // (a wedged renderer), not total honest drain time.
  | 'app:drain-heartbeat'
  // Sidebar — per-machine state (width, in-app floating mode, bounds)
  | 'sidebar:get-state'
  | 'sidebar:set-state';

/**
 * Channels the renderer may push one-way to the main process via
 * `window.filo.send` (fire-and-forget — no response). A strict subset of
 * `IpcChannel`: `send` is NOT a general-purpose escape hatch around the
 * payload validation `invoke` enforces, so only genuine push channels belong
 * here. Today that's just the quit handshake — `app:ready-to-quit` is the
 * renderer's reply to the main-process `app:flush-and-quit` broadcast.
 *
 * M1 (AUDIT_REMEDIATION_PLAN_2026-05-29) — typing `send` against this narrow
 * union (rather than the full `IpcChannel`) lets the preload `send` wrapper
 * run the same `validateIpcPayload` gate `invoke` uses, closing the hole
 * where `send` forwarded unvalidated args straight to the main process.
 */
export type SendChannel =
  | 'app:ready-to-quit'
  | 'app:cancel-quit'
  | 'app:quit-awaiting-user'
  | 'app:drain-heartbeat';

/**
 * Audit-15 P3.3 — channels the renderer may SUBSCRIBE to via `window.filo.on`.
 * These are the pure main→renderer events main pushes with
 * `webContents.send(...)`; the renderer is receive-only on them. The preload
 * `on` wrapper validates against this list at runtime so a compromised renderer
 * can't attach a listener to an arbitrary channel string — defence in depth,
 * since `invoke` and `send` are already payload-validated and `on` was the one
 * un-gated bridge method.
 *
 * MUST stay in sync with `MAIN_TO_RENDERER_EVENTS` in
 * `scripts/check-ipc-parity.mjs` (the parity gate forces every such event into
 * that set — this is its renderer-facing twin) and with the `broadcastOnly`
 * set in `ipcChannelParity.test.ts`. The `: readonly IpcChannel[]` annotation
 * makes every entry compile-time-checked against the `IpcChannel` union, so a
 * typo or a removed channel fails the build rather than silently mis-gating.
 */
export const RECEIVE_CHANNELS: readonly IpcChannel[] = [
  'vault:files-changed',
  'vault:tree-updated',
  'vault:file-renamed',
  'vault:watcher-failed',
  'vault:watcher-state',
  'vault:tree-too-large',
  'app:flush-and-quit',
];

/**
 * File tree node representing a file or folder in the vault.
 */
export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileTreeNode[];
  extension?: string;
  modifiedAt?: number;
  /** File size in bytes. Undefined for directories. */
  sizeBytes?: number;
}

/**
 * Board type identifiers.
 */
export type BoardType = 'mindmap' | 'kanban' | 'tasklist' | 'document';

/**
 * Tile type identifiers.
 */
export type TileType =
  | 'text'
  | 'image'
  | 'video'
  | 'file'
  | 'audio'
  | 'link'
  | 'iframe'
  | 'timer';

/**
 * Connection path type identifiers.
 */
export type ConnectionPathType = 'curved' | 'straight' | 'elbow' | 'smart';

/**
 * Tile shape options.
 */
export type TileShape = 'rectangle' | 'rounded';

/**
 * Border style options.
 */
export type BorderStyle = 'solid' | 'dashed' | 'dotted';

/**
 * Arrow type options for connections.
 */
export type ArrowType = 'none' | 'start' | 'end' | 'both';

/**
 * Background pattern options for boards.
 */
export type BackgroundPattern = 'grid' | 'dots' | 'lines' | 'none';

/**
 * Theme identifiers for built-in themes.
 */
export type ThemeId = 'light' | 'dark' | 'blueprint' | 'retro' | 'nature';

/**
 * Timer mode options.
 */
export type TimerMode = 'hms' | 'ms' | 's' | 'clock';

/**
 * Connection visibility states.
 */
export type ConnectionVisibility = 'visible' | 'visible-locked' | 'hidden' | 'hidden-locked';

/**
 * Sort & group settings for the vault sidebar. Sort and group each have a
 * field (the attribute) and a direction (ascending / descending). Folders
 * always sort by name regardless of the active field (mtime/size are
 * meaningless for folders); only files honour the field.
 */
export type VaultSortField = 'none' | 'name' | 'modified' | 'type' | 'size';
export type VaultSortDirection = 'asc' | 'desc';
export type VaultGroupField = 'none' | 'name' | 'modified' | 'type' | 'size';

/**
 * Toolbar size options.
 */
export type ToolbarSize = 'small' | 'medium' | 'large';

/**
 * Window API exposed to the renderer via contextBridge.
 *
 * `invoke` is typed against `IpcChannelMap` from `./ipcContracts.ts`
 * (Phase 1, CONSOLIDATION_PLAN_2026-05-25.md). Each callsite sees the
 * actual args tuple and the actual return shape — including the
 * `{ ok | success: false, ... }` failure branch on envelope channels.
 *
 * `on` / `send` still accept the bare `IpcChannel` union (which
 * includes push-only channels like `vault:files-changed` that have no
 * `invoke` shape and so don't appear in the channel map).
 *
 * The envelope-aware `invokeOk` lives renderer-side at
 * `src/renderer/lib/utils/invokeOk.ts`, not on the bridge — Electron's
 * `contextBridge` strips custom Error subclass fields via structured
 * clone, which would lose `IpcEnvelopeError`'s `channel` / `code`
 * data. The renderer-side helper applies `assertIpcOk` in the
 * renderer's context where the throw preserves the full error shape.
 */
import type {
  IpcChannelMap,
  ChannelArgs,
  ChannelResult,
  EnvelopeChannel,
  SuccessOf,
  InvokeChannel,
} from './ipcContracts';

export type {
  IpcChannelMap,
  ChannelArgs,
  ChannelResult,
  EnvelopeChannel,
  SuccessOf,
  InvokeChannel,
};

export interface FiloAPI {
  /**
   * Invokes an IPC channel and resolves with the raw return shape —
   * `{ ok | success: true | false, ... }` for envelope channels,
   * bare values for the rest. Prefer `invokeOk` (renderer-side helper)
   * for envelope channels unless you genuinely want to inspect the
   * failure branch.
   */
  invoke: <C extends InvokeChannel>(
    channel: C,
    ...args: ChannelArgs<C>
  ) => Promise<ChannelResult<C>>;
  on: (channel: IpcChannel, callback: (...args: unknown[]) => void) => () => void;
  /**
   * One-way push to main (no response). Narrowed to `SendChannel` so the
   * preload wrapper can validate the payload symmetrically with `invoke`
   * (M1, AUDIT_REMEDIATION_PLAN_2026-05-29).
   */
  send: (channel: SendChannel, ...args: unknown[]) => void;
  /**
   * Returns the absolute OS path for a `File` object obtained from a
   * drag-drop or `<input type="file">`. Replaces Electron's removed
   * `File.path` property (gone in Electron 32+). Returns `''` for `File`
   * objects not backed by a real on-disk file.
   */
  getPathForFile: (file: File) => string;
}

declare global {
  interface Window {
    filo: FiloAPI;
  }
}
