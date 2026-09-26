/**
 * The store side of `lib/boards/configDrift.ts`: the Reload / Keep local
 * prompt for a settings file changed outside Filo, taking that file's
 * settings into memory on Reload, and the one-time notices.
 */
import { uiStore } from './ui.svelte';
import { vaultStore } from './vault.svelte';
import { themeStore } from './theme.svelte';
import { vaultSwapResettable } from '../core/vaultLifecycle';
import { parseSettingsSlices, type VaultCandidateWarning } from '../lib/vault/vaultCandidate';
import type { BundledConfigFile, ConfigDriftChoice, ConfigExternalHandlers } from '../lib/boards/configDrift';
import type { Project } from '../schema/index';

/** One prompt per file at a time: a burst of saves shares its answer. */
const openPrompts = new Map<BundledConfigFile, Promise<ConfigDriftChoice>>();
/** Notice keys already shown this vault session. */
const shownNotices = new Set<string>();
vaultSwapResettable('configDriftPrompt', () => {
  openPrompts.clear();
  shownNotices.clear();
});

function promptConfigExternalEdit(file: BundledConfigFile): Promise<ConfigDriftChoice> {
  const existing = openPrompts.get(file);
  if (existing) return existing;
  const promise = new Promise<ConfigDriftChoice>((resolve) => {
    uiStore.pushToast({
      text:
        `.filo/${file} was changed outside Filo. Reload to use its settings, or keep Filo's settings ` +
        '(the other version is copied to .filo/recovery/ first).',
      type: 'warning',
      duration: 0,
      // Dismissed or timed out: nothing is written over the file, and the next
      // settings change asks again.
      onDismiss: () => resolve('defer'),
      actions: [
        { label: 'Reload', handler: () => resolve('reload') },
        {
          label: 'Keep local',
          // allow-keep-local-no-backup: resolves to checkConfigDisk, which backs up before the write
          handler: () => resolve('keep-local'),
        },
      ],
    });
  });
  openPrompts.set(file, promise);
  void promise.finally(() => {
    if (openPrompts.get(file) === promise) openPrompts.delete(file);
  });
  return promise;
}

/** The file's settings replace the ones in memory. Nothing is marked dirty: disk already holds them. */
function reloadConfigIntoMemory(file: BundledConfigFile, disk: Record<string, unknown>): boolean {
  const project = vaultStore.project;
  const vaultRoot = vaultStore.path;
  if (!project || !vaultRoot) return false;
  const current = project.settings;
  if (file === 'app.json' || file === 'defaults.json') {
    const warnings: VaultCandidateWarning[] = [];
    const parsed = parseSettingsSlices(
      file === 'app.json' ? disk : { ...current.general },
      file === 'defaults.json'
        ? disk
        : { mindmap: current.mindmap, kanban: current.kanban, tasklist: current.tasklist, document: current.document },
      warnings,
    );
    if (warnings.length > 0) return false;
    if (file === 'app.json') {
      project.settings.general = parsed.general;
    } else {
      project.settings.mindmap = parsed.mindmap;
      project.settings.kanban = parsed.kanban;
      project.settings.tasklist = parsed.tasklist;
      project.settings.document = parsed.document;
    }
    return true;
  }
  if (file === 'appearance.json') {
    const theme = typeof disk.activeTheme === 'string' && disk.activeTheme.trim() ? disk.activeTheme.trim() : 'light';
    if (typeof disk.font === 'string') project.settings.general.globalFont = disk.font;
    project.theme = theme as Project['theme'];
    void themeStore.applyById(vaultRoot, theme);
    return true;
  }
  return false;
}

function noticeOnce(key: string, text: string): void {
  if (shownNotices.has(key)) return;
  shownNotices.add(key);
  uiStore.pushToast({ text, type: 'info', duration: 8000 });
}

export const configExternalHandlers: ConfigExternalHandlers = {
  prompt: promptConfigExternalEdit,
  reload: reloadConfigIntoMemory,
  notice: noticeOnce,
};
