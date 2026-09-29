/**
 * Performance measurements against the built app (not run in CI).
 *
 *   npm run build
 *   node scripts/perf/genVault.mjs <vault> 5000
 *   node scripts/perf/measure.mjs <vault> [scenario ...] [--out result.json]
 *
 * Scenarios (default: all), each on a fresh launch with its own user-data dir:
 *   boards  vault open → sidebar; search latency; open time of each board
 *           (Kanban 300, Kanban 102, Task List 400, Mind Map 400); switching
 *           back to a Kanban tab; expanding the 2,000-note `Bulk/` folder
 *   fields  Task List 400 restored at open: when rows appear, and when their
 *           completion / priority / due date match the files
 *   typing  Task List 400 beside a note in a split pane: typing in the note,
 *           then the autosave. Frame gaps and long tasks while it runs
 *   typingtask  the same, typing in the note of one of the list's tasks
 *   profile     a CPU profile of opening Kanban 300 (PROFILE_ACTION=sidebar:
 *               expanding Bulk/; PROFILE_FOCUS=<function>: its samples only)
 *
 * A board "opens" when the renderer answers a probe and shows the board's
 * rows: a probe can't run while a long synchronous mount holds the main
 * thread, so this is the pause the user sees. The window is restored and
 * background throttling turned off first (a minimized test window looks
 * frozen). The folder picker is stubbed in main; nothing else is.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(PROJECT, 'package.json'));
const { _electron: electron } = require('@playwright/test');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outFile = outIdx >= 0 ? argv.splice(outIdx, 2)[1] : null;
const [vaultArg, ...scenarioArgs] = argv;
if (!vaultArg) {
  console.error('Usage: node scripts/perf/measure.mjs <vault> [boards|fields|typing ...] [--out file.json]');
  process.exit(1);
}
const VAULT = path.resolve(vaultArg);
if (!fs.existsSync(path.join(VAULT, '.filo', 'perf-vault'))) {
  console.error(`${VAULT} isn't a vault made by scripts/perf/genVault.mjs`);
  process.exit(1);
}
const SCENARIOS = scenarioArgs.length ? scenarioArgs : ['boards', 'fields', 'typing', 'typingtask'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => 'TIMEOUT')]);

const WORKSPACE = path.join(VAULT, '.filo', 'workspace.json');
function setWorkspace(ws) {
  if (ws === null) fs.rmSync(WORKSPACE, { force: true });
  else fs.writeFileSync(WORKSPACE, JSON.stringify({ sidebarWidth: 260, boardToolbars: {}, ...ws }, null, 2));
}
function clearRecoveryState() {
  // A killed run leaves the dirty sentinel, which would put a recovery prompt
  // in front of the next run.
  for (const f of fs.readdirSync(path.join(VAULT, '.filo'))) {
    if (f.startsWith('.dirty.')) fs.rmSync(path.join(VAULT, '.filo', f), { force: true });
  }
}

async function launch() {
  clearRecoveryState();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-perf-'));
  const app = await electron.launch({
    args: [path.join(PROJECT, 'dist/main/main.js'), `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, VAULT);
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.setBackgroundThrottling(false);
      if (w.isMinimized()) w.restore();
      w.showInactive();
    }
  });
  const errors = [];
  win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
  await win.waitForLoadState('domcontentloaded');
  await win.locator('button.action-card', { hasText: 'Open Vault' }).waitFor({ timeout: 30000 });
  return { app, win, errors, userData };
}

async function openVault(win) {
  const t0 = Date.now();
  await win.locator('button.action-card', { hasText: 'Open Vault' }).click();
  await win.locator('.file-row').first().waitFor({ timeout: 120000 });
  return Date.now() - t0;
}

async function quit(app, userData) {
  const closed = new Promise((r) => app.process().once('exit', r));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {});
  const res = await Promise.race([closed.then(() => 'exited'), sleep(30000).then(() => 'timeout')]);
  if (res === 'timeout') { try { app.process().kill(); } catch { /* already gone */ } }
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3 });
  return res;
}

/** Milliseconds until `probe` (run in the page) returns truthy; the page must answer to count. */
async function until(win, probe, arg, max = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < max) {
    const v = await withTimeout(win.evaluate(probe, arg), 3000);
    if (v !== 'TIMEOUT' && v) return Date.now() - t0;
    await sleep(20);
  }
  return `>${max}`;
}

