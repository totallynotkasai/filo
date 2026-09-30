import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, launchBuilt, makeTemp, quitLikeUser, removeTemp, sleep, sidebarRow } from './helpers/app';
import type { LaunchedApp } from './helpers/app';

/**
 * The performance budgets on a 5,000-note vault (`scripts/perf/genVault.mjs`:
 * Kanban 300, Task List 400, a 2,000-note folder). Slow, so it runs only when
 * FILO_E2E_SCALE is set (a local run, on request). FILO_E2E_BUDGET_FACTOR
 * scales every budget for a slower machine (a hosted CI runner needs about 4).
 *
 * A board "opens" when the page answers a probe and shows the board's rows: a
 * probe can't run while a long synchronous mount holds the main thread, so
 * this is the pause the user sees.
 */

const FACTOR = Number(process.env.FILO_E2E_BUDGET_FACTOR ?? '1') || 1;
const budget = (ms: number): number => ms * FACTOR;

test.skip(!process.env.FILO_E2E_SCALE, 'scale budgets are slow (set FILO_E2E_SCALE=1 to run them)');
// Not serial: each budget is measured on its own launch, so one over budget
// must not hide the others.

let root: string;
let vault: string;

test.beforeAll(() => {
  test.setTimeout(300_000);
  root = makeTemp('scale');
  vault = path.join(root, 'BigVault');
  const gen = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'perf', 'genVault.mjs'), vault, '5000'], { encoding: 'utf8' });
  if (gen.status !== 0) throw new Error(`genVault failed: ${gen.stderr}`);
});

test.afterAll(() => removeTemp(root));

function setWorkspace(ws: Record<string, unknown> | null): void {
  const file = path.join(vault, '.filo', 'workspace.json');
  if (ws === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, JSON.stringify({ boardToolbars: {}, ...ws }, null, 2));
}

/** Milliseconds until `probe` (run in the page) returns truthy; the page must answer to count. */
async function until(win: Page, probe: (arg: number) => boolean, arg = 0, max = 60_000): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < max) {
    const v = await Promise.race([win.evaluate(probe, arg), sleep(3000).then(() => 'timeout' as const)]);
    if (v !== 'timeout' && v) return Date.now() - t0;
    await sleep(20);
  }
  return Number.POSITIVE_INFINITY;
}

async function dblclickName(win: Page, fileName: string): Promise<void> {
  const row = sidebarRow(win, fileName);
  await row.scrollIntoViewIfNeeded();
  const b = await row.boundingBox();
  if (!b) throw new Error(`no row for ${fileName}`);
  // Not awaited: the measurement starts at the click, not when the page answers.
  void win.mouse.dblclick(b.x + 45, b.y + b.height / 2).catch(() => undefined);
}

async function clickTab(win: Page, name: string): Promise<void> {
  const b = await win.locator('.tab', { hasText: name }).first().boundingBox();
  if (!b) throw new Error(`no tab ${name}`);
  void win.mouse.click(b.x + 20, b.y + b.height / 2).catch(() => undefined);
}

const cardsShown = (): boolean => document.querySelectorAll('.kanban-card-shell').length > 0;

test('Kanban 300 opens in under 1 s and its tab comes back in under 0.5 s', async () => {
  setWorkspace(null);
  const launched: LaunchedApp = await launchBuilt(vault);
  const { win } = launched;
  try {
    await win.locator('.file-row').first().waitFor({ timeout: 120_000 });
    await sleep(8000); // the index settles, so the board numbers aren't mixed with it
    await dblclickName(win, 'Kanban 300.board.json');
    const openMs = await until(win, cardsShown);
    await sleep(2000);
    await dblclickName(win, 'Task List 400.board.json');
    await until(win, () => document.querySelectorAll('.task-item-wrap').length > 0);
    await sleep(1500);
    await clickTab(win, 'Kanban 300');
    const backMs = await until(win, cardsShown);
    test.info().annotations.push({ type: 'measure', description: `Kanban 300 open ${openMs} ms, switch back ${backMs} ms` });
    expect.soft(openMs, 'Kanban 300 open').toBeLessThan(budget(1000));
    expect.soft(backMs, 'Kanban 300 switch back').toBeLessThan(budget(500));
  } finally {
    await quitLikeUser(launched);
  }
});

