/**
 * IpcChannelMap — typed contract for every channel registered in
 * `src/main/ipc/*.ts`. Each entry pairs the positional args the channel
 * accepts with the shape the handler resolves with on the happy path
 * AND the shape it resolves with on the catch path. Failure-path
 * envelopes (`{ ok: false, ... }` / `{ success: false, ... }`) are
 * part of the type so a caller that doesn't go through `invokeOk` /
 * `assertIpcOk` sees both branches at the type level and can't pretend
 * the call always succeeds. See CONSOLIDATION_PLAN_2026-05-25.md
 * Phase 1 for the bug-class this map prevents.
 *
 * Channel names are kept in sync with `IpcChannel` in `./types.ts` via
 * the `ci:ipc-parity` gate.
 *
 * The variadic-args contract (each entry's `args`) is intentionally
 * lighter than the runtime check in `IPC_PAYLOAD_SCHEMAS`
 * (`./ipcSchemas.ts`). The schema validates each positional arg at the
 * preload bridge; the type here gates *what TypeScript callers see*.
 * Keep the two in sync — adding a channel here without a schema entry
 * is a soft miss (the runtime falls through validation); adding a
 * schema without a channel-map entry leaves callers untyped.
 */

import type { FileTreeNode } from './types';

// ────────────────────────────────────────────────────────────────────
// Result shape helpers
// ────────────────────────────────────────────────────────────────────

/**
 * `ok`-discriminated envelope used by board, recovery, config, theme,
 * and the `vault:read-tree` / `vault:init-config` channels. Success
 * branch carries the additional `T` fields directly (no nested `data`
 * wrapper — matches the on-disk handler shape).
 */
export type IpcOk<T = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; code?: string; error?: string };

/**
 * `success`-discriminated envelope used by the older vault file-ops,
 * media, fonts, export, templates set. Same runtime contract as
 * `IpcOk` (the renderer-side `assertIpcOk` accepts either) — kept
 * distinct here because the handler shape is observably different.
 */
export type IpcSuccess<T = Record<never, never>> =
  | ({ success: true } & T)
  | { success: false; code?: string; error?: string };

// Per-channel structured types (kept inline below for greppability).
// `RecentVault` mirrors the main-side definition in
// `src/main/services/recentVaults.ts:7`. Keep these two in sync — the
// handlers serialise this shape directly to / from disk.
export interface RecentVault {
  path: string;
  name: string;
  lastOpened: number;
  pinned?: boolean;
}
// Mirrors `src/main/services/sidebarState.ts:26`.
export interface SidebarState {
  width: number;
  floating: boolean;
  floatingBounds?: { x: number; y: number; width: number; height: number };
}
// Shape of imported font entries returned by `font:import`. Matches the
// handler in `src/main/ipc/fonts.ipc.ts:80`.
export interface FontData {
  name: string;
  path: string;
  dataBase64: string;
}

// ────────────────────────────────────────────────────────────────────
// Channel map
// ────────────────────────────────────────────────────────────────────

