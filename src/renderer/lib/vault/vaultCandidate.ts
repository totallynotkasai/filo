/**
 * Vault open as a transaction.
 *
 * `loadVaultCandidate` performs every fallible I/O for an `openVault`
 * call against a local snapshot, NEVER touching global stores. On
 * success it returns a fully-loaded `VaultCandidate` the orchestrator
 * (`vaultStore.openVault`) can install synchronously; on failure it
 * throws so the caller leaves the user on the home screen. This prevents
 * a throw mid-open (e.g. a custom theme with an unknown `base`) from
 * leaving the renderer half-open.
 *
 * What goes here vs. what stays in `vault.svelte.ts`:
 *
 *   - vaultCandidate.ts (this file): every IPC call, every parse, every
 *     `recovery:snapshot` for failed boards. Toast specs are BUFFERED
 *     into the returned candidate rather than fired immediately, so a
 *     candidate that ultimately fails (and is never committed) doesn't
 *     leave the user staring at warning toasts for a vault they couldn't
 *     open. Errors that justify aborting the open throw out of this
 *     function.
 *
 *   - vault.svelte.ts: the synchronous commit (global mutations) and the
 *     post-commit hooks (watcher start, index rebuild, recovery
 *     sequencer). Those are orchestration over multiple stores, not
 *     I/O, so they stay close to the stores they coordinate.
 */

import { SvelteSet } from 'svelte/reactivity';
import type { FileTreeNode } from '../../../shared/types';
import type {
  Project,
  ProjectSettings,
  WorkspaceState,
} from '../../schema/index';
import {
  defaultProjectSettings,
  GeneralSettingsSchema,
  MindMapDefaultsSchema,
  KanbanDefaultsSchema,
  TaskListDefaultsSchema,
  DocumentDefaultsSchema,
} from '../../schema/settings';
import { ProjectSchema } from '../../schema/project';
import { loadAllBoards, isTransientBoardLoadError } from '../boards/boardLoader';
import { boardLoadRetryToast } from '../boards/boardLoadRetryPrompt';
import { syncConflictToast, groupByCanonical } from './syncConflictNotices';
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError, assertIpcOk } from '@shared/ipcEnvelope';
import { reportError } from '../utils/errorBus';
import type {
  V7BoardFileData,
  ViewportEntry,
} from '../boards/boardSaver';
import type { ThemeFile } from '../themes/themeManager';
import type { TagsFile } from '../../schema/tagsFile';
import { loadTagsFile } from './tagsStorage';
import { normalizePath, toPosix } from '../utils/path';
import { noteBaseline } from './fileBaselineRegistry';
import { stashRecoveryStatusBeforeCommit } from './dirtyFlagRecovery';
import { loadMachineIdentity } from './machineIdentity';

/**
 * Failed-board kinds whose on-disk bytes are readable but
 * unusable, so a copy in .filo/recovery/ is worth taking. (`not-found`,
 * `too-large`, `snapshot-failed` and the transient kinds are not.)
 */
// allow-module-state: immutable lookup table
const SNAPSHOT_FAILED_BOARD_KINDS: ReadonlySet<string> = new Set([
  'parse-error',
  'schema-invalid',
  'from-future',
  'no-migration-path',
  'duplicate-board-id',
  'sync-conflict-copy',
]);

/**
 * Toast specs buffered during load and drained during commit. Keeping
 * them out of `uiStore` until commit means a load that ultimately
 * throws doesn't leave the user with orphan warning toasts for a vault
 * they never opened.
 */
export interface VaultCandidateWarning {
  text: string;
  type: 'info' | 'warning' | 'error';
  duration: number;
  /** An actionable notice (e.g. a locked board's Retry). */
  sticky?: boolean;
  dedupeKey?: string;
  actions?: Array<{ label: string; handler: () => void | Promise<void> }>;
}

/**
 * Corrupt-config write targets — the candidate records them and the
 * commit phase calls `markCorruptConfigTarget` on each so the writer
 * scheduler skips overwriting the user's hand-edited file with
 * defaults. Strings match the in-scheduler keys.
 */
export type CorruptionTarget =
  | 'app.json'
  | 'appearance.json'
  | 'defaults.json'
  | 'hotkeys.json'
  | 'viewports.json'
  | 'sidebar-order.json'
  | 'config:save-workspace';

