# Phase 6 — Single-Parser Frontmatter Refactor Plan

**Date:** 2026-06-03
**Status:** ✅ **COMPLETE** — **6.0–6.7 ALL DONE** (working tree, `ci:verify` green, 34 gates). **6.8 DEFERRED by decision (2026-06-03)**: it is the optional, post-dogfood pure-op model, and the decision-gate resolved to *defer* — see its section below for the full rationale. The headline reason: 6.8 **cannot deliver its stated objective** ("eliminate the in-engine diff entirely"), because the `tagRewriter` path patches files that aren't open editors (read bytes → patch once → write) and so has no read→write model to carry — it must keep `patchFrontmatterSourceCst`'s diff regardless. 6.8 would therefore leave *two* frontmatter write paths (carried-model for open editors + diff for tag sweeps) rather than one, for marginal additional safety the now-single-parser diff already provides. **The bug class behind DI-01/DI-05/R1/M2/C1/L23/L27/L28/DI-06 is already deleted (not guarded) by 6.0–6.7** — Phase 6's goal is met. Supersedes the one-paragraph "Phase 6 — Optional deep refactor" in `AUDIT6_REMEDIATION_PLAN_2026-06-02.md` with an executable, phased breakdown.

> **6.8 decision (2026-06-03): DEFERRED — Phase 6 closed at 6.7.** The decision-gate was evaluated and resolved to *defer* (not implement). Trace of the surface area: the pure-op model would re-thread `documentStore` to cache + invalidate a CST model and convert **~15 production mutation sites** (`taskCommands`, `kanbanCommands`, `propertiesCommands`, `frontmatterRebase`, `TextTile`, `PropertiesPopup`, `vaultExternalChanges`, the gateway, `boardCache`, kanban/tasklist writers — several non-trivial: merge-cleaning, 3-way external rebase, conflict reconcile) to emit `setKey/deleteKey/addTag` ops, plus ~50 test files. The disqualifying finding: **`tagRewriter` cannot carry a model.** Tag-rename sweeps patch files that aren't open editors (read disk bytes → patch once → write), an inherently one-shot diff with no read→write model to thread — so `patchFrontmatterSourceCst`'s diff **stays** regardless. 6.8 would thus produce *two* frontmatter write paths instead of one (more machinery, contradicting the "delete the machine" thesis) for safety the single-parser diff already provides. **Revisit only if real-vault dogfooding surfaces a frontmatter corruption the single-parser CST diff cannot prevent** — none observed (the dogfooding Book Vault is frontmatter-less). See the Phase 6.8 section for the full record.

> **6.7 landed (2026-06-03):** the dual-parser scaffolding is retired — the legacy machinery is *deleted, not guarded*. Deleted the legacy byte-splice `patchFrontmatterSource` body + its helpers, the `frontmatterPatch.ts` engine-dispatcher, and the `VITE_FILO_FM_ENGINE=legacy` rollback lever (all four production call sites — `assembleMarkdownFile` + the three `tagRewriter` writers — now call `patchFrontmatterSourceCst` directly; `valuesEqual` / `serializeScalar` / `serializeKeyValue` stay in `frontmatterEngine.ts` as shared helpers, not relocated). Gate **`ci:frontmatter-core-schema` → repurposed to `ci:no-jsyaml-in-frontmatter`** (the old `scripts/check-frontmatter-core-schema.mjs` is deleted; the new `scripts/check-no-jsyaml-in-frontmatter.mjs` is wired into `ci:verify`), a structurally-stronger invariant: it fails the build on ANY `js-yaml` import under the frontmatter paths except the single annotated exception. **js-yaml is now imported by exactly one renderer module — `tagsStorage.ts` (the D1 tag-name minting guard, `allow-default-schema`-annotated, not a frontmatter read).** The differential harness's old-engine arm was removed (its invariant assertions kept as a permanent single-engine regression test); `KNOWN_LIMITATIONS.md#1` + the `CLAUDE.md` frontmatter gotcha were rewritten to describe the single-parser CST-operations engine (untouched keys — incl. folded `>` scalars — now byte-exact). `ci:verify` green (34 gates, exit 0). NOT git-committed (working tree, matching 6.0–6.6). (Recorded 2026-06-03 alongside the 6.8 defer decision — the landing happened in the 6.7 session but this note was added when Phase 6 was formally closed; verified against the live tree: `frontmatterPatch.ts` absent, no `VITE_FILO_FM_ENGINE` in source, gate swapped.)

