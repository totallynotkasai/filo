/**
 * configWriteScheduler — the `.filo/` config-bundle write pipeline.
 *
 * Bundles four files (workspace, defaults.json, app.json, appearance.json)
 * because they share a single debounced flush window. Each payload is
 * compared against its last successfully written copy and skipped if
 * unchanged, so a theme-only change only touches `appearance.json`.
 *
 * Routes every write through the shared inflight / sentinel / write-error
 * pipeline (via `createScheduler`) so failures surface in the same
 * save-state path as board and misc writes.
 *
 * Phase R1 (2026-05-26) — backing scheduler swapped to the unified
 * `createScheduler` primitive. The legacy module had no in-flight map,
 * so `flushScheduledConfig` returned `null` the moment the debounce
 * timer fired, regardless of whether the IPC was still pending. Ctrl+S
 * landing in that gap reported "saved" while writes were mid-flight.
 * The primitive owns the in-flight tracker for free; failures surface
 * through `failed[]` whether the IPC was pending or completed.
 */

import type {
  ProjectSettings,
  WorkspaceState,
} from '../../schema/index';
import type { WorkspaceLayout } from '../../stores/workspace.svelte';
import { BOARD_WRITE_DEBOUNCE_MS } from './boardWriteDebounce';
import {
  notifyWriteError,
  registerResetCallback,
  registerTestResetCallback,
  markRecentSelfWrite,
} from './writeStateTracking';
import { invokeOk } from '../utils/invokeOk';
import { createScheduler } from './writeScheduler';
import { getBaseline, noteBaseline, hasBaselineDrifted } from '../vault/fileBaselineRegistry';

export interface ConfigWriteArgs {
  vaultRoot: string;
  settings: ProjectSettings;
  theme: string;
  workspace: WorkspaceState;
  layout: WorkspaceLayout;
}

/**
 * Targets the corruption sentinel can gate writes against. Adding a new
 * member here is a two-step operation:
 *
 *   1. Update the producer (whoever calls `markCorruptConfigTarget` during
 *      vault open in `vault.svelte.ts`).
 *   2. Update the consumer (whichever scheduler runs the write — usually
 *      `writeConfigs` here, or `miscWriteScheduler.scheduleMiscWrite` /
 *      `vault.svelte.ts:scheduleSidebarOrderWrite` for the misc-bucket
 *      configs). The consumer must call `isConfigTargetCorrupt(target)`
 *      before its disk write and skip silently when true.
 *
 * Phase 23 M20 — hotkeys.json, viewports.json, and sidebar-order.json were
 * added so a hand-edited corruption in any one of them no longer gets
 * silently overwritten by the next debounced flush of in-memory defaults.
 */
type ConfigTarget =
  | 'config:save-workspace'
  | 'defaults.json'
  | 'app.json'
  | 'appearance.json'
  | 'hotkeys.json'
  | 'viewports.json'
  | 'sidebar-order.json';

/**
 * Last-successfully-written serialized payload per config target. A target
 * whose freshly built payload matches its cache entry is skipped at write
 * time — isolated changes (theme only, workspace only) no longer rewrite
 * the other three files. Cleared on vault swap.
 */
const lastWrittenConfigs = new Map<ConfigTarget, string>();

/**
 * Config targets that loaded from disk in a corrupt state (ENOENT and
 * parse-error are distinguished in `configOps.loadConfig`). Writes to any
 * target in this set are suppressed: the in-memory store would otherwise
 * stamp its bootstrap-default shape on top of a user-edited file that's
 * just temporarily unparseable. Cleared per vault swap; the renderer
 * clears specific entries via `clearCorruptConfigTarget` once the user
 * resolves the issue (e.g. picks "Use defaults" in the modal).
 */
const corruptConfigTargets = new Set<ConfigTarget>();

export function markCorruptConfigTarget(target: ConfigTarget): void {
  corruptConfigTargets.add(target);
}

export function clearCorruptConfigTarget(target: ConfigTarget): void {
  corruptConfigTargets.delete(target);
}

export function isConfigTargetCorrupt(target: ConfigTarget): boolean {
  return corruptConfigTargets.has(target);
}

