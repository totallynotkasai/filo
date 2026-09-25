import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Pre-daily-use regression bracket: three silent-data-loss paths the note
 * store and writer must keep closed.
 *
 *  1. Vault swap with "Don't Save" — the note store's pre-swap reset drops
 *     every queued write before the outgoing vault closes, so a pending
 *     write against vault A can't land after vault B opens.
 *  2. BOM-preserving edit — every write applies the change to a fresh read
 *     and re-emits its BOM, so a Notepad-saved `.md` keeps its leading
 *     `EF BB BF` after a write round-trip.
 *  3. Nothing is written before the note has loaded — a body set while the
 *     note is still being read is refused, so the race between editor mount
 *     and the read can't clobber the file with an empty body.
 *
 * Tests drive the renderer via `window.evaluate` (same pattern as
 * dailyDriverSmoke.test.ts) rather than DOM gestures — the store is a
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
          const { noteStore } = await import('/src/renderer/stores/notes.svelte.ts');
          const { fireVaultSwap } = await import('/src/renderer/core/vaultLifecycle.ts');

          // Phase 1: open vault A, load Notes.md, queue an edit.
          await vaultStore.openVault(rootA as string);
          const note = noteStore.acquire('Notes.md', 'pre-daily-use-test');
          await note.loaded;
          noteStore.setBody('Notes.md', 'A edited body — should never land on disk', 'pre-daily-use-test');

          // Phase 2: fire pre-swap with saveOutgoing=false — the
          // "Don't Save" branch in vaultStore.openVault. The note store's
          // onVaultSwap('pre-swap', 'noteStore', ...) handler drops every
          // queued write; the armed timer should never fire. We invoke
          // fireVaultSwap directly rather than openVault(rootB) because
          // openVault would surface the native "Save / Don't Save / Cancel"
          // dialog that hangs the Playwright window.
          await fireVaultSwap({
            phase: 'pre-swap',
            previousVault: rootA as string,
            nextVault: rootB as string,
            saveOutgoing: false,
          });

          // Phase 3: drain anything that might still be pending. After the
          // reset this should be a no-op — but explicitly draining surfaces
          // a regression where a write queued against rootA leaks past the
          // pre-swap hook.
          await noteStore.flushAll();

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
        const { noteStore } = await import('/src/renderer/stores/notes.svelte.ts');

        await vaultStore.openVault(rootArg);
        // The writer reads the file fresh and re-emits the BOM it finds.
        const note = noteStore.acquire('BomNote.md', 'pre-daily-use-test');
        await note.loaded;
        noteStore.setBody('BomNote.md', 'edited body line', 'pre-daily-use-test');
        await noteStore.flush('BomNote.md');
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

  test('a body set before the note has loaded is refused; body intact', async () => {
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
        const { noteStore } = await import('/src/renderer/stores/notes.svelte.ts');

        await vaultStore.openVault(rootArg);

        // Simulate the race: an editor mounts and a keystroke arrives while
        // the note is still being read. The store refuses a body until the
        // note has loaded.
        const note = noteStore.acquire('BigDoc.md', 'pre-daily-use-test');
        const statusAtSet = note.status;
        noteStore.setBody('BigDoc.md', 'X', 'pre-daily-use-test'); // hostile body: would replace 200KB
        await note.loaded;
        await noteStore.flushAll();
        return { statusAtSet, pending: note.hasUnsavedBody };
      }, vaultDir);

      // If the body had been taken, the 200KB note would now be a single 'X'.
      expect(guard.statusAtSet).toBe('loading');
      expect(guard.pending).toBe(false);

      // File on disk is byte-identical to the seed — no write happened.
      const after = fs.readFileSync(path.join(vaultDir, 'BigDoc.md'), 'utf8');
      expect(after).toBe(ORIGINAL);
    } finally {
      await app.close();
    }
  });
});