> **6.6 landed (2026-06-03):** the deferred reconcile-gate data-flow piece is closed — path-equality is now **structural**, not statically inferred. New `writeMarkdownAndReconcile({ vaultRoot, path, content, mode, create?, track? })` in `lib/vault/syncOpenEditorsAfterDiskMutation.ts` performs the direct `.md` write (via `trackComponentWrite`, channel chosen by `create`) AND the matching reconcile for the **same `path`** in one call: `mode: 'full'` → `syncOpenEditorsAfterDiskMutation` (body+FM reload), `mode: 'frontmatter'` → `reconcileOpenEditorFrontmatter` (FM-only, body-preserving). Because both halves read one `path` arg, the written path and the reconciled path cannot diverge by construction. **All six non-gateway `.md` writers migrated** onto it: the two `fileTags` single-tag fast paths (`frontmatter`; each keeps its Audit-6 M3 post-write baseline refresh at the call site, since that needs a `vault:stat` the helper doesn't do), `ReplaceAllCommand.writeAll` (`full`; the per-file reconcile replaced the post-batch `syncOpenEditors` in execute/undo), `CascadeDeleteCommand.undo` (`full`, `create: true`; media binary restores unchanged), `recreateDeletedFile` (`full`, `create: true`; `markHydrated` now runs after the helper — independent state), and `tagRewriteSweep` (`full`; per-file reconcile inside the drain replaced the post-drain batch). A subtle correctness improvement falls out: the helper reconciles **only on write success** (`trackComponentWrite` re-throws on failure), so a failed write never converges an editor onto bytes that didn't land — the prior batch callers reconciled unconditionally. The gate `ci:md-writers-reconcile-editors` was **hardened + simplified**: it dropped the same-top-level-block scan (a nearby reconcile call no longer satisfies it) and now fails any raw `vault:write-(existing-)?file-text` invoke outside the coupled helper, `RECONCILE_EXEMPT` (new-file seeds / `.filo/` sentinels / config geometry), or a `// reconcile-elsewhere:` escape — BITE-verified (temp non-exempt writer → red; escape → green). Helper's two raw invokes carry `// allow-direct-write:` for `ci:markdown-gateway`. +5 new `writeMarkdownAndReconcile` tests in `syncOpenEditorsAfterDiskMutation.test.ts` (same-path full/FM, create-channel, sibling-isolation, no-reconcile-on-failure); existing reconcile tests (`tagWriteReconcile`, `cascadeDeleteSyncsOpenEditors`, `tagRewriteSweepSyncsOpenEditors`, `recreateDeletedFileCancelsPendingWrites`, `replaceAllCommand`) all green unchanged (they assert end-state). Ceilings held by trimming the added comments — `fileTags.svelte.ts` and `vaultExternalChanges.ts` stay under their snapshots (no ceiling bump). `ci:verify` green end-to-end (381 files, 3818 tests, 34 gates, exit 0). NOT git-committed (working tree, matching 6.0–6.5). Surgically updated the gate's CLAUDE.md description (it had claimed path-equality was "deferred, Phase 6"); the broader doc rewrite (KNOWN_LIMITATIONS, frontmatter gotcha) + gate retirement stay deferred to 6.7. **6.7 next:** retire the dual-parser scaffolding, docs, gates, ceilings (optional cleanup).

> **6.5 landed (2026-06-03):** the vault index was the last *active* frontmatter read on js-yaml, and it's now on the `yaml` package — **no js-yaml parses any active frontmatter path.** One swap: `vaultIndex.parseFrontmatterBlock` `js-yaml.load(yamlSource, { schema: CORE_SCHEMA })` → `parseDocument(yamlSource)` + `.toJS()` (object-root guard; `doc.errors.length > 0` OR an unexpected throw routes to the **kept** gray-matter/`{}` safety net — the same shape js-yaml's throw used to take; a clean parse to a non-object root still yields `{}` directly, parity with the prior code). `import yaml from 'js-yaml'` removed from the module. This closes the read side of the M2 seam in the index too: js-yaml CORE read `1_000`/`0b1010` as the NUMBERS 1000/10 while the `yaml` package keeps them STRINGS, so an exotic-numeric value used to diverge between the index metadata and the documentStore frontmatter (a phantom external-edit signal); one parser everywhere ends it. DI-01/DI-05 preserved — the `yaml` core schema resolves no timestamp/merge tag, so an unquoted date stays a `string` and `<<: *a` a literal `<<`. The only remaining js-yaml frontmatter touches are both out of the active path, retired/kept by design: the **legacy byte-splice engine's compare** (`frontmatterEngine.ts:174`, behind the `VITE_FILO_FM_ENGINE=legacy` rollback lever — deleted in 6.7) and the **D1 tag-name minting guard** (`tagsStorage.ts:255`, intentional YAML-1.1 coercion, `allow-default-schema`-annotated, not a frontmatter read). Swept `src/main` for any frontmatter `yaml.load`: none. +3 `vaultIndex.test.ts` cases (`1_000`/`0b1010` → strings = M2 consistency with `parseMarkdownFile`; unquoted date stays a string = DI-01; tags still extracted alongside an exotic-numeric sibling = indexing unaffected). `ci:frontmatter-core-schema` stays green (`0 offenders` — the gate lives until 6.7 retires/repurposes it per D2). `ci:verify` green (381 test files, 34 gates, exit 0). NOT git-committed (working tree, matching 6.0–6.4). Docs (`CLAUDE.md`/`KNOWN_LIMITATIONS.md`) + gate retirement remain deferred to 6.7. **6.6 next:** the deferred reconcile-gate data-flow piece.

