import { test, expect, _electron as electron } from '@playwright/test';
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
 * Drives split-pane creation through the workspace store directly because
 * HTML5 drag-and-drop is unreliable to script. The store mutation is the
 * same code path the UI uses, so this validates DOM rendering of the tree.
 */
test.describe('Filo E2E — Split Panes', () => {
  test('renders two panes side-by-side after splitRoot', async () => {
    // Bootstrap a project with one tab so there is something to split
    await window.evaluate(async () => {
      const { workspaceStore } = await import('/src/renderer/stores/workspace.svelte.ts');
      workspaceStore.reset();
      workspaceStore.ensureRoot('tab_a');
      workspaceStore.splitRoot('tab_b', 'right');
    });

    // SplitPaneContainer should render when leafCount > 1
    const container = window.locator('.split-pane-container, .pane-view');
    await expect(container.first()).toBeVisible({ timeout: 5000 });

    // Two PaneView nodes (leaves)
    const panes = window.locator('.pane-view');
    await expect(panes).toHaveCount(2);
  });

  test('enforces max 3 leaves', async () => {
    const overflowed = await window.evaluate(async () => {
      const { workspaceStore } = await import('/src/renderer/stores/workspace.svelte.ts');
      workspaceStore.reset();
      workspaceStore.ensureRoot('tab_a');
      workspaceStore.splitRoot('tab_b', 'right');
      workspaceStore.splitRoot('tab_c', 'bottom');
      const fourth = workspaceStore.splitRoot('tab_d', 'left');
      return { fourth, leafCount: workspaceStore.leafCount };
    });
    expect(overflowed.fourth).toBe(false);
    expect(overflowed.leafCount).toBe(3);
  });

  test('closeLeaf collapses a single-child split', async () => {
    const result = await window.evaluate(async () => {
      const { workspaceStore } = await import('/src/renderer/stores/workspace.svelte.ts');
      workspaceStore.reset();
      workspaceStore.ensureRoot('tab_a');
      workspaceStore.splitRoot('tab_b', 'right');

      const root = workspaceStore.paneTree as { children: { id: string }[] };
      const firstLeafId = root.children[0].id;
      workspaceStore.closeLeaf(firstLeafId);

      return {
        rootType: workspaceStore.paneTree?.type,
        leafCount: workspaceStore.leafCount,
      };
    });
    expect(result.rootType).toBe('leaf');
    expect(result.leafCount).toBe(1);
  });
});