const count = (sel) => document.querySelectorAll(sel).length;

/** Starts recording long tasks (over 50 ms) in the page. */
const watchLongTasks = (win) => win.evaluate(() => {
  window.__longTasks = [];
  try {
    window.__ltObs?.disconnect();
    window.__ltObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration)); });
    window.__ltObs.observe({ type: 'longtask', buffered: false });
  } catch { /* no long-task timing */ }
});
const longTasks = (win) => win.evaluate(() => { const t = window.__longTasks ?? []; return { count: t.length, max: Math.max(0, ...t), total: t.reduce((a, b) => a + b, 0) }; });

async function dblclickRow(win, fileName) {
  const row = win.locator(`.file-row[title$="${fileName}"]`).first();
  await row.scrollIntoViewIfNeeded();
  const b = await row.boundingBox();
  // On the name, not the centre: the centre can land on a tag chip.
  void win.mouse.dblclick(b.x + 45, b.y + b.height / 2).catch(() => {});
}

async function clickTab(win, name) {
  const b = await win.locator('.tab', { hasText: name }).first().boundingBox();
  void win.mouse.click(b.x + 20, b.y + b.height / 2).catch(() => {});
}

// ── Scenarios ──

async function boards() {
  setWorkspace(null);
  const { app, win, errors, userData } = await launch();
  const r = {};
  try {
    r.openToSidebarMs = await openVault(win);
    // Let the index settle so board numbers aren't mixed with it.
    await sleep(8000);

    await win.keyboard.press('Control+Shift+F');
    await win.locator('#search-find-input').waitFor({ timeout: 10000 });
    const t0 = Date.now();
    await win.locator('#search-find-input').fill('dragon castle');
    await until(win, () => /\d/.test(document.querySelector('.search-panel .result-count')?.textContent ?? ''));
    r.searchMs = Date.now() - t0;
    r.searchResultText = (await win.locator('.search-panel .result-count').textContent())?.trim();
    await win.keyboard.press('Escape');
    await sleep(500);

    const openBoard = async (file, sel, min) => {
      await dblclickRow(win, file);
      await sleep(50);
      return until(win, ([s, m]) => document.querySelectorAll(s).length >= m, [sel, min]);
    };
    await watchLongTasks(win);
    r.kanban300OpenMs = await openBoard('Kanban 300.board.json', '.kanban-card-shell', 1);
    await sleep(3000);
    // Editors mounted in the 3 s after open, and the long tasks meanwhile.
    r.kanban300After3s = {
      ...(await win.evaluate(() => ({ cards: document.querySelectorAll('.kanban-card-shell').length, editors: document.querySelectorAll('.ProseMirror').length }))),
      longTasks: await longTasks(win),
    };
    r.kanban102OpenMs = await openBoard('Kanban 102.board.json', '.kanban-card-shell', 1);
    await sleep(1500);
    r.taskListOpenMs = await openBoard('Task List 400.board.json', '.task-item-wrap', 1);
    await sleep(1500);
    r.mindMapOpenMs = await openBoard('Mind Map 400.board.json', '.tile-container', 1);
    await sleep(1500);
    await clickTab(win, 'Kanban 102');
    r.kanban102SwitchBackMs = await until(win, () => document.querySelectorAll('.kanban-card-shell').length > 0);
    await sleep(1500);
    await clickTab(win, 'Kanban 300');
    r.kanban300SwitchBackMs = await until(win, () => document.querySelectorAll('.kanban-card-shell').length > 0);
    await sleep(1500);
    await clickTab(win, 'Task List 400');
    r.taskListSwitchBackMs = await until(win, () => document.querySelectorAll('.task-item-wrap').length > 0);
    await sleep(1500);

    const bulk = win.locator('.file-row[title$="Bulk"]').first();
    await bulk.scrollIntoViewIfNeeded();
    const before = await win.evaluate(count, '.file-row');
    const bb = await bulk.boundingBox();
    await watchLongTasks(win);
    const tExpand = Date.now();
    void win.mouse.click(bb.x + 45, bb.y + bb.height / 2).catch(() => {});
    // First rows on screen, then all 2,000 rendered.
    r.sidebarExpandFirstRowsMs = await until(win, (n) => document.querySelectorAll('.file-row').length > n + 50, before);
    await until(win, (n) => document.querySelectorAll('.file-row').length >= n + 2000, before);
    r.sidebarExpandAllRowsMs = Date.now() - tExpand;
    r.sidebarExpandLongTasks = await longTasks(win);
    r.heapMB = await win.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576));
  } catch (e) {
    r.exception = String(e?.stack ?? e).slice(0, 600);
  } finally {
    r.quit = await quit(app, userData);
    r.errors = errors.slice(0, 5);
  }
  return r;
}

