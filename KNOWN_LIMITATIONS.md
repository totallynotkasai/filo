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

**Impact:** On a pathologically slow disk or under aggressive antivirus, the OS
change event can arrive after both windows expire, so the app's own write is
classified as an external edit — surfacing a spurious "Reload / Keep local"
toast. This is a UX annoyance, **not** data loss. Monitor; widen the window only
if it bites in practice.

---

## 6. Minimap recomputes the whole board every drag frame (large boards)

**What:** The minimap (on by default) reads the entire `boardStore.tiles` map
and renders one absolutely-positioned DOM pip per tile. `boardStore.tiles`
re-derives through `getFullTiles`, which allocates fresh tile objects on every
drag frame, so the minimap's `activeMediaIds` set, bounding box, per-pip
`effectiveTileStyle` resolution, and all N pip nodes recompute each frame — not
just the tile that moved. The viewport also feeds the bounds, so `mapScale` /
offset (and therefore every pip's pixel position) can shift each frame too.

**Where:** [src/renderer/components/canvas/Minimap.svelte](src/renderer/components/canvas/Minimap.svelte)
(`allTiles`, `activeMediaIds`, `bounds`, the pip `#each`). Root cause: the
referential churn of `getFullTiles` in
[src/renderer/stores/board.svelte.ts](src/renderer/stores/board.svelte.ts) (`tiles`).

**Why deferred (not a permanent trade-off):** A minimap-local memo can't fix
this on its own — a content-keyed pip cache still can't skip the viewport-driven
`mapScale` reposition, and skipping `effectiveTileStyle` per pip needs a stable
per-tile identity that `getFullTiles` doesn't provide. The robust fix is the
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
