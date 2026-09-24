import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;
let tempVault: string;

test.beforeAll(async () => {
  tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-kanban-e2e-'));

  electronApp = await electron.launch({
    args: [path.join(__dirname, '..', '..', '..', 'dist', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FILO_VAULT_PATH: tempVault,
    },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
  try { fs.rmSync(tempVault, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * E2E coverage for Kanban Board flows. Like the Task List E2E, this drives
 * the renderer via the store APIs the UI uses and asserts on the rendered
 * DOM. The double-click regression specifically guards the wiring from
 * KanbanCard.handleDoubleClick → KanbanColumn.onOpenAsDocument →
 * kanbanFrontmatterWriter.openTileAsDocument → tabStore.open(documentId).
 */

async function bootstrapKanbanBoardWithCard(): Promise<{
  boardId: string;
  tileId: string;
  filename: string;
}> {
  fs.writeFileSync(path.join(tempVault, 'KanbanCard E2E.md'), '---\n---\n', 'utf8');
  return await window.evaluate(async (vaultPath: string) => {
    const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
    const { boardStore } = await import('/src/renderer/stores/board.svelte.ts');
    const { boardCacheStore } = await import('/src/renderer/stores/boardCache.svelte.ts');
    const { tabStore } = await import('/src/renderer/stores/tabs.svelte.ts');
    if (!vaultStore.project) {
      await vaultStore.openVault(vaultPath);
    }
    const board = await boardStore.createBoard('Kanban E2E', 'kanban', {});
    if (!board) throw new Error('createBoard failed');
    tabStore.open(board.id, board.name, board.type, board.emoji ?? '');

    // Seed a column + a text-tile placement.
    boardCacheStore.addKanbanColumn(board.id, { id: 'col_e2e', title: 'Todo' });
    const filename = 'KanbanCard E2E.md';
    // The card's note is identified by its path; the file itself is seeded
    // on disk before this block runs.
    const def = {
      id: 'tile_kb_e2e',
      type: 'text',
      title: 'KanbanCard E2E',
      filePath: filename,
    };
    boardCacheStore.persistAddKanbanPlacement(board.id, 'col_e2e', def as never, 0);
    return { boardId: board.id, tileId: def.id, filename };
  }, tempVault);
}

test.describe('Filo E2E — Kanban Board', () => {
  test('double-clicking a text card opens its backing document in a new tab', async () => {
    const { tileId } = await bootstrapKanbanBoardWithCard();

    // The card should render inside the Kanban column.
    const card = window.locator(`[data-tile-id="${tileId}"] .kanban-card-shell`);
    await expect(card).toBeVisible({ timeout: 5000 });

    // Snapshot the tab count BEFORE the double-click so the assertion is
    // robust against the Kanban tab already existing.
    const beforeTabCount = await window.evaluate(async () => {
      const { tabStore } = await import('/src/renderer/stores/tabs.svelte.ts');
      return tabStore.tabs.length;
    });

    // The handler short-circuits on editable / button targets, so target a
    // safe area: the outer kanban-card-shell beneath the body — guaranteed
    // to be neither contenteditable nor a <button>.
    await card.dblclick({ position: { x: 4, y: 4 } });

    // A new document tab should now exist.
    await expect.poll(async () =>
      window.evaluate(async () => {
        const { tabStore } = await import('/src/renderer/stores/tabs.svelte.ts');
        return tabStore.tabs.length;
      }),
    { timeout: 3000 }).toBeGreaterThan(beforeTabCount);

    // And at least one tab should be of boardType 'document' (pointing at
    // the seeded .md file via documentStore.openDocumentTab).
    const hasDocumentTab = await window.evaluate(async () => {
      const { tabStore } = await import('/src/renderer/stores/tabs.svelte.ts');
      return tabStore.tabs.some((t) => t.boardType === 'document');
    });
    expect(hasDocumentTab).toBe(true);
  });
});