test('Task List fields are right within 1 s of its rows appearing at vault open', async () => {
  setWorkspace({
    openTabs: [{ id: 'perftabtask1', boardId: 'perftasklist' }],
    activeTabId: 'perftabtask1',
    paneTree: { type: 'leaf', id: 'perfpane0001', tabId: 'perftabtask1' },
    activePaneId: 'perfpane0001',
  });
  const tl = JSON.parse(fs.readFileSync(path.join(vault, 'Task List 400.board.json'), 'utf8')) as {
    board: { tasks: Array<{ tileId: string }> };
    tileDefs: Record<string, { filePath: string }>;
  };
  let completed = 0;
  let dated = 0;
  for (const t of tl.board.tasks) {
    const text = fs.readFileSync(path.join(vault, tl.tileDefs[t.tileId].filePath), 'utf8');
    if (/completed: true/.test(text)) completed++;
    if (/dueDate: /.test(text)) dated++;
  }
  const rows = tl.board.tasks.length;

  const launched = await launchBuilt(vault, { open: false });
  const { win } = launched;
  try {
    const t0 = Date.now();
    await win.locator('button.action-card', { hasText: 'Open Vault' }).click();
    let rowsAt: number | undefined;
    let readyAt: number | undefined;
    while (Date.now() - t0 < 60_000 && readyAt === undefined) {
      const s = await win.evaluate(() => ({
        rows: document.querySelectorAll('.task-item-wrap').length,
        completed: document.querySelectorAll('.task-checkbox[aria-checked="true"]').length,
        prio: document.querySelectorAll('.task-priority:not(.task-priority-empty)').length,
        dated: document.querySelectorAll('.task-due').length,
      }));
      const at = Date.now() - t0;
      if (s.rows > 0 && rowsAt === undefined) rowsAt = at;
      if (s.rows > 0 && s.completed === completed && s.prio === rows && s.dated === dated) readyAt = at;
      await sleep(50);
    }
    expect(rowsAt, 'Task List rows never appeared').toBeDefined();
    expect(readyAt, 'Task List fields never matched the files').toBeDefined();
    const lag = (readyAt as number) - (rowsAt as number);
    test.info().annotations.push({ type: 'measure', description: `rows at ${rowsAt} ms, fields right ${lag} ms later` });
    expect(lag).toBeLessThan(budget(1000));
  } finally {
    await quitLikeUser(launched);
    setWorkspace(null);
  }
});

test('expanding a 2,000-note folder shows its first rows in under 300 ms', async () => {
  setWorkspace(null);
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await win.locator('.file-row').first().waitFor({ timeout: 120_000 });
    await sleep(5000);
    const before = await win.evaluate(() => document.querySelectorAll('.file-row').length);
    const bulk = sidebarRow(win, 'Bulk');
    await bulk.scrollIntoViewIfNeeded();
    const b = await bulk.boundingBox();
    if (!b) throw new Error('no Bulk folder row');
    void win.mouse.click(b.x + 45, b.y + b.height / 2).catch(() => undefined);
    const firstMs = await until(win, (n: number) => document.querySelectorAll('.file-row').length > n + 50, before);
    const allMs = (await until(win, (n: number) => document.querySelectorAll('.file-row').length >= n + 2000, before)) + firstMs;
    test.info().annotations.push({ type: 'measure', description: `first rows ${firstMs} ms; all 2,000 in ${allMs} ms` });
    expect(firstMs).toBeLessThan(budget(300));
    expect(allMs).toBeLessThan(budget(5000));
  } finally {
    await quitLikeUser(launched);
  }
});
