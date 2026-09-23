import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Phase 4.2 / IMPL_PLAN_2026-05-25 — pre-daily-use regression bracket.
 *
 * Three scenarios pin the markdown-write gateway against the three P0
 * silent-data-loss paths the gateway was built to close:
 *
 *  1. Vault swap with "Don't Save" — cancelAllMarkdownWrites pre-swap hook
 *     drops every armed timer before the outgoing vault closes, so a
 *     pending write against vault A can't land after vault B opens.
 *     Closes P0 #4.
 *  2. BOM-preserving edit — parseMarkdownFile/markHydrated thread `hadBom`
 *     into assembleMarkdownFile so a Notepad-saved `.md` keeps its leading
 *     `EF BB BF` after a write round-trip. Closes P0 #1.
 *  3. Hydrate gate — writeMarkdownFile refuses to write a relPath that
 *     hasn't been markHydrated() yet, so the 100ms race window between
 *     editor mount and disk hydrate can no longer clobber the file with
 *     an empty body. Closes P0 #2.
 *
 * Tests drive the renderer via `window.evaluate` (same pattern as
 * dailyDriverSmoke.test.ts) rather than DOM gestures — the gateway is a
 * lib-layer contract and DOM-driven editing adds incidental flake without
 * exercising any extra code path.
 */

let tempRoot: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-pre-daily-use-e2e-'));
});