/**
 * Loose-typed companion to {@link isConfigTargetCorrupt}. Misc-bucket writers
 * (viewports, hotkeys, sidebar-order) carry their target as a free-form
 * string ("`.filo/viewports.json`", "`.filo/hotkeys.json`", etc.) rather
 * than the strict `ConfigTarget` union, because miscWriteScheduler is a
 * generic key→write registry. Use this to gate those writes against the
 * corruption set without leaking the strict-typing requirement.
 *
 * The matcher accepts both the bare `'viewports.json'` form (what
 * `markCorruptConfigTarget` records during vault open) and the
 * `'.filo/viewports.json'` form (what miscWriteScheduler call sites pass
 * as their `path`). Anything outside the known target set returns false.
 */
export function isConfigPathCorrupt(path: string): boolean {
  if (!path) return false;
  const normalized = path.replace(/^[\\/]?\.?filo[\\/]/, '');
  for (const target of corruptConfigTargets) {
    if (target === normalized || `.filo/${target}` === path) return true;
  }
  return false;
}

// Self-register cleanup so vault swap and test reset don't leak between vaults.
registerResetCallback(() => {
  lastWrittenConfigs.clear();
  corruptConfigTargets.clear();
  configScheduler.reset();
});
registerTestResetCallback(() => {
  lastWrittenConfigs.clear();
  corruptConfigTargets.clear();
  configScheduler.reset();
});

/**
 * Builds the serialized payload for each of the four `.filo/` config files
 * this scheduler is responsible for. The other three `ConfigTarget` entries
 * (hotkeys, viewports, sidebar-order) live in `miscWriteScheduler` and
 * `vaultStore.scheduleSidebarOrderWrite` respectively — they share the
 * corruption sentinel but not the snapshot/dedupe cache.
 *
 * Shared by `writeConfigs` (compares each against cached last-written
 * payload to skip unchanged files) and `seedConfigSnapshots` (primes the
 * cache from loaded-state so the first post-open save only writes files
 * the user actually changed).
 */
type BundledConfigTarget = 'config:save-workspace' | 'defaults.json' | 'app.json' | 'appearance.json';

function buildConfigPayloads(
  settings: ProjectSettings,
  theme: string,
  workspace: WorkspaceState,
  layout?: WorkspaceLayout,
): Record<BundledConfigTarget, string> {
  return {
    'config:save-workspace': JSON.stringify({
      openTabs: workspace.openTabs,
      activeTabId: workspace.activeTabId,
      paneTree: layout?.paneTree ?? null,
      activePaneId: layout?.activePaneId ?? null,
      sidebarWidth: layout?.sidebarWidth ?? 260,
    }, null, 2),
    'defaults.json': JSON.stringify({
      mindmap: settings.mindmap ?? {},
      kanban: settings.kanban ?? {},
      tasklist: settings.tasklist ?? {},
      document: settings.document ?? {},
    }, null, 2),
    'app.json': JSON.stringify({
      // DI-1 — spread the in-memory general slice first so passthrough/unknown
      // keys (and any schema-known key absent from the explicit list below,
      // e.g. `historyLimit`, plus the vault `name`) survive the round-trip
      // instead of being dropped on every save. The explicit fallbacks below
      // still pin defaults for the known keys.
      ...settings.general,
      globalFont: settings.general?.globalFont ?? '',
      globalFontSize: settings.general?.globalFontSize ?? 13,
      defaultBoardFontSize: settings.general?.defaultBoardFontSize ?? {},
      systemFonts: settings.general?.systemFonts ?? [],
      globalToolbarScale: settings.general?.globalToolbarScale ?? 1,
      boardToolbarScale: settings.general?.boardToolbarScale ?? 1,
      tabBarScale: settings.general?.tabBarScale ?? 1,
      minimapScale: settings.general?.minimapScale ?? 1,
      waypointScale: settings.general?.waypointScale ?? 1,
      toolbarColor: settings.general?.toolbarColor ?? '',
      tabBarColor: settings.general?.tabBarColor ?? '',
      radarEnabled: settings.general?.radarEnabled ?? true,
      recentColors: settings.general?.recentColors ?? [],
      activeRootFolder: settings.general?.activeRootFolder ?? '',
      sidebarSortField: settings.general?.sidebarSortField ?? 'none',
      sidebarSortDirection: settings.general?.sidebarSortDirection ?? 'asc',
      sidebarGroupField: settings.general?.sidebarGroupField ?? 'none',
      sidebarGroupDirection: settings.general?.sidebarGroupDirection ?? 'asc',
      showFileExtensions: settings.general?.showFileExtensions ?? false,
      hoverButtons: settings.general?.hoverButtons ?? {},
    }, null, 2),
    // Audit 3.3 — appearance.json is fully Filo-owned: activeTheme + font only.
    // saveConfig → atomicWriteFile is a whole-file (tmp+rename) replace, NOT a
    // read-modify-write merge, so it cannot preserve any other on-disk key. The
    // seed in configOps.initVaultConfig matches this exact shape, so disk shape
    // and code ownership agree. A hand-added `snippets` array is therefore NOT
    // preserved across a theme/font save — it is explicitly unmanaged, not
    // round-tripped. (Preserving unknown keys would require carrying the loaded
    // appearance object in memory and spreading it the way app.json spreads the
    // general slice — the audit's option (a), deliberately not taken here.)
    'appearance.json': JSON.stringify({
      activeTheme: theme ?? 'light',
      font: settings.general?.globalFont ?? '',
    }, null, 2),
  };
}

