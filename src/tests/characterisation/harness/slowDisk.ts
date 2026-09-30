/**
 * A disk that is slow or refuses, for the moments around a rename: Filo's own
 * call to main is held until the spec lets it go (as a Windows lock retry or a
 * slow volume holds it), or answered with the refusal a lock that outlasted
 * the retry gives. And the actions that start a rename without waiting for it,
 * so the spec can look at the disk while it is out.
 */
import type { CharApp } from './app';
import { settle, waitFor } from './app';
import { $, chooseMenuItem, click, contextMenu, dblclick, key, revealInSidebar, typeInto } from './actions';
import { mainHandlers, type MainHandler } from './electronFake';

export interface HeldCall {
  /** Resolves once Filo has made the call. */
  reached: Promise<void>;
  /** Lets the call run as it would have. */
  release(): void;
  /** Answers it as Windows does when a file inside the folder stays open elsewhere (EPERM after the retry). */
  refuseAsLocked(): void;
}

/** Held calls not yet answered, let go by {@link releaseHeldCalls}. */
const outstanding = new Set<() => void>();

/** Lets every held call run and restores the handlers (a spec's cleanup, so one failed case can't hold up the next). */
export function releaseHeldCalls(): void {
  for (const release of [...outstanding]) release();
  outstanding.clear();
}

/**
 * Holds Filo's next `channel` call whose arguments `matches` accepts (paths
 * are absolute), until released or refused. Later calls run as usual.
 */
export function holdNextMainCall(channel: string, matches: (args: unknown[]) => boolean = () => true): HeldCall {
  const original = mainHandlers.get(channel);
  if (!original) throw new Error(`no main handler for ${channel}`);
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  let decide!: (answer: 'run' | 'refuse') => void;
  const decision = new Promise<'run' | 'refuse'>((resolve) => { decide = resolve; });
  let taken = false;
  const held: MainHandler = async (event, ...args) => {
    if (taken || !matches(args)) return original(event, ...args);
    taken = true;
    reach();
    const answer = await decision;
    mainHandlers.set(channel, original);
    if (answer === 'refuse') return { success: false, code: 'EACCES', error: "EPERM: operation not permitted, rename" };
    return original(event, ...args);
  };
  mainHandlers.set(channel, held);
  const release = (): void => {
    outstanding.delete(release);
    if (mainHandlers.get(channel) === held) mainHandlers.set(channel, original);
    decide('run');
  };
  outstanding.add(release);
  return {
    reached,
    release,
    refuseAsLocked: () => {
      outstanding.delete(release);
      decide('refuse');
    },
  };
}

/** A path argument naming `rel` (a vault path, absolute here) exactly. */
export function namesPath(app: CharApp, rel: string): (args: unknown[]) => boolean {
  const target = app.abs(rel).replace(/\\/g, '/').toLowerCase();
  return (args) => String(args[1] ?? '').replace(/\\/g, '/').toLowerCase() === target;
}

/** Sidebar: right-click → Rename → type `newName` → Enter, without waiting for the rename to finish. */
export async function startSidebarRename(app: CharApp, rel: string, newName: string): Promise<void> {
  contextMenu(await revealInSidebar(app, rel));
  await settle();
  await chooseMenuItem(app, 'Rename');
  await waitFor(() => app.el.querySelector('input.rename-input') !== null, 'rename input');
  const input = $(app.el, 'input.rename-input') as HTMLInputElement;
  typeInto(input, newName);
  key(input, 'Enter');
  await settle();
}

/** Double-click the active tab, type `name`, press Enter (a board's rename), without waiting for it to finish. */
export async function startActiveBoardRename(app: CharApp, name: string): Promise<void> {
  dblclick($(app.el, '.tab.active, .tab[aria-selected="true"]'));
  await waitFor(() => app.el.querySelector('input.tab-rename') !== null, 'tab rename input');
  const input = $(app.el, 'input.tab-rename') as HTMLInputElement;
  typeInto(input, name);
  key(input, 'Enter');
  await settle();
}

/** Kanban "Add Column", without waiting for its save (which a held rename would hold up). */
export async function addKanbanColumnNow(app: CharApp): Promise<void> {
  const n = app.el.querySelectorAll('.kanban-column').length;
  click($(app.el, 'button.add-column-btn'));
  await waitFor(() => app.el.querySelectorAll('.kanban-column').length === n + 1, 'new column');
}

/**
 * The watcher's queue is busy for `ms` (another program's changes, or the
 * aftermath of a big rename, being worked through). Resolves once it is busy;
 * `free` resolves when it is free again.
 *
 * Adapter knowledge: that queue is `vaultStore.enqueueRenameQueueWork`.
 */
export async function keepWatcherQueueBusy(ms: number): Promise<{ free: Promise<void> }> {
  const { vaultStore } = await import('@renderer/stores/vault.svelte');
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const done = vaultStore.enqueueRenameQueueWork(async () => {
    started();
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await running;
  return { free: done.then(() => undefined, () => undefined) };
}
