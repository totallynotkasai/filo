# Audit-10 Remediation Plan — 2026-06-04

**Posture:** Fresh-eyes data-integrity audit (9 read-only agents) of the working
tree *after* Audits 1–9 + write-path remediation. `ci:verify` is green
end-to-end (lint, svelte-check, all unit tests, build, 38 guards) — so every
finding here is **outside** existing gate coverage: a logic/data-flow bug that
type-checks and passes tests. Each Blocker/High below was **personally verified
against source** (functions read, data flow traced, OS behavior confirmed via
Node), not just agent-reported.

**Meta-thesis:** The frontmatter CST engine and the Phase-4 field-command delta
path are genuinely excellent and could not be broken. The remaining bugs are all
in **what is handed to the engine** — lossy popup coercion, a wrong path
resolver, an empty-cache fallback, a parallel hand-rolled tag parser, and one
OS-filename security gap. **No architecture change is required.** This is 5
targeted fixes + a 6th UX fix.

---

## Findings summary

| ID | Sev | Area | One-line | Verified |
|----|-----|------|----------|----------|
| B1 | Blocker | Properties popup | Untouched nested-object / numeric-array FM corrupted to `"[object Object]"` / strings on any popup edit | ✅ source |
| B2 | Blocker | Kanban/Properties path | Field edit on a subfolder card (doc not loaded) writes to wrong root path → edit lost, or unrelated same-named file corrupted | ✅ source |
| B3 | Blocker (security, local TM) | `media:open-external` | `evil.exe.` / `evil.exe::$DATA` bypass the launcher blocklist → `shell.openPath` RCE | ✅ source + Node |
| H1 | High | Tag rewriter | Tag rename/remove corrupts a *sibling* tag carrying an inline comment / quoted comma / escaped apostrophe | ✅ source |
| H2 | High | Editor body save | Body-only save with an empty FM cache wipes the whole on-disk YAML block | ✅ source |
| M1–M6 | Medium | various | Replace-All serialization race, delete-cascade swap, reconcile snapshot, body+FM no-editor ignore, 2-space hard-break → read-only, pan O(n)/frame | agent-reported |

Phasing (each phase ends with `npm run ci:verify` green before commit):

