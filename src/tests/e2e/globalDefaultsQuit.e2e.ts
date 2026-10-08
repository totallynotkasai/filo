import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, makeTemp, openNoteByName, quitLikeUser, removeTemp } from './helpers/app';

/**
 * An Apply in Settings → Global Defaults leaves nothing unapplied: the quit
 * that follows exits at once, with Settings still open or closed, and never
 * asks about "unapplied changes" the Apply already saved.
 */

let root: string;

test.beforeAll(() => {
  root = makeTemp('defaultsquit');
});

test.afterAll(() => removeTemp(root));

/** Settings → Global Defaults → Document: Page Layout and Background Pattern changed, then Apply. */
async function applyDocumentDefaults(win: Page): Promise<void> {
  await win.keyboard.press('Control+,');
  await win.locator('[role="tab"]', { hasText: 'Global Defaults' }).click();
  await win.locator('#board-type-select').selectOption('document');
  await win.locator('#doc-page-layout').selectOption('continuous');
  await win.locator('#doc-pattern').selectOption('dots');
  const apply = win.locator('.settings-action-bar button', { hasText: 'Apply' });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(apply).toBeDisabled({ timeout: 5_000 });
}

/** `.filo/defaults.json`'s Document defaults ({} until the Apply has written it). */
function documentDefaults(vault: string): { pageLayout?: string; backgroundPattern?: string } {
  const file = path.join(vault, '.filo', 'defaults.json');
  if (!fs.existsSync(file)) return {};
  const defaults = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    document?: { pageLayout?: string; backgroundPattern?: string };
  };
  return defaults.document ?? {};
}

for (const settingsOpen of [true, false]) {
  test(`after an Apply in Global Defaults, the quit exits (Settings ${settingsOpen ? 'still open' : 'closed'})`, async () => {
    const vault = freshVault(root, `Vault ${settingsOpen ? 'open' : 'closed'}`, { 'River Road.md': '---\ntitle: River Road\n---\nAria rode north.\n' });
    const launched = await launchBuilt(vault);
    const { win } = launched;
    let outcome: Awaited<ReturnType<typeof quitLikeUser>> | null = null;
    try {
      // A Document tab open, as when it was seen.
      await openNoteByName(win, 'River Road');
      await applyDocumentDefaults(win);
      await expect.poll(() => documentDefaults(vault)).toMatchObject({ pageLayout: 'continuous', backgroundPattern: 'dots' });
      if (!settingsOpen) {
        await win.keyboard.press('Escape');
        await expect(win.locator('.settings-action-bar')).toHaveCount(0);
      }
    } finally {
      outcome = await quitLikeUser(launched, 15_000);
    }
    const asked = outcome.outcome === 'timeout' ? { dialogs: outcome.dialogs, boxes: outcome.boxes?.map((b) => b.message) } : null;
    expect(asked, 'nothing asked at quit').toBeNull();
    expect(documentDefaults(vault)).toMatchObject({ pageLayout: 'continuous', backgroundPattern: 'dots' });
  });
}