/**
 * Primes `lastWrittenConfigs` from the state just loaded from disk so the
 * first post-open save only writes the files the user actually changed.
 * Called by `vaultStore.openVault` after configs and workspace layout have
 * been hydrated.
 */
export function seedConfigSnapshots(
  settings: ProjectSettings,
  theme: string,
  workspace: WorkspaceState,
  layout?: WorkspaceLayout,
): void {
  const payloads = buildConfigPayloads(settings, theme, workspace, layout);
  for (const [target, payload] of Object.entries(payloads) as [BundledConfigTarget, string][]) {
    lastWrittenConfigs.set(target, payload);
  }
}

/**
 * Writes all `.filo/` config files (settings, workspace, appearance).
 *
 * Each file is compared against its last successfully written payload and
 * skipped if unchanged, so an isolated theme change touches only
 * `appearance.json` instead of all four.
 *
 * Each file write is independently try-caught so one failure doesn't halt
 * the chain. Returns the list of target identifiers that failed so callers
 * (notably the scheduler's `performWrite` → `flushAll` → `vaultStore.save()`)
 * can surface an honest failure status to the Ctrl+S toast.
 */
export async function writeConfigs(
  vaultRoot: string,
  settings: ProjectSettings,
  theme: string,
  workspace: WorkspaceState,
  layout?: WorkspaceLayout,
): Promise<{ failed: string[] }> {
  const payloads = buildConfigPayloads(settings, theme, workspace, layout);

  const failed: string[] = [];
  for (const [target, payload] of Object.entries(payloads) as [BundledConfigTarget, string][]) {
    if (lastWrittenConfigs.get(target) === payload) continue;
    if (corruptConfigTargets.has(target)) {
      // Loaded as corrupt — skip the write to preserve whatever the user
      // has on disk. Resolution happens externally (user fixes the file
      // and reopens the vault, or picks "Use defaults" which calls
      // clearCorruptConfigTarget and re-arms the write).
      continue;
    }
    // Phase R6 — pre-write drift check. Compare on-disk mtime against
    // the baseline captured at load time / after the last successful
    // self-write. A mismatch means a process other than Filo wrote to
    // the config file in the gap, so we abort the write to avoid
    // silently clobbering the external edit. The user can resolve by
    // reopening the vault (re-reads disk, re-bases) or by manually
    // re-applying their change in-app (which re-arms the write, this
    // time with the freshly-rebased baseline).
    const sentinelPath = target === 'config:save-workspace'
      ? '.filo/workspace.json'
      : `.filo/${target}`;
    const baseline = getBaseline(sentinelPath);
    if (baseline !== undefined) {
      let preWriteStat: { mtimeMs: number; size: number } | undefined;
      try {
        preWriteStat = await invokeOk('vault:stat', vaultRoot, sentinelPath);
      } catch {
        // Stat failed — fall through; the save IPC will surface the
        // failure if it matters (e.g. ENOENT after a manual delete).
      }
      if (preWriteStat !== undefined && hasBaselineDrifted(baseline, preWriteStat)) {
        const externalEditError = Object.assign(
          new Error(`Config "${sentinelPath}" was modified externally; write aborted.`),
          { code: 'EXTERNAL_EDIT' },
        );
        notifyWriteError({ kind: 'config', path: target, error: externalEditError });
        failed.push(target);
        continue;
      }
    }
    try {
      // Phase A.2a — mark suppression BEFORE the IPC; the OS watcher echo
      // can reach the renderer before the IPC promise resolves. Re-marked
      // on success to refresh the TTL.
      if (target === 'config:save-workspace') {
        markRecentSelfWrite('.filo/workspace.json');
        await invokeOk('config:save-workspace', vaultRoot, payload);
        markRecentSelfWrite('.filo/workspace.json');
      } else {
        markRecentSelfWrite(`.filo/${target}`);
        await invokeOk('config:save', vaultRoot, target, payload);
        markRecentSelfWrite(`.filo/${target}`);
      }
      lastWrittenConfigs.set(target, payload);
      // Phase R6 — refresh baseline so the next write compares against
      // the state we just wrote, not the pre-write one.
      try {
        const postStat = await invokeOk('vault:stat', vaultRoot, sentinelPath);
        noteBaseline(sentinelPath, postStat.mtimeMs, postStat.size);
      } catch {
        // Non-fatal — next load/write rebases.
      }
    } catch (err) {
      console.error(`[V7] Failed to save config file (${target}):`, err);
      notifyWriteError({ kind: 'config', path: target, error: err });
      failed.push(target);
    }
  }
  return { failed };
}

