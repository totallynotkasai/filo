/**
 * Phase R4 — vault open as a transaction.
 *
 * `loadVaultCandidate` performs every fallible I/O for an `openVault`
 * call against a local snapshot, NEVER touching global stores. On
 * success it returns a fully-loaded `VaultCandidate` the orchestrator
 * (`vaultStore.openVault`) can install synchronously; on failure it
 * throws so the caller leaves the user on the home screen.
 *
 * Without this split, the previous `openVault` mutated `currentProject`
 * and `vaultPath` BEFORE its async theme / watcher / tags I/O — any
 * throw past the commit point left the renderer half-open: vault path
 * recorded, but no watcher, no theme, no tags. The audit's concrete
 * reproducer was a custom theme with a hand-edited unknown `base`,
 * which threw inside `applyCustomTheme` after the swap had already
 * committed.
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
import { loadAllBoards } from '../boards/boardLoader';
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
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
   * F6 (2026-05-28) — true when `.filo/tags.json` was written by a newer
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
   * 6.3.P3 — vault-relative paths of `.filo/` config files whose drift
   * baseline was seeded during load (i.e. the file existed on disk and a
   * successful `vault:stat` returned its mtime + size). Used by the
   * commit-side `assertBaselinesSeeded` tripwire to catch a regression
   * where a config baseline isn't seeded eagerly anymore — symmetrical
   * to the existing `boardPaths` tripwire.
   *
   * Empty when none of the configs exist on disk (fresh vault before any
   * `config:save` lands). Configs that ENOENT are skipped on purpose:
   * the writer's drift check no-ops without a baseline, which matches the
   * legacy "no comparison anchor on first write" behaviour.
   */
  seededConfigBaselinePaths: string[];
}

/**
 * 6.3.P3 — sentinel paths for the four bundled config files the writer
 * scheduler (`configWriteScheduler`) protects with a pre-write drift check.
 * Their baselines were never seeded on vault open, so the 5.1 ENOENT
 * resurrection guard was inert on a fresh open until the next successful
 * self-write seeded the baseline. Listed here once so the load-side
 * seed and the dev tripwire stay in lockstep.
 */
const CONFIG_SENTINEL_PATHS = [
  '.filo/defaults.json',
  '.filo/app.json',
  '.filo/appearance.json',
  '.filo/workspace.json',
] as const;

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

  await invokeOk('vault:init-config', newVaultPath);

  // ── 1. Read & classify `.filo/*.json` configs ────────────────────
  const rawConfigs = await window.filo.invoke('config:load-all', newVaultPath) as
    | Record<string, unknown>
    | null
    | undefined;
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
  for (const key of Object.keys(corruptionMap) as ConfigKey[]) {
    const v = configs[key] as { __corrupt?: unknown; error?: unknown } | undefined;
    if (!v || typeof v !== 'object' || v.__corrupt !== true) continue;
    const target = corruptionMap[key];
    const detail = typeof v.error === 'string' ? v.error : 'parse error';
    if (target) corruptionTargets.push(target);
    warnings.push({
      // Audit-4 DI-12 — dropped the dead "or close this toast to overwrite with
      // defaults" clause. Nothing wired closing the toast to
      // `clearCorruptConfigTarget`, so the corrupt file is preserved (the safe
      // direction) and that promise was misleading. State what actually
      // happens: edits stay paused until the user fixes the JSON and reopens.
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

  // ── 3. Parse settings slices (per-slice fallback) ────────────────
  const settings = parseSettingsSlices(raw.app, raw.defaults, warnings);

  // ── 4. Construct & validate the virtual Project ──────────────────
  const now = Date.now();
  const workspaceState: WorkspaceState = {
    openTabs: (raw.workspace.openTabs as WorkspaceState['openTabs']) ?? [],
    activeTabId: (raw.workspace.activeTabId as string) ?? '',
  };
  // Sprint C / C4 — `version` and `tags` were removed from ProjectSchema;
  // the schema still tolerates them via `.passthrough()` but new call
  // sites shouldn't seed them. The virtual project is reconstructed on
  // every open, so there's no on-disk file to migrate.
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
  // Sprint A / A16 — accumulate parse failures so the candidate's
  // warnings list (surfaced post-commit) can name every bad theme. The
  // candidate phase doesn't toast directly; the renderer's `applyById`
  // / `refreshAvailable` path covers post-open follow-ups.
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
    // Theme enumeration failed — match the prior `refreshAvailable`
    // behaviour (graceful: only built-in themes are available) and
    // surface via the bus so the user knows. Not fatal to the load.
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
        // Sprint A / A16 — same parse-failure envelope as the bulk load
        // above. Surface a toast naming the bad theme so the user
        // understands why their picked theme isn't applying.
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
        // Audit reproducer: a custom theme's `base` was hand-edited
        // to an unknown built-in. Throw here so the candidate is
        // discarded BEFORE any global state is touched.
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
    const tagsRaw = (await window.filo.invoke('tags:load', newVaultPath)) as string | null;
    // F6 — route through the version migrator so a from-future tags file is
    // detected (and surfaced) here rather than silently re-saved later.
    const loaded = loadTagsFile(tagsRaw);
    tagsFile = loaded.file;
    tagsReadOnly = loaded.fromFuture || loaded.noMigrationPath;
  } catch (err) {
    throw new Error(
      `Failed to load .filo/tags.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── 10. Seed drift baselines for `.filo/` configs ────────────────
  //
  // 6.3.P3 — the 5.1 ENOENT-skip guard inside `writeConfigs` is gated on
  // `baseline !== undefined`. Without an eager seed at vault open, the
  // first save after open lands in the "no baseline → skip the drift
  // check entirely" branch — which the original 5.1 fix calls "the same
  // bug, re-introduced for the most common open path." Stamp each
  // existing config's mtime + size here so the guard takes the
  // intended branch on the very first write after open.
  //
  // ENOENT is the common case for a fresh vault (none of the configs
  // exist yet); skip silently. Other stat failures (EACCES, NO_ACTIVE_VAULT
  // after a fast swap) are non-fatal — the legacy "no comparison anchor"
  // behaviour still protects user edits.
  const seededConfigBaselinePaths: string[] = [];
  for (const sentinelPath of CONFIG_SENTINEL_PATHS) {
    try {
      const stat = await invokeOk('vault:stat', newVaultPath, sentinelPath);
      // Defensive: a bare-result IPC mock (test fixture that doesn't
      // route `vault:stat`) returns `undefined`; `invokeOk`'s envelope
      // check passes that through. Without baseline data, the load
      // continues — no baseline = same pre-5.1 behaviour for the
      // next write, which is the documented fallback shape.
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
      // / share hiccup is visible during development. Doesn't block the
      // load — a missing baseline degrades to the legacy unguarded write
      // path, which is the same shape as the pre-5.1 behaviour.
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
  // DI-1 — spread the raw config first so keys this build doesn't recognise
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