export interface VaultCandidate {
  path: string;
  project: Project;
  manualOrder: Record<string, string[]>;
  boardCache: Record<string, V7BoardFileData>;
  // allow-string-path-key: keys are boardId (nanoid), not vault-relative paths
  boardPaths: Record<string, string>;
  backfilledBoardIds: string[];
  prunedBoardIds: string[];
  normalizedBoardIds: string[];
  viewports: Record<string, ViewportEntry>;
  workspaceConfig: Record<string, unknown>;
  tagsFile: TagsFile;
  /**
   * True when `.filo/tags.json` was written by a newer
   * Filo (or declares an un-migratable version). The commit phase passes
   * this to `fileTagsStore.commitFromCandidate` so the tag store goes
   * read-only and never re-saves (downgrades) the newer file.
   */
  tagsReadOnly: boolean;
  themeCache: Record<string, ThemeFile>;
  availableThemeIds: string[];
  activeThemeId: string;
  /** `null` for a built-in active theme (no file load needed). */
  activeThemeFile: ThemeFile | null;
  tree: FileTreeNode[];
  /**
   * Vault-relative paths of every file in `tree`, lowercased.
   * Pre-computed here so the commit phase doesn't walk the tree twice.
   */
  knownPaths: Set<string>;
  /** Settings to install via `seedConfigSnapshots`. */
  settings: ProjectSettings;
  /** Workspace state from `.filo/workspace.json` (post-parse). */
  workspaceState: WorkspaceState;
  warnings: VaultCandidateWarning[];
  corruptionTargets: CorruptionTarget[];
  /**
   * Vault-relative paths of `.filo/` config files whose drift baseline was
   * seeded during load (the file existed and `vault:stat` succeeded). Used by
   * the commit-side `assertBaselinesSeeded` tripwire. Configs that ENOENT are
   * skipped: the writer's drift check no-ops without a baseline.
   */
  seededConfigBaselinePaths: string[];
}

/**
 * The four bundled config files the writer scheduler (`configWriteScheduler`)
 * protects with a pre-write drift check. Their baselines are seeded on vault
 * open so the ENOENT-resurrection guard is live from the first write. Listed
 * once so the load-side seed and the dev tripwire stay in lockstep.
 */
const CONFIG_SENTINEL_PATHS = [
  '.filo/defaults.json',
  '.filo/app.json',
  '.filo/appearance.json',
  '.filo/workspace.json',
] as const;

/**
 * Backoff schedule (ms) for retrying a transient `config:load-all`
 * whole-folder read failure. ~1.45 s worst case, and ONLY on the failure path
 * (a successful first read adds zero latency). Kept short so vault-open latency
 * stays acceptable while still riding out the sub-second OneDrive/AV locks that
 * are the common cause.
 */
const CONFIG_LOAD_RETRY_DELAYS_MS = [150, 400, 900] as const;

interface RawConfigs {
  app: Record<string, unknown>;
  appearance: Record<string, unknown>;
  defaults: Record<string, unknown>;
  workspace: Record<string, unknown>;
  viewports: Record<string, unknown>;
  sidebarOrder: Record<string, unknown>;
}

/**
 * Drives the entire load. May throw on any fatal failure — IPC
 * collapse, invalid theme `base`, etc. — leaving the caller to bail
 * out of `openVault` cleanly. Non-fatal issues (settings slices that
 * fall back to defaults, failed-board entries that snapshot to
 * `.filo/recovery/`, corrupt config files) are buffered into
 * `candidate.warnings` for the commit phase to surface.
 */
