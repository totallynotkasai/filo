/**
 * The running app for the characterisation suite: the real `App.svelte`,
 * mounted once per test file, opening a fresh real temp vault per test.
 *
 * Everything a spec asserts goes through here or `actions.ts`, never through
 * store internals, so the specs survive the file-model refactor. When an
 * internal API moves, update the adapter, not the spec.
 */
import { mount, flushSync, tick } from 'svelte';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mainBridge, type MainBridge } from './mainBridge';
import { mainListeners, messageBoxes, rendererSink, type MessageBoxCall } from './electronFake';

export interface CharApp {
  /** Absolute vault root. */
  root: string;
  bridge: MainBridge;
  /** The mounted app's root element. */
  el: HTMLElement;
  abs(rel: string): string;
  read(rel: string): string;
  exists(rel: string): boolean;
  /** Vault-relative paths of every file outside `.filo/`, `/`-separated. */
  userFiles(): string[];
  /** Bytes of every user file (outside `.filo/`), for "nothing was written" checks. */
  snapshot(): Map<string, string>;
  /** An edit made by another program: plain bytes on disk, seen through the real watcher. */
  writeExternally(rel: string, text: string): void;
  /** A rename made by another program (Explorer, a sync client): a plain rename, seen through the real watcher. */
  renameExternally(from: string, to: string): void;
  /** A delete made by another program: the file is gone, seen through the real watcher. */
  deleteExternally(rel: string): void;
}

let appEl: HTMLElement | null = null;
let current: CharApp | null = null;

/** Flush Svelte, microtasks and short timers. */
export async function settle(ms = 30): Promise<void> {
  const rounds = 6;
  for (let i = 0; i < rounds; i++) {
    flushSync();
    await tick();
    await new Promise((r) => setTimeout(r, ms / rounds));
  }
}

/** Poll until `pred` holds (or throw with `what`). Timers run between polls. */
export async function waitFor(pred: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = pred();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await settle(40);
  }
}

/**
 * Let every debounced write run and land: the markdown and board debounces are
 * 300 ms, the viewport one 1.5 s, and a write is only done when main answers.
 */
export async function quiesce(ms = 2000): Promise<void> {
  await settle(ms);
  const b = mainBridge();
  await waitFor(() => b.inFlight() === 0, 'in-flight IPC to finish');
  await settle(60);
}

// An atomic write's temp sibling (`<name>.<hex>.tmp`) exists only while the write runs.
const ATOMIC_TMP = /\.[0-9a-f]{8,}\.tmp$/;

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (ATOMIC_TMP.test(name)) continue;
    const p = join(dir, name);
    const rel = relative(root, p).split(sep).join('/');
    if (rel === '.filo' || rel.startsWith('.filo/')) continue;
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue; // gone between the listing and the stat
    }
    if (isDir) walk(root, p, out);
    else out.push(rel);
  }
}

/**
 * Start the app on a vault seeded with `files` (vault-relative → text or
 * bytes), written the way another program would: plain bytes before the app
 * sees them. The vault is a new temp dir unless `opts.root` names an empty or
 * missing directory to build it in.
 */