export interface IpcChannelMap {
  // ── Vault file operations ────────────────────────────────────────
  'vault:select': {
    args: [];
    result: string | null;
  };
  'vault:read-tree': {
    args: [vaultRoot: string];
    result: IpcOk<{ tree: FileTreeNode[] }>;
  };
  'vault:create-folder': {
    args: [vaultRoot: string, folderPath: string];
    result: IpcSuccess;
  };
  'vault:suggest-folder-name': {
    args: [vaultRoot: string, parentPath: string, baseName: string];
    result: IpcSuccess<{ name: string }>;
  };
  'vault:rename': {
    args: [vaultRoot: string, oldRelPath: string, newRelPath: string];
    // IMPL_PLAN_2026-05-26 / Item 2 — `strandedAt` carries the temp path
    // a Windows case-only rename ended up on when both the retries and
    // the rescue restore failed. The renderer's rename-failure toast
    // includes the path so the user can recover the file via File
    // Explorer rather than thinking it was lost.
    result:
      | { success: true }
      | { success: false; code?: string; error?: string; strandedAt?: string };
  };
  'vault:delete': {
    args: [vaultRoot: string, relPath: string];
    result: IpcSuccess;
  };
  'vault:watch': {
    args: [vaultRoot: string];
    result: IpcSuccess;
  };
  /**
   * Sprint B / B24 — closes the active vault: stops the watcher, drops the
   * registry pointer. Idempotent. The renderer-side "Close vault" action
   * pairs this with its own `fireVaultSwap` so per-vault stores reset.
   */
  'vault:close': {
    args: [];
    result: IpcSuccess;
  };
  'vault:reconcile': {
    args: [];
    result: IpcSuccess<{ skipped?: boolean }>;
  };
  'vault:copy-file': {
    args:
      | [sourcePath: string, vaultRoot: string]
      | [sourcePath: string, vaultRoot: string, destFolder: string | undefined];
    result: IpcSuccess<{ path: string; relativePath: string }>;
  };
  'vault:read-file-text': {
    args: [vaultRoot: string, relPath: string];
    // `mtimeMs` + `size` (F1, 2026-05-28; size added later) are captured by
    // the handler's pre-flight stat and returned with the content so hydrate
    // sites seed the pre-write drift baseline (mtime + size) without a second
    // `vault:stat` round-trip. Both optional because a future handler revision
    // could omit them; callers pass them to `markHydrated`, which only seeds a
    // baseline when both are finite.
    result: IpcSuccess<{ content: string; mtimeMs?: number; size?: number }>;
  };
  'vault:write-file-text': {
    args: [vaultRoot: string, relPath: string, content: string];
    result: IpcSuccess<{ path: string }>;
  };
  'vault:write-existing-file-text': {
    args: [vaultRoot: string, relPath: string, content: string];
    result: IpcSuccess<{ path: string }>;
  };
  /** Audit-19 BL-1 — create-exclusive; fails with code 'EEXIST' instead of overwriting. */
  'vault:create-file-text': {
    args: [vaultRoot: string, relPath: string, content: string];
    result: IpcSuccess<{ path: string }>;
  };
  'vault:write-file-binary': {
    args: [vaultRoot: string, relPath: string, base64Data: string];
    result: IpcSuccess<{ path: string }>;
  };
  'vault:file-exists': {
    args: [vaultRoot: string, relPath: string];
    result: boolean;
  };
  'vault:stat': {
    args: [vaultRoot: string, relPath: string];
    result: IpcSuccess<{ mtimeMs: number; size: number }>;
  };
  'vault:init-config': {
    args: [vaultRoot: string];
    result: IpcOk;
  };
  'vault:get-launch-preference': {
    args: [];
    result: { openOnLaunch: boolean };
  };
  'vault:set-open-on-launch': {
    args: [openOnLaunch: boolean];
    result: IpcSuccess;
  };
  'vault:list-recents': {
    args: [];
    result: RecentVault[];
  };
  'vault:add-recent': {
    args: [path: string, name: string];
    // Audit-18 4.5 — `ok`-discriminated so a failed add (validation / missing
    // directory) is distinguishable from a genuinely empty list; the renderer
    // leaves the displayed recents intact on `{ ok: false }` instead of wiping
    // them. The read-only sibling channels keep their bare `RecentVault[]`.
    result: IpcOk<{ recents: RecentVault[] }>;
  };
  'vault:remove-recent': {
    args: [path: string];
    result: RecentVault[];
  };
  'vault:pin-recent': {
    args: [path: string, pinned: boolean];
    result: RecentVault[];
  };
  'vault:clear-recents': {
    args: [];
    result: RecentVault[];
  };

  // ── Boards ───────────────────────────────────────────────────────
  'board:list': {
    args: [vaultRoot: string];
    result: string[];
  };
  'board:load': {
    args: [vaultRoot: string, relPath: string];
    /** Audit-19 ERR-1 — the parsed board object (legacy double-encoded files are unwrapped main-side), or null. */
    result: unknown;
  };
  'board:save': {
    args: [vaultRoot: string, relPath: string, data: unknown];
    result: IpcOk;
  };
  'board:create': {
    args:
      | [vaultRoot: string, name: string, data: unknown]
      | [vaultRoot: string, name: string, data: unknown, subfolder: string | undefined];
    result: IpcOk<{ path: string }>;
  };
  'board:delete': {
    args: [vaultRoot: string, relPath: string];
    result: IpcOk;
  };