export async function loadVaultCandidate(newVaultPath: string): Promise<VaultCandidate> {
  const warnings: VaultCandidateWarning[] = [];
  const corruptionTargets: CorruptionTarget[] = [];

  // Every crash sentinel this session names is built from this machine's id;
  // load it before the first sentinel read below.
  await loadMachineIdentity();
  await invokeOk('vault:init-config', newVaultPath);

  // Read + stash the prior session's sentinel BEFORE the commit can schedule
  // any write (an open-time repair write would replace it and destroy a
  // genuine prior-crash breadcrumb). Must run after `vault:init-config` (the
  // read IPC is gated on the armed registry). Never throws.
  await stashRecoveryStatusBeforeCommit(newVaultPath);

  // ── 1. Read & classify `.filo/*.json` configs ────────────────────
  // A transient whole-folder read failure (OneDrive/AV lock) pauses EVERY
  // config write for the session (see `__loadAllFailed` below), so retry the
  // pure read with short backoff first. This must happen at LOAD time:
  // resuming writes post-commit would stamp bootstrap defaults over the
  // intact-but-was-locked files on disk.
  const rawConfigs = await loadAllConfigsWithRetry(
    () => window.filo.invoke('config:load-all', newVaultPath),
  ) as Record<string, unknown> | null | undefined;
  // Defensive: if the IPC returned null/undefined or a non-object (e.g.
  // a partial read on a corrupted .filo/), fall back to an empty bag so
  // every subsequent `.app` / `.appearance` lookup hits the `?? {}` arm.
  const configs: Record<string, unknown> = rawConfigs && typeof rawConfigs === 'object'
    ? rawConfigs
    : {};

  // Detect per-file corruption (file exists on disk but failed to parse).
  // The main-process `loadConfig` returns a `{ __corrupt: true, raw, error }`
  // sentinel rather than silently dropping to the bootstrap fallback.
  type ConfigKey = 'app' | 'appearance' | 'defaults' | 'hotkeys' | 'workspace' | 'viewports' | 'sidebarOrder';
  const corruptionMap: Record<ConfigKey, CorruptionTarget | null> = {
    app: 'app.json',
    appearance: 'appearance.json',
    defaults: 'defaults.json',
    hotkeys: 'hotkeys.json',
    workspace: 'config:save-workspace',
    viewports: 'viewports.json',
    sidebarOrder: 'sidebar-order.json',
  };
  // A TOP-LEVEL `config:load-all` failure (the whole `.filo/`
  // read rejected — locked dir / transient IO, not a per-file parse error) tags
  // the bag with `__loadAllFailed`. Pause EVERY config write so we don't seed
  // bootstrap defaults over the intact-but-unreadable files, and warn ONCE
  // (rather than the seven per-file toasts a blanket `__corrupt` would emit).
  // Reopening the vault re-attempts the read.
  if (typeof (configs as { __loadAllFailed?: unknown }).__loadAllFailed === 'string') {
    for (const target of Object.values(corruptionMap)) {
      if (target) corruptionTargets.push(target);
    }
    warnings.push({
      text: "Filo couldn't read your .filo/ settings (the folder may be locked or mid-sync). Settings changes are paused to protect the files on disk — reopen the vault to retry.",
      type: 'warning',
      duration: 0,
    });
  }
  for (const key of Object.keys(corruptionMap) as ConfigKey[]) {
    const v = configs[key] as { __corrupt?: unknown; error?: unknown } | undefined;
    if (!v || typeof v !== 'object' || v.__corrupt !== true) continue;
    const target = corruptionMap[key];
    const detail = typeof v.error === 'string' ? v.error : 'parse error';
    if (target) corruptionTargets.push(target);
    warnings.push({
      text: `Filo couldn't parse .filo/${key}.json (${detail}). Edits to that file are paused to protect it — fix the JSON and reopen the vault to resume.`,
      type: 'error',
      duration: 0,
    });
  }

  const raw: RawConfigs = {
    app: pickObject(configs, 'app'),
    appearance: pickObject(configs, 'appearance'),
    defaults: pickObject(configs, 'defaults'),
    workspace: pickObject(configs, 'workspace'),
    viewports: pickObject(configs, 'viewports'),
    sidebarOrder: pickObject(configs, 'sidebarOrder'),
  };

  // ── 2. Boards — bulk load + snapshot failed ones ─────────────────
  const {
    boards,
    cache: boardCache,
    paths: boardPaths,
    connections,
    frames,
    failedBoards,
    backfilledBoardIds,
    prunedBoardIds,
    normalizedBoardIds,
  } = await loadAllBoards(newVaultPath);

  // Snapshot every failed board's bytes into `.filo/recovery/<ts>/` so
  // the originals survive any subsequent write Filo might do in this
  // session. Best-effort: the user already saw a toast from
  // `loadAllBoards` via the errorBus; this is the defensive backup
  // that lets them recover the file content even if they edit + save
  // adjacent boards before realising one didn't load.
  for (const failed of failedBoards) {
    // A locked / offline / transient-IO board is NOT
    // snapshotted (the snapshot would fail, or hydrate an online-only
    // placeholder); it gets a sticky Retry notice instead. Only kinds whose
    // bytes are readable but unusable are worth preserving.
    if (isTransientBoardLoadError(failed.errorKind)) {
      warnings.push(boardLoadRetryToast(newVaultPath, failed.path, failed.message));
      continue;
    }
    if (!SNAPSHOT_FAILED_BOARD_KINDS.has(failed.errorKind)) continue;
    try {
      await invokeOk('recovery:snapshot', newVaultPath, failed.path);
    } catch (snapshotErr) {
      reportError(
        'vault.recovery-snapshot',
        snapshotErr,
        `Failed to snapshot unloadable board ${failed.path} into .filo/recovery/`,
      );
    }
  }

  // Board files a sync client forked
  // (`Plan.board-HOST.json`) never appear in `board:list`; surface them once,
  // after the open commits (buffered), instead of leaving the other machine's
  // edits invisible. Best-effort: a failed scan just skips the notice.
  try {
    const { copies } = await invokeOk('board:list-conflicts', newVaultPath);
    for (const group of groupByCanonical(copies)) warnings.push(syncConflictToast(newVaultPath, group));
  } catch {
    // no notice — the live watcher still announces forks as they arrive
  }

  // ── 3. Parse settings slices (per-slice fallback) ────────────────
  const settings = parseSettingsSlices(raw.app, raw.defaults, warnings);

  // ── 4. Construct & validate the virtual Project ──────────────────
  const now = Date.now();
  const workspaceState: WorkspaceState = {
    openTabs: (raw.workspace.openTabs as WorkspaceState['openTabs']) ?? [],
    activeTabId: (raw.workspace.activeTabId as string) ?? '',
  };
  // `version` / `tags` are not part of ProjectSchema; don't seed them. The
  // virtual project is reconstructed on every open (no on-disk file).
  const virtualProjectInput = {
    vaultPath: newVaultPath,
    name: (raw.app.name as string) || newVaultPath.split(/[\\/]/).pop() || 'Vault',
    theme: ((raw.appearance.activeTheme as string) || 'light') as Project['theme'],
    settings,
    boards,
    connections,
    frames,
    workspace: workspaceState,
    createdAt: now,
    updatedAt: now,
  };

  // Parse-validate the virtual project so a malformed `.filo/` config
  // is caught before the renderer paints against it. On parse failure
  // we still proceed with the unvalidated object so the user isn't
  // locked out of their vault, but a warning toast surfaces the issue.
  const parsed = ProjectSchema.safeParse(virtualProjectInput);
  const project: Project = parsed.success
    ? (parsed.data as Project)
    : (virtualProjectInput as Project);
  if (!parsed.success) {
    warnings.push({
      text: 'Project metadata failed schema validation; using best-effort defaults. Check `.filo/` config files.',
      type: 'warning',
      duration: 0,
    });
  }

  // ── 5. Manual sidebar order (sanitize hand-edited shapes) ────────
  const manualOrder: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw.sidebarOrder)) {
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      manualOrder[k] = v as string[];
    }
  }

  // ── 6. File tree ─────────────────────────────────────────────────
  const treeEnvelope = await window.filo.invoke('vault:read-tree', newVaultPath);
  if (treeEnvelope.ok === false) {
    const code = treeEnvelope.code ?? 'unknown';
    throw new Error(
      `vault:read-tree failed (${code}): ${treeEnvelope.error ?? 'unable to enumerate vault tree'}`,
    );
  }
  const tree = treeEnvelope.tree;
  const knownPaths = computeKnownPaths(tree, newVaultPath);

  // ── 7. Themes — enumerate + load all custom files ────────────────
  const themeCache: Record<string, ThemeFile> = {};
  let availableThemeIds: string[] = [];
  // Accumulate parse failures so one toast can name every bad theme.
  const themeParseFailures: string[] = [];
  try {
    const filenames = (await window.filo.invoke('theme:list', newVaultPath)) as string[];
    availableThemeIds = filenames.map((f) => f.replace(/\.json$/i, ''));
    for (const id of availableThemeIds) {
      const data = (await window.filo.invoke('theme:load', newVaultPath, id)) as
        | ThemeFile
        | { ok: false; code: 'invalid-json'; name?: string }
        | null;
      if (data && typeof data === 'object' && 'ok' in data && (data as { ok?: boolean }).ok === false) {
        themeParseFailures.push(id);
        continue;
      }
      if (data) themeCache[id] = data as ThemeFile;
    }
    if (themeParseFailures.length > 0) {
      const list = themeParseFailures.map((n) => `"${n}"`).join(', ');
      reportError(
        'theme.parse',
        new Error(`Invalid JSON in theme files: ${list}`),
        `Failed to load theme${themeParseFailures.length > 1 ? 's' : ''}: ${list} — invalid JSON. Fix the file in .filo/themes/ to make it available again.`,
      );
    }
  } catch (err) {
    // Theme enumeration failed — only built-in themes are available.
    // Surface via the bus; not fatal to the load.
    reportError(
      'theme.list',
      err,
      'Failed to enumerate themes from .filo/themes/ — only built-in themes will be available',
    );
  }

  // ── 8. Active theme file (validated, NOT applied) ────────────────
  const activeThemeId = ((raw.appearance.activeTheme as string) || 'light').trim() || 'light';
  let activeThemeFile: ThemeFile | null = null;
  if (!isBuiltinId(activeThemeId)) {
    activeThemeFile = themeCache[activeThemeId] ?? null;
    if (!activeThemeFile) {
      // The cache miss may be a stale appearance.json pointing at a
      // file that was deleted off-disk. Try a direct theme:load before
      // giving up — match runtime `applyById`'s fallback.
      try {
        const loaded = (await window.filo.invoke('theme:load', newVaultPath, activeThemeId)) as
          | ThemeFile
          | { ok: false; code: 'invalid-json'; name?: string }
          | null;
        // Same parse-failure envelope as the bulk load above. Surface a toast
        // naming the bad theme so the user knows why it isn't applying.
        if (loaded && typeof loaded === 'object' && 'ok' in loaded && (loaded as { ok?: boolean }).ok === false) {
          reportError(
            'theme.parse',
            new Error(`Invalid JSON in theme "${activeThemeId}"`),
            `Active theme "${activeThemeId}" has invalid JSON — falling back to Light theme.`,
          );
        } else if (loaded) {
          activeThemeFile = loaded as ThemeFile;
          themeCache[activeThemeId] = loaded as ThemeFile;
          if (!availableThemeIds.includes(activeThemeId)) {
            availableThemeIds = [...availableThemeIds, activeThemeId];
          }
        }
      } catch (err) {
        throw new Error(
          `Failed to load active theme "${activeThemeId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (activeThemeFile) {
      const baseOk = isBuiltinId(activeThemeFile.base ?? 'dark');
      if (!baseOk) {
        // A custom theme's `base` names an unknown built-in. Throw here so
        // the candidate is discarded BEFORE any global state is touched.
        throw new Error(
          `Active theme "${activeThemeId}" has unknown base "${activeThemeFile.base}". Fix the value in .filo/themes/${activeThemeId}.json or pick a different active theme.`,
        );
      }
    }
  }

  // ── 9. Tags — load `.filo/tags.json` (no graceful fallback) ──────
  let tagsFile: TagsFile;
  let tagsReadOnly = false;
  try {
    // assertIpcOk re-throws a `{ ok: false }` error envelope so the catch
    // below wraps it with context (bare string|null passes through).
    const tagsRaw = assertIpcOk(
      await window.filo.invoke('tags:load', newVaultPath),
      'tags:load',
    ) as string | null;
    // Route through the version migrator so a from-future tags file is
    // detected here rather than silently re-saved (downgraded) later. A
    // `corrupt` file is also read-only, so post-commit FM tag-seeding can't
    // overwrite a recoverable-but-unparseable tags.json.
    const loaded = loadTagsFile(tagsRaw);
    tagsFile = loaded.file;
    tagsReadOnly = loaded.fromFuture || loaded.noMigrationPath || loaded.corrupt;
  } catch (err) {
    throw new Error(
      `Failed to load .filo/tags.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── 10. Seed drift baselines for `.filo/` configs ────────────────
  //
  // The ENOENT-skip guard inside `writeConfigs` only runs when a baseline
  // exists, so stamp each existing config's mtime + size here — otherwise the
  // first save after open would skip the drift check entirely.
  //
  // ENOENT is the common case for a fresh vault; skip silently. Other stat
  // failures (EACCES, NO_ACTIVE_VAULT after a fast swap) are non-fatal.
  const seededConfigBaselinePaths: string[] = [];
  for (const sentinelPath of CONFIG_SENTINEL_PATHS) {
    try {
      const stat = await invokeOk('vault:stat', newVaultPath, sentinelPath);
      // Defensive: a bare-result IPC mock (test fixture that doesn't
      // route `vault:stat`) returns `undefined`; `invokeOk`'s envelope
      // check passes that through. Without baseline data, the load
      // continues unguarded for this file.
      if (!stat || typeof stat.mtimeMs !== 'number' || typeof stat.size !== 'number') {
        continue;
      }
      noteBaseline(sentinelPath, stat.mtimeMs, stat.size);
      seededConfigBaselinePaths.push(sentinelPath);
    } catch (err) {
      if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
        continue;
      }
      // Non-ENOENT envelope failure: surface via the bus so a permissions
      // / share hiccup is visible. Doesn't block the load — a missing
      // baseline degrades to an unguarded write.
      reportError(
        'vault.config-baseline-seed',
        err,
        `Couldn't seed drift baseline for ${sentinelPath} — config-write drift detection is inert for it until the next successful self-write.`,
      );
    }
  }

  return {
    path: newVaultPath,
    project,
    manualOrder,
    boardCache,
    boardPaths,
    backfilledBoardIds,
    prunedBoardIds,
    normalizedBoardIds,
    viewports: raw.viewports as Record<string, ViewportEntry>,
    workspaceConfig: raw.workspace,
    tagsFile,
    tagsReadOnly,
    themeCache,
    availableThemeIds,
    activeThemeId,
    activeThemeFile,
    tree,
    knownPaths,
    settings,
    workspaceState,
    warnings,
    corruptionTargets,
    seededConfigBaselinePaths,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * True when `config:load-all` tagged the bag with a top-level
 * read failure (`board.ipc.ts` returns the all-empty bag + `__loadAllFailed`
 * string rather than rejecting). Per-file `__corrupt` sentinels are NOT this —
 * those are genuine parse errors handled per-file below, not a transient lock.
 */
export function isConfigLoadAllFailed(bag: unknown): boolean {
  return (
    !!bag &&
    typeof bag === 'object' &&
    typeof (bag as { __loadAllFailed?: unknown }).__loadAllFailed === 'string'
  );
}

/**
 * Reads `config:load-all` with bounded retry on a transient
 * whole-folder failure. Returns the first non-`__loadAllFailed` bag, or the
 * last failed bag once the backoff schedule is exhausted (caller then takes
 * the pause-and-warn path). `loadOnce`/`sleep` are injectable so this is unit-
 * testable without a real IPC bridge or wall-clock delays.
 */
export async function loadAllConfigsWithRetry(
  loadOnce: () => Promise<unknown>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  delays: readonly number[] = CONFIG_LOAD_RETRY_DELAYS_MS,
): Promise<unknown> {
  let bag = await loadOnce();
  for (let i = 0; i < delays.length && isConfigLoadAllFailed(bag); i++) {
    await sleep(delays[i] ?? 0);
    bag = await loadOnce();
  }
  return bag;
}

function pickObject(configs: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = configs[key];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  // Corruption sentinels mustn't seed the in-memory store with their
  // `__corrupt`/`raw`/`error` keys — return an empty object so the
  // bootstrap path treats the slice as fresh.
  if ((v as { __corrupt?: unknown }).__corrupt === true) return {};
  return v as Record<string, unknown>;
}

function parseSettingsSlices(
  appConfig: Record<string, unknown>,
  defaultsConfig: Record<string, unknown>,
  warnings: VaultCandidateWarning[],
): ProjectSettings {
  // Spread the raw config first so keys this build doesn't recognise
  // (forward-compat fields, the vault `name`) survive `GeneralSettingsSchema`'s
  // `.passthrough()` instead of being silently dropped on load → re-saved away.
  // Every schema-known key is normalised explicitly below, overriding the
  // spread, so the spread only contributes the unknown keys.
  const generalInput = {
    ...appConfig,
    globalFont: appConfig.globalFont ?? '',
    globalFontSize: appConfig.globalFontSize,
    defaultBoardFontSize: appConfig.defaultBoardFontSize ?? {},
    systemFonts: appConfig.systemFonts ?? [],
    globalToolbarScale: appConfig.globalToolbarScale,
    boardToolbarScale: appConfig.boardToolbarScale,
    tabBarScale: appConfig.tabBarScale,
    minimapScale: appConfig.minimapScale,
    waypointScale: appConfig.waypointScale,
    toolbarColor: appConfig.toolbarColor ?? appConfig.toolbarColour ?? '',
    tabBarColor: appConfig.tabBarColor ?? appConfig.tabBarColour ?? '',
    radarEnabled: appConfig.radarEnabled ?? true,
    recentColors: appConfig.recentColors ?? appConfig.recentColours ?? [],
    activeRootFolder: typeof appConfig.activeRootFolder === 'string' ? appConfig.activeRootFolder : '',
    sidebarSortField: typeof appConfig.sidebarSortField === 'string' ? appConfig.sidebarSortField : undefined,
    sidebarSortDirection: typeof appConfig.sidebarSortDirection === 'string' ? appConfig.sidebarSortDirection : undefined,
    sidebarGroupField: typeof appConfig.sidebarGroupField === 'string' ? appConfig.sidebarGroupField : undefined,
    sidebarGroupDirection: typeof appConfig.sidebarGroupDirection === 'string' ? appConfig.sidebarGroupDirection : undefined,
    showFileExtensions: typeof appConfig.showFileExtensions === 'boolean' ? appConfig.showFileExtensions : false,
    hoverButtons: appConfig.hoverButtons ?? {},
    historyLimit: appConfig.historyLimit,
  };
  const fallback = defaultProjectSettings();
  const sliceResults = {
    general: GeneralSettingsSchema.safeParse(generalInput),
    mindmap: MindMapDefaultsSchema.safeParse(defaultsConfig.mindmap ?? {}),
    kanban: KanbanDefaultsSchema.safeParse(defaultsConfig.kanban ?? {}),
    tasklist: TaskListDefaultsSchema.safeParse(defaultsConfig.tasklist ?? {}),
    document: DocumentDefaultsSchema.safeParse(defaultsConfig.document ?? {}),
  } as const;
  const failedSlices: string[] = [];
  for (const [name, res] of Object.entries(sliceResults)) {
    if (!res.success) failedSlices.push(name);
  }
  if (failedSlices.length > 0) {
    warnings.push({
      text: `Settings slice(s) reset to defaults due to parse errors: ${failedSlices.join(', ')}.`,
      type: 'warning',
      duration: 0,
    });
  }
  return {
    general: sliceResults.general.success ? sliceResults.general.data : fallback.general,
    mindmap: sliceResults.mindmap.success ? sliceResults.mindmap.data : fallback.mindmap,
    kanban: sliceResults.kanban.success ? sliceResults.kanban.data : fallback.kanban,
    tasklist: sliceResults.tasklist.success ? sliceResults.tasklist.data : fallback.tasklist,
    document: sliceResults.document.success ? sliceResults.document.data : fallback.document,
  };
}

function computeKnownPaths(tree: FileTreeNode[], vaultPath: string): Set<string> {
  const out = new SvelteSet<string>();
  const root = normalizePath(vaultPath).toLowerCase();
  const walk = (nodes: FileTreeNode[]): void => {
    for (const n of nodes) {
      const rel = toPosix(n.path).toLowerCase();
      if (rel.startsWith(root + '/')) {
        const slice = toPosix(n.path).slice(root.length + 1);
        if (!n.isDirectory && slice) out.add(slice);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/**
 * Tiny local copy of the built-in check rather than importing from
 * `themeStore` (which would create a load-time cycle: themeStore →
 * fileTagsStore → vaultStore → vaultCandidate). The list is small and
 * stable.
 */
function isBuiltinId(id: string): boolean {
  return ['light', 'dark', 'blueprint', 'retro', 'nature'].includes(id);
}
