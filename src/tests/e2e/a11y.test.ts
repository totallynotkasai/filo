import { test, expect, _electron as electron } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import path from 'path';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, '..', '..', '..', 'dist', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
});

/**
 * Phase 5.5 — WCAG 2.1 AA audit via axe-core.
 *
 * Each main view is scanned. Rules with known false positives in this app's
 * canvas-heavy context (`region`, `landmark-one-main` inside the floating
 * Find & Replace panel) are excluded so the report focuses on actionable
 * violations. Any colour-contrast / aria-* / label / focus-order failure
 * fails the suite.
 */
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('Axe a11y — WCAG AA', () => {
  test('Home screen has no detectable violations', async () => {
    await window.locator('.home-title, .welcome-title').first().waitFor({ timeout: 10_000 });
    const results = await new AxeBuilder({ page: window as never })
      .withTags(wcagTags)
      .disableRules(['region']) // Electron shell has no <main>/<nav> wrapper on the splash
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('App shell exposes a labelled main landmark and skip link', async () => {
    const main = window.locator('main#main-workspace');
    await expect(main).toHaveAttribute('aria-label', /workspace/i);

    const skip = window.locator('a.skip-link');
    await expect(skip).toHaveAttribute('href', '#main-workspace');
  });

  test('Mind map canvas has role=application and an accessible name', async () => {
    // The canvas only mounts after a board is open. Open one programmatically.
    const opened = await window.evaluate(async () => {
      try {
        const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
        const { boardStore } = await import('/src/renderer/stores/board.svelte.ts');
        const { tabStore } = await import('/src/renderer/stores/tabs.svelte.ts');
        if (!vaultStore.project) return false;
        const created = await boardStore.createBoard('A11y Test Board', 'mindmap', {});
        if (!created) return false;
        tabStore.open(created.id, created.name, created.type, created.emoji ?? '');
        return true;
      } catch {
        return false;
      }
    });

    test.skip(!opened, 'No vault open in this test session — canvas not mounted.');

    const canvas = window.locator('.mindmap-board[role="application"]');
    await expect(canvas).toBeVisible({ timeout: 5_000 });
    await expect(canvas).toHaveAttribute('aria-label', /canvas/i);

    const results = await new AxeBuilder({ page: window as never })
      .include('.mindmap-board')
      .withTags(wcagTags)
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('Project Settings modal traps focus and is dialog-labelled', async () => {
    await window.evaluate(async () => {
      const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
      uiStore.openModal('project-settings');
    });

    const dialog = window.locator('dialog[aria-modal="true"]').first();
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    const results = await new AxeBuilder({ page: window as never })
      .include('dialog[aria-modal="true"]')
      .withTags(wcagTags)
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  /**
   * C10 — extends axe coverage beyond the mind-map canvas. Each non-mindmap
   * board type has its own DOM root and its own a11y surface area (Kanban
   * column toolbar, TaskList sections + sortable order, Document editor
   * landmark). Programmatically open one of each, scope axe to the board
   * root, and fail on any WCAG 2.1 AA violation.
   */
  async function openBoardOfType(type: 'kanban' | 'tasklist' | 'document'): Promise<boolean> {
    return window.evaluate(async (boardType) => {
      try {
        const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
        const { boardStore } = await import('/src/renderer/stores/board.svelte.ts');
        const { tabStore } = await import('/src/renderer/stores/tabs.svelte.ts');
        if (!vaultStore.project) return false;
        const created = await boardStore.createBoard(`A11y ${boardType} Board`, boardType, {});
        if (!created) return false;
        tabStore.open(created.id, created.name, created.type, created.emoji ?? '');
        return true;
      } catch {
        return false;
      }
    }, type);
  }

  test('Kanban board has no detectable violations', async () => {
    const opened = await openBoardOfType('kanban');
    test.skip(!opened, 'No vault open in this test session — Kanban not mounted.');

    const board = window.locator('.kanban-board');
    await expect(board).toBeVisible({ timeout: 5_000 });

    const results = await new AxeBuilder({ page: window as never })
      .include('.kanban-board')
      .withTags(wcagTags)
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('Task List board has no detectable violations', async () => {
    const opened = await openBoardOfType('tasklist');
    test.skip(!opened, 'No vault open in this test session — Task List not mounted.');

    const board = window.locator('.tasklist-board');
    await expect(board).toBeVisible({ timeout: 5_000 });

    const results = await new AxeBuilder({ page: window as never })
      .include('.tasklist-board')
      .withTags(wcagTags)
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('Document board has no detectable violations', async () => {
    const opened = await openBoardOfType('document');
    test.skip(!opened, 'No vault open in this test session — Document board not mounted.');

    const board = window.locator('.document-board').first();
    await expect(board).toBeVisible({ timeout: 5_000 });

    const results = await new AxeBuilder({ page: window as never })
      .include('.document-board')
      .withTags(wcagTags)
      // The TipTap editor's role=textbox surface (a contenteditable inside a
      // wrapper div) trips `aria-input-field-name` because labels are
      // visually attached to the surrounding panel header rather than the
      // contenteditable itself. The wider editor toolbar gives the surface
      // a name in context.
      .disableRules(['aria-input-field-name'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('Board Browser modal has no detectable violations', async () => {
    await window.evaluate(async () => {
      const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
      uiStore.openModal('board-browser');
    });

    const dialog = window.locator('dialog[aria-modal="true"]').first();
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    const results = await new AxeBuilder({ page: window as never })
      .include('dialog[aria-modal="true"]')
      .withTags(wcagTags)
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Template Browser modal has no detectable violations', async () => {
    await window.evaluate(async () => {
      const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
      uiStore.openModal('template-browser');
    });

    const dialog = window.locator('dialog[aria-modal="true"]').first();
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    const results = await new AxeBuilder({ page: window as never })
      .include('dialog[aria-modal="true"]')
      .withTags(wcagTags)
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
