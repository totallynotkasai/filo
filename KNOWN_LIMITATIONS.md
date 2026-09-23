# Filo — Known Limitations

These are **deliberate, accepted trade-offs**, not bugs. They follow from Filo's
core design principles (open format, local-first, no sidecar files) or from
platform constraints. They are documented here so they aren't repeatedly
re-discovered and "fixed" — changing any of them needs a design discussion, not
a patch. (Cross-referenced from the audit's Appendix C, "do NOT fix".)

If you hit one of these and believe the trade-off should change, open a design
note rather than a quick fix — each entry lists why it is the way it is.

---

## 1. Frontmatter full re-dump — only for files Filo hasn't read (and a few narrow cases)

**What (Phase 6 — root cause deleted, not patched):** Filo's frontmatter writes
go through a single-parser, source-preserving **CST-operations engine**
(`frontmatterCstModel.ts`, built entirely on the `yaml` package). It tokenises
the on-disk frontmatter source, rewrites ONLY the keys whose value actually
changed, and emits every UNTOUCHED key from its own source tokens —
byte-for-byte. Comments, key order, quote/indent style, exotic scalars (`02134`,
`0xFF00FF`, `1_000`), AND untouched folded `>` block scalars all survive a
metadata edit verbatim. This is the path taken by every open document's metadata
save (Text Tile / Document Board) and by the tag rewriter's fallback.

Six audits fought a recurring corruption class here (DI-01 unquoted date→ISO,
DI-05 destroyed `<<` merge keys, R1/M2 canonicalised untouched scalars, C1
bare-key collapse, DI-06 folded-scalar reflow). The shared root cause was a
**dual-parser object-vs-source diff plus a hand-rolled byte-splice** (js-yaml for
the compare, the `yaml` package for the emit) — two libraries that disagreed on a
handful of scalar forms. Phase 6 replaced that machine with the single-parser CST
engine, so the class is **structurally gone, not guarded**. The
`ci:no-jsyaml-in-frontmatter` gate keeps js-yaml out of every frontmatter path
(its one remaining, annotated use is the tag-name minting guard, which is not a
frontmatter read).

**Residual full re-dump (lossless by nature):** When the engine has no on-disk
source to preserve, or can't safely patch the source, it emits a full dump
(`new Document(fm).toString()` — the `yaml` package, no js-yaml). This fires for:
a brand-new file (no baseline exists, so there are no comments to lose); a write
whose backing file Filo never read into the document store (no baseline
captured); a block the engine can't parse as a block mapping; or a CHANGED /
DELETED key carrying a YAML anchor/alias (the engine refuses the splice rather
than dangle an alias — L27, and the dump expands the anchor to a concrete value).
In each case there is either nothing to preserve, or the structure is expanded
while the DATA stays exact.

**Remaining narrow formatting losses (documented, regression-pinned, never data
loss):**

- **L23 — nested-collection inner comments.** Verbatim preservation is
  TOP-LEVEL. An untouched top-level key keeps every byte (including comments
  inside a nested block it owns), but when a nested collection's VALUE changes,
  that whole pair is re-serialised — dropping comments that lived INSIDE the
  changed nested block.
- **L28 — type-change trailing comment.** A scalar→collection (or
  collection→scalar) type change re-serialises the pair, so a same-line trailing
  comment on the old value is dropped (a scalar→scalar value change keeps it, via
  the value-only splice).
- **A9-L6 — deleted key's documenting comment.** Deleting a frontmatter key
  (clearing a field in the Properties popup, or an orphan-card edit that empties a
  value) also drops a standalone comment line immediately ABOVE that key. A
  comment conventionally documents the key it precedes, so it is removed WITH the
  key rather than relocated onto the next surviving key — where it would
  mis-document an unrelated field — or left dangling at the document end.
  Inter-key blank-line spacing survives; only the comment line(s) the deleted key
  owned are dropped (`gapWithoutCommentLines` in `frontmatterCstModel.ts`). This
  was a deliberate trade-off introduced with the L4 delete-handling work
  (relocating mis-documents the survivor); option (b) — relocate to a trailing
  block instead of dropping — is tracked if dogfooding shows users rely on
  frontmatter comments.
- **Touched anchored key.** Changing or deleting a key carrying `&a`/`*a`
  full-dumps (structure expanded, data exact); an anchor/alias confined to
  UNTOUCHED keys is spliced verbatim and survives (DI-05's `<<: *base`).
- **New-file / no-baseline.** Emitted in the `yaml` package's default style
  (nothing prior to preserve).

**Where:** [src/renderer/lib/vault/frontmatterCstModel.ts](src/renderer/lib/vault/frontmatterCstModel.ts)
(the engine) + [src/renderer/lib/vault/frontmatterEngine.ts](src/renderer/lib/vault/frontmatterEngine.ts)
(shared value helpers); the disk-baseline source is retained per-doc in
[src/renderer/stores/document.svelte.ts](src/renderer/stores/document.svelte.ts)
(`originalFrontmatterCache`) and threaded through
[src/renderer/lib/vault/markdownFileWriter.ts](src/renderer/lib/vault/markdownFileWriter.ts)
→ `assembleMarkdownFile` in
[src/renderer/lib/editor/markdownSync.ts](src/renderer/lib/editor/markdownSync.ts).

**Impact:** Negligible — hand-authored YAML comments/formatting (including
untouched folded scalars) now survive a metadata edit on any file Filo has open.
Only a never-before-read file's first rewrite, a changed nested block's inner
comment, or a touched anchored key is emitted in the package's default style, and
deleting a key also drops the comment line that documented it. File *content* is
never lost.

---

## 2. Attachment tags are vault-local

**What:** Text-tile tags live in two synced places — the `.board.json` tile def
**and** the file's YAML frontmatter (`tags: [...]`) — so they travel with the
`.md` file. Attachment-tile tags (image / video / audio / generic file) have
nowhere to write into the file itself, so they live in `.board.json` plus
`.filo/tags.json` (`fileTags[mediaPath]`) only.

**Where:** Persistence boundary documented in
[CLAUDE.md](CLAUDE.md); tag storage in
[src/renderer/lib/vault/tagsStorage.ts](src/renderer/lib/vault/tagsStorage.ts).

**Why accepted:** Writing a sidecar file next to each media file would violate
the open-format principle (no proprietary files cluttering the vault). The
deliberate consequence: copying or moving an attachment **out** of the vault
without its `.filo/` directory loses its tags.

**Impact:** Attachment tags don't survive being moved outside the vault. Do not
add a sidecar file without a separate design discussion.

---

## 3. Windows directory-fsync after rename is a no-op

**What:** The atomic write path fsyncs the file *data* before the rename, but
fsyncing the containing *directory* (which makes the rename's metadata durable)
is best-effort. Windows can't open a directory for sync, so `EISDIR` / `EBADF`
/ `ENOTSUP` / `EPERM` are swallowed silently (POSIX systems do get the dir
fsync; SMB shares retry on `EBUSY`/`EACCES`).

**Where:** [src/main/vault/filenameUtils.ts](src/main/vault/filenameUtils.ts)
(the dir-fsync block after the rename loop).

**Why accepted:** Rename-metadata durability isn't enforceable via Node on
Windows. The file *data* is always fsynced first, so this only affects the
directory entry, not file contents.

**Impact:** A power loss in the instant after a rename could *theoretically*
lose a just-renamed file's directory entry on NTFS. Extremely narrow; the
`.filo/.dirty` sentinel + recovery flow covers the broader crash case.

**Audit-4 DI-10 (confirmed, accepted).** Re-verified: the file-handle `fsync`
(data durability) always runs before the rename; only the containing-directory
`fsync` (rename-metadata durability) is best-effort on Windows. The failure
mode is therefore "lose the last rename's directory entry," never file-content
corruption. A native `FlushFileBuffers` on the directory handle would be the
only way to harden it on Windows — deferred unless a user actually hits it.

---

## 4. Quit flush is best-effort under a 5s ceiling

**What:** On quit, the main process asks the renderer to flush pending debounced
writes, but waits at most `FLUSH_TIMEOUT_MS = 5000` ms.

**Where:** [src/main/main.ts](src/main/main.ts) (`FLUSH_TIMEOUT_MS`, the
`before-quit` / window-`close` flush coordination).

**Why accepted:** A wedged or unresponsive renderer must not block the app from
quitting indefinitely. Five seconds is generous for a normal flush.

**Impact:** A renderer still wedged past the timeout loses its pending writes.
This is exactly the case the `.filo/.dirty` sentinel detects — recovery is
offered on next launch.

---

## 5. Self-write suppression window can misfire on a very slow disk

**What:** When Filo writes a file, it suppresses its own file-watcher echo so it
isn't reclassified as an external edit. Two layers: the main-process watcher
suppresses for ~500–2000 ms (`FileWatcher.suppress`), and a renderer-side
registry holds each path for `RECENT_SELF_WRITE_TTL_MS = 1500` ms (or
`RECENT_SELF_WRITE_TTL_BULK_MS = 5000` ms while a bulk write is in flight).

**Where:** [src/renderer/lib/boards/writeStateTracking.ts](src/renderer/lib/boards/writeStateTracking.ts)
(recent-self-write registry) + the main-side `FileWatcher.suppress`.

**Why accepted:** The windows are sized for normal and bulk (200-file tag
rename) workloads. Widening them unconditionally would slow genuine external-edit
detection.

**Audit-13 M4 — in-window handling is content-aware, not time-only:** A watcher
event for a recently self-written path is no longer suppressed by the timer
alone. `handleExternalMarkdownChanges`
([src/renderer/stores/vaultExternalChanges.ts](src/renderer/stores/vaultExternalChanges.ts))
drops it ONLY when the file's fresh disk stat still matches the baseline Filo
wrote (`selfWriteDivergedFromBaseline` → `hasBaselineDrifted`); a diverged
mtime/size means a *second* writer touched the file inside the window, so the
event is kept and reconciled. So a genuine external edit that lands inside the
suppression window is **not** dropped — only the benign direction below remains.

**Impact:** On a pathologically slow disk or under aggressive antivirus, a
self-write's OS echo can arrive *after* the recent-self-write window has expired
(`isRecentSelfWrite` already false), so the app's own write is classified as an
external edit — surfacing a spurious "Reload / Keep local" toast. This is a UX
annoyance, **not** data loss (and, per M4 above, never a *dropped* external
edit). Monitor; widen the window only if it bites in practice.

---

## 6. Minimap recomputes the whole board every drag frame (large boards)

**What:** The minimap (on by default) reads the entire `boardStore.tiles` map
and renders one absolutely-positioned DOM pip per tile. `boardStore.tiles`
re-derives through `getFullTiles`, which allocates fresh tile objects whenever a
tile changes, so on an actual tile **drag** the minimap's `activeMediaIds` set,
the all-tiles bounding box, per-pip `effectiveTileStyle` resolution, and all N
pip nodes recompute — not just the tile that moved.

**Already narrowed (H4 perf split) — a pure pan/zoom no longer walks every
tile.** The bounds math was split into
[src/renderer/lib/canvas/minimapBounds.ts](src/renderer/lib/canvas/minimapBounds.ts):
`tilesAABB = $derived(computeTilesAABB(tiles))` is keyed on the tile set ONLY
(not the viewport) and `bounds = $derived(computeMinimapBounds(tilesAABB,
viewportRect))` is the cheap viewport union + padding. So panning/zooming re-runs
only the cheap `bounds`; the tile walk is cached. The remaining per-frame
recompute is confined to an actual tile drag, where the moved tile's fresh
identity out of `getFullTiles` invalidates `tilesAABB`, `activeMediaIds`, and the
pips.

**Where:** [src/renderer/components/canvas/Minimap.svelte](src/renderer/components/canvas/Minimap.svelte)
(`allTiles`, `activeMediaIds`, `bounds`, the pip `#each`). Root cause: the
referential churn of `getFullTiles` in
[src/renderer/stores/board.svelte.ts](src/renderer/stores/board.svelte.ts) (`tiles`).

**Why deferred (not a permanent trade-off):** The viewport-driven half is already
done — the H4 split above memoizes `tilesAABB` independently of the viewport, so
pan/zoom no longer re-walks the tiles. The residual tile-drag recompute can't be
fixed by a minimap-local memo alone — skipping `effectiveTileStyle` per pip and
reusing pip nodes needs a stable per-tile identity that `getFullTiles` doesn't
provide. The robust fix is the
same stable-identity refactor deferred from Audit2 3.3 (return reference-stable
tile objects from `getFullTiles` when a tile's placement + def are unchanged),
which removes the connection-path **and** minimap recompute together. It was
scoped out of Phase 4 (Audit2 item 4.5) as too broad/risky for one 🟡 item, and
the perf claim isn't expressible as a unit test (no component-mount harness).

**Impact:** Frame-rate dip while dragging on boards with many hundreds of tiles
**when the minimap is open** — toggle it off (the SideToolbar minimap button) as
a workaround. No data risk; rendering throughput only. Revisit alongside the
`getFullTiles` stable-identity work.

---

## 7. External rename of a very large / very small attachment doesn't auto-relink tiles

**What:** When a file is renamed *outside* Filo, the watcher emits a `delete` +
a `create`; `renameCorrelation` pairs them back into a rename so tile references
follow the new name. To avoid pairing two genuinely-unrelated files by
coincidence, cross-basename correlation (the name actually changed, e.g.
`git mv clip.mp4 final.mp4`) is **refused** at the size extremes:

- **< 256 B** (`CROSS_BASENAME_MIN_SIZE_BYTES`) — too many small files share an
  exact byte-length for size to be evidence.
- **≥ 10 MB** (`CROSS_BASENAME_HASH_REQUIRED_BELOW`) — above this the content-hash
  gate is skipped (hashing every large file on each watcher batch is too costly),
  and size+extension alone isn't strong enough evidence to merge tile references
  for two unrelated multi-MB files.

In the middle band (256 B – 10 MB) a content-hash confirms the pair. Same-basename
renames (only the folder moved) always pair, at any size. So the only case that
dangles is a rename **with a name change** on a file at the size extremes.

**Where:** [src/main/services/renameCorrelation.ts](src/main/services/renameCorrelation.ts)
(the `CROSS_BASENAME_MIN_SIZE_BYTES` floor and the `CROSS_BASENAME_HASH_REQUIRED_BELOW`
ceiling). The safety net is the manual broken-reference relink flow,
[src/renderer/stores/boardRefIntegrity.svelte.ts](src/renderer/stores/boardRefIntegrity.svelte.ts).

**Why accepted (Audit-8 L2):** This is deliberate false-positive avoidance —
silently re-pointing a tile at the *wrong* file (an unrelated same-size video)
is far worse than flagging a broken reference the user can relink in one click.
Renaming a large attachment outside the app, then changing its name, is
uncommon; when it happens the tile is flagged broken, not lost, and the backing
bytes are untouched on disk.

**Impact:** A tile pointing at a ≥10 MB (or <256 B) attachment that is renamed
*and* moved entirely outside Filo shows as a broken reference until the user
relinks it. No data loss; the file and its content are intact. A proactive
"did you rename X? relink N tiles" prompt for a large delete+create of matching
size+extension is a possible future enhancement, not a correctness fix.

## 8. Vault-wide tag rename can drop keystrokes typed *during* the sweep

**What:** A vault-wide tag rename / removal
([src/renderer/lib/vault/tagRewriteSweep.ts](src/renderer/lib/vault/tagRewriteSweep.ts))
drains all pending writes, then walks every `.md`, re-reads it fresh, rewrites
the tag, and reloads any open editor on that file (`mode: 'full'`). On a large
vault the walk takes long enough that a user could keep typing. If they type
into an editor for a file the sweep has *not yet* reached, the sweep's fresh
re-read sees disk *without* those just-typed (still-debouncing) keystrokes, and
the `mode: 'full'` reload then cancels the editor's armed write and swaps in the
rewritten body — losing those in-flight keystrokes for that one file.

**Where:** the `writeMarkdownAndReconcile({ mode: 'full' })` call inside the
`withDrainedWrites` loop in `tagRewriteSweep.ts` (the `Audit-11 T2` comment).

**Why accepted (Audit-11 T2):** Closing it in code means switching that file's
reconcile to frontmatter-only (body-preserving) when `isPathPending(path)` —
which would couple this deliberately store-free, pure-rewrite module to live
scheduler state, the exact dependency its module docstring avoids. The race is
narrow (it needs simultaneous typing into an unreached file *and* a vault-wide
tag rename), the `.md` tag rewrite itself still lands on disk correctly, and the
lost keystrokes were never committed (Ctrl+Z in the editor restores them).

**Impact:** A few unsaved keystrokes in one note can be lost if the user keeps
editing that note while a vault-wide tag rename is mid-sweep. No committed data
is lost; the tag rename completes correctly. Doing the rename when not actively
typing avoids it entirely.

## 9. Field/FM delta write reads body and frontmatter from two separate disk reads

**What:** A field edit (Kanban card / Task row) or a Properties edit writes its
frontmatter through the gateway's *delta* branch
([src/renderer/lib/vault/markdownFileWriter.ts](src/renderer/lib/vault/markdownFileWriter.ts)).
That branch applies the delta to a FRESH in-chain disk read (so untouched /
external frontmatter keys survive by construction — the Phase-4 fix), but the
`body` it assembles with came from a *separate, earlier* read (the scheduler's
no-editor hydrate read, or the orphan-card read). There is therefore a micro-TOCTOU
window between those two reads.

**Where:** the `args.frontmatterDelta` branch of `writeMarkdownFileImpl` (the
`Audit-11 N2` comment) — `nextFm` derives from `parsedFresh` (the in-chain read)
while `body` is the value threaded in by the caller.

**Why accepted (Audit-11 N2):** The delta write path only ever carries FIELD /
frontmatter edits — none of them touch the body — so the body is identical
between the two reads in every real case. Reading the body from `parsedFresh`
instead would also be *wrong* for the one case that matters: when a Document
editor is open on the file, its LIVE (possibly-unsaved) body must win, so the
gateway can't blanket-swap in the just-read disk body without clobbering the
editor. And if an external editor genuinely changed the body between the two
reads, the file-watcher reclassifies it and the open editor reconciles — the
edit self-heals rather than being lost.

**Impact:** None in practice. The only way to exercise the window is an external
process rewriting the file's BODY in the few milliseconds between the body read
and the frontmatter read of a field/Properties edit — and even then the
watcher-driven reconcile recovers it. Frontmatter is always correct (it comes
from the in-chain read). Documented rather than closed because closing it
(threading a single combined read) would entangle the gateway's body-source
policy with the open-editor-wins rule for no real-world benefit.

## 10. CSP `frame-src https:` permits any third-party iframe origin

**What:** The Content-Security-Policy (`<meta>` in `index.html` + the matching
HTTP-header CSP) allows `frame-src https:` / `child-src https:` — i.e. an Iframe
tile may embed *any* `https://` origin. A narrow origin allowlist isn't possible
because embedding arbitrary sites (YouTube, CodePen, a docs page, …) is the
whole point of the Iframe tile.

**Where:** [src/main/main.ts](src/main/main.ts) (`installContentSecurityPolicy`)
and [index.html](index.html). The src is validated by `asSafeIframeSrc`
([src/shared/untrusted.ts](src/shared/untrusted.ts)) and the tile renders inside
a `sandbox="allow-scripts"` iframe (deliberately WITHOUT `allow-same-origin`).

**Why accepted (Audit-14 4.5):** This is defense-in-depth, not a hole. Because
the embedding iframe has no `allow-same-origin`, embedded content runs in an
opaque origin and cannot read Filo's `file://` document, its storage, or other
vault contents; `default-src 'self'` still governs the app document itself. The
residual risk is the embedded page exfiltrating *its own* request URL or
fingerprinting — inherent to letting the user embed arbitrary sites, and bounded
by the sandbox. Tightening `frame-src` to a fixed allowlist would break the
feature for no real security gain given the sandbox.

**Impact:** An Iframe tile can load any https origin the user types. No access to
vault data (sandbox + opaque origin). Revisit only if Iframe tiles gain a
same-origin capability, which would change this calculus.

## 11. Partial-read guard can refuse a save for a body that legitimately starts with `---`

**What:** The delta-write gateway's truncation guard
([src/renderer/lib/vault/markdownFileWriter.ts](src/renderer/lib/vault/markdownFileWriter.ts),
Audit-14 3.3) refuses to write when a file that *previously had* frontmatter is
read back with an opening `---` fence but no closing fence — it assumes a
non-atomic external writer was caught mid-write, and refusing protects the
on-disk frontmatter from being stripped. If frontmatter is instead *legitimately*
removed by an external editor AND the new body's first line happens to be a `---`
thematic break (a horizontal rule), the guard mis-reads that stable shape as a
partial read and refuses the next field/Properties save. Because the shape is
stable, the refusal repeats on retry rather than clearing.

**Where:** the `!parsedFresh.hasFrontmatter` branch in `writeMarkdownFileImpl`.

**Why accepted (Audit-15 P2.3):** It fails **safe** — the refusal is loud
(`markPathFailed` + a "save failed" surface), no data is lost, and the on-disk
file is untouched. Every attempt to distinguish "stable FM-removed body that
starts with `---`" from "genuine partial read" using only the read is
undecidable: a size heuristic (e.g. "read is < ½ the prior byte size") lets a
truncated read of *most* of a small file through, which re-opens the
HIGH-severity Audit-14 3.3 silent-frontmatter-drop (the `audit14Phase3` "refuses
… truncated" test pins exactly that 25-of-38-byte case). For a data-integrity
guard, "never silently drop frontmatter" correctly wins over "never show a
spurious toast."

**Impact:** A field/Properties edit on a card whose backing `.md` had its
frontmatter externally deleted *and* whose body's first line is `---` will keep
failing to save until the user adds a non-`---` first line (e.g. a heading) or
re-adds a frontmatter block. Rare; surfaced loudly; never silent loss.

## 12. Empty "Unsectioned" leading bucket is not a drop target

**What:** On a Task List board with sections, tasks whose placement sits before
the first section render in a synthetic leading "Unsectioned" bucket. That bucket
is only emitted when it actually contains rows
([src/renderer/lib/tasklist/taskListViewModel.svelte.ts](src/renderer/lib/tasklist/taskListViewModel.svelte.ts),
`sectionedView`), so when it is empty there is no dndzone to drag a task *above*
the first section (back into the unsectioned area).

**Why accepted (DRAG-7):** Sections are the organizing unit; the leading bucket
is a backward-compat construct for pre-section boards. Always rendering an empty
"Unsectioned" header would add visual noise to every sectioned board for a rare
gesture (and the host renders one dndzone per emitted `SectionView`, so an
always-present zone is a host change too). A task can still leave the first
section by being dragged into any other section.

**Impact:** Once the unsectioned area is empty you can't drag a task back into it.
Minor; it is a legacy bucket. A minimal always-present leading drop zone is a
possible future enhancement, not a correctness fix.

## 13. Hand-edited quoted `completed: "true"` reads as incomplete

**What:** A task's completion is read as a strict `fm.completed === true`
([src/renderer/lib/tasks/frontmatterReaders.ts](src/renderer/lib/tasks/frontmatterReaders.ts),
`FIELD_READERS.completed`) — a real YAML boolean (`completed: true` /
`completed: yes` both parse to `true`). If a file is hand-edited so the value is
the QUOTED STRING `completed: "true"`, it parses as the string `"true"`, which is
not `=== true`, so the row displays as **incomplete** even though the author meant
"done."

**Why accepted (COERCE-1):** A strict boolean read is correct for Filo-written
files (Filo always writes a real boolean) and deliberately avoids coercing
arbitrary strings (`"false"`, `"no"`, `"0"`) into a truthiness guess. Toggling the
checkbox once normalizes the value to a real boolean while preserving every other
key (the source-preserving engine).

**Impact:** A hand-edited quoted `completed: "true"` shows the task as incomplete
until the checkbox is toggled once. Rare (only hand-edited files); self-heals on
first toggle; never data loss — only a display mismatch.

## 14. Board post-write drift baseline is size-only (no content read-back)

**What:** After a successful `.board.json` self-write,
[src/renderer/lib/boards/boardWriteScheduler.ts](src/renderer/lib/boards/boardWriteScheduler.ts)
(`writeBoardFile`) refreshes the pre-write drift baseline only when the
post-write `vault:stat` **size** equals the bytes it wrote. The markdown gateway
(Audit-17 5.3, for notes below the 1 MB read-back threshold — see #15) and the
`.filo/` config scheduler (Audit-18 3.6) go further and read the bytes **back** to
also reject a *same-byte-count* foreign write that landed in the save→stat gap;
the board writer deliberately does **not**.

**Where:** the post-write `refreshBaselineAfterWrite` block in `writeBoardFile`.

**Why accepted (Audit-18 3.6):** A `.board.json` can be multi-MB and is rewritten
every 300 ms while a user drags tiles. A full content read-back on every save
would double the write-path IO on the hot path — a real perf cost — to close a
window that requires a foreign tool to write the *exact same byte count* to the
board file within the ~millisecond save→stat gap. The small `.filo/` configs pay
the read-back cheaply; whole-file board writes do not.

**Impact:** In the (extraordinarily narrow) case above, a foreign edit could be
adopted as Filo's own baseline and overwritten without a drift prompt on the next
save. The main-process watcher's **content-hash** reconcile pass (which compares
hashes, not just mtime/size) remains the backstop and re-surfaces such an edit.
Upgrade to a size-gated or hashed read-back if this ever bites in practice.

## 15. Markdown post-write read-back is skipped for notes ≥ 1 MB

**What:** After a successful `.md` self-write, the markdown gateway
([src/renderer/lib/vault/markdownFileWriter.ts](src/renderer/lib/vault/markdownFileWriter.ts))
refreshes the post-write drift baseline by reading the bytes **back** for notes
*below* `MARKDOWN_READBACK_BYTE_THRESHOLD` (1 MB) to reject a *same-byte-count*
foreign write that landed in the save→stat gap (Audit-17 5.3). For a note at or
above that threshold the read-back is skipped and only the post-write **size** is
checked, mirroring the board scheduler's whole-file decision (#14).

**Where:** the post-write `refreshBaselineAfterWrite` block in
`writeMarkdownFileImpl` (the `MARKDOWN_READBACK_BYTE_THRESHOLD` size-gate).

**Why accepted (Audit-18 5.4):** A markdown write is 300 ms idle-debounced and
bound by a 60-second timeout (`MARKDOWN_WRITE_TIMEOUT_MS`). A full content
read-back on every write doubles write-path IO; for multi-MB notes on a slow
volume (OneDrive/SMB/AV) that doubling can push a write past the timeout into
timeout-then-self-heal flapping. The 1 MB threshold keeps the read-back's
protection for the overwhelming majority of notes (typical task/note tiles) while
sparing large notes the IO doubling. The triggering case — a foreign tool writing
the *exact same byte count* to a ≥ 1 MB note within the ~millisecond save→stat gap
— is extraordinarily rare.

**Impact:** In that (extraordinarily narrow) case, a foreign edit to a ≥ 1 MB note
could be adopted as Filo's own baseline and overwritten without a drift prompt on
the next save. The main-process watcher's **content-hash** reconcile pass remains
the backstop and re-surfaces such an edit. Upgrade to a hashed read-back (no IO
doubling) if this ever bites in practice.

## 16. `documentStore` mutation-version maps grow per-docId until vault swap

**What:** The document store keeps two staleness-token maps,
`mutationVersions` and `bodyMutationVersions`
([src/renderer/stores/document.svelte.ts](src/renderer/stores/document.svelte.ts),
Audit-16 1.1), keyed by `docId`. They are **deliberately NOT pruned** when a
document is unloaded — only `clear()` (vault swap) empties them. A docId's entry
therefore survives `unloadDocument`, so an early write after the same file is
reopened still compares its scheduled version against the pre-unload high-water
mark and can't be mistaken for stale (the silent-drop class 1.1 closes). The
trade-off is that the maps accumulate one small `number` entry per distinct docId
touched during a session and only shrink on a vault swap.

**Where:** `mutationVersions` / `bodyMutationVersions` in
[src/renderer/stores/document.svelte.ts](src/renderer/stores/document.svelte.ts)
(declared with the `// allow-module-state` annotation; cleared together in
`clear()`).

**Why accepted (Audit-18 6.2):** Pruning an entry on unload would re-open the
post-reopen staleness hole 1.1 was written to close — a reopened doc's first
write would have no high-water mark to compare against, or worse, compare against
a reset-to-zero token and be skipped. Each entry is a single integer, growth is
bounded by the number of distinct documents opened in one vault session (already
bounded by the vault's file count), and every entry is released on the next vault
swap. There is no real-world session large enough for this to matter.

**Impact:** Negligible. Two `Map<string, number>` entries per distinct docId
opened this session, fully released on vault swap. No code change unless a real
memory complaint surfaces — at which point an LRU-with-floor (keep the last N
high-water marks) would close it without re-opening the 1.1 class.
