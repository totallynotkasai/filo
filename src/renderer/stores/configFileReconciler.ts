/**
 * configFileReconciler — the watcher's `config` events: a `.filo/` settings
 * or view state file changed outside Filo.
 *
 *  - `viewports.json` / `sidebar-order.json` / `hotkeys.json`, with no change
 *    of Filo's waiting to be saved: the file is read again and taken into
 *    memory (view state merges; see miscConfigDrift.ts). With a change
 *    waiting, its write does the same check before it writes.
 *  - A file Filo stopped saving because it was unreadable, that now reads:
 *    it is saved again. The settings files are then checked before their next
 *    write (a change Filo made meanwhile asks Reload / Keep local).
 */
import type { ExternalChangeEvent } from '../lib/vault/externalChangeRegistry';
import { isPathPending, isRecentSelfWrite } from '../lib/boards/boardSaver';
import {
  clearCorruptConfigTarget,
  isConfigLoadFailed,
  isConfigPathCorrupt,
  isConfigTargetCorrupt,
  rescheduleConfigWrite,
} from '../lib/boards/configWriteScheduler';
import { noticeConfig } from '../lib/boards/configDrift';
import { readOutsideVersion, type MiscConfigFile } from '../lib/boards/miscConfigDrift';
import { mergeViewportsFromDisk } from '../lib/boards/viewportCache';
import { markBaselineUnverified } from '../lib/vault/fileBaselineRegistry';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { reportError } from '../lib/utils/errorBus';
import { toPosix } from '../lib/utils/path';
import { applyHotkeysFromDisk, hotkeysUnreadFor, saveHotkeyOverrides } from '../core/hotkeys';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';
import { mergeSidebarOrderFromDisk } from './sidebarOrder.svelte';

// allow-module-state: immutable lookup table
const MISC_FILES: ReadonlySet<string> = new Set<MiscConfigFile>(['viewports.json', 'sidebar-order.json', 'hotkeys.json']);
// allow-module-state: immutable lookup table
const SETTINGS_FILES: ReadonlySet<string> = new Set(['app.json', 'defaults.json', 'appearance.json', 'workspace.json']);

export async function reconcileConfigFileChange(event: ExternalChangeEvent): Promise<void> {
  const rel = toPosix(event.filename).replace(/^\/+/, '');
  const match = /^\.filo\/([^/]+)$/i.exec(rel);
  const file = match?.[1]?.toLowerCase() ?? '';
  if (!MISC_FILES.has(file) && !SETTINGS_FILES.has(file)) return;
  if (isRecentSelfWrite(rel)) return;
  const captured = captureVaultIdentity();
  const vaultRoot = getActiveVaultPath();
  if (!vaultRoot) return;
  try {
    if (SETTINGS_FILES.has(file)) {
      await unpauseSettingsFile(vaultRoot, file, captured);
      return;
    }
    const misc = file as MiscConfigFile;
    const wasPaused = isConfigPathCorrupt(rel);
    if (misc === 'hotkeys.json' && hotkeysUnreadFor(vaultRoot)) return;
    if (isPathPending(rel)) {
      // A shortcut change Filo couldn't save while the file was unreadable:
      // save it now, which asks Reload / Keep local if the file differs.
      if (misc === 'hotkeys.json' && wasPaused) {
        clearCorruptConfigTarget('hotkeys.json');
        markBaselineUnverified(rel);
        saveHotkeyOverrides(vaultRoot);
      }
      return;
    }
    const outside = await readOutsideVersion(vaultRoot, misc, { always: true }).catch(() => null);
    if (!outside || outside.kind !== 'changed' || !isStillSameVault(captured) || isPathPending(rel)) return;
    if (misc === 'viewports.json') mergeViewportsFromDisk(outside.disk);
    else if (misc === 'sidebar-order.json') mergeSidebarOrderFromDisk(outside.disk);
    else applyHotkeysFromDisk(outside.disk);
    outside.adopt();
    if (wasPaused) noticeConfig(`config-readable:${file}`, `${rel} reads again, and Filo saves it again.`);
  } catch (err) {
    reportError('externalChange.config', err, `Couldn't re-read ${rel} after it changed outside Filo.`);
  }
}

/**
 * A settings file Filo stopped saving (unreadable at open) that now reads is
 * saved again, after a check: it is marked unverified, so the next write
 * reads it first and asks Reload / Keep local if it differs from Filo's.
 */
async function unpauseSettingsFile(
  vaultRoot: string,
  file: string,
  captured: ReturnType<typeof captureVaultIdentity>,
): Promise<void> {
  const rel = `.filo/${file}`;
  const target = file === 'workspace.json' ? 'config:save-workspace' : (file as 'app.json' | 'defaults.json' | 'appearance.json');
  if (!isConfigTargetCorrupt(target)) return;
  const loaded: unknown = await window.filo.invoke('config:load', vaultRoot, file);
  if (!isStillSameVault(captured)) return;
  if (!loaded || typeof loaded !== 'object' || isConfigLoadFailed(loaded) || '__corrupt' in loaded) return;
  clearCorruptConfigTarget(target);
  markBaselineUnverified(rel);
  noticeConfig(`config-readable:${file}`, `${rel} reads again. Filo checks it before it next saves your settings.`);
  // A settings change the pause held back is saved now (after that check).
  rescheduleConfigWrite();
}