export async function startApp(
  files: Record<string, string | Uint8Array> = {},
  opts: { root?: string } = {},
): Promise<CharApp> {
  const bridge = mainBridge();
  bridge.attach();
  let root: string;
  if (opts.root) {
    if (existsSync(opts.root) && readdirSync(opts.root).length > 0) throw new Error(`${opts.root} is not empty`);
    mkdirSync(opts.root, { recursive: true });
    root = opts.root;
  } else {
    root = mkdtempSync(join(tmpdir(), 'filo-char-vault-'));
  }
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  const { vaultStore } = await import('@renderer/stores/vault.svelte');
  if (!appEl) {
    // Boards are lazy chunks. Load them before the clock starts: the first
    // transform can take many seconds when the whole test run shares the CPU.
    const { boardRegistry } = await import('@renderer/core/boardRegistry');
    await Promise.all(Object.values(boardRegistry).map((entry) => entry.component?.()));
    const { default: App } = await import('@renderer/App.svelte');
    appEl = document.createElement('div');
    document.body.appendChild(appEl);
    mount(App, { target: appEl });
    await settle();
  }
  const ok = await vaultStore.openVault(root);
  if (!ok) throw new Error(`openVault(${root}) failed`);
  await quiesce(400);
  bridge.resetLog();

  const abs = (rel: string): string => join(root, ...rel.split('/'));
  const app: CharApp = {
    root,
    bridge,
    el: appEl,
    abs,
    read: (rel) => readFileSync(abs(rel), 'utf-8'),
    exists: (rel) => existsSync(abs(rel)),
    userFiles: () => {
      const out: string[] = [];
      walk(root, root, out);
      return out.sort();
    },
    snapshot: () => {
      const m = new Map<string, string>();
      for (const rel of app.userFiles()) m.set(rel, readFileSync(abs(rel), 'latin1'));
      return m;
    },
    writeExternally: (rel, text) => {
      const p = abs(rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    },
    renameExternally: (from, to) => {
      mkdirSync(dirname(abs(to)), { recursive: true });
      renameSync(abs(from), abs(to));
    },
    deleteExternally: (rel) => {
      rmSync(abs(rel), { recursive: true, force: true });
    },
  };
  current = app;
  return app;
}

/**
 * Runs `during` while an open note is reading the version of `rel` that
 * `start()` wrote, as a slow disk would let a user keep typing then: every
 * read of `rel` is held until the one it is meant for.
 *
 * Adapter knowledge: a change to a note is read twice, first by the search
 * index, then (once that is done) by the open note. `during` runs inside the
 * second. Keys typed earlier reach the note before its read starts, which is
 * a different case.
 */
export async function whileReading(
  app: CharApp,
  rel: string,
  start: () => void,
  during: () => Promise<void>,
): Promise<void> {
  const NOTE_READ = 2;
  const hold = app.bridge.holdReads(rel);
  try {
    start();
    for (let n = 1; n <= NOTE_READ; n++) {
      await waitFor(() => hold.count() >= n, `read ${n} of ${rel}`);
      if (n === NOTE_READ) await during();
      hold.releaseNewest();
    }
  } finally {
    hold.release();
  }
  await settle();
}

/**
 * Quit and relaunch on the same vault: close it (saving, as a normal quit
 * does), then open it again. The log is cleared, so what follows is only what
 * the next session does.
 */
export async function reopenVault(app: CharApp): Promise<void> {
  app.bridge.attach();
  const { vaultStore } = await import('@renderer/stores/vault.svelte');
  await quiesce(100);
  if (!(await vaultStore.closeVault())) throw new Error('closeVault refused');
  await settle(100);
  if (!(await vaultStore.openVault(app.root))) throw new Error('reopen failed');
  await quiesce(600);
  app.bridge.resetLog();
}

/**
 * Quit the way a user does, straight after their last keystroke: close the
 * vault, saving. Resolves with how long the close took (ms). The app stays
 * mounted; `stopApp` then only removes the vault.
 */
export async function quitApp(app: CharApp): Promise<number> {
  app.bridge.attach();
  const { vaultStore } = await import('@renderer/stores/vault.svelte');
  const started = Date.now();
  if (!(await vaultStore.closeVault())) throw new Error('closeVault refused');
  return Date.now() - started;
}

/**
 * Quit from the window (its close button, Alt+F4): main asks the renderer to
 * save, and nothing is unmounted. Resolves with the renderer's answer:
 * `ready` (main may quit now) or `awaiting-user` (a "Save failed" confirm is
 * up; answer it with `answerConfirm`, then await `quitDone`).
 */
export async function quitFromWindow(app: CharApp): Promise<{ answer: 'ready' | 'awaiting-user'; quitDone: Promise<'ready' | 'cancel'> }> {
  app.bridge.attach();
  const listen = (channel: string, fn: () => void): void => {
    const list = mainListeners.get(channel) ?? [];
    const once = (): void => {
      mainListeners.set(channel, (mainListeners.get(channel) ?? []).filter((l) => l !== once));
      fn();
    };
    list.push(once);
    mainListeners.set(channel, list);
  };
  let settleDone!: (v: 'ready' | 'cancel') => void;
  const quitDone = new Promise<'ready' | 'cancel'>((r) => { settleDone = r; });
  const answer = await new Promise<'ready' | 'awaiting-user'>((resolve) => {
    listen('app:ready-to-quit', () => {
      resolve('ready');
      settleDone('ready');
    });
    listen('app:quit-awaiting-user', () => {
      resolve('awaiting-user');
      listen('app:cancel-quit', () => settleDone('cancel'));
    });
    rendererSink.send('app:flush-and-quit');
  });
  return { answer, quitDone };
}

/** What happened when the user closed the vault or opened another one. */
export interface LeaveVaultResult {
  /** False when the app stayed on the vault (the user cancelled). */
  done: boolean;
  /** Every message box shown on the way, in order. */
  dialogs: MessageBoxCall[];
}

async function leaveVault(answers: string[], go: () => Promise<boolean>): Promise<LeaveVaultResult> {
  mainBridge().attach();
  messageBoxes.shown.length = 0;
  messageBoxes.answers.splice(0, messageBoxes.answers.length, ...answers);
  try {
    const done = await go();
    await settle(100);
    return { done, dialogs: [...messageBoxes.shown] };
  } finally {
    messageBoxes.answers.length = 0;
  }
}

/**
 * File → Close Vault, straight away (no waiting for debounces). A dialog, if
 * one appears, is answered with the button labelled `answer` (its first button
 * when none is given).
 */
export async function closeVault(_app: CharApp, answer?: string): Promise<LeaveVaultResult> {
  const { vaultStore } = await import('@renderer/stores/vault.svelte');
  return leaveVault(answer ? [answer] : [], () => vaultStore.closeVault());
}

/** File → Open Vault on a second, new vault seeded with `files`, straight away. */
export async function openOtherVault(
  app: CharApp,
  files: Record<string, string> = {},
  answer?: string,
): Promise<LeaveVaultResult & { other: string }> {
  const other = mkdtempSync(join(tmpdir(), 'filo-char-vault-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(other, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  const { vaultStore } = await import('@renderer/stores/vault.svelte');
  extraRoots.push(other);
  const result = await leaveVault(answer ? [answer] : [], () => vaultStore.openVault(other));
  return { ...result, other };
}

/** Second vaults a test opened, removed by `stopApp` with the first. */
const extraRoots: string[] = [];

/** Every file under `.filo/recovery/` (vault-relative path → text). */
export function recoveryCopies(app: CharApp): Map<string, string> {
  const out = new Map<string, string>();
  const base = join(app.root, '.filo', 'recovery');
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) visit(p);
      else out.set(relative(app.root, p).split(sep).join('/'), readFileSync(p, 'utf-8'));
    }
  };
  visit(base);
  return out;
}

/** Close the vault (saving, as a user quitting normally would) and delete it, unless `keep`. */
export async function stopApp(opts: { keep?: boolean } = {}): Promise<void> {
  const app = current;
  current = null;
  if (!app) return;
  mainBridge().attach();
  const { vaultStore } = await import('@renderer/stores/vault.svelte');
  await quiesce(100);
  await vaultStore.closeVault();
  await settle(100);
  if (opts.keep) return;
  for (const root of [app.root, ...extraRoots.splice(0)]) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A watcher handle can hold the dir briefly on Windows; the OS temp sweep gets it.
    }
  }
}