  // ── Recovery snapshot ────────────────────────────────────────────
  'recovery:snapshot': {
    args: [vaultRoot: string, relPath: string];
    result: IpcOk<{ path: string }>;
  };
  // Bare channel (like theme:load) — returns the snapshot list directly,
  // `[]` on scan failure. Not envelope-discriminated: surfacing the list is
  // best-effort UX, so "scan failed" and "none" both render as nothing.
  'recovery:list': {
    args: [vaultRoot: string];
    result: Array<{ relPath: string; basename: string; timestamp: string }>;
  };
  // Audit-19 EXT-5 — moves orphaned `*.<12hex>.tmp` / `.case-rename-*` files
  // older than 10 min into `.filo/recovery/orphan-tmp/` (never deletes).
  'vault:sweep-orphan-tmp': {
    args: [vaultRoot: string];
    result: IpcSuccess<{ moved: Array<{ from: string; to: string }> }>;
  };

  // ── Config ───────────────────────────────────────────────────────
  'config:load': {
    args: [vaultRoot: string, configName: string];
    result: unknown;
  };
  'config:save': {
    args: [vaultRoot: string, configName: string, data: unknown];
    result: IpcOk;
  };
  'config:load-all': {
    args: [vaultRoot: string];
    result: {
      app: unknown;
      appearance: unknown;
      defaults: unknown;
      hotkeys: unknown;
      workspace: unknown;
      viewports: unknown;
      sidebarOrder: unknown;
    };
  };
  'config:save-workspace': {
    args: [vaultRoot: string, data: unknown];
    result: IpcOk;
  };

  // ── Tags ─────────────────────────────────────────────────────────
  // Audit-14 4.4 — bare value on success (`string | null` / `void`), a
  // `{ ok: false }` envelope on error (NO_ACTIVE_VAULT during a swap, an
  // oversize/locked file). Like `theme:load`, this is a bare-with-
  // envelope-on-error channel (deliberately NOT in the
  // `ci:check-ipc-envelope-usage` allowlist): every renderer caller routes
  // the result through `assertIpcOk`, which passes bare values through and
  // re-throws on `{ ok: false }` — preserving the old throw-based control
  // flow the miscScheduler / vault-open pipeline relies on, now with a code.
  'tags:load': {
    args: [vaultRoot: string];
    result: string | null | { ok: false; code?: string; error?: string };
  };
  'tags:save': {
    args: [vaultRoot: string, data: string];
    result: void | { ok: false; code?: string; error?: string };
  };

  // ── Theme ────────────────────────────────────────────────────────
  'theme:list': {
    args: [vaultRoot: string];
    result: unknown[];
  };
  'theme:load': {
    args: [vaultRoot: string, name: string];
    result: unknown;
  };
  'theme:save': {
    args: [vaultRoot: string, name: string, data: unknown];
    result: IpcOk;
  };
  'theme:delete': {
    args: [vaultRoot: string, name: string];
    result: IpcOk;
  };

  // ── Layout templates ─────────────────────────────────────────────
  'templates:layout:list': {
    args: [vaultRoot: string];
    result: { filename: string; content: unknown }[];
  };
  'templates:layout:write': {
    args: [vaultRoot: string, filename: string, data: unknown];
    result: IpcSuccess<{ filename: string }>;
  };
  'templates:layout:rename': {
    args: [vaultRoot: string, oldName: string, newName: string];
    result: IpcSuccess;
  };
  'templates:layout:delete': {
    args: [vaultRoot: string, filename: string];
    result: IpcSuccess;
  };

  // ── Dialog ───────────────────────────────────────────────────────
  'dialog:confirm': {
    args: [message: string, detail?: string, kind?: string];
    result: boolean;
  };
  'dialog:choice': {
    args:
      | [message: string, buttons: string[]]
      | [message: string, buttons: string[], options: Record<string, unknown>];
    result: number;
  };
  'dialog:open-file': {
    args: [] | [options: Record<string, unknown>];
    result: string[] | null;
  };