> **6.4 landed (2026-06-03):** the tag rewriter (`lib/vault/tagRewriter.ts`) is now js-yaml-free — the LAST js-yaml use in any frontmatter write path is gone. Three swaps: `loadYamlObject` `js-yaml.load(CORE)` → `parseDocument(src, {uniqueKeys:true}).toJS()` (errors-len/type guards; `uniqueKeys` reproduces js-yaml's throw-on-dup-key refusal); `dumpYaml` (last-resort fallback) `js-yaml.dump` → `new Document(fm).toString({lineWidth:0}).trimEnd()` (matches `assembleMarkdownFile`'s 6.3 fallback); `emitTagScalar` (the sharp edge) `js-yaml.dump([tag],{flowLevel:0})` → `new Document([tag], {version:'1.1'})` + `contents.flow=true` + `toString({singleQuote:true, lineWidth:0})` then bracket-slice. **`version:'1.1'` is load-bearing** (and MUST sit on the `Document` ctor, not `toString` — verified): it preserves js-yaml's deliberately-conservative YAML-1.1 quoting so `yes`/`no`/`on`/`off`, `1_000`, `2024-01-01`, `1:30` all stay quoted STRINGS for every reader — incl. the vault-index CORE read, under which an unquoted `1_000` would resolve to the NUMBER 1000. Spiked against the old oracle on a 66-name hostile table: **64/66 byte-identical**; the 2 residual diffs (`'apos` → double- vs old doubled-single-quote; `=` → bare vs old defensive single-quote) re-parse to the IDENTICAL string under js-yaml DEFAULT/CORE **and** the `yaml` package in flow AND block context (**0 round-trip failures** across all 6 reader×context combos). The `loadYamlObject` swap is NOT cosmetic: the CST engine derives its compare via `doc.toJS()`, so the old js-yaml-CORE loader (which read `1_000`→1000, `0b1010`→10) disagreed with it and made an UNTOUCHED divergent sibling look "changed" on a tag-FALLBACK edit, canonicalising it on disk (the M2 class). Pinned by two new BITE-verified fallback tests (temp-revert → `0b1010`→`10` reds) plus a 66-name quoting-oracle parity test (old-vs-new + round-trip-everywhere) in `tagRewriter.test.ts`. `emitTagScalar` exported for the parity test. `ci:verify` green (381 files, 3810 tests + the 271 invariant gate, 34 gates, exit 0; `ci:frontmatter-core-schema` 0 offenders confirms the js-yaml read is gone). NOT git-committed (working tree, matching 6.0–6.3). Docs (`CLAUDE.md`/`KNOWN_LIMITATIONS.md`) + gate retirement remain deferred to 6.7; the `tagsStorage` minting guard (D1) is the only intentional js-yaml use left, untouched. **6.5 next:** the vault-index read.

> **6.3 landed (2026-06-03):** the read path AND the CST engine's value-comparison object are now BOTH on the `yaml` package, so frontmatter read/write/diff are single-parser. Changes: `markdownSync.parseMarkdownFile` `yaml.load(CORE_SCHEMA)` → `parseDocument().toJS()` (bail to `{}` on `doc.errors` / non-mapping root); `assembleMarkdownFile` full-dump fallback `js-yaml.dump` → `new Document(fm).toString({lineWidth:0}).trimEnd()` (D3); `frontmatterCstModel` compare `jsyaml.load(CORE)` → `doc.toJS()` (the deferred 6.2 unification — M2 now structurally dead). markdownSync no longer imports js-yaml. The legacy engine KEEPS its js-yaml CORE compare as the rollback lever (unchanged) — still safe because a `yaml`-package `nextObj` re-serialises byte-identically through it. Empirically reconfirmed against `yaml@2.9.0`/`js-yaml@4.1.1`: `1_000`/`0b1010` are the ONLY two forms the parsers disagree on (STRING vs NUMBER); the `new Document().toString()` dump is byte-identical to `js-yaml.dump` for the array case and needs no `Buffer`. The differential harness's read sim (`parseCore`→`parseFm`) moved to the `yaml` package, and `isExpectedImprovement` broadened to a MULTISET-superset-on-source-faithful-lines check (the fuzzer surfaced the legitimate improvement: legacy re-serialises a nested block holding a `1_000` and canonicalises its siblings (`0o17`→`15`, drops nested comments), while the single-parser CST engine preserves it verbatim). New M2-dead tests in `markdownSync.test.ts`. `markdownSync.test.ts` needed NO re-baseline (its assertions are `toContain`/re-parse, and the new-file dump is byte-identical to the old). `ci:verify` green (381 files, 34 gates, exit 0); 10× differential fuzz reruns clean (4000 cases). NOT git-committed (working tree, matching 6.0–6.2). Docs (`CLAUDE.md`/`KNOWN_LIMITATIONS.md`) + gate retirement remain deliberately deferred to 6.7.

> **6.2 landed (2026-06-03):** production frontmatter writes now route through the CST engine via a single swap point — new `lib/vault/frontmatterPatch.ts` `patchFrontmatterSourceActive`, called from `assembleMarkdownFile` + the three `tagRewriter` writers. Standalone-6.2 form per this section's coupling note: the CST engine **keeps the js-yaml CORE compare** (the `doc.toJS()` unification is deferred to land *with* 6.3's read-path switch, else an untouched `1_000` would look changed — M2). D4 rollback lever shipped as `VITE_FILO_FM_ENGINE=legacy` (read once at module load; `ImportMetaEnv` extended in `shims.d.ts`; deleted in 6.7). New `frontmatterPatch.test.ts` pins both selections. Dogfood smoke (read-only, real Book Vault): all 13 files are frontmatter-less so the swap is byte-neutral on them; a synthetic Filo-style-FM edit confirmed CST ≡ legacy byte-for-byte with every untouched line preserved.
**Decision context:** User has elected to do the refactor (rather than the plan's default "defer"). The Phase-5 corpus prerequisite ("corpus first, refactor second, corpus guards the refactor") is **met** — `frontmatterInvariant.test.ts` ships 264 hand cases + a 400-run fast-check fuzzer. This plan is built so the corpus *is* the safety net for every step.

> **Goal (in the user's words):** "ensure that gaps in my current implementation for data integrity are patched up completely as currently issues keep cropping up." This plan does that by **structurally eliminating root-cause A** (the dual-parser object-vs-source diff + hand-rolled byte-splice) rather than patching one more instance. After Phase 6, the bug class behind DI-01, DI-05, R1, M2, C1, L23, L27, L28, and DI-06 **cannot recur**, because the code path that generated them is deleted, not guarded.

---

## 1. Why this is the right cut (root cause, not instance)

Six audits patched ~dozens of frontmatter bugs. They kept recurring because the fixes were instance-level while the **source** is one architectural smell:

> Frontmatter is written by **diffing a plain object against a re-parsed source** and then **hand-splicing bytes** for the changed keys — with **two different YAML parsers** in the loop (`js-yaml` for the read/compare, the `yaml` package for the CST ranges + scalar emit).

Every recurring bug is a leak in that machine:

| Bug | What leaked |
| --- | --- |
| DI-01 | js-yaml DEFAULT read turned `2026-06-01` into a `Date`; the diff "saw" a change → ISO rewrite |
| DI-05 | js-yaml resolved `<<: *a` to a merged map; the diff destroyed the merge key |
| R1 | re-serializing untouched plain scalars canonicalized them (`02134`→`2134`) |
| M2 | `yaml` keeps `1_000` a string, js-yaml CORE makes it `1000` → untouched key looks "changed" |
| C1 | value-only byte-splice on a bare key emitted `aliases:home` (no space) → whole block collapsed |
| L23 | nested-collection edit re-serializes → inner comments dropped |
| L27 | anchored-key edit dangles aliases → refuse + lossy dump |
| L28 | scalar→collection type change drops trailing comment |
| DI-06 | folded `>` scalar reflows when a sibling changes |

**The cure is to delete the machine.** Make the **`yaml` package the single parser** for all frontmatter, and express writes as **CST operations on a source-preserving model** (`CST.setScalarValue` / item splice / item build → `CST.stringify`) instead of an object diff + byte splice. Untouched CST nodes are emitted from their own source tokens — byte-for-byte — with no heuristic. There is no second parser to disagree with, and no manual splice arithmetic to get wrong.

### 1.1 Feasibility — proven, not assumed

Verified against the installed `yaml@2.9.0` / `js-yaml@4.1.1` (four throwaway spikes, since deleted):

- `CST.stringify` of a parsed block-map preserves every **untouched** node's exact bytes — leading zeros, hex case, padded spacing, inline + standalone comments, nested-map comments, `1_000`, `0b1010`. (The high-level `doc.toString()` does **not**, even with `keepSourceTokens` — it canonicalizes. So the engine **must** use `CST.stringify`, never `doc.toString()`.)
- `CST.setScalarValue(item.value, v)` rewrites one scalar in place, keeping its line + trailing comment.
- Deleting a key = splicing the item out of `map.items`; the **standalone comment above the deleted key is preserved** (it attaches to the gap).
- Changing a nested collection = swapping just that item's `value` token (built from a throwaway `new Document({k:v}).toString()` → re-parsed to CST); untouched siblings + nested comments survive.
- The **L27 anchor case improves**: a sibling edit in an anchored doc now applies *and* keeps `&b`/`*b` verbatim (today it refuses + dumps).
- **One known wrinkle** (already reproduced, solvable): an appended item needs an explicit leading newline/indent or it concatenates onto the previous line (`- betapriority: high`). The add path must build the separator deliberately. This is the single non-trivial mechanic and gets its own validation spike (6.1).

---

## 2. Target architecture

```
                       ┌──────────────────────────────────────────┐
   .md bytes  ───────► │  parseMarkdownFile (markdownSync.ts)      │
                       │   • yaml package: parseDocument()         │
                       │   • frontmatter  = doc.toJS()  (cache)    │
                       │   • rawFrontmatter = verbatim source      │
                       └──────────────────────────────────────────┘
                                       │  (plain object = READ-ONLY cache for
                                       │   index / board-JSON / display)
                                       ▼
   edit a key  ─►  documentStore.frontmatterCache  +  originalFrontmatterCache (disk source)
                                       │
                                       ▼
                       ┌──────────────────────────────────────────┐
   write       ◄────── │  assembleMarkdownFile (UNCHANGED API)     │
                       │   originalFrontmatter + live object       │
                       │            │                              │
                       │            ▼                              │
                       │  patchFrontmatterSource  (REWRITTEN)      │
                       │   • parseDocument(src,{keepSourceTokens}) │
                       │   • currentObj = doc.toJS()  ◄─ SAME      │
                       │     parser as the read → no cross-parser  │
                       │     "looks changed but isn't"             │
                       │   • for each key: unchanged → leave CST   │
                       │     node; changed scalar → setScalarValue;│
                       │     changed coll / added → build+splice;  │
                       │     deleted → splice out                  │
                       │   • CST.stringify(mapToken)               │
                       └──────────────────────────────────────────┘