function expectedTaskFields() {
  const tl = JSON.parse(fs.readFileSync(path.join(VAULT, 'Task List 400.board.json'), 'utf8'));
  let completed = 0;
  let dated = 0;
  for (const t of tl.board.tasks) {
    const txt = fs.readFileSync(path.join(VAULT, tl.tileDefs[t.tileId].filePath), 'utf8');
    if (/completed: true/.test(txt)) completed++;
    if (/dueDate: /.test(txt)) dated++;
  }
  return { rows: tl.board.tasks.length, completed, dated };
}

async function fields() {
  setWorkspace({
    openTabs: [{ id: 'perftabtask1', boardId: 'perftasklist' }],
    activeTabId: 'perftabtask1',
    paneTree: { type: 'leaf', id: 'perfpane0001', tabId: 'perftabtask1' },
    activePaneId: 'perfpane0001',
  });
  const expected = expectedTaskFields();
  const { app, win, errors, userData } = await launch();
  const r = { expected };
  try {
    const t0 = Date.now();
    await win.locator('button.action-card', { hasText: 'Open Vault' }).click();
    const samples = [];
    while (Date.now() - t0 < 60000) {
      const s = await withTimeout(win.evaluate(() => ({
        rows: document.querySelectorAll('.task-item-wrap').length,
        completed: document.querySelectorAll('.task-checkbox[aria-checked="true"]').length,
        prio: document.querySelectorAll('.task-priority:not(.task-priority-empty)').length,
        dated: document.querySelectorAll('.task-due').length,
      })), 3000);
      const at = Date.now() - t0;
      if (s !== 'TIMEOUT') {
        samples.push({ at, ...s });
        if (s.rows > 0 && r.rowsAtMs === undefined) r.rowsAtMs = at;
        if (s.rows > 0 && s.completed === expected.completed && s.prio === expected.rows && s.dated === expected.dated) { r.fieldsReadyAtMs = at; break; }
      }
      await sleep(50);
    }
    if (r.rowsAtMs !== undefined && r.fieldsReadyAtMs !== undefined) r.fieldsLagMs = r.fieldsReadyAtMs - r.rowsAtMs;
    r.samples = samples.filter((_, i) => i % 5 === 0).slice(0, 40);
  } catch (e) {
    r.exception = String(e?.stack ?? e).slice(0, 600);
  } finally {
    r.quit = await quit(app, userData);
    r.errors = errors.slice(0, 5);
  }
  return r;
}