- **Phase 1 — B2, B1** (corruptors reachable in normal use) — ✅ **DONE 2026-06-05** (ci:verify green, 39 gates). Both B2 write-path resolvers delegate to `resolveTextTileVaultPath`; B1 adds a verbatim read-only `raw` PropType. New `ci:writer-path-honors-filepath` narrow-allowlist gate + tests (`kanbanFrontmatterWriter.test.ts`, `audit10Phase1.test.ts`, propertyRowTypes additions), all bite-verified.
- **Phase 2 — H2, H1** (frontmatter loss) — ✅ **DONE 2026-06-05** (ci:verify green, 39 gates). **H2:** the gateway cache-FM branch ([markdownFileWriter.ts](src/renderer/lib/vault/markdownFileWriter.ts) `writeMarkdownFileImpl`) now re-reads disk in-chain + seeds the cache when the FM cache is never-seeded (`!documentStore.hasFrontmatter(docId)`) AND the caller passes no FM (`argsFmEmpty`) — so a body-only editor save can't assemble against `{}` and strip the on-disk YAML block (the TextTile "adopt sibling doc" wipe). A deliberate `{}` seed is still trusted (no re-read). `ci:no-silent-write-abort` extended with a GATEWAY_REQUIRED ratchet (`hasFrontmatter(` + `argsFmEmpty` must survive); `markdownFileWriter.ts` ceiling 1259→1286. **H1:** `locateTagsField` ([tagRewriter.ts](src/renderer/lib/vault/tagRewriter.ts)) now declines block items carrying an inline comment / escaped quote (new `itemUnsafeForLinePath`) and flow/scalar fields whose quoting hides a comma or that carry an inline comment — routing them to the load→CST fallback (which tokenises correctly) instead of letting the hand-rolled fast path SUCCEED with a corrupted SIBLING tag. New `audit10Phase2.test.ts` (4 gateway tests) + 8 H1 cases in `tagRewriter.test.ts`; both fixes + the gate bite-verified (gate red on token removal, tests red with guards neutered). Note: on a CHANGED block `tags:` the surviving item's inline comment is dropped by the source-preserving engine (accepted, like L23/L28) — the data guarantee is sibling-VALUE correctness; a single-line scalar's inline comment IS preserved.
- **Phase 3 — B3** (security; before any vault sharing) — ✅ **DONE 2026-06-05** (ci:verify green, still 39 gates). Both the renderer slice (`asSafeOpenExternal`) and the main handler ([media:open-external](src/main/ipc/media.ipc.ts)) now extract the launcher extension through a new shared, pure `launcherExtension(rawPath)` ([untrusted.ts](src/shared/untrusted.ts)) that strips Win32 trailing dots/spaces and drops the NTFS ADS (`:`) suffix BEFORE reading the final `.ext`. So `evil.exe.` / `evil.exe ` / `evil.exe::$DATA` — which `path.extname` reads as the non-blocklisted `'.'` / `'.exe '` / `'.exe::$DATA'` — all resolve to the true `.exe` and are blocked (verified via Node: `path.resolve` PRESERVES the trailing dot/ADS on win32, so `assertWithinVault` realpaths past them to the in-vault file and lets execution reach the blocklist, which is the only defence on this channel — `assertSafeFilename` is not run here). The main handler ALSO adds a defence-in-depth bail rejecting any basename with a trailing dot/space or an embedded `:` — catching `report.pdf:evil`, whose `launcherExtension` is the safe-looking `.pdf` but which names an alternate data stream. **No new gate** — covered by tests: new `mediaOpenExternalLauncherExt.test.ts` (12 handler cases incl. positive controls + URL branch) and a `launcherExtension` describe block + B3 cases added to `sharedUntrusted.test.ts`; both bite-verified (9 reds when the extractor is reverted to the naive `lastIndexOf('.')` form + the handler to `path.extname`). The `UNSAFE_*` extension sets are unchanged, so the renderer↔main parity test still holds. Did NOT take the optional allowlist-flip (kept the blocklist; lower regression risk, the OS-launcher set is already comprehensive).
- **Phase 4 — M5** (prose read-only; quality-of-life for the fiction workflow) — ✅ **DONE 2026-06-05** (ci:verify green, 39 gates, no new gate). `normaliseForRoundTripCompare` ([markdownSync.ts](src/renderer/lib/editor/markdownSync.ts)) now collapses the backslash hard-break form (`\n` after a `\`) to a bare newline — matching how the existing trailing-whitespace strip already collapses the two-space form — so a verse/dialogue body written with two-space hard breaks round-trips equal instead of being forced read-only. A second pass canonicalises every valid thematic-break line (`---`/`***`/`___`/`* * *`/`- - -`) to one form (placed AFTER the Setext passes so a `---` directly under text stays a Setext H2, and BEFORE the list-bullet pass so `* * *` isn't mangled to `- * *`). Both transforms run on both sides of the compare, so they can't turn a genuine loss into a false match — the dropped-thematic-break negative control still flags lossy. 6 new `isLossyMarkdownRoundTrip` tests in `markdownSync.test.ts` (68 total); bite-verified (the 2 M5 tests go red when the transforms are neutered, the Setext-H2 + negative controls stay green).
- **Phase 5 (optional) — M1–M4, M6** — ✅ **DONE 2026-06-05** (ci:verify green, 39 gates, **no new gate**). All five source-verified against current code, then fixed: **M1** Replace-All now enrols each bulk write on `runSerializedMarkdownWrite` (per-path chain) so it orders behind an in-flight editor/gateway save to the same `.md` instead of racing it; **M2** `performDelete` adds a second `isStillSameVault` bail AFTER the `flushAllDirty` await (the 842 bail only covered `ensureAllLoaded`), before the in-memory cascade; **M3** the reconcile snapshot no longer advances past a suppressed path (carry the prior entry / drop a newly-appeared one) so an external edit landing inside a self-write window re-surfaces once suppression lifts; **M4** the no-editor classifier branch now syncs frontmatter (with the same partial-read guard the editor branches use) when the body ALSO changed; **M6** `visibleTiles` maps over the culled `visibleTileIds` (O(visible), not O(total) per pan frame) with a cached insertion-order map that preserves overlapping-tile stacking. **The rAF-throttle of `panBy` was deliberately NOT taken** — see the Phase 5 section below for the rationale. Tests (all bite-verifiable): `conflictResolver.test.ts` (+3 M4), `fileWatcherReconcile.test.ts` (+1 M3), `replaceAllCommand.test.ts` (+1 M1), `vaultFolderOpsDelete.test.ts` (+1 M2), new `visibleTilesViewModel.test.ts` (5 M6). Ceilings held with no allowlist bump (`vaultFolderOps.ts` 996→999, `fileWatcher.ts` 960→983, both ≤1000). STILL UNCOMMITTED (whole Audit-7/8/9/10 + write-path tree).

---

## B2 — Kanban/Properties write resolver ignores `tile.filePath`

**Root cause:** `vaultPathForTile` ([src/renderer/lib/kanban/kanbanFrontmatterWriter.ts:24](src/renderer/lib/kanban/kanbanFrontmatterWriter.ts)) and `vaultRelativePath` ([src/renderer/components/tiles/PropertiesPopup.svelte:100](src/renderer/components/tiles/PropertiesPopup.svelte)) are the only two of five text-tile path resolvers that **omit the authoritative `filePath`** the def carries for subfolder cards (stamped at [kanbanTileCreation.ts:162,185](src/renderer/lib/kanban/kanbanTileCreation.ts)). After a restart the document store is empty (boards don't preload docs), so they fall back to `${title}.md` at vault root. `UpdateCardFieldCommand` then writes to that path (`this.relPath`, [kanbanCommands.ts:578](src/renderer/commands/kanbanCommands.ts)). Common case → ENOENT (edit lost, loud toast, card reverts on reload). Collision case (a root file with the same name) → that **unrelated file is silently mutated**.

**Fix — delegate to the canonical resolver** (already does `filePath → documentStore → cascade`):

```ts
// kanbanFrontmatterWriter.ts — add import
import { resolveTextTileVaultPath } from '../boards/textTilePath';

// replace the whole body of vaultPathForTile:
export function vaultPathForTile(tile: Tile): string | null {
  return resolveTextTileVaultPath(tile);
}

// in the factory, thread the owning board so the cascade fallback anchors correctly:
function vaultPathForTileSafe(tile: Tile): string {
  return resolveTextTileVaultPath(tile, getBoard()?.id) ?? `${tile.title || 'Untitled'}.md`;
}
```

```svelte
<!-- PropertiesPopup.svelte — add import, replace vaultRelativePath body -->
import { resolveTextTileVaultPath } from '../../lib/boards/textTilePath';

function vaultRelativePath(t: Tile): string | null {
  return resolveTextTileVaultPath(t);
}
```

(This also fixes a latent Mind-Map Properties bug: a Mind-Map text tile in a subfolder had the same wrong-path exposure.)

**Tests:**
- `kanbanFrontmatterWriter.test.ts`: a card def with `filePath:'Folder/Card.md'`, `contentId` set, **no** document loaded → `vaultPathForTile` returns `Folder/Card.md` (today returns `Card.md`). Bite-verify by reverting the fix.
- End-to-end: `updateTileFrontmatter` on such a card writes to `Folder/Card.md` (assert the gateway `relPath`).

**Gate (new ratchet, optional but recommended):** `ci:writer-path-honors-filepath` — fail any text-tile path resolver under `src/renderer/lib/{kanban,tasklist}` or the Properties popup that returns a `${...title...}.md` literal without first consulting `filePath` (or simpler: assert these sites import `resolveTextTileVaultPath`). Closes the "policed the FM object, never the path" systemic gap.

**Risk:** Minimal — `resolveTextTileVaultPath` is the established resolver used by `TextTile`/`TaskList`. Behavior changes only for the currently-broken subfolder-card case.

---

## B1 — Properties popup corrupts untouched non-scalar frontmatter

**Root cause:** `beforeSnapshot.fm` is the **raw** FM object ([PropertiesPopup.svelte:134](src/renderer/components/tiles/PropertiesPopup.svelte)); rows are built by coercing each value through `valueForRow` ([propertyRowTypes.ts:52](src/renderer/lib/utils/propertyRowTypes.ts)), which does `String(object)` → `"[object Object]"` for a nested map and `array.map(String)` → strings for a numeric/boolean array. On any edit + save, `diffToFrontmatterDelta(rawBefore, coercedAfter)` ([frontmatterDelta.ts:87](src/renderer/lib/vault/frontmatterDelta.ts)) flags the untouched non-scalar key as "changed" and writes the corrupted value. It **also** writes the coerced object into the display cache ([PropertiesPopup.svelte:164](src/renderer/components/tiles/PropertiesPopup.svelte)), so a later body-only save (see H2) can re-emit the corruption even if the delta is fixed. The `diffToFrontmatterDelta` doc comment's "over-inclusion is harmless (re-sets a key to its own value)" assumption is **false under lossy coercion**.

**Fix (recommended — preserve non-representable values verbatim):** add a `raw` row type that round-trips the original value untouched and renders read-only.

```ts
// propertyRowTypes.ts
export type PropType = 'text' | 'number' | 'boolean' | 'date' | 'list' | 'tag' | 'status' | 'raw';

/** A value the typed rows can't represent without loss: a nested object/array,
 *  or an array containing non-string items (numbers/booleans/objects). */
export function isRepresentable(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.every((v) => typeof v === 'string');
  return typeof value !== 'object'; // primitives ok; plain objects are not
}

export function detectType(key: string, value: unknown): PropType {
  const k = key.trim().toLowerCase();
  if (k === 'tags' && Array.isArray(value) && value.every((v) => typeof v === 'string')) return 'tag';
  if (k === 'status' && typeof value === 'string') return 'status';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (!isRepresentable(value)) return 'raw';          // <-- new, BEFORE the array/list branch
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  return 'text';
}

export function valueForRow(value: unknown, type: PropType): unknown {
  switch (type) {
    case 'raw': return value;                          // verbatim, no String()/coercion
    // ...existing branches unchanged...
  }
}
```

```svelte
<!-- PropertiesPopup.svelte: rowsToObject already does out[key] = row.value, so a
     'raw' row's verbatim value flows through unchanged once valueForRow passes it. -->
<!-- Render: add a read-only branch for type==='raw' showing a YAML/JSON preview +
     a hint ("structured value — edit in your text editor to preserve it"). -->
```

Result: `coordinates:{lat,lng}` and `years:[2024,2025]` become `raw` rows that round-trip identically → absent from the delta (preserved from disk) **and** the cache write (line 164) stays correct.

**Minimal alternative (if the read-only UI is deferred):** in `buildFrontmatterWriteArgs`, compute the delta against a coerced `before` (`diffToFrontmatterDelta(rowsToObject(rowsFromObject(openFm)), obj)`) **and** stop writing non-representable keys into the cache — preserves the write, but the displayed value is still lossy. The `raw` row is the correct fix; this is a stopgap.

**Tests:**
- `propertyRowTypes.test.ts`: `detectType('coordinates', {lat:1})==='raw'`; `valueForRow({lat:1},'raw')` deep-equals `{lat:1}`; numeric array → `raw`, round-trips.
- Seam test (drives real `assembleMarkdownFile`): FM `coordinates:{lat:5,lng:6}\nyears:[2024,2025]`, popup edits only `status`, save → disk still has the nested map and numeric list byte-for-byte. Bite-verify by reverting `detectType`.

**Risk:** Low. `raw` is additive; existing scalar/list/tag rows are untouched. UX: structured values become read-only in the popup (correct — the popup can't safely edit them).

---

## H2 — Body-only editor save wipes frontmatter when the FM cache is empty

**Root cause:** `TextTile.buildWriteArgs` ([TextTile.svelte:115](src/renderer/components/tiles/TextTile.svelte)) sets `frontmatter: getFrontmatter(contentId) || {}` and passes **no `frontmatterDelta`**, so the gateway takes the cache-FM branch ([markdownFileWriter.ts:697](src/renderer/lib/vault/markdownFileWriter.ts)). With an empty cache, `fm = {}`, `rawFrontmatter`/`originalFrontmatter` are `undefined`, and `assembleMarkdownFile` emits **body only** — the on-disk YAML is deleted. Reachable via the TextTile "adopt sibling doc" branch, which flips `hydrated=true` without seeding FM. Asymmetric with the FM scheduler, which guards `if (!delta && !fm) return`.

**Fix (gateway-level, covers TextTile + DocumentEditor):** in the cache-FM branch, if the doc has no seeded FM, re-read disk in-chain instead of assembling against `{}`.

```ts
// markdownFileWriter.ts, top of the cache-FM branch (after computing `fm`):
let fm = (docId ? documentStore.getFrontmatter(docId) : undefined) ?? args.frontmatter;
// H2 — never assemble a body-only write against an EMPTY/never-seeded FM cache;
// that would strip an on-disk YAML block. Re-read disk in-chain and source FM
// from there (mirrors the delta branch + the H13 stale re-read).
const cacheHasFm = docId ? documentStore.hasFrontmatter(docId) : false;   // confirm this accessor; else use getRawFrontmatter !== undefined || getFrontmatter !== undefined
const argsFmEmpty = !args.frontmatter || Object.keys(args.frontmatter).length === 0;
if (docId && !cacheHasFm && argsFmEmpty) {
  try {
    const readResult = await invokeOk('vault:read-file-text', vaultRoot, relPath);
    const parsed = parseMarkdownFile(readResult.content);
    documentStore.setFrontmatter(docId, parsed.frontmatter, parsed.rawFrontmatter);
    fm = parsed.frontmatter;
  } catch { /* ENOENT (genuinely new file) → keep {}; correct */ }
}
```

> Implementation note: confirm `documentStore.hasFrontmatter(docId)` exists (distinguishes never-seeded from deliberate `{}`). If not, add it, or treat "`getFrontmatter`===undefined" as never-seeded.

**Alternative (localized):** seed FM from a fresh disk read in the TextTile adoption branch ([TextTile.svelte:~235](src/renderer/components/tiles/TextTile.svelte)) instead of trusting the sibling, and gate `buildWriteArgs` on `hasFrontmatter`. The gateway fix is preferred (defense in depth, single chokepoint).

**Tests:** gateway test — `documentStore` has docId with NO FM, disk file has `---\ntitle: Keep\ntags:\n  - x\n---\nbody`, body-only write fires → disk FM preserved. Bite-verify by reverting.

**Gate:** extend `ci:no-silent-write-abort` (or a sibling) to assert the gateway body branch re-reads disk when the FM cache is empty — i.e., forbid assembling against an empty `fm` without a fresh-read guard.

---

## H1 — Tag rewriter corrupts sibling tags (inline comment / quoted comma / escaped quote)

**Root cause:** the line-level fast path's `locateTagsField` ([tagRewriter.ts:200](src/renderer/lib/vault/tagRewriter.ts)) mis-parses shapes its hand-rolled tokenizer can't handle, then `renderTagsField` re-emits **all** items from the mis-parsed values: `BLOCK_ITEM_RE` swallows an inline `# comment` into the tag value; the flow branch `inside.split(',')` cuts through `"b,c"`; `QUOTED_RE` (`^['"][^'"]*['"]$`) can't unwrap `'it''s'`. These shapes make `locateTagsField` *succeed with wrong values* instead of returning `null` (which routes to the already-correct load→CST fallback).

**Fix — bail to the safe fallback on shapes the line path can't represent:**

```ts
// tagRewriter.ts
// A list/scalar item the line-level path can't tokenize losslessly. Returning
// null from locateTagsField routes the edit through the load→CST fallback,
// which round-trips these correctly (same signal already used for anchors).
function itemUnsafeForLinePath(rawItem: string): boolean {
  const t = rawItem.trim();
  if (QUOTED_RE.test(t)) return false;        // cleanly single/double-quoted: fine
  if (/['"]/.test(t)) return true;            // embedded/escaped quote (e.g. 'it''s')
  if (/(^|\s)#/.test(t)) return true;         // inline comment after the value
  return false;
}
```

Apply it:
- **Block branch** (around line 216): `const item = itemMatch[2]; if (itemUnsafeForLinePath(item)) return null; blockItems.push(unquote(item));`
- **Flow branch** (around line 232): `if (/['"]/.test(inside)) return null;` (any quoting in a flow list → fallback; Filo emits bare/simple-quoted, the CST path handles the rest).
- **Scalar branch** (around line 240): `if (/['"]/.test(rest) || /(^|\s)#/.test(rest)) return null;`

**Tests:** `tagRewriter.test.ts` — for each of `rewriteTagInMarkdown` / `removeTagFromMarkdown` / `addTagToMarkdown`, assert a sibling survives:
- block: `tags:\n  - alpha\n  - beta # note\n  - gamma`, remove `alpha` → `beta` stays `beta` with its comment (via fallback), not `beta # note`.
- flow: `tags: [draft, "b,c"]`, rename `draft`→`pub` → `b,c` stays one tag.
- escaped: `tags:\n  - alpha\n  - 'it''s'`, remove `alpha` → `it's` preserved.
Bite-verify by removing the guards.

**Risk:** Low — only widens the existing `null`→fallback path. Confirm the three public functions treat `locateTagsField()===null` as "take the fallback" (they already do for the anchor case at line 207).

---

## B3 — `media:open-external` launcher-blocklist bypass → Windows RCE (local threat model)

**Root cause:** exact-string extension matching defeated by Win32 filename normalization. Confirmed via Node: `path.extname('evil.exe.')==='.'` and `path.extname('evil.exe::$DATA')==='.exe::$DATA'` — neither in the blocklist, at **both** the renderer slice ([untrusted.ts:238](src/shared/untrusted.ts)) and the main handler ([media.ipc.ts:321](src/main/ipc/media.ipc.ts)). `assertWithinVault` passes (realpath resolves the trailing-dot name to the real in-vault file); `assertSafeFilename` (which rejects trailing dots/`:`) is **not** on this channel. `ShellExecute` strips the trailing dot → runs `evil.exe`. Threat model is local (hostile/shared/synced vault content) — not a risk for a solo vault today, but a real RCE before any vault sharing.

**Fix — robust extension extraction in a shared helper, used by both sites:**

```ts
// shared helper (e.g. src/shared/untrusted.ts):
export function launcherExtension(rawPath: string): string {
  const lastSlash = Math.max(rawPath.lastIndexOf('/'), rawPath.lastIndexOf('\\'));
  let base = lastSlash >= 0 ? rawPath.slice(lastSlash + 1) : rawPath;
  base = base.replace(/[ .]+$/, '');           // Win32 strips trailing dots/spaces
  const ads = base.indexOf(':');               // NTFS ADS suffix → real ext is before it
  if (ads >= 0) base = base.slice(0, ads);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}
```

- `asSafeOpenExternal` local branch: `const ext = launcherExtension(trimmed); if (UNSAFE_LOCAL_FILE_EXTENSIONS.has(ext)) return null;`
- `media.ipc.ts`: `const ext = launcherExtension(target); if (UNSAFE_FILE_EXTENSIONS.has(ext)) return {success:false,...};` and, defense-in-depth, **reject** the target outright if its basename has a trailing dot/space or an embedded `:` (ADS) past the drive letter.

**Tests:** `sharedUntrusted.test.ts` + media-ipc test matrix — `evil.exe.`, `evil.exe `, `evil.exe::$DATA`, `evil.html.`, `EVIL.EXE`, `report.pdf.exe` all blocked; `report.pdf` still allowed. Bite-verify by reverting `launcherExtension`.

**Consider:** flip the local branch to an **allowlist** of known-safe document extensions — "hand an arbitrary vault file to the OS launcher" is inherently dangerous.

---

## Phase 4 — M5: 2-space hard break mis-flagged lossy → document read-only — ✅ DONE 2026-06-05

**Root cause:** `normaliseForRoundTripCompare` ([markdownSync.ts:242](src/renderer/lib/editor/markdownSync.ts)) strips trailing whitespace on input but tiptap-markdown serializes a hard break as the backslash form, so the two never compare equal → `setReadOnly(true)` → saving disabled. Hits a fiction writer's verse/dialogue line breaks. **Fix:** normalize both hard-break encodings (`/ {2,}\n/` and `/\\\n/`) to one form before comparing; treat `* * *`/`***`/`---` thematic breaks as equivalent. Reproduced empirically by the audit. **Test:** round-trip a 2-space hard-break body → `lossy===false`.

**Implemented:** added two transforms to `normaliseForRoundTripCompare`:

```ts
// hard breaks: the trailing-whitespace strip above already collapses the
// two-space form to a bare newline; collapse the backslash form to match.
.replace(/\\\n/g, '\n')
// thematic breaks: canonicalise ---/***/___/* * */- - - to one form. AFTER the
// Setext passes (a `---` under text is still a Setext H2), BEFORE the list-bullet
// pass (so `* * *` isn't first rewritten to `- * *`).
.replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '---')
```

Note: rather than forcing both hard-break encodings to a backslash *token* (which would have regressed the existing line-452 test — a 3-space trailing on disk is already treated as cosmetic, equal to a clean newline), the fix collapses the backslash form to a bare newline so it matches what the trailing-whitespace strip already does to the two-space form. Both encodings — and a plain soft break — normalise to the same thing, consistent with the module's existing "trailing whitespace is cosmetic" stance. Because the transforms run on both sides symmetrically, they can't manufacture a false match: the dropped-thematic-break negative control still reports `lossy===true`. 6 new tests in `markdownSync.test.ts` (hard-break two-space-vs-backslash incl. multi-line verse + a disk-backslash file, thematic-break four-marker matrix, Setext-H2-not-a-rule guard, dropped-rule negative control); bite-verified by neutering each transform (only the 2 M5 tests go red; Setext + negative controls stay green). `markdownSync.ts` 543→557 LOC (comments; well under the 1000 ceiling). No new gate — the M5 class is a comparison-only false-positive, fully covered by the unit suite.

---

## Phase 5 (optional) — Mediums — ✅ DONE 2026-06-05

All five source-verified against current code before implementing; ci:verify green (39 gates, no new gate). Each fix carries bite-verifiable tests.

- **M1** ✅ Replace-All bypassed per-path write serialization ([replaceAllCommand.ts](src/renderer/commands/replaceAllCommand.ts) `writeAll`). **Verified:** `writeMarkdownAndReconcile` → `trackComponentWrite` → direct `invokeOk('vault:write-existing-file-text')`, which does NOT join the `writeChainByPath` chain — so a bulk write races an editor's in-flight gateway save at the IPC layer (the reconcile cancels only the *armed* writer, not the in-flight one). **Fix:** each `writeMarkdownAndReconcile(item)` is wrapped in `runSerializedMarkdownWrite(item.path, …)` so it orders behind any in-flight write to the same path. Chose the per-path chain (not `withDrainedWrites`) because it is ordering-only and doesn't reintroduce the debounce race the inline comment deliberately bypassed. Test: occupant gates the chain → Replace-All write provably does not land until released.
- **M2** ✅ `performDelete` re-checked vault identity once (line 842, after `ensureAllLoaded`) but then `await`ed `flushAllDirty()` before the in-memory cascade ([vaultFolderOps.ts](src/renderer/stores/vaultFolderOps.ts) `performDelete`). **Verified:** a swap landing during that flush would run `cascadeDeleteByVaultPath` + tag drops + doc-unloads against the NEW vault (disk delete is main-side gated; the in-memory cascade is not). **Fix:** a second `if (!isStillSameVault(deleteIdentity)) return true;` immediately after the `flushAllDirty` await, before the cascade (mirrors `runRename`). Kept to 3 lines so `vaultFolderOps.ts` stays ≤1000 (996→999, no allowlist bump). Test spies `flushAllDirty` to bump the generation at exactly that window and asserts the cascade is skipped (docStore entry preserved) + delete still reports success.
- **M3** ✅ reconcile snapshot advanced past a self-write-suppressed path ([fileWatcher.ts](src/main/services/fileWatcher.ts) `reconcileNow`). **Verified:** the diff loop SKIPS suppressed paths, but `reconcileSnapshot = current` baked the post-suppression bytes in unconditionally — so an external edit landing inside a suppression window (self-write or in-flight folder delete) was masked forever (next pass: `current === snapshot`). The data-loss requires a reconcile pass DURING the window (the 30 s tick or a focus-triggered pass). **Fix:** before assigning the snapshot, for each currently-suppressed path carry its prior entry forward (or drop a path that only just appeared) so the next un-suppressed pass re-diffs it. Guarded by `suppressed*.size > 0` so a quiet vault pays nothing. Safe because a pure self-write re-surfaces harmlessly — the renderer's index already reflects it, so its re-read finds `disk === index` and ignores it. Test: external edit during suppression → no event that pass, event fires once suppression lifts.
- **M4** ✅ an external body+FM change with no editor open was fully ignored ([conflictResolver.ts](src/renderer/lib/vault/conflictResolver.ts) `classifyExternalChange`). **Verified:** the FM-only short-circuit only fires when the body is equivalent; a simultaneous body change fell through to `{action:'ignore', reason:'no-editor-open'}`, leaving tile caches / tag store / seeded-FM cache stale (a closed-file Kanban card / Task row could then revert the external key on its next field write). **Fix:** in the `!editor` branch, when `previousMetadata` exists and the frontmatter differs, return `sync-frontmatter` (reusing the existing consumer path: applyFrontmatterToBackedTiles + setFileTags + dropStaleSeededFrontmatterCache + noteBaseline), guarded by the same `isLikelyPartialRead` check the editor branches use so a truncated read isn't pushed into the caches. The body itself needs no action (no editor holds it; next tile load hydrates fresh). Tests: body+FM → sync-frontmatter; body-only (FM unchanged) still ignored; body+FM partial-read → partial-read-retry.
- **M6** ✅ pan recomputed O(total-tiles) per frame ([visibleTilesViewModel.svelte.ts](src/renderer/lib/mindmap/visibleTilesViewModel.svelte.ts) `visibleTiles`). **Verified:** the interactive branch did `Object.values(board.tiles).filter(t => visibleTileIds.has(t.id) && …)` — O(total) on every viewport change, even though `visibleTileIds` is already the culled rbush result. **Fix:** map over `visibleTileIds` (O(visible)) and look each id up in `board.tiles`. **Regression caught + mitigated:** tiles share the `--z-tile` z-index, so DOM order = paint order for overlapping tiles; the rbush traversal order ≠ insertion order. Added a cached `tileOrder` map (id→insertion index, a `$derived` over `board.tiles` that recomputes ONLY when the tile set changes — a pure pan doesn't touch it) and sort the visible set by it, so overlapping-tile stacking is byte-for-byte preserved. Export mode still walks every tile (culling intentionally off). Tests: culling, insertion-order preservation under a reversed spatial query, frame-hidden exclusion, stale-id tolerance, export mode.
  - **rAF-throttle of `panBy` — deliberately NOT taken.** The plan also suggested rAF-throttling `panBy`. After source verification this was rejected: (1) the O(n) cost — the actual finding — is fully eliminated by the culled map above, so each pan-frame recompute is now O(visible) and cheap; (2) browsers already coalesce `pointermove` to ~rAF cadence, so `panBy` is typically called once per frame already (the wheel/trackpad path can exceed it, but coalescing several *cheap* recomputes yields negligible benefit); (3) throttling would convert `panBy` from synchronous to async (accumulate deltas, apply next frame), which risks the gesture pipeline + any synchronous-read-after-pan + the existing canvas tests, and requires teardown plumbing to cancel a pending rAF on scope destroy / vault swap (else a late frame mutates a torn-down scope's transform). High risk, negligible marginal benefit → not worth it.

---

## Solid (do NOT touch)
Quit/drain ordering, command snapshot/inverse discipline, recurrence/date-math/quick-add, read/write path containment (realpath + symlink walk), SSRF defense, DOMPurify on `{@html}` sinks, CSP/contextIsolation/sandbox, save-state honesty, focus-trap correctness, the CST frontmatter engine itself, canvas/connection/frame load-time pruning + recovery snapshots. These survived hard scrutiny.