```

**Invariants of the design:**

1. **One parser for frontmatter: the `yaml` package.** `js-yaml` is removed from every frontmatter read/write/compare. (It may remain *only* for the isolated, intentionally-YAML-1.1 tag-name-minting guard in `tagsStorage.ts` — see Open Decision D1.) The `ci:frontmatter-core-schema` gate (DI-01) becomes moot for frontmatter and is repurposed/retired (Open Decision D2).
2. **The plain object is a read-only cache.** It feeds the index, board-JSON, and display. It is **never** the thing written back verbatim; the write path patches the **source** via CST ops. (This is already mostly true via the source-preserving patch; Phase 6 makes it structurally true and single-parser.)
3. **Caller API is stable.** `assembleMarkdownFile(fm, body, { originalFrontmatter, rawFrontmatter, frontmatterDirty, bom, contentId })` keeps its exact signature and semantics. Only the *internals* of `patchFrontmatterSource` change. → minimal blast radius on the ~6 write callers and the gateway.
4. **Fails closed, identically.** `patchFrontmatterSource` still returns `string | null`; `null` still means "caller falls back to a full dump." The set of inputs that return `null` only **shrinks** (e.g., L27 anchors now mostly handled) — it never grows, so no caller newly hits the dump path.
5. **BOM / CRLF / fence handling stays in the callers** (`assembleMarkdownFile`, `tagRewriter.reassemble`). The engine continues to operate on an LF-normalized block and return LF; the caller re-applies the file's own ending. Unchanged.

---

## 3. The unbreakable contract (what must not regress)

Extracted from `frontmatterInvariant.test.ts` (264 + fuzzer), `markdownSync.test.ts`, `frontmatterEngine.test.ts`, `tagRewriter.test.ts`, `KNOWN_LIMITATIONS.md#1`, and the CI gates. **Every phase must keep all of these green.**