  // ── Media ────────────────────────────────────────────────────────
  // Handler signature (`media.ipc.ts:86`):
  //   (vaultPath, audioData, fileName, destFolder?)
  'media:save-audio': {
    args:
      | [vaultRoot: string, audioData: string, filename: string]
      | [vaultRoot: string, audioData: string, filename: string, destFolder: string | undefined];
    result: IpcSuccess<{ path: string }>;
  };
  'media:read-file': {
    args: [vaultRoot: string, relPath: string];
    result: IpcSuccess<{ data: string; mimeType: string }>;
  };
  'media:open-external': {
    args: [url: string];
    result: IpcSuccess;
  };

  // ── Link metadata ────────────────────────────────────────────────
  'link:fetch-metadata': {
    args: [url: string];
    result: IpcSuccess<{
      title?: string;
      description?: string;
      image?: string;
      favicon?: string;
      domain?: string;
    }>;
  };

  // ── Export ───────────────────────────────────────────────────────
  'export:save': {
    args:
      | [filename: string, data: string]
      | [filename: string, data: string, mimeType: string | undefined];
    // Audit-18 4.4 — the failure branch carries an optional `canceled` flag so
    // the renderer can tell a save-dialog dismissal (no-op) from a real write
    // failure (error toast). Spelled out rather than `IpcSuccess<…>` so the
    // discriminator is part of the contract.
    result:
      | { success: true; path: string }
      | { success: false; canceled?: boolean; code?: string; error?: string };
  };

  // ── Fonts ────────────────────────────────────────────────────────
  'font:list-system': {
    args: [];
    result: string[];
  };
  'font:import': {
    args: [] | [vaultRoot: string | undefined];
    result: IpcSuccess<{ fonts: FontData[] }>;
  };

  // ── Shell / OS ───────────────────────────────────────────────────
  'shell:show-item-in-folder': {
    args: [absolutePath: string];
    result: boolean;
  };

  // ── App lifecycle (renderer → main) ──────────────────────────────
  'app:ready-to-quit': {
    args: [];
    result: void;
  };
  // 6.2.H4 — renderer cancels the in-flight quit (user picked "Stay
  // open and retry" on the save-failure confirm).
  'app:cancel-quit': {
    args: [];
    result: void;
  };
  // Audit-4 DI-04 — renderer heartbeat before the open-ended save-failure
  // confirm; main clears the auto-destroy flush timer on receipt.
  'app:quit-awaiting-user': {
    args: [];
    result: void;
  };
  // Audit5 2.1 — periodic drain heartbeat WHILE the quit flush runs; main
  // re-arms the auto-destroy flush timer on each beat.
  'app:drain-heartbeat': {
    args: [];
    result: void;
  };

  // ── Sidebar geometry ─────────────────────────────────────────────
  'sidebar:get-state': {
    args: [];
    result: SidebarState;
  };
  'sidebar:set-state': {
    args: [next: unknown];
    result: SidebarState;
  };
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Every channel listed in the map. */
export type InvokeChannel = keyof IpcChannelMap;

/** Args tuple for a given channel. */
export type ChannelArgs<C extends InvokeChannel> = IpcChannelMap[C]['args'];

/** Result type for a given channel (the full discriminated union for
 * envelope channels; the bare type for non-envelope channels). */
export type ChannelResult<C extends InvokeChannel> = IpcChannelMap[C]['result'];

/**
 * The set of channels whose result is an `{ ok | success }`-style
 * envelope, i.e. `invokeOk` makes sense for them. Used to constrain
 * `FiloAPI.invokeOk` so a caller can't accidentally invokeOk a bare
 * channel like `vault:file-exists`.
 */
export type EnvelopeChannel = {
  [C in InvokeChannel]:
    ChannelResult<C> extends { ok: true } | { ok: false; error?: string }
      ? C
      : ChannelResult<C> extends { success: true } | { success: false; error?: string }
        ? C
        : never;
}[InvokeChannel];

/**
 * The success branch of an envelope channel — `{ ok: true; … }` or
 * `{ success: true; … }`. `invokeOk` resolves to this; the failure
 * branch is converted into a thrown `IpcEnvelopeError`.
 */
export type SuccessOf<C extends EnvelopeChannel> =
  Extract<ChannelResult<C>, { ok: true } | { success: true }>;