/**
 * Singleton schedule key — the config bundle is a single logical write
 * (up to four files coalesced), so we always schedule under the same key.
 * The primitive's per-key tracking still gives us pending/in-flight
 * bookkeeping with one timer at a time.
 */
const CONFIG_KEY = 'config-bundle';

/**
 * Sentinel path used for every scheduler-level beginWrite/endWrite call.
 * The bundle's per-target writes don't have an individual sentinel entry —
 * the whole bundle is tracked as one unit dirty-flagged by `.filo/`.
 */
const CONFIG_SENTINEL_PATH = '.filo/';

const configScheduler = createScheduler<ConfigWriteArgs>({
  name: 'configWriteScheduler',
  debounceMs: BOARD_WRITE_DEBOUNCE_MS,
  performWrite: async (args) => {
    return writeConfigs(args.vaultRoot, args.settings, args.theme, args.workspace, args.layout);
  },
  getSentinelInfo: (args) => ({ vaultRoot: args.vaultRoot, path: CONFIG_SENTINEL_PATH }),
  getFailureId: () => CONFIG_SENTINEL_PATH,
  missingSourceMessage: () =>
    "Filo couldn't save the latest configuration changes. Re-apply them and save again.",
});

/**
 * Schedules a debounced write of the `.filo/` config bundle.
 */
export function scheduleConfigWrite(
  getWriteArgs: () => ConfigWriteArgs | null,
): void {
  configScheduler.schedule(CONFIG_KEY, getWriteArgs);
}

/**
 * Cancels the pending config write timer without firing it. Called from
 * the vault-swap path so a timer armed against the previous vault can't
 * fire after a new vault opens.
 */
export function cancelPendingConfigWrite(): void {
  configScheduler.cancel(CONFIG_KEY);
}

/**
 * Flushes the pending config write immediately if one is queued. Returns
 * `{ vaultRoot, failed }` so `flushAll` / `vaultStore.save()` can both track
 * the vault for the defensive sentinel sync AND aggregate the failed config
 * targets into the honest Ctrl+S result.
 *
 * Phase R1 — returns the full `{ vaultRoot, failed }` envelope whether or
 * not the timer had already fired before flush. The legacy module returned
 * `null` once the timer fired, so a Ctrl+S landing in the in-flight gap
 * silently dropped the failure list; the primitive's awaited in-flight
 * tracker closes that gap.
 */
export async function flushScheduledConfig(
  _getWriteArgs: () => ConfigWriteArgs | null,
): Promise<{ vaultRoot: string | undefined; failed: string[] } | null> {
  const result = await configScheduler.flushAll();
  if (result.vaultRoot === undefined && result.failed.length === 0) {
    // Nothing pending and nothing in-flight — preserve the legacy "null
    // means truly nothing to do" sentinel so callers can short-circuit
    // the syncSentinelIfIdle and sentinel-touch paths.
    return null;
  }
  return { vaultRoot: result.vaultRoot, failed: result.failed };
}
