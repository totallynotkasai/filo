/**
 * Drives the BUILT app (`dist/main/main.js`), as the user runs it, or the
 * packaged one when `FILO_E2E_EXE` names its executable. Nothing here
 * imports renderer modules: the page is the packaged renderer, which can't
 * resolve `/src/…`, and a spec that reached into stores would test a path the
 * user never takes. Run `npm run build` first.
 *
 * Main-process stubs (test scaffolding, not app changes):
 *  - `dialog.showOpenDialog` answers with the vault the spec picked, so the
 *    Home screen's "Open Vault" opens it;
 *  - `dialog.showMessageBox` records every native box and answers with its
 *    cancel button.
 */
import { _electron as electron, expect } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(__dirname, '..', '..', '..', '..');
// FILO_E2E_MAIN runs the suite against another build (say, an older commit's
// worktree), to see a spec fail where the bug it pins is still present.
export const MAIN = process.env.FILO_E2E_MAIN ?? path.join(REPO, 'dist', 'main', 'main.js');
// FILO_E2E_EXE runs it against a packaged app instead (`win-unpacked/Filo.exe`
// from `npm run package:dir`): what an installed Filo loads, packaged CSP and
// asar included, with no node_modules beside it.
const EXE = process.env.FILO_E2E_EXE;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface NativeBox {
  title?: string;
  message?: string;
  detail?: string;
  buttons: string[];
}

export interface LaunchedApp {
  app: ElectronApplication;
  win: Page;
  userDataDir: string;
  /** Console errors and uncaught page errors, in order. */
  errors: string[];
}

export interface LaunchOptions {
  /** Reuse a user-data dir (keeps the machine id, so crash sentinels count as this machine's). */
  userDataDir?: string;
  /** Copy `machine-id.json` from this user-data dir into a fresh one. */
  sameMachineAs?: string;
  /** Click "Open Vault" and wait for the workspace (default true). */
  open?: boolean;
  /**
   * Keep Chromium's background throttling, as a user's window has it. Off by
   * default, since a test window left in the background looks frozen; a spec
   * about a minimized window needs it on.
   */
  throttled?: boolean;
}

/** A temp folder for one spec; removed by `removeTemp`. */
export function makeTemp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `filo-e2e-${label}-`));
}

export function removeTemp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** An empty vault folder (with `.filo/`) under `root`, holding `files` (vault-relative path → text or bytes). */
export function freshVault(root: string, name: string, files: Record<string, string | Buffer> = {}): string {
  const vault = path.join(root, name);
  fs.rmSync(vault, { recursive: true, force: true });
  fs.mkdirSync(path.join(vault, '.filo'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vault, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return vault;
}

/**
 * Starts the built app on a fresh `--user-data-dir` (so no recent vault
 * auto-opens), stubs the native dialogs, restores the window and turns off
 * background throttling (a minimized or hidden test window looks frozen), and
 * by default opens `vault` from the Home screen.
 */
export async function launchBuilt(vault: string, opts: LaunchOptions = {}): Promise<LaunchedApp> {
  const target = EXE ?? MAIN;
  if (!fs.existsSync(target)) throw new Error(`${target} is missing: run \`npm run ${EXE ? 'package:dir' : 'build'}\` first`);
  const userDataDir = opts.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'filo-e2e-udd-'));
  if (opts.sameMachineAs) {
    fs.copyFileSync(path.join(opts.sameMachineAs, 'machine-id.json'), path.join(userDataDir, 'machine-id.json'));
  }
  const userData = `--user-data-dir=${userDataDir}`;
  const app = await electron.launch({
    ...(EXE ? { executablePath: EXE, args: [userData] } : { args: [MAIN, userData] }),
    env: { ...process.env, NODE_ENV: 'test' },
  });
  await app.evaluate(({ dialog }, picked) => {
    const g = globalThis as unknown as { __boxes: NativeBox[]; __picked: string };
    g.__boxes = [];
    g.__picked = picked;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [g.__picked] })) as typeof dialog.showOpenDialog;
    dialog.showMessageBox = (async (a: unknown, b?: unknown) => {
      const o = (b ?? a) as { title?: string; message?: string; detail?: string; buttons?: string[]; cancelId?: number };
      const buttons = o.buttons ?? ['OK'];
      g.__boxes.push({ title: o.title, message: o.message, detail: o.detail, buttons });
      return { response: o.cancelId ?? buttons.length - 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, vault);
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await bringToFront(app, { throttled: opts.throttled });
  await win.waitForLoadState('domcontentloaded');
  if (opts.open !== false) await openVaultFromHome(win);
  return { app, win, userDataDir, errors };
}

/** Restores, shows and (unless `throttled`) un-throttles every window: a throttled background one runs few timers or frames. */
export async function bringToFront(app: ElectronApplication, { throttled = false }: { throttled?: boolean } = {}): Promise<void> {
  await app.evaluate(({ BrowserWindow }, keep) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!keep) w.webContents.setBackgroundThrottling(false);
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    }
  }, throttled);
}