test.afterAll(() => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function launchApp(): Promise<{
  app: Awaited<ReturnType<typeof electron.launch>>;
  window: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>;
}> {
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..', '..', 'dist', 'main', 'main.js')],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window };
}

test.describe('Filo E2E — Pre-daily-use regression bracket', () => {
  test('vault swap "Don\'t Save" — pending writes against vault A drop; vault B same-named file unchanged', async () => {
    test.setTimeout(60_000);

    // Two sibling vault dirs under the shared tempRoot. Both seeded with
    // the SAME filename so a leaked write would land in B's file instead
    // of A's and surface as a same-named-file collision.
    const vaultA = path.join(tempRoot, 'vault-a');
    const vaultB = path.join(tempRoot, 'vault-b');
    fs.mkdirSync(vaultA, { recursive: true });
    fs.mkdirSync(vaultB, { recursive: true });

    const A_INITIAL = '---\ntitle: A\n---\nA initial body\n';
    const B_INITIAL = '---\ntitle: B\n---\nB initial body\n';
    fs.writeFileSync(path.join(vaultA, 'Notes.md'), A_INITIAL, 'utf8');
    fs.writeFileSync(path.join(vaultB, 'Notes.md'), B_INITIAL, 'utf8');

    const { app, window } = await launchApp();
    try {
      const result = await window.evaluate(
        async ([rootA, rootB]) => {
          const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
          const gateway = await import('/src/renderer/lib/vault/markdownFileWriter.ts');
          const { parseMarkdownFile } = await import('/src/renderer/lib/editor/markdownSync.ts');
          const { fireVaultSwap } = await import('/src/renderer/core/vaultLifecycle.ts');
          const { invokeOk } = await import('/src/renderer/lib/utils/invokeOk.ts');

          // Phase 1: open vault A, hydrate Notes.md, schedule an edit.
          await vaultStore.openVault(rootA as string);
          const readA = await invokeOk('vault:read-file-text', rootA as string, 'Notes.md');
          const parsedA = parseMarkdownFile(readA.content);
          gateway.markHydrated('Notes.md', parsedA.hadBom);
          gateway.scheduleMarkdownWrite({
            vaultRoot: rootA as string,
            relPath: 'Notes.md',
            frontmatter: parsedA.frontmatter,
            body: 'A edited body — should never land on disk',
            callerId: 'pre-daily-use-test:vault-a:Notes.md',
          });

          // Phase 2: fire pre-swap with saveOutgoing=false — the
          // "Don't Save" branch in vaultStore.openVault. The gateway's
          // onVaultSwap('pre-swap', 'markdownFileWriter', ...) handler
          // calls cancelAllMarkdownWrites; the armed timer should never
          // fire. We invoke fireVaultSwap directly rather than
          // openVault(rootB) because openVault would surface the native
          // "Save / Don't Save / Cancel" dialog that hangs the Playwright
          // window — the lifecycle event is what the Don't Save branch
          // dispatches in production anyway.
          await fireVaultSwap({
            phase: 'pre-swap',
            previousVault: rootA as string,
            nextVault: rootB as string,
            saveOutgoing: false,
          });

          // Phase 3: drain anything that might still be pending. After
          // cancelAllMarkdownWrites runs, this should be a no-op — but
          // explicitly draining surfaces a regression where a write
          // armed against rootA leaks past the pre-swap hook.
          await gateway.flushAllMarkdownWrites();

          return { ok: true };
        },
        [vaultA, vaultB] as const,
      );
      expect(result.ok).toBe(true);

      // Both files on disk should match what we seeded — neither vault's
      // Notes.md was rewritten.
      expect(fs.readFileSync(path.join(vaultA, 'Notes.md'), 'utf8')).toBe(A_INITIAL);
      expect(fs.readFileSync(path.join(vaultB, 'Notes.md'), 'utf8')).toBe(B_INITIAL);
    } finally {
      await app.close();
    }
  });

  test('BOM-preserving edit — Notepad-saved BOM survives a write round-trip', async () => {
    test.setTimeout(60_000);

    const vaultDir = path.join(tempRoot, 'vault-bom');
    fs.mkdirSync(vaultDir, { recursive: true });

    // EF BB BF + frontmatter + body. Writing as Buffer to guarantee the
    // exact byte sequence — fs.writeFileSync('utf8') would also encode
    // the U+FEFF char as EF BB BF, but explicit bytes leave no ambiguity.
    const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const TAIL = Buffer.from('---\ntitle: BomNote\n---\noriginal body line\n', 'utf8');
    fs.writeFileSync(path.join(vaultDir, 'BomNote.md'), Buffer.concat([BOM, TAIL]));

    // Pre-flight: confirm we actually wrote the BOM bytes.
    const seedBytes = fs.readFileSync(path.join(vaultDir, 'BomNote.md'));
    expect(seedBytes[0]).toBe(0xef);
    expect(seedBytes[1]).toBe(0xbb);
    expect(seedBytes[2]).toBe(0xbf);

    const { app, window } = await launchApp();
    try {
      await window.evaluate(async (rootArg) => {
        const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
        const gateway = await import('/src/renderer/lib/vault/markdownFileWriter.ts');
        const { parseMarkdownFile } = await import('/src/renderer/lib/editor/markdownSync.ts');
        const { invokeOk } = await import('/src/renderer/lib/utils/invokeOk.ts');

        await vaultStore.openVault(rootArg);
        const read = await invokeOk('vault:read-file-text', rootArg, 'BomNote.md');
        const parsed = parseMarkdownFile(read.content);
        // markHydrated must record hadBom=true so writeMarkdownFile threads
        // it into assembleMarkdownFile and re-emits the leading BOM.
        gateway.markHydrated('BomNote.md', parsed.hadBom);
        await gateway.writeMarkdownFile({
          vaultRoot: rootArg,
          relPath: 'BomNote.md',
          frontmatter: parsed.frontmatter,
          body: 'edited body line',
          callerId: 'pre-daily-use-test:bom:BomNote.md',
        });
      }, vaultDir);

      // The leading three bytes must still be the BOM. Other byte-level
      // changes are expected (body changed); we don't pin the full
      // contents to keep the assertion focused on the regression.
      const after = fs.readFileSync(path.join(vaultDir, 'BomNote.md'));
      expect(after[0]).toBe(0xef);
      expect(after[1]).toBe(0xbb);
      expect(after[2]).toBe(0xbf);

      // Sanity check: the edited body actually landed (otherwise the BOM
      // could "pass" by simply skipping the write entirely).
      expect(after.toString('utf8')).toContain('edited body line');
      expect(after.toString('utf8')).not.toContain('original body line');
    } finally {
      await app.close();
    }
  });

  test('hydrate gate — writeMarkdownFile refuses an unhydrated relPath; body intact', async () => {
    test.setTimeout(60_000);

    const vaultDir = path.join(tempRoot, 'vault-hydrate');
    fs.mkdirSync(vaultDir, { recursive: true });

    // ~200KB body — same shape as the "open a 200KB document" scenario
    // in the plan. The size matters less than the hydrate-gate
    // contract, but a realistic-size body proves the gate stops the
    // write before any disk I/O happens.
    const BIG_BODY = `${'lorem ipsum dolor sit amet, '.repeat(8_000)}\n`;
    const ORIGINAL = `---\ntitle: BigDoc\n---\n${BIG_BODY}`;
    expect(ORIGINAL.length).toBeGreaterThan(200_000);
    fs.writeFileSync(path.join(vaultDir, 'BigDoc.md'), ORIGINAL, 'utf8');

    const { app, window } = await launchApp();
    try {
      const guard = await window.evaluate(async (rootArg) => {
        const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
        const gateway = await import('/src/renderer/lib/vault/markdownFileWriter.ts');

        await vaultStore.openVault(rootArg);

        // Simulate the race: editor mounts, the user's first keystroke
        // fires onUpdate, scheduleMarkdownWrite would build args — but
        // hydrateFromDisk hasn't completed yet, so the gate refuses.
        // We call writeMarkdownFile directly with no prior markHydrated:
        // the same code path the schedule timer eventually invokes once
        // the debounce window expires.
        let threw = false;
        let message = '';
        try {
          await gateway.writeMarkdownFile({
            vaultRoot: rootArg,
            relPath: 'BigDoc.md',
            frontmatter: {},
            body: 'X', // hostile body — single char would replace 200KB on disk
            callerId: 'pre-daily-use-test:hydrate:BigDoc.md',
          });
        } catch (err) {
          threw = true;
          message = err instanceof Error ? err.message : String(err);
        }

        return { threw, message };
      }, vaultDir);

      // The gateway must have thrown. If it didn't, the 200KB body
      // would now be a single 'X' on disk.
      expect(guard.threw).toBe(true);
      expect(guard.message).toContain('not hydrated');

      // File on disk is byte-identical to the seed — no write happened.
      const after = fs.readFileSync(path.join(vaultDir, 'BigDoc.md'), 'utf8');
      expect(after).toBe(ORIGINAL);
    } finally {
      await app.close();
    }
  });
});