async function typing(which = 'other') {
  const notes = JSON.parse(fs.readFileSync(path.join(VAULT, '.filo', 'perf-notes.json'), 'utf8'));
  // 'task': the note of the Task List's first task; else a note on no board.
  const notePath = which === 'task' ? notes.tasks[400] : notes.other[0];
  setWorkspace({
    openTabs: [
      { id: 'perftabtask1', boardId: 'perftasklist' },
      { id: 'perftabnote1', boardId: 'perfnotetab1', notePath },
    ],
    activeTabId: 'perftabnote1',
    paneTree: {
      type: 'split', id: 'perfsplit001', orientation: 'horizontal', sizes: [0.5, 0.5],
      children: [
        { type: 'leaf', id: 'perfpane0001', tabId: 'perftabtask1' },
        { type: 'leaf', id: 'perfpane0002', tabId: 'perftabnote1' },
      ],
    },
    activePaneId: 'perfpane0002',
  });
  const { app, win, errors, userData } = await launch();
  const r = { notePath };
  try {
    await openVault(win);
    await win.locator('.task-item-wrap').first().waitFor({ timeout: 60000 });
    await sleep(10000); // index settled, rows filled
    r.rows = await win.evaluate(count, '.task-item-wrap');
    const editor = win.locator('.document-editor .ProseMirror, .doc-editor .ProseMirror').first();
    const target = (await editor.count()) ? editor : win.locator('.ProseMirror').last();
    await target.click();
    await win.keyboard.press('Control+End');
    await win.evaluate(() => {
      const w = window;
      w.__perf = { gaps: [], longTasks: [], running: true };
      let last = performance.now();
      const frame = (t) => { w.__perf.gaps.push(t - last); last = t; if (w.__perf.running) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__perf.longTasks.push(Math.round(e.duration)); })
          .observe({ type: 'longtask', buffered: false });
      } catch { /* no long-task timing */ }
    });
    const text = ' the quick brown fox jumps over the lazy dog again';
    for (const ch of text) { await win.keyboard.type(ch); await sleep(90); }
    await sleep(2500); // serialise (150 ms) + writer debounce (300 ms) + write + index refresh
    const perf = await win.evaluate(() => { window.__perf.running = false; return window.__perf; });
    const gaps = perf.gaps.slice(1).sort((a, b) => a - b);
    r.frames = gaps.length;
    r.frameGapP50 = Math.round(gaps[Math.floor(gaps.length * 0.5)] ?? 0);
    r.frameGapP95 = Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0);
    r.frameGapMax = Math.round(gaps[gaps.length - 1] ?? 0);
    r.framesOver16 = gaps.filter((g) => g > 17).length;
    r.framesOver50 = gaps.filter((g) => g > 50).length;
    r.longTasks = perf.longTasks;
    r.longTaskTotalMs = perf.longTasks.reduce((a, b) => a + b, 0);
    const disk = fs.readFileSync(path.join(VAULT, notePath), 'utf8');
    r.savedToDisk = disk.includes('lazy dog again');
  } catch (e) {
    r.exception = String(e?.stack ?? e).slice(0, 600);
  } finally {
    r.quit = await quit(app, userData);
    r.errors = errors.slice(0, 5);
  }
  return r;
}

/** CPU profile of the 5 s after opening Kanban 300 (or, with PROFILE_ACTION=sidebar, expanding `Bulk/`). */
async function profile() {
  setWorkspace(null);
  const { app, win, errors, userData } = await launch();
  const r = {};
  try {
    await openVault(win);
    await sleep(8000);
    const cdp = await win.context().newCDPSession(win);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
    // PROFILE_ACTION=sidebar profiles expanding the 2,000-note folder instead.
    if (process.env.PROFILE_ACTION === 'sidebar') {
      const bb = await win.locator('.file-row[title$="Bulk"]').first().boundingBox();
      void win.mouse.click(bb.x + 45, bb.y + bb.height / 2).catch(() => {});
    } else {
      await dblclickRow(win, 'Kanban 300.board.json');
    }
    await sleep(5000);
    const { profile: p } = await cdp.send('Profiler.stop');
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const label = (n) => `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber}`;
    const self = new Map();
    const total = new Map();
    // PROFILE_FOCUS=<function name>: count only samples with it on the stack.
    const focus = process.env.PROFILE_FOCUS;
    const onStack = (id) => {
      for (let cur = id; cur !== undefined; cur = parent.get(cur)) if (byId.get(cur).callFrame.functionName === focus) return true;
      return false;
    };
    p.samples.forEach((id, k) => {
      if (focus && !onStack(id)) return;
      const d = p.timeDeltas[k] ?? 0;
      const l0 = label(byId.get(id));
      self.set(l0, (self.get(l0) ?? 0) + d);
      const seen = new Set();
      for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
        const l = label(byId.get(cur));
        if (!seen.has(l)) { total.set(l, (total.get(l) ?? 0) + d); seen.add(l); }
      }
    });
    const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${Math.round(v / 1000)}ms ${k}`);
    r.topSelf = top(self, 25);
    r.topTotal = top(total, 60);
  } catch (e) {
    r.exception = String(e?.stack ?? e).slice(0, 600);
  } finally {
    r.quit = await quit(app, userData);
    r.errors = errors.slice(0, 5);
  }
  return r;
}

const RUN = { boards, fields, typing, typingtask: () => typing('task'), profile };
const results = { vault: VAULT, at: new Date().toISOString() };
for (const s of SCENARIOS) {
  if (!RUN[s]) { console.error(`unknown scenario ${s}`); process.exit(1); }
  results[s] = await RUN[s]();
  console.log(s, JSON.stringify(results[s]));
}
setWorkspace(null);
if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