export async function openVaultFromHome(win: Page): Promise<void> {
  const openBtn = win.locator('button.action-card', { hasText: 'Open Vault' });
  await expect(openBtn).toBeVisible({ timeout: 30_000 });
  await openBtn.click();
  await expect(openBtn).toBeHidden({ timeout: 60_000 });
}

/** A launch's machine id (created in its user-data dir on first launch). */
export function machineIdOf(userDataDir: string): string {
  const { id } = JSON.parse(fs.readFileSync(path.join(userDataDir, 'machine-id.json'), 'utf8')) as { id: string };
  return id;
}

export type QuitResult =
  | { outcome: 'exited'; ms: number }
  | { outcome: 'timeout'; ms: number; boxes: NativeBox[] | null; dialogs: string[] | null };

/**
 * Closes the window the way the title-bar X does, so the renderer's quit flow
 * (save, then ask if anything is left) runs, and waits for the process to exit.
 * On a timeout it records what was on screen and kills the app.
 */
export async function quitLikeUser(launched: LaunchedApp, waitMs = 30_000): Promise<QuitResult> {
  const { app, win } = launched;
  const t0 = Date.now();
  const closed = new Promise<void>((r) => app.process().once('exit', () => r()));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined);
  const res = await Promise.race([closed.then(() => 'exited' as const), sleep(waitMs).then(() => 'timeout' as const)]);
  if (res === 'exited') return { outcome: 'exited', ms: Date.now() - t0 };
  const boxes = await nativeBoxes(app).catch(() => null);
  const dialogs = await win
    .evaluate(() =>
      [...document.querySelectorAll('.confirm-dialog, [role="dialog"], [role="alertdialog"]')].map((d) =>
        (d.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
    )
    .catch(() => null);
  killApp(app);
  return { outcome: 'timeout', ms: Date.now() - t0, boxes, dialogs };
}

/** Presses the window's close button without waiting: for a spec that answers the quit dialog itself. */
export async function requestClose(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
}

/** Kills the app and its renderer / GPU children (on Windows a plain kill leaves them running). */
export function killApp(app: ElectronApplication): void {
  const pid = app.process().pid;
  try {
    if (process.platform === 'win32' && pid !== undefined) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      app.process().kill('SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

/**
 * Runs `use`, which puts something on the machine's real clipboard, and puts
 * back what the clipboard held before, whatever `use` does.
 */
export async function withClipboardKept(app: ElectronApplication, use: () => Promise<void>): Promise<void> {
  await app.evaluate(async ({ clipboard }) => {
    (globalThis as unknown as { __clip: unknown }).__clip = await clipboard.read();
  });
  try {
    await use();
  } finally {
    await app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const saved = (globalThis as unknown as { __clip: Parameters<typeof clipboard.write>[0] }).__clip;
      // An item read can't be written back as it is: each is rebuilt from its parts.
      const items = await Promise.all(saved.map(async (item) => {
        const parts: Record<string, Blob> = {};
        for (const type of item.types) {
          const part = await item.getType(type);
          if (part instanceof Blob) parts[type] = part;
        }
        return new ClipboardItem(parts);
      }));
      if (items.length > 0) await clipboard.write(items);
      else clipboard.clear();
    });
  }
}

export const nativeBoxes = (app: ElectronApplication): Promise<NativeBox[]> =>
  app.evaluate(() => (globalThis as unknown as { __boxes: NativeBox[] }).__boxes);

/** The folder the next "Open Vault" (Home, the vault menu, Ctrl+O) picks. */
export const setPickedVault = (app: ElectronApplication, vault: string): Promise<void> =>
  app.evaluate((_e, v) => {
    (globalThis as unknown as { __picked: string }).__picked = v;
  }, vault);

/** The text of every toast on screen. */
export const toasts = (win: Page): Promise<string[]> =>
  win.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) =>
      ((t.querySelector('.toast-text') ?? t).textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  );

/** A sidebar row by its file name (the row's `title` is the full path). */
export const sidebarRow = (win: Page, fileName: string): Locator =>
  win.locator(`.file-row[title$="${fileName}"]`).first();

/**
 * Opens a note in a Document tab from the sidebar and returns its editor.
 * Double-clicks the row's NAME: the row's centre can land on a tag chip,
 * which filters the tree instead. `title` is the note's title (its tab's
 * name) when frontmatter gives it one other than the file name.
 */
export async function openNoteByName(win: Page, stem: string, title = stem): Promise<Locator> {
  const row = sidebarRow(win, `${stem}.md`);
  await row.scrollIntoViewIfNeeded();
  await row.locator('.file-name').dblclick();
  // The note's own tab first: until it is active, the editor on screen may
  // still be the previous note's.
  await expect(win.locator('.tab[aria-selected="true"] .tab-name').first()).toHaveText(title, { timeout: 30_000 });
  const editor = win.locator('.document-board .ProseMirror:visible').first();
  await editor.waitFor({ timeout: 30_000 });
  return editor;
}

/** Opens a board (`<name>.board.json`) from the sidebar. */
export async function openBoardByName(win: Page, name: string): Promise<void> {
  const row = sidebarRow(win, `${name}.board.json`);
  await row.scrollIntoViewIfNeeded();
  await row.locator('.file-name').dblclick();
}

/** Makes a new board of the given type from the tab bar's "+" menu. */
export async function newBoard(win: Page, label: 'Mind Map' | 'Kanban' | 'Task List'): Promise<void> {
  await win.locator('button.new-tab-btn').click();
  await win.locator('.new-tab-menu button.new-tab-option', { hasText: label }).click();
}

// ── Files ──────────────────────────────────────────────────────────────────

/** Every file under `root` (recursive), as vault-relative posix paths, filtered by `pred`. */
export function listFiles(root: string, pred: (rel: string) => boolean = () => true): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (pred(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** SHA-1 of every file outside `.filo/`: what "no bytes written by looking" compares. */
export function hashVault(root: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const rel of listFiles(root, (r) => !r.startsWith('.filo/'))) {
    m.set(rel, crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex'));
  }
  return m;
}

/** Paths whose hash differs, plus paths added or removed. */
export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const [k, v] of after) if (before.get(k) !== v) out.add(k);
  for (const k of before.keys()) if (!after.has(k)) out.add(k);
  return [...out].sort();
}

// ── Generated vault ────────────────────────────────────────────────────────

export interface GeneratedVault {
  notes: string[];
  boards: { mindmap: string; kanban: string; tasklist: string };
}

/**
 * Writes `count` notes in the shapes Filo must never rewrite by looking:
 * about 10% CRLF, 3% with a BOM, 5% with a user comment and `zip: 02134`
 * (a string a careless YAML dump turns into the number 2134), some without
 * frontmatter, task fields, tables, code, checklists. Plus one small board
 * of each type (v8) on the first notes. Deterministic.
 */
export function generateVault(vault: string, count: number): GeneratedVault {
  let seed = 7;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima dragon castle river'.split(' ');
  const sentence = (n: number): string => Array.from({ length: n }, () => pick(words)).join(' ');
  const bodies = [
    (): string => `# ${sentence(3)}\n\n${sentence(30)}\n\n- ${sentence(4)}\n- ${sentence(3)}\n  - ${sentence(2)}\n`,
    (): string => `${sentence(12)} **${sentence(2)}** and *${sentence(2)}* with \`code\`.\n\n> ${sentence(8)}\n\n1. ${sentence(3)}\n2. ${sentence(3)}\n`,
    (): string => `| Name | Value |\n| --- | --- |\n| ${pick(words)} | ${pick(words)} |\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n\n- [ ] ${sentence(3)}\n- [x] ${sentence(3)}\n`,
  ];
  const folders = ['Notes', 'Notes/Deep', 'Tasks', 'Inbox'];
  for (const f of folders) fs.mkdirSync(path.join(vault, f), { recursive: true });
  const notes: string[] = [];
  for (let i = 0; i < count; i++) {
    const folder = i % 4 === 0 ? 'Tasks' : pick(folders);
    const rel = `${folder}/Note ${String(i).padStart(4, '0')}.md`;
    let text: string;
    if (rnd() < 0.05) {
      text = `${sentence(20)}\n`;
    } else {
      const fm = [`title: ${sentence(2)} ${i}`, `tags: [${pick(['plot', 'idea', 'todo'])}, ${pick(['world/magic', 'draft'])}]`];
      if (folder === 'Tasks') fm.push(`completed: ${rnd() < 0.3}`, `dueDate: 2026-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`, `priority: ${pick(['low', 'high'])}`);
      if (rnd() < 0.05) fm.push('# a comment the user wrote', 'zip: 02134');
      text = `---\n${fm.join('\n')}\n---\n\n${pick(bodies)()}`;
    }
    if (rnd() < 0.1) text = text.replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(vault, rel), (rnd() < 0.03 ? String.fromCharCode(0xfeff) : '') + text, 'utf8');
    notes.push(rel);
  }

  const now = 1790000000000;
  let n = 0;
  const id = (p: string): string => `${p}${String(n++).padStart(10, '0')}`;
  const textDef = (filePath: string): Record<string, unknown> => ({ id: id('g'), type: 'text', filePath, style: { headerColor: '', bodyColor: '' }, createdAt: now, updatedAt: now });
  const head = (bid: string, name: string, type: string, settings: Record<string, unknown>): Record<string, unknown> => ({
    id: bid, name, emoji: '', createdAt: now, updatedAt: now, type,
    settings: { backgroundColor: '', defaultFolder: '', ...settings, defaults: {} },
  });
  const save = (name: string, board: Record<string, unknown>, tileDefs: Record<string, Record<string, unknown>>): string => {
    const file = `${name}.board.json`;
    fs.writeFileSync(path.join(vault, file), JSON.stringify({ version: 8, board, tileDefs, connections: {}, frames: [] }, null, 2));
    return file;
  };
  const taskNotes = notes.filter((p) => p.startsWith('Tasks/'));
  const other = notes.filter((p) => !p.startsWith('Tasks/'));

  const kbDefs: Record<string, Record<string, unknown>> = {};
  const columns = ['To do', 'Doing', 'Done'].map((title, ci) => {
    const tilePlacements = Array.from({ length: 10 }, (_, i) => {
      const d = textDef(taskNotes[(ci * 10 + i) % taskNotes.length]);
      kbDefs[d.id as string] = d;
      return { tileId: d.id, position: i };
    });
    return { id: `gencol${ci}xxxxx`, title, position: ci, collapsed: false, tilePlacements };
  });
  const kanban = save('Gen Kanban', { ...head('genkanban001', 'Gen Kanban', 'kanban', { accentColor: '', lastView: { sortBy: 'manual', filterTags: [], filterProp: null } }), columns }, kbDefs);

  const tlDefs: Record<string, Record<string, unknown>> = {};
  const tasks = Array.from({ length: 40 }, (_, i) => {
    const d = textDef(taskNotes[(30 + i) % taskNotes.length]);
    tlDefs[d.id as string] = d;
    return { tileId: d.id, position: i };
  });
  const tasklist = save('Gen Task List', {
    ...head('gentasklist1', 'Gen Task List', 'tasklist', {
      accentColor: '', groupBy: 'status', sortBy: 'manual',
      lastView: { filterTags: [], filterStatus: null, filterPriority: null, showCompleted: true, smartList: 'all' },
    }),
    tasks, sections: [{ id: 'sec_genxxxxxx', title: 'Section 1', position: 0, collapsed: false }], collapsedSubtasks: [],
  }, tlDefs);

  const mmDefs: Record<string, Record<string, unknown>> = {};
  const placements: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) {
    const d = textDef(other[i % other.length]);
    mmDefs[d.id as string] = d;
    placements[d.id as string] = { x: (i % 8) * 280, y: Math.floor(i / 8) * 200, width: 240, height: 160, locked: false, faded: false, frameless: false };
  }
  const mindmap = save('Gen Mind Map', {
    ...head('genmindmap01', 'Gen Mind Map', 'mindmap', { semanticZoom: true, snapToGrid: false, connectionsVisible: true, labelsVisible: true }),
    placements, inlineTiles: {}, connections: [], frames: [], waypoints: [], groups: [], viewport: { x: 0, y: 0, scale: 1 },
  }, mmDefs);

  return { notes, boards: { mindmap, kanban, tasklist } };
}