1. **Data-loss invariant.** No write path drops a key, corrupts the YAML, or edits the body. Refusal (`null` → dump) is acceptable; silent loss is not.
2. **Byte-equality on untouched single-line scalars** (incl. `02134`, `0xFF00FF`, `6.022e23`, `1_000`, `0b1010`, `0o17`, `+5`, padded spacing, quoted forms).
3. **BOM preserved** (`hadBom` → output BOM).
4. **CRLF tolerated and preserved** end-to-end (engine LF-internal; caller re-applies).
5. **Bare-key set re-parses** (C1: `aliases:` + value never concatenates without a space).
6. **Anchors/aliases**: never dangle an alias or silently diverge an anchor (today: refuse touched-anchored-key; Phase 6: preserve when untouched, refuse-or-handle when touched — **must not regress DI-05's `<<: *base`**).
7. **Comment survival**: leading / standalone / trailing / inter-key comments survive edits to unrelated keys.
8. **Nested collection**: untouched nested block keeps inner comments; a changed nested block may drop them (documented L23 boundary) — but data survives.
9. **Folded `>` scalar**: parsed value byte-identical (cosmetic reflow allowed; Phase 6 may *improve* to byte-exact when untouched — that still passes).
10. **Fence robustness**: trailing whitespace on `---` tolerated; indented `---` inside a block scalar not mis-segmented (this lives in `parseMarkdownFile`'s regex, not the YAML parser — unaffected, but re-tested).
11. **New-file / no-baseline path** still emits a clean dump (Phase 6 may change the *serializer* — see D3 — but output must stay valid + tests updated deliberately).
12. **Read/write parity**: the object the read produces and the object the write diffs against come from the **same** parser (now structurally guaranteed, not gate-enforced).

**CI gates that must stay green (34):** `ci:frontmatter-invariant`, `ci:frontmatter-core-schema` (until retired in 6.7), `ci:markdown-gateway`, `ci:markdown-read-gateway`, `ci:md-writers-reconcile-editors`, `ci:awaited-writes-bounded`, `ci:file-sizes`, `ci:type-casts`, plus the full `ci:verify` chain.

---

## 4. Surface-area map (from the codebase sweep)

**Frontmatter READS (all must end up on the `yaml` package):**

| Site | File:line | Today | Phase |
| --- | --- | --- | --- |
| Primary read | `lib/editor/markdownSync.ts:106` | `js-yaml CORE` | 6.3 |
| Vault index | `lib/vault/vaultIndex.ts:150` | `js-yaml CORE` | 6.5 |
| Tag rewriter fallback load | `lib/vault/tagRewriter.ts:104` | `js-yaml CORE` | 6.4 |
| Engine compare object | `lib/vault/frontmatterEngine.ts:174` | `js-yaml CORE` | 6.2 |
| Tag-name minting guard | `lib/vault/tagsStorage.ts:255` | `js-yaml DEFAULT` (intentional, annotated) | D1 (likely keep) |

**Frontmatter WRITES / serialization:**

| Site | File:line | Today | Phase |
| --- | --- | --- | --- |
| Engine scalar emit | `frontmatterEngine.ts:355` | `yaml` Document | rewritten 6.1 |
| Engine pair emit | `frontmatterEngine.ts:364` | `yaml` Document | rewritten 6.1 |
| Full-dump fallback | `markdownSync.ts:394` | `js-yaml dump` | 6.3 / D3 |
| Tag dump fallback | `tagRewriter.ts:113` | `js-yaml dump` | 6.4 |
| Tag scalar quoting oracle | `tagRewriter.ts:268` | `js-yaml dump` | 6.4 (careful — quoting parity) |

**WRITE callers / option invariants (API stays fixed):** gateway `markdownFileWriter.ts:657` (passes `bom`, `rawFrontmatter`, `frontmatterDirty`, `originalFrontmatter`); new-file seeds `seedTextFileForNewTile.ts:80`, `taskCreation.ts:158`, `kanbanTileCreation.ts:251` (full dump, no baseline); `buildMarkdownFileFromEditor` (tests). `patchFrontmatterSource` consumers: `assembleMarkdownFile:392`, `tagRewriter` ×3 (`:380/:421/:489`).

**READ consumers sensitive to parsed types** (the read-path switch in 6.3/6.5 changes how exotic numerics surface): `vaultIndex` (MiniSearch metadata), `markdownFileWriter.readMarkdownForHydrate`, `syncOpenEditorsAfterDiskMutation` / `reconcileOpenEditorFrontmatter`, `markdownTileSeed`. → see Risk R2.

**Baseline plumbing (unchanged, but the source it stores is now the CST model's input):** `documentStore` `frontmatterCache` / `rawFrontmatterCache` (clean signal) / `originalFrontmatterCache` (disk source, survives mutations) / `mutationVersions`; `fileBaselineRegistry` (mtime/size drift).

---

## 5. Phased execution

Each phase: **objective → changes → validation → exit criteria → risk/rollback.** Every phase ends with `npm run check` + `npm run lint` + the relevant corpus + full `ci:verify` green, and a runnable app. Phases are ordered so the **engine is fully proven before anything switches to depend on it**, and the riskiest change (read-path parser swap) is isolated.

### Phase 6.0 — Safety net: differential harness + corpus gap-fill (no production change)

**Objective:** Build the net that proves the refactor is behavior-preserving before writing it.

**Changes (tests only):**
- New `src/tests/unit/frontmatterEngineDifferential.test.ts`: a harness that takes the existing corpus generators (the 8 `PATCH_CORPUS` blocks, the `OBJECT_OPS` matrix, the hostile tag corpus, and the fast-check generators from `frontmatterInvariant.test.ts`) and is shaped to run an input through **two** engine implementations and assert: (a) both outputs re-parse to the same object; (b) the new output's untouched-single-line-scalar lines are byte-identical to the *input* (the existing `topLevelKeyLine` assertion); (c) any new-vs-old divergence falls in an explicit `EXPECTED_IMPROVEMENTS` allowlist (L27 anchor preserved, DI-06 folded scalar preserved). In 6.0 it runs old-vs-old (a no-op self-check) so the harness itself is validated; in 6.1 the second arg becomes the new engine.
- Fill the corpus gaps the sweep surfaced (additive, must pass against the *current* engine): an anchored **untouched** sibling alongside a changed key; a folded `>` untouched sibling; a CRLF×BOM×nested matrix row; an added-key-after-a-trailing-blank-line case (the 6.1 wrinkle, pinned now so the new engine must satisfy it).

**Validation:** `ci:frontmatter-invariant` green with the new cases; differential harness green old-vs-old.

**Exit:** corpus strictly larger, all green; harness ready to receive the new engine. **Risk:** ~nil (tests only). **Rollback:** delete the test files.

### Phase 6.1 — Build the CST-operations engine *alongside* the old one (no swap)

**Objective:** Implement and fully validate the new engine without anything depending on it.

**Changes:**
- New module `lib/vault/frontmatterCstModel.ts` (keeps `frontmatterEngine.ts` under its one-concern budget; the engine file currently 365 LOC, the CST helpers will add ~150–200): exports `patchFrontmatterSourceCst(originalSource, nextObj): string | null`.
  - Parse once: `parseDocument(source, { keepSourceTokens: true, uniqueKeys: true })`; bail to `null` on `doc.errors.length`, non-map root, or flow-mapping root (parity with today).
  - `currentObj = root ? root.toJS(doc) : {}` — **same parser** as the source; in 6.1 we still feed it a js-yaml-CORE `nextObj` (read path not yet switched), so **6.1 keeps the existing js-yaml-CORE `currentObj` derivation too** for the diff to stay correct — i.e. 6.1 is a pure serialization-mechanism swap (byte-splice → CST ops) with the *diff inputs unchanged*. (The parser unification of the diff is 6.2.)
  - Operate on `doc.contents.srcToken` (the block-map CST token):
    - unchanged key (`valuesEqual(currentObj[k], nextObj[k])`): leave the item untouched → byte-preserved by `CST.stringify`.
    - changed primitive on a scalar value: `CST.setScalarValue(item.value, v)`.
    - changed collection / scalar→collection / changed-to-primitive-on-nonscalar: rebuild the item's `sep`+`value` from a throwaway `new Document({k:v}).toString()` re-parsed to CST.
    - deleted key: splice the item from `items`.
    - added key: build a fresh item via the throwaway-doc route; **insert with a deliberate leading line-start/indent** (the proven wrinkle) — before a single trailing blank line if present, else append, guaranteeing the prior item ends in a newline.
  - Emit `CST.stringify(mapToken)`, then `.replace(/\r?\n$/, '')` (parity with today's trailing-newline contract). Grow-from-empty (null root) routes through a small `new Document(...)` builder → `.toString()` (nothing to preserve).
  - Anchors/aliases: re-implement the L27 guard as **"refuse only when a CHANGED/DELETED key's own subtree carries `&`/`*`"** (the existing narrow guard, ported), because rebuilding such a node still risks a dangling alias. Untouched anchored keys are left as CST nodes → preserved (this is the improvement).
- `valuesEqual` stays in `frontmatterEngine.ts` (shared).

**Validation (the crux):**
- Point the differential harness's second engine at `patchFrontmatterSourceCst`. Run the **entire** corpus + the 400-run fuzzer through old-vs-new. Require: new satisfies all 12 contract invariants; new == old except the `EXPECTED_IMPROVEMENTS` allowlist.
- A focused `frontmatterCstModel.test.ts` for the add-item-newline wrinkle across positions (first/middle/last/after-blank/after-comment) and the nested-collection swap.

**Exit:** new engine passes the full corpus + fuzzer + differential; **still unused in production.** `ci:verify` green. **Risk:** low (additive). **Rollback:** delete the module; nothing references it.

### Phase 6.2 — Unify the diff parser + swap the engine in

**Objective:** Make the engine single-parser and route production through it. This is the **load-bearing swap.**

**Changes:**
- In `patchFrontmatterSourceCst`, derive `currentObj` from `doc.toJS()` (drop the js-yaml-CORE compare). **Coupled with 6.3** (the read path must hand the engine a `yaml`-package `nextObj`), so 6.2 and 6.3 land together or 6.2 temporarily keeps a CORE compare guarded by a flag. *Recommended:* land 6.2+6.3 as one reviewed unit behind a single swap point.
- Re-point `assembleMarkdownFile:392` and the three `tagRewriter` call sites from `patchFrontmatterSource` → `patchFrontmatterSourceCst`. Keep the old `patchFrontmatterSource` exported but unused for one cycle (rollback lever; optionally gate via `FILO_FM_ENGINE=legacy` read once at module load — Open Decision D4).

**Validation:** full `ci:verify`; **manual dogfood smoke** on the real Book Vault (open a note, edit a metadata field, add/rename/remove a tag, external-edit-then-save) — diff the `.md` bytes before/after to confirm only intended lines changed.

**Exit:** production frontmatter writes go through the CST engine; corpus + fuzzer + differential green; dogfood smoke clean. **Risk:** **high** (this is the trust boundary). **Rollback:** flip the call sites back (or `FILO_FM_ENGINE=legacy`); old engine still present.

### Phase 6.3 — Switch the primary read path to the `yaml` package — ✅ DONE (2026-06-03)

**Objective:** Make `parseMarkdownFile` single-parser so `nextObj` matches the engine's `currentObj`.

**Changes:**
- `markdownSync.parseMarkdownFile`: replace `yaml.load(fenced[1], { schema: CORE_SCHEMA })` with `parseDocument(fenced[1]).toJS()` (guard: non-object/array → `{}`, same as today's try/catch-to-`{}`). `rawFrontmatter`, BOM, fence handling unchanged.
- `markdownSync.assembleMarkdownFile`: the full-dump fallback `yaml.dump(...)` → `new Document(fm).toString({ lineWidth: 0 }).trimEnd()` (single-parser; see D3 for the test-update implication).

**Validation:** `markdownSync.test.ts` (re-baseline any new-file formatting deltas deliberately), `ci:frontmatter-invariant`, the read-consumer tests (`vaultIndex`, `syncOpenEditors`, hydrate). Add a test asserting `parseMarkdownFile` and the engine agree on `1_000`/`0b1010` (both strings now) — the M2 class proven dead.

**Exit:** read + write + diff all on the `yaml` package; full `ci:verify` green. **Risk:** **medium** (read-consumer blast radius — exotic numerics now surface as strings to the index/cache; see R2). **Rollback:** revert the two functions.

### Phase 6.4 — Fold the tag rewriter onto the single parser — ✅ DONE (2026-06-03)

**Objective:** Remove js-yaml from the tag path; keep the fast line-level rewrite as an optimization.

> **Outcome:** All three conversions landed exactly as planned (see the "6.4 landed" note at the top for the full record). Two refinements to the plan's sketch, both verified empirically against `yaml@2.9.0` / `js-yaml@4.1.1`:
> - **`emitTagScalar` quoting parity is achievable on the `yaml` package only via `version: '1.1'`.** The plan's bare `new Document([tag]).toString()` (1.2 core) leaves `yes`/`1_000`/`2024-01-01`/`1:30` UNQUOTED — a regression (an unquoted `1_000` reads as the NUMBER 1000 under the vault-index CORE schema, and 1.1 external tools coerce the rest). `version: '1.1'` + `singleQuote: true` reproduces js-yaml's conservatism: 64/66 hostile names byte-identical, the 2 diffs round-trip-equivalent everywhere. The `version` MUST be on the `Document` ctor (it selects the schema at construction); on `toString` it is ignored. "Identical quoting" is therefore met as **round-trip-faithful quoting** — pinned by an old-vs-new parity table that allows only round-trip-safe cosmetic diffs.
> - **The `loadYamlObject` swap is a correctness fix, not cleanup.** Because the CST engine compares via `doc.toJS()`, the old js-yaml-CORE fallback object disagreed on `1_000`/`0b1010` and silently canonicalised an untouched sibling on a tag-fallback edit (M2). Two BITE-verified fallback tests guard it.

**Changes:**
- `tagRewriter.loadYamlObject`: `js-yaml CORE` → `parseDocument().toJS()`.
- `tagRewriter.dumpYaml` (fallback) and `emitTagScalar` (quoting oracle): re-implement on the `yaml` package. **`emitTagScalar` is the sharp edge** — it must produce **identical quoting** to today (`@home`, `123`, `null`, comma-bearing names, leading-indicator chars). Build a `yaml`-package equivalent (`new Document([tag]).toString()` → slice the flow brackets, or `CST`-emit a single flow scalar) and pin it with an exhaustive quoting table test *before* swapping.
- The three `patchFrontmatterSource` fallbacks already re-point in 6.2.

**Validation:** `tagRewriter.test.ts` + the hostile tag corpus in `frontmatterInvariant.test.ts` (108 tag-op cases + fuzzer) — these already stress `@home`, `123`, `a:b`, `project/sub`. Add a dedicated quoting-oracle parity test (old `emitTagScalar` vs new across a YAML-hostile table).

**Exit:** tag path js-yaml-free; tag corpus green. **Risk:** medium (quoting parity). **Rollback:** revert `emitTagScalar`/`loadYamlObject`.

### Phase 6.5 — Switch the vault index + remaining reads — ✅ DONE (2026-06-03)

**Objective:** No frontmatter read remains on js-yaml.

**Changes:**
- `vaultIndex.parseFrontmatterBlock:150`: `js-yaml CORE` → `parseDocument().toJS()` (keep the gray-matter/`{}` safety fallback).
- Sweep for any other `yaml.load` on frontmatter (the sweep found none beyond the table; re-grep to be sure) and convert.

**Validation:** `vaultIndex` tests, search/index tests, full `ci:verify`. Confirm tag indexing + MiniSearch unaffected (tags are strings either way).

**Exit:** **js-yaml no longer parses any frontmatter** (only the `tagsStorage` minting guard may remain — D1). **Risk:** low-medium. **Rollback:** revert the index read.

### Phase 6.6 — Close the deferred reconcile-gate data-flow piece (the other half of "Phase 6") — ✅ DONE (2026-06-03)

**Objective:** Honor the `ci:md-writers-reconcile-editors` TODO — *prove the reconciled path equals the written path* — structurally, not with fragile static analysis.

> **Outcome:** Landed as planned — see the "6.6 landed" note at the top for the full record. One deviation from the sketch, both safe: `writeMarkdownAndReconcile` takes an **options object** (`{ vaultRoot, path, content, mode, create?, track? }`) rather than the positional `(path, content, mode)` — the real writers need `vaultRoot`, the create-vs-existing channel, and `trackComponentWrite` options, which the helper now folds in (the raw `vault:write-…` invoke moved into the helper, so callers no longer trip the gate). All six non-gateway writers migrated (not just the four named) — the hardened gate requires it, and leaving `recreateDeletedFile` / `tagRewriteSweep` on the old same-block form would have contradicted "the safe path is the only path." The plan's `runReconcilerGuarded` reference is conceptual (no such symbol exists; the mirror is the coupling discipline, now enforced by the gate).

**Changes (make the safe path the only path):**
- Introduce `writeMarkdownAndReconcile(path, content, mode)` in `lib/vault/syncOpenEditorsAfterDiskMutation.ts` (or adjacent): one helper that performs the direct `.md` write **and** the matching `reconcileOpenEditorFrontmatter`/`syncOpenEditorsAfterDiskMutation` for the **same `path`**, so the path cannot diverge by construction (mirrors root-cause-B's `runReconcilerGuarded`).
- Migrate the direct writers (`fileTags.svelte.ts` single-tag writers; any `replaceAll`/`CascadeDelete` direct write) onto the helper.
- Harden `scripts/check-md-writers-reconcile-editors.mjs`: a direct write is satisfied **only** via the coupled helper (or an explicit `// reconcile-elsewhere:`), and update the docstring to mark the path-equality part **done** (no longer "Phase 6 territory").

**Validation:** the gate bites if a writer bypasses the helper; existing reconcile tests (`tagWriteReconcile`, etc.) green; add one asserting a tag write reconciles the **same** path it wrote.

**Exit:** the gate proves path-equality structurally. **Risk:** low. **Rollback:** revert the helper + gate (writers fall back to the same-block form).

### Phase 6.7 — Retire the dual-parser scaffolding, docs, gates, ceilings

**Objective:** Delete the dead machinery and the discipline it required.

**Changes:**
- Delete the old `patchFrontmatterSource` byte-splice body + its helpers (`serializeScalar`, `serializeKeyValue`, `valueIsSingleLineScalar`, `pairHasAnchorOrAlias` if superseded), the `FILO_FM_ENGINE=legacy` lever, and the differential harness's old-engine arm (keep the harness's invariant assertions as a permanent regression test, now single-engine).
- `ci:frontmatter-core-schema`: with js-yaml gone from frontmatter, this gate is **moot**. Either delete it or **repurpose** it to assert "no `js-yaml` import under frontmatter paths" (a stronger, structural invariant). *Recommended:* repurpose → `ci:no-jsyaml-in-frontmatter`.
- Remove the now-unused `js-yaml` import sites; keep the dependency only if `tagsStorage` retains it (D1).
- `KNOWN_LIMITATIONS.md#1`: rewrite. The "lossy dump fallback / DI-06 folded reflow / dual-parser parity note" largely **goes away**: untouched keys are now byte-exact (incl. folded scalars when untouched), single parser, no canonicalization. Document the *remaining* honest limits: changed nested-collection inner comments (L23), changed-scalar→collection trailing comment (L28), changed/deleted anchored-key refusal→dump, and new-file/no-baseline dump style.
- `CLAUDE.md`: update the "Frontmatter writes are source-preserving" gotcha to describe the CST-operations engine + single parser; drop the DI-01 CORE_SCHEMA note (or point it at the repurposed gate).
- `ci:file-sizes`: re-baseline ceilings for any touched file that grew (`frontmatterCstModel.ts` new; `frontmatterEngine.ts`/`markdownSync.ts` likely shrink; watch `markdownFileWriter.ts`'s 1110 ceiling if touched).

**Validation:** full `ci:verify` green (now 34 gates, one repurposed); `npm run check`/`lint` clean; grep proves zero js-yaml frontmatter reads.

**Exit:** the dual-parser is gone from the codebase and from the gate surface; docs match reality. **Risk:** low (deletions, guarded by the corpus). **Rollback:** git revert the cleanup commit (engine already proven in 6.2–6.5).

### Phase 6.8 — *(Optional, post-dogfood)* pure-operations model — ⛔ DEFERRED BY DECISION (2026-06-03)

**Objective (as originally scoped):** The plan's purest form — eliminate the in-engine diff entirely by carrying the CST model (or an op-log) from read to write so the object is *never* re-diffed.

**DECISION (2026-06-03): DEFERRED — do not implement now.** The decision-gate ("post-dogfood, decision-gated") was evaluated and resolved to *defer*. Phase 6 is **closed at 6.7**; the bug class behind DI-01/DI-05/R1/M2/C1/L23/L27/L28/DI-06 is already **deleted, not guarded** (6.0–6.7), so Phase 6's stated goal is met without 6.8. Rationale, in order of weight:

1. **6.8 cannot deliver its objective ("eliminate the in-engine diff entirely").** The `tagRewriter` path patches `.md` files that are **not open editors** — a tag-rename sweep reads bytes off disk, patches them once, and writes back. There is no read→write lifetime over which to carry a CST model; it is inherently a one-shot diff. So `patchFrontmatterSourceCst`'s diff **must remain** for tag sweeps (and any future one-shot disk patch) regardless of how `documentStore` is rearchitected. The best 6.8 can achieve is a *carried model for open-editor writes alongside the surviving diff for sweeps* — **two** frontmatter write paths where there is now one. That is *more* machinery, directly contradicting the plan's "delete the machine" thesis (§1).

2. **The residual diff is already single-parser and reliable.** Post-6.3, both sides of the in-engine diff (`currentObj` from `doc.toJS()`, `nextObj` from `parseMarkdownFile`) come from the `yaml` package. The cross-parser "looks changed but isn't" failure mode (M2) is structurally dead. The diff also fails *safe*: `documentStore`'s `originalFrontmatterCache` doc-comment already notes the engine "always emits the full live object, so the worst case is preserving comments from a slightly older read" — i.e. a stale baseline is data-safe, not data-lossy.

3. **Large, invasive, marginal-benefit.** Re-threading `documentStore` to cache + invalidate a CST model (across external-edit reloads `applyReloadFromDisk` / `vaultExternalChanges`, and vault swaps) and converting **~15 production mutation sites** to emit `setKey/deleteKey/addTag` ops — several of them *not* simple key-sets (`mergeFrontmatter` empty-value cleaning, `frontmatterRebase`'s 3-way rebase, `vaultExternalChanges` conflict reconcile) — plus ~50 test files, is a multi-day refactor for safety the single-parser diff already provides.

**Revisit trigger (when to un-defer):** real-vault dogfooding surfaces a frontmatter corruption that the single-parser CST diff demonstrably *cannot* prevent (e.g. a same-value-different-comment case the object diff conflates, reproduced on a real file). None observed to date — the dogfooding Book Vault is frontmatter-less. If that trigger fires, scope 6.8 as "carried CST model for the `documentStore`-backed open-editor write path only," and explicitly keep `patchFrontmatterSourceCst` as the one-shot engine for `tagRewriter` + recovery/recreate paths.

*Listed originally so "feature complete" has a defined ceiling; that ceiling is now reached and consciously parked.*

---

## 6. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | New CST add/collection path mis-indents or concatenates a line | med | high (corruption) | Proven wrinkle; dedicated 6.1 spike + corpus pins (incl. after-blank/after-comment); differential fuzzer on RAW non-canonical source |
| R2 | Read-path switch changes how exotic numerics (`1_000`) surface to index/cache | med | low | Narrow form set; both read & write now agree (no internal mismatch); add explicit M2-dead test; index stores strings either way for search |
| R3 | `emitTagScalar` quoting parity drift breaks tag round-trip | med | med | Pin old-vs-new quoting table *before* swap; 108 hostile tag-op corpus cases + fuzzer |
| R4 | New-file dump serializer (`yaml` pkg vs js-yaml) changes formatting | high | low | Deliberate; re-baseline `markdownSync.test.ts`; new files have nothing to preserve (lossless) |
| R5 | `CST.stringify` line-ending behavior differs on CRLF input | low | med | Engine is LF-internal (caller re-applies EOL); CRLF×BOM matrix row added in 6.0 |
| R6 | A read consumer relied on a `Date`/number type from js-yaml DEFAULT/CORE | low | med | DI-01 already moved reads to CORE (strings); `yaml` pkg also strings → strictly closer, not farther |
| R7 | Hidden js-yaml frontmatter read missed by the sweep | low | med | 6.7 grep gate `ci:no-jsyaml-in-frontmatter` fails the build if any remain |

**Overarching mitigation:** the differential harness (6.0–6.2) runs *both* engines over the entire corpus + fuzzer and asserts equivalence-or-known-improvement on thousands of inputs. The refactor cannot land a silent regression the corpus can express.

---

## 7. Open decisions (resolve before/early in execution)

- **D1 — Keep js-yaml for the tag-name minting guard?** `tagsStorage.isSafeNewTagName` uses `js-yaml DEFAULT` *intentionally* (YAML-1.1 coercion rejects `2024`/`true`/`null` as confusing tag names). It is **not** a frontmatter read (already `allow-default-schema`-annotated). *Recommendation:* **keep it** (isolated, well-justified, out of the frontmatter path) → "single parser" means single-parser-**for-frontmatter**, not zero js-yaml in the repo. Replacing it (yaml-pkg coercion check) is a tiny optional follow-up.
- **D2 — Retire vs repurpose `ci:frontmatter-core-schema`?** *Recommendation:* **repurpose** to `ci:no-jsyaml-in-frontmatter` (structurally stronger than the schema annotation).
- **D3 — New-file dump serializer.** Switch `yaml.dump` → `new Document(fm).toString()` for true single-parser, accepting a one-time `markdownSync.test.ts` re-baseline. *Recommendation:* **switch** (purity; lossless for new files).
- **D4 — Ship the `FILO_FM_ENGINE=legacy` rollback lever?** *Recommendation:* **yes for one dogfooding cycle**, delete in 6.7. Cheap insurance on the trust boundary.

---

## 8. Sequencing & effort

| Phase | Theme | Effort | Gate to land |
| --- | --- | --- | --- |
| 6.0 | Differential net + corpus gaps | S | additive, green |
| 6.1 | Build CST engine (unused) | M | corpus+fuzzer+differential green |
| 6.2 | Unify diff parser + swap in | M | dogfood smoke + ci:verify |
| 6.3 | Read path → yaml pkg | M | read-consumer tests + ci:verify |
| 6.4 | Tag rewriter → yaml pkg | M | tag corpus + quoting parity |
| 6.5 | Vault index + remaining reads | S | index/search tests |
| 6.6 | Reconcile data-flow gate (the deferred half) | S–M | gate bites |
| 6.7 | Retire scaffolding + docs + gates | S–M | ci:verify, grep clean |
| 6.8 | *(optional)* pure-op model | L | ⛔ **DEFERRED 2026-06-03** — decision-gate resolved → defer (tag-sweep path keeps the diff regardless; see §6.8) |

**Recommended landing order:** 6.0 → 6.1 → **(6.2+6.3 together)** → 6.4 → 6.5 → 6.6 → 6.7. Each is its own commit with `ci:verify` green; 6.2+6.3 is the one coupled unit and the only step warranting manual dogfood verification before moving on.

**Definition of done:** every frontmatter read/write/compare is on the `yaml` package; `patchFrontmatterSource` is CST-operation-based; the 264+fuzzer corpus + differential harness are green against the single engine; the reconcile gate proves path-equality; `KNOWN_LIMITATIONS.md`/`CLAUDE.md` describe the new model; `ci:verify` green; and the bug class behind DI-01/DI-05/R1/M2/C1/L23/L27/L28/DI-06 is deleted, not guarded.

**Status (2026-06-03): ✅ MET — Phase 6 complete.** All definition-of-done criteria are satisfied by 6.0–6.7 (working tree, `ci:verify` green, 34 gates). The optional 6.8 pure-op model is **deferred by decision** (see §6.8) and is *not* part of the definition of done — Phase 6's goal (delete the root-cause bug class, not patch instances) is achieved without it.
