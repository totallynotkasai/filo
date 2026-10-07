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
 * save-state path as board and misc writes. The primitive's in-flight tracker
 * means failures surface through `failed[]` whether the IPC was pending or
 * completed.
 */

import type {
  ProjectSettings,
  WorkspaceState,
} from '../../schema/index';
import type { WorkspaceLayout } from '../../stores/workspace.svelte';
import { BOARD_WRITE_DEBOUNCE_MS, WRITE_TIMEOUT_MS, writtenByteLength } from './boardWriteDebounce';
import {
  notifyWriteError,
  registerResetCallback,
  registerTestResetCallback,
  markRecentSelfWrite,
} from './writeStateTracking';
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { createScheduler } from './writeScheduler';
import { isRetainableWriteError } from './writeSchedulerFailures';
import { refreshBaselineAfterWrite } from '../vault/fileBaselineRegistry';
import { backupConfig, checkConfigDisk, noticeConfig, reloadConfigFromDisk, type BundledConfigFile } from './configDrift';
import { isConfigDriftHeld, refuseHeldConfigWrite, registerConfigDriftTarget } from './configDriftHold';

export interface ConfigWriteArgs {
  vaultRoot: string;
  settings: ProjectSettings;
  theme: string;
  workspace: WorkspaceState;
  layout: WorkspaceLayout;
  /**
   * The vault's display name (`project.name`), saved as `app.json` `name`.
   * It lives on the project, not in `settings.general`, so it must be passed.
   */
  name?: string;
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
 *      before its disk write and, when true, skip the write and report it as
 *      failed (`CONFIG_CORRUPT`, not retried), never as saved.
 *
 * hotkeys.json, viewports.json, and sidebar-order.json are included so a
 * hand-edited corruption in any one of them isn't silently overwritten by the next debounced flush of in-memory defaults.
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
// allow-module-state: reset via resetConfigWriteScheduler called from boardSaver's pre-swap handler
const lastWrittenConfigs = new Map<ConfigTarget, string>();

/**
 * Config targets that loaded from disk in a corrupt state (ENOENT and
 * parse-error are distinguished in `configOps.loadConfig`). Writes to any
 * target in this set are suppressed: the in-memory store would otherwise
 * stamp its bootstrap-default shape on top of a user-edited file that's
 * just temporarily unparseable. Cleared per vault swap, and per target by
 * `clearCorruptConfigTarget` once the file reads again (the watcher's
 * `configFileReconciler`, or a view state write's own re-read).
 */
// allow-module-state: reset via resetConfigWriteScheduler called from boardSaver's pre-swap handler
const corruptConfigTargets = new Set<ConfigTarget>();

/**
 * Targets whose corrupt-suppression toast has already fired
 * this session. The suppression itself runs on EVERY debounce flush of a
 * changed-but-corrupt config, so without this the once-honest "we're not
 * saving this" notice would re-toast on each keystroke window. Cleared on
 * vault swap (with `corruptConfigTargets`) and when the user resolves a
 * target (`clearCorruptConfigTarget`) so a later re-corruption re-notifies.
 */
// allow-module-state: reset via resetConfigWriteScheduler called from boardSaver's pre-swap handler
const corruptSuppressToastShown = new Set<ConfigTarget>();

/**
 * Settings files that loaded with some fields reset to their defaults (see
 * `parseSettingsSlices`). The first write over one copies the file as it is
 * on disk to `.filo/recovery/` first, so the values Filo couldn't read are
 * never lost with it. Cleared per vault swap and once the copy is made.
 */
// allow-module-state: reset via resetConfigWriteScheduler called from boardSaver's pre-swap handler
const salvagedSettingsFiles = new Set<'app.json' | 'defaults.json'>();

export function markSalvagedSettingsFile(file: 'app.json' | 'defaults.json'): void {
  salvagedSettingsFiles.add(file);
}

/**
 * True for `config:load`'s `{ __loadFailed }` marker: the file could not be
 * read at all (lock, EPERM, inactive vault). Unlike `{}` it says nothing about
 * what is on disk.
 */
export function isConfigLoadFailed(loaded: unknown): boolean {
  return !!loaded && typeof loaded === 'object' && (loaded as { __loadFailed?: unknown }).__loadFailed === true;
}

export function markCorruptConfigTarget(target: ConfigTarget): void {
  corruptConfigTargets.add(target);
}

export function clearCorruptConfigTarget(target: ConfigTarget): void {
  corruptConfigTargets.delete(target);
  // Re-arm the honest toast for a future re-corruption of this target.
  corruptSuppressToastShown.delete(target);
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

/**
 * The args getter of the latest scheduled config write: the live settings,
 * layout and theme. Read for rescue copies of whatever isn't on disk yet.
 */
// allow-module-state: reset via resetConfigWriteScheduler called from boardSaver's pre-swap handler
let latestConfigArgs: (() => ConfigWriteArgs | null) | null = null;

// Self-register cleanup so vault swap and test reset don't leak between vaults.
registerResetCallback(() => {
  latestConfigArgs = null;
  lastWrittenConfigs.clear();
  corruptConfigTargets.clear();
  corruptSuppressToastShown.clear();
  salvagedSettingsFiles.clear();
  configScheduler.reset();
});
registerTestResetCallback(() => {
  latestConfigArgs = null;
  lastWrittenConfigs.clear();
  corruptConfigTargets.clear();
  corruptSuppressToastShown.clear();
  salvagedSettingsFiles.clear();
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
  name?: string,
): Record<BundledConfigTarget, string> {
  return {
    'config:save-workspace': JSON.stringify({
      openTabs: workspace.openTabs,
      activeTabId: workspace.activeTabId,
      paneTree: layout?.paneTree ?? null,
      activePaneId: layout?.activePaneId ?? null,
      boardToolbars: layout?.boardToolbars ?? {},
      // Like spell check, written only once a board hides a panel.
      ...(Object.keys(layout?.mindMapPanels ?? {}).length > 0 ? { mindMapPanels: layout?.mindMapPanels } : {}),
      // Written only when off, so a vault that never turned it off keeps its file as it was.
      ...(layout?.spellcheck === false ? { spellcheck: false } : {}),
      // Likewise only once notes are zoomed.
      ...(layout && layout.documentZoom !== 1 ? { documentZoom: layout.documentZoom } : {}),
    }, null, 2),
    'defaults.json': JSON.stringify({
      mindmap: settings.mindmap ?? {},
      kanban: settings.kanban ?? {},
      tasklist: settings.tasklist ?? {},
      document: settings.document ?? {},
    }, null, 2),
    'app.json': JSON.stringify({
      // Spread the in-memory general slice first so passthrough/unknown
      // keys (and any schema-known key absent from the explicit list below,
      // e.g. `historyLimit`) survive the round-trip instead of being dropped
      // on every save. The explicit fallbacks below still pin defaults for
      // the known keys.
      ...settings.general,
      // The vault name lives on the project; the spread above only carries
      // the name loaded at open, so a rename would otherwise never be saved.
      ...(name ? { name } : {}),
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
      vaultColor: settings.general?.vaultColor ?? '',
      boardFolders: settings.general?.boardFolders ?? false,
      hoverButtons: settings.general?.hoverButtons ?? {},
    }, null, 2),
    // appearance.json is fully Filo-owned: activeTheme + font only. The write is
    // a whole-file replace, so any other on-disk key (e.g. a hand-added
    // `snippets` array) is NOT preserved — it's explicitly unmanaged. The seed in
    // configOps.initVaultConfig matches this exact shape. (Preserving unknown
    // keys would need the loaded object spread in, as app.json does.)
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
  name?: string,
): void {
  const payloads = buildConfigPayloads(settings, theme, workspace, layout, name);
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
 *
 * `live` reads the settings in memory now. A Reload on the drift prompt
 * changes them mid-loop (`appearance.json` also carries the font, `app.json`
 * the vault name), so the files still to write are rebuilt from it.
 */
export async function writeConfigs(
  vaultRoot: string,
  settings: ProjectSettings,
  theme: string,
  workspace: WorkspaceState,
  layout?: WorkspaceLayout,
  name?: string,
  live?: () => ConfigWriteArgs | null,
): Promise<{ failed: string[]; error?: unknown }> {
  let payloads = buildConfigPayloads(settings, theme, workspace, layout, name);

  const failed: string[] = [];
  // The first failure a re-fire could fix, and whether any failure can't be
  // fixed that way; they decide whether the scheduler keeps the write.
  let retryError: unknown;
  let notRetryable = false;
  for (const target of Object.keys(payloads) as BundledConfigTarget[]) {
    const payload = payloads[target];
    if (lastWrittenConfigs.get(target) === payload) continue;
    if (corruptConfigTargets.has(target)) {
      // Loaded as corrupt — skip the write to preserve whatever the user
      // has on disk. Once the file reads again, the watcher clears the mark
      // (configFileReconciler.ts) and the next write checks it first.
      //
      // But DON'T resolve it as a clean no-op, or every change is silently
      // dropped while Ctrl+S flashes "Saved". Report it honestly:
      //   (a) push the target onto `failed` so `vaultStore.save()` returns
      //       false and the save indicator reads 'error';
      //   (b) surface a once-per-target toast naming the corrupt file. The
      //       `CONFIG_CORRUPT` code makes `buildWriteErrorToast` emit a
      //       corrupt-specific message instead of the generic disk copy.
      failed.push(target);
      notRetryable = true;
      if (!corruptSuppressToastShown.has(target)) {
        corruptSuppressToastShown.add(target);
        const corruptError = Object.assign(
          new Error(
            `Config "${target}" is corrupt on disk; changes are not being saved so the existing file isn't clobbered.`,
          ),
          { code: 'CONFIG_CORRUPT' },
        );
        notifyWriteError({ kind: 'config', path: target, error: corruptError });
      }
      continue;
    }
    // The file on disk may not be the one Filo last wrote or loaded: another
    // program changed or deleted it. `checkConfigDisk` decides (see
    // configDrift.ts); nothing here leaves a file blocked for the session.
    const file: BundledConfigFile = target === 'config:save-workspace' ? 'workspace.json' : target;
    const sentinelPath = `.filo/${file}`;
    // Waiting for a Reload / Keep local answer, or another version just found:
    // this file's write is refused at once (no prompt awaited) and kept for
    // the answer; the bundle's other files are still written.
    const verdict = isConfigDriftHeld(file)
      ? ({ kind: 'drifted' } as const)
      : await checkConfigDisk({ vaultRoot, file, payload, lastWritten: lastWrittenConfigs.get(target) });
    if (verdict.kind === 'drifted') {
      try {
        refuseHeldConfigWrite(file, vaultRoot, payload);
      } catch (held) {
        failed.push(target);
        retryError ??= held;
        lastWrittenConfigs.delete(target);
      }
      continue;
    }
    if (verdict.kind === 'adopted') {
      lastWrittenConfigs.set(target, verdict.json);
      const now = live?.();
      if (now) payloads = buildConfigPayloads(now.settings, now.theme, now.workspace, now.layout, now.name);
      continue;
    }
    if (verdict.kind === 'fail') {
      notifyWriteError({ kind: 'config', path: target, error: verdict.error });
      failed.push(target);
      if (isRetainableWriteError(verdict.error, true)) retryError ??= verdict.error;
      else notRetryable = true;
      // The disk no longer holds the cached payload, so a later change back
      // to it must be written rather than skipped as unchanged.
      lastWrittenConfigs.delete(target);
      continue;
    }
    const recreate = verdict.kind === 'recreate';
    if (!recreate && (target === 'app.json' || target === 'defaults.json') && salvagedSettingsFiles.has(target)) {
      // Some of this file's values couldn't be read at open; keep the file
      // as it is before this write replaces them with defaults.
      if (!(await backupConfig(vaultRoot, sentinelPath))) {
        const error = Object.assign(
          new Error(`Filo couldn't copy ${sentinelPath} to .filo/recovery/ before saving over it, so your change wasn't saved yet.`),
          { code: 'EBUSY' },
        );
        notifyWriteError({ kind: 'config', path: target, error });
        failed.push(target);
        retryError ??= error;
        lastWrittenConfigs.delete(target);
        continue;
      }
      salvagedSettingsFiles.delete(target);
    }
    try {
      // Mark suppression BEFORE the IPC; the OS watcher echo
      // can reach the renderer before the IPC promise resolves. Re-marked
      // on success to refresh the TTL.
      markRecentSelfWrite(sentinelPath);
      if (recreate) {
        await invokeOk('config:save', vaultRoot, file, payload, { createOnly: true });
      } else if (target === 'config:save-workspace') {
        await invokeOk('config:save-workspace', vaultRoot, payload);
      } else {
        await invokeOk('config:save', vaultRoot, target, payload);
      }
      markRecentSelfWrite(sentinelPath);
      lastWrittenConfigs.set(target, payload);
      if (recreate) noticeConfig(`config-recreated:${file}`, `${sentinelPath} was deleted outside Filo and has been recreated.`);
      // Refresh the baseline so the next write compares against the state we
      // just wrote. KEEP the prior baseline on an unusable stat; see
      // `refreshBaselineAfterWrite` for the trade-off.
      try {
        const postStat = await invokeOk('vault:stat', vaultRoot, sentinelPath);
        // Size verify plus content read-back: a same-byte-count foreign write in
        // the save→stat gap would otherwise be adopted as Filo's baseline and
        // clobbered promptless by the next write. Stamp only when disk
        // re-serialises to EXACTLY what we wrote; otherwise keep the prior
        // baseline so the next drift check looks again. Config files are small,
        // so the read is cheap (the board writer stays size-only — see
        // KNOWN_LIMITATIONS).
        let confirmed = false;
        if (postStat.size === writtenByteLength(payload)) {
          try {
            const loaded = await window.filo.invoke('config:load', vaultRoot, file);
            if (loaded && typeof loaded === 'object' && !('__corrupt' in loaded) && !isConfigLoadFailed(loaded)) {
              confirmed = JSON.stringify(loaded, null, 2) === payload;
            }
          } catch {
            /* transient IO — keep prior baseline (safe direction) */
          }
        }
        if (confirmed) {
          refreshBaselineAfterWrite(sentinelPath, postStat.mtimeMs, postStat.size);
        } else {
          refreshBaselineAfterWrite(sentinelPath, undefined, undefined);
        }
      } catch {
        refreshBaselineAfterWrite(sentinelPath, undefined, undefined);
      }
    } catch (err) {
      // A recreate that meets a copy put back meanwhile wrote nothing. The
      // baseline still names the deleted file, so the next save compares
      // against the copy that came back instead of overwriting it.
      const error = recreate && err instanceof IpcEnvelopeError && err.code === 'EEXIST'
        ? Object.assign(new Error(`${sentinelPath} came back while Filo was recreating it; your change wasn't saved over it.`), { code: 'EXTERNAL_EDIT' })
        : err;
      console.error(`[config] Failed to save config file (${target}):`, err);
      notifyWriteError({ kind: 'config', path: target, error });
      failed.push(target);
      if (isRetainableWriteError(error, true)) retryError ??= error;
      else notRetryable = true;
    }
  }
  // A re-fire can fix a failed save, but not a failure the user must decide
  // (a change made outside Filo, a corrupt file), which would only ask again.
  return { failed, error: notRetryable ? undefined : retryError };
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
    return writeConfigs(args.vaultRoot, args.settings, args.theme, args.workspace, args.layout, args.name, () => latestConfigArgs?.() ?? null);
  },
  getSentinelInfo: (args) => ({ vaultRoot: args.vaultRoot, path: CONFIG_SENTINEL_PATH }),
  getFailureId: () => CONFIG_SENTINEL_PATH,
  missingSourceMessage: () =>
    "Filo couldn't save the latest configuration changes. Re-apply them and save again.",
  // `writeConfigs` awaits `vault:stat` + `config:save`
  // IPCs with no interactive prompt, but a stalled network volume (OneDrive /
  // SMB) can still wedge those IPCs and hang `flushAll` / quit. Bound for
  // uniformity with the board scheduler and the note writer.
  writeTimeoutMs: WRITE_TIMEOUT_MS,
  // A settings file waiting for Reload / Keep local is refused at once, with
  // no stat and no prompt, so a re-fire (Retry, the quit drain) costs nothing
  // and still writes the bundle's other files; the answer re-fires it.
  retainIoError: true,
});

for (const file of ['app.json', 'defaults.json', 'appearance.json'] as const) {
  registerConfigDriftTarget(file, {
    ledgerPath: CONFIG_SENTINEL_PATH,
    reload: (disk, json) => {
      if (!reloadConfigFromDisk(file, disk)) return false;
      lastWrittenConfigs.set(file, json);
      return true;
    },
    // Keep local writes Filo's version; after a Reload the file reads as
    // written (unless memory normalised it), and the bundle's other files may
    // still be owed, so the held bundle is re-fired either way. The held write
    // may not be retained (a write that also met a failure no retry mends
    // keeps nothing), so the bundle is scheduled again from the latest
    // settings too; a retained one then fires at once in its place.
    resume: () => {
      rescheduleConfigWrite();
      void configScheduler.retryFailed(CONFIG_KEY);
    },
  });
}

/**
 * Schedules a debounced write of the `.filo/` config bundle.
 */
export function scheduleConfigWrite(
  getWriteArgs: () => ConfigWriteArgs | null,
): void {
  latestConfigArgs = getWriteArgs;
  configScheduler.schedule(CONFIG_KEY, getWriteArgs);
}

/**
 * Schedules the config bundle again from the latest settings, when a write
 * was ever scheduled: a file that reads again after a pause then gets the
 * change the pause held back (each file is written only if it differs).
 */
export function rescheduleConfigWrite(): void {
  if (latestConfigArgs) configScheduler.schedule(CONFIG_KEY, latestConfigArgs);
}

/**
 * Each bundled config file whose in-memory content isn't what Filo last wrote
 * (or loaded), with that content: what a rescue copy keeps when the vault is
 * left with settings unsaved.
 */
export function unsavedConfigPayloads(): Array<{ name: string; json: string }> {
  const args = latestConfigArgs?.();
  if (!args) return [];
  const payloads = buildConfigPayloads(args.settings, args.theme, args.workspace, args.layout, args.name);
  return (Object.entries(payloads) as [BundledConfigTarget, string][])
    .filter(([target, json]) => lastWrittenConfigs.get(target) !== json)
    .map(([target, json]) => ({ name: target === 'config:save-workspace' ? 'workspace.json' : target, json }));
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
 * Returns the full envelope whether or not the timer had already fired, so a
 * Ctrl+S landing while the IPC is in flight still sees its failures.
 */
export async function flushScheduledConfig(
  _getWriteArgs: () => ConfigWriteArgs | null,
): Promise<{ vaultRoot: string | undefined; failed: string[] } | null> {
  const result = await configScheduler.flushAll();
  if (result.vaultRoot === undefined && result.failed.length === 0) {
    // Nothing pending and nothing in-flight — "null means truly nothing to
    // do" so callers can short-circuit
    // the syncSentinelIfIdle and sentinel-touch paths.
    return null;
  }
  return { vaultRoot: result.vaultRoot, failed: result.failed };
}
