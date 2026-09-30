# Filo — Known Limitations

These are **deliberate, accepted trade-offs**, not bugs. They follow from Filo's
core design principles (open format, local-first, no sidecar files) or from
platform constraints. They are documented here so they aren't repeatedly
re-discovered and "fixed" — changing any of them needs a design discussion, not
a patch. (Cross-referenced from the audit's Appendix C, "do NOT fix".)

If you hit one of these and believe the trade-off should change, open a design
note rather than a quick fix — each entry lists why it is the way it is.

---

## 1. Frontmatter full re-dump — only for new files (and a few narrow cases)

**What (Phase 6 — root cause deleted, not patched):** Filo's frontmatter writes
go through a single-parser, source-preserving **CST-operations engine**
(`frontmatterCstModel.ts`, built entirely on the `yaml` package). It tokenises
the on-disk frontmatter source, rewrites ONLY the keys whose value actually
changed, and emits every UNTOUCHED key from its own source tokens —
byte-for-byte. Comments, key order, quote/indent style, exotic scalars (`02134`,
`0xFF00FF`, `1_000`), AND untouched folded `>` block scalars all survive a
metadata edit verbatim. Every note write takes this path: the note writer reads
the file fresh at each flush and patches that source, and the tag rewriter's
fallback uses the same engine.

Six audits fought a recurring corruption class here (DI-01 unquoted date→ISO,
DI-05 destroyed `<<` merge keys, R1/M2 canonicalised untouched scalars, C1
bare-key collapse, DI-06 folded-scalar reflow). The shared root cause was a
**dual-parser object-vs-source diff plus a hand-rolled byte-splice** (js-yaml for
the compare, the `yaml` package for the emit) — two libraries that disagreed on a
handful of scalar forms. Phase 6 replaced that machine with the single-parser CST
engine, so the class is **structurally gone, not guarded**. The
`no-jsyaml` gate keeps js-yaml out of the app entirely (tests keep it only as an
independent oracle).

**Residual full re-dump:** When the engine has no on-disk source to preserve,
or can't safely patch the source, it emits a full dump
(`new Document(fm).toString()` — the `yaml` package, no js-yaml). This fires for:
a brand-new file, or the first keys added to a file with no frontmatter (there
are no comments to lose); a FLOW mapping root (`{title: X}`), which the engine
can't patch as a block mapping; or a CHANGED / DELETED key carrying a YAML
anchor/alias or an explicit tag (the engine refuses the splice rather than
dangle an alias — L27, and the dump expands the anchor to a concrete value).

The dump is written from the parsed core-schema values, so it is NOT lossless
by nature: `02134` would come back as `2134`, `1.10` as `1.1`, `0xFF00FF` as
`16711935`, and an explicit `!tag` would be dropped. So every dump of an
existing block is checked first (`dumpPreservesUntouched` in
`frontmatterCstModel.ts`): each key the edit didn't touch must say exactly what
it said before (a string may change its quoting, a null its spelling). If one
doesn't, the edit is refused and the block kept byte-for-byte, with the "saving
it would also change other values" toast. The same check guards the tag
rewriter's dump. What a dump that passes can still lose is formatting only:
comments, key order, flow style, anchors expanded to their values.

**Refused instead of dumped:** a block that doesn't parse, one with a
non-scalar key, and one that parses but isn't a mapping (a paragraph between
two leading `---` rules reads as a scalar; a list) are kept byte-for-byte and
the metadata edit is refused with a toast, because a dump would delete what
they hold. A comment-only block is patched normally (the comment stays). The
note writer also refuses any write that would turn a block that parses into
one that doesn't (gate `frontmatter-parse-preserved`).

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
  (removing the last tag in a Document tab's tag row, or a card/task field
  edit that empties a value) also drops a standalone comment line immediately ABOVE that key. A
  comment conventionally documents the key it precedes, so it is removed WITH the
  key rather than relocated onto the next surviving key — where it would
  mis-document an unrelated field — or left dangling at the document end.
  Inter-key blank-line spacing survives; only the comment line(s) the deleted key
  owned are dropped (`gapWithoutCommentLines` in `frontmatterCstModel.ts`). This
  was a deliberate trade-off introduced with the L4 delete-handling work
  (relocating mis-documents the survivor); option (b) — relocate to a trailing
  block instead of dropping — is tracked if dogfooding shows users rely on
  frontmatter comments.
- **Touched anchored or tagged key.** Changing or deleting a key carrying
  `&a`/`*a` or a `!tag` full-dumps (structure expanded), provided the dump
  keeps every untouched value exact; otherwise the edit is refused. An
  anchor/alias confined to UNTOUCHED keys is spliced verbatim and survives
  (DI-05's `<<: *base`).
- **New file.** Emitted in the `yaml` package's default style
  (nothing prior to preserve).

**Where:** [src/renderer/lib/vault/frontmatterCstModel.ts](src/renderer/lib/vault/frontmatterCstModel.ts)
(the engine) + [src/renderer/lib/vault/frontmatterEngine.ts](src/renderer/lib/vault/frontmatterEngine.ts)
(shared value helpers). The note writer
([src/renderer/lib/notes/noteWriter.ts](src/renderer/lib/notes/noteWriter.ts))
reads the file fresh at each flush and passes its frontmatter source through
`assembleNoteText` ([src/renderer/lib/notes/noteFile.ts](src/renderer/lib/notes/noteFile.ts))
→ `assembleMarkdownFile` in
[src/renderer/lib/editor/markdownSync.ts](src/renderer/lib/editor/markdownSync.ts).

**Impact:** Negligible — hand-authored YAML comments/formatting (including
untouched folded scalars) survive a metadata edit on any note. Only a new
file's first keys, a changed nested block's inner
comment, or a touched anchored key is emitted in the package's default style, and
deleting a key also drops the comment line that documented it. A metadata edit
that could only land by changing another value is refused, never applied.
File *content* is never lost.

---

## 2. Attachment tags are vault-local

**What:** A note's tags live only in its YAML frontmatter (`tags: [...]`), so
they travel with the `.md` file. Attachment tags (image / video / audio /
generic file) have nowhere to write into the file itself, so their only copy is
`.filo/tags.json` (`fileTags[mediaPath]`). Board files hold no copy of either.
The attachment's tags follow the file across boards, and follow in-app renames
and moves.

**Where:** Persistence boundary documented in
[CLAUDE.md](CLAUDE.md); tag storage in
[src/renderer/stores/fileTags.svelte.ts](src/renderer/stores/fileTags.svelte.ts) and
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
`.filo/.dirty.<machineId>` sentinel + recovery flow covers the broader crash case.

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
This is exactly the case the `.filo/.dirty.<machineId>` sentinel detects — recovery is
offered on next launch.

**The 5 s bounds inter-beat SILENCE, not the drain:** the
renderer beats `app:drain-heartbeat` every ~2 s while it drains, and each beat
re-arms main's timer. Since each atomic write may now wait up to ~5 s for a
Windows file lock (OneDrive / antivirus) before failing, a drain of N serialised
locked writes can take up to about N × 5 s; the absolute
`QUIT_DRAIN_DEADLINE_MS` (60 s) still bounds it, after which the "Save failed"
dialog offers **Retry now** (re-fires every retained failed write), **Quit
anyway** or **Stay open**. The dialog names each file and why it wasn't saved
(locked, no longer exists, waiting for a conflict answer, not UTF-8), and
**Quit anyway** first writes rescue copies of the unsaved text to
`.filo/recovery/<timestamp>-unsaved/` (#33).

**Windows shutdown, restart or sign-out** closes neither the window nor the
app first, so the quit flush above doesn't run. The renderer keeps main told
whether leaving now could lose work (anything unsaved, a question waiting for
an answer, unapplied Settings, a focused text field). Only then does main hold
the session back (Windows shows its "Filo is preventing shutdown" screen) for
at most about 4 s, while the renderer saves and writes rescue copies of what
is left, unapplied Settings and theme-editor edits included
(`_filo__*.unapplied.json`), with no dialog; then Filo exits and Windows goes
on. Choosing **Shut down anyway** on that screen, or a shutdown Windows
doesn't let apps delay, ends Filo mid-save: whatever wasn't written is named
by the dirty sentinel, as after a crash. Text typed in the last second before a
forced shutdown may not have been reported yet
([src/main/services/sessionEnd.ts](src/main/services/sessionEnd.ts),
[src/renderer/lib/vault/handleSessionEnding.ts](src/renderer/lib/vault/handleSessionEnding.ts)).

---

## 5. Self-write suppression window can misfire on a very slow disk (board and `.filo/` files)

**Notes are no longer affected.** The note writer remembers the content hash of
each write it makes, and the note store ignores a watcher event whose bytes
match one of those hashes or the note's current base
([src/renderer/lib/notes/noteWriter.ts](src/renderer/lib/notes/noteWriter.ts)
`isOwnWrite`, [src/renderer/lib/notes/noteDiskChange.ts](src/renderer/lib/notes/noteDiskChange.ts)).
A late echo of a note write is therefore recognised however late it arrives
while the note is open; for a closed note it only re-indexes the same metadata.
Moving this hash check into the main-process watcher (so the echo is never sent
at all) was not done; it would only save work, not change behaviour.

**What (still open):** For `.board.json` and `.filo/` config files, Filo
suppresses its own file-watcher echo with time windows so it isn't reclassified
as an external edit. Two layers: the main-process watcher suppresses for
~500–2000 ms (`FileWatcher.suppress`; for boards `suppressWrite`, which drops
only Filo's own bytes), and a renderer-side registry holds each
path for `RECENT_SELF_WRITE_TTL_MS = 1500` ms (or
`RECENT_SELF_WRITE_TTL_BULK_MS = 5000` ms while a bulk write is in flight).

**Where:** [src/renderer/lib/boards/writeStateTracking.ts](src/renderer/lib/boards/writeStateTracking.ts)
(recent-self-write registry) + the main-side `FileWatcher.suppress`.

**Why accepted:** The windows are sized for normal and bulk (200-file tag
rename) workloads. Widening them unconditionally would slow genuine external-edit
detection.

**Audit-13 M4 — in-window handling is content-aware, not time-only:** A watcher
event for a recently self-written board path is not suppressed by the timer
alone. The board reconciler
([src/renderer/stores/vaultExternalReconcilers.ts](src/renderer/stores/vaultExternalReconcilers.ts))
drops it ONLY when the file's fresh disk stat still matches the baseline Filo
wrote (`selfWriteDivergedFromBaseline` → `hasBaselineDrifted`); a diverged
mtime/size means a *second* writer touched the file inside the window, so the
event is kept and reconciled. So a genuine external edit that lands inside the
suppression window is **not** dropped — only the benign direction below remains.

**Impact:** On a pathologically slow disk or under aggressive antivirus, a
board or config self-write's OS echo can arrive *after* the recent-self-write
window has expired (`isRecentSelfWrite` already false), so the app's own write
is classified as an external edit — surfacing a spurious "Reload / Keep local"
board toast. This is a UX
annoyance, **not** data loss (and, per M4 above, never a *dropped* external
edit). Monitor; widen the window only if it bites in practice.

**Audit-19 EXT-5 — slower renames:** a write whose rename waits out a Windows
file lock can land up to ~5 s late. Main's pre-write suppression now covers that
(`LOCK_AWARE_SUPPRESS_MS` = the lock budget + 2 s), but the renderer's
recent-self-write TTL can still expire first; for boards the baseline-divergence
tie-break (Audit-15 P2.4) then drops the echo because the disk stat matches what
Filo wrote. Notes use the content-hash check above.

**Board writes hide only their own bytes; `.filo/` files still hide by time.**
`board:save` and `board:create` suppress with `suppressWrite` and the bytes
written, as note writes do, so another program's board write inside main's
window (`LOCK_AWARE_SUPPRESS_MS`, about 7 s on Windows) is reported at once.
The `.filo/` config, tags and template handlers still use the time-only
`suppress`: a config file rewritten by another program within those seconds of
a Filo save raises no event, and nothing is shown until Filo next writes that
file. It is still never overwritten: every config write goes through a drift
check first (`writeConfigs`, `saveMiscConfig`).

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

(See also #19: a rename to a sync-conflict-shaped name is never auto-relinked.)

**What:** When a file is renamed *outside* Filo, the watcher emits a `delete` +
a `create`; `renameCorrelation` pairs them back into a rename so tile references
follow the new name. To avoid pairing two genuinely-unrelated files by
coincidence, cross-basename correlation (the name actually changed, e.g.
`git mv clip.mp4 final.mp4`) is **refused** at the size extremes:

- **< 256 B** (`CROSS_BASENAME_MIN_SIZE_BYTES`) — too many small files share an
  exact byte-length for size to be evidence, so a small file pairs only on a
  whole-content hash match. The old side's hash comes from the watcher's cache,
  which holds notes (`.md`) and board files only, so a small note is followed
  but a small attachment is not. Empty files never pair.
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

## 8. (Closed) Vault-wide tag rename could drop keystrokes typed *during* the sweep

**Closed.** The sweep
([src/renderer/lib/vault/tagRewriteSweep.ts](src/renderer/lib/vault/tagRewriteSweep.ts))
now writes each note through `noteStore.transform`. That first asks every open
view of the note to hand over its current text, writes anything queued for the
note, and only then rewrites the tag on a fresh read of the file, inside the
note's own write queue. The rewrite touches only frontmatter, and an open
editor never loads over keystrokes it hasn't handed over yet, so text typed
while the sweep runs is kept. Pinned by
`src/tests/unit/noteTransformViews.test.ts` ("writes a view's unsaved typing
first, so the rewrite never reverts it").

## 9. (Closed) Field/FM delta write read body and frontmatter from two separate disk reads

**Closed.** Every note write now reads the file once, inside the path's write
queue, and applies the queued change to that one read
([src/renderer/lib/notes/noteWriter.ts](src/renderer/lib/notes/noteWriter.ts)).
A frontmatter-only change keeps the body exactly as it is on disk; a body
change is written only if the body on disk still matches the one the edit was
built on, and otherwise becomes the Reload / Keep mine prompt. There is no
second, earlier read left to disagree with.

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

Iframes are denied every browser permission (camera, microphone, geolocation,
notifications, clipboard, …). Only the app document itself may request
microphone audio, for the Audio tile
([src/main/utils/permissionPolicy.ts](src/main/utils/permissionPolicy.ts)).

An embedded page can ask to open a link in a new window (`target=_blank`,
`window.open`). Filo never opens a window; such a link goes to the default
browser if it is a public `https://` address, at most one a second
([src/main/utils/embedPopup.ts](src/main/utils/embedPopup.ts)). So an embedded
page can open a public https page in the browser once per click, as the link
in a note can.

## 11. Partial-read guard can briefly refuse a save for a body that legitimately starts with `---`

**What:** The note writer's torn-read guard (`looksTorn` in
[src/renderer/lib/notes/noteWriter.ts](src/renderer/lib/notes/noteWriter.ts))
refuses to write when a note last known to have frontmatter is read back with
an opening `---` fence but no closing fence. It assumes a non-atomic external
writer was caught mid-write, and refusing protects the on-disk frontmatter from
being stripped. The writer re-reads three times (40 / 120 / 300 ms) and then
fails the save loudly. If frontmatter was instead *legitimately* removed by an
external editor AND the new body's first line happens to be a `---` thematic
break (a horizontal rule), the guard mis-reads that stable shape as a partial
read.

"Last known to have frontmatter" comes from the open note's base, else the vault
index. Both catch up with the external change: an open note re-reads after
500 / 1,500 / 3,000 ms and then takes a still-torn-looking file as it is, and
the vault index re-reads a closed note on the watcher event. After that the
guard no longer applies and saves go through.

**Where:** `looksTorn` and its callers in `noteWriter.ts`; the disk-change retry
(`TORN_RETRY_MS`) in [src/renderer/stores/notes.svelte.ts](src/renderer/stores/notes.svelte.ts).

**Why accepted (Audit-15 P2.3):** It fails **safe** — the refusal is loud
(`markPathFailed` + a "save failed" surface), no data is lost, and the on-disk
file is untouched. Every attempt to distinguish "stable FM-removed body that
starts with `---`" from "genuine partial read" using only the read is
undecidable: a size heuristic (e.g. "read is < ½ the prior byte size") lets a
truncated read of *most* of a small file through, which re-opens the
HIGH-severity Audit-14 3.3 silent-frontmatter-drop (the `deltaWriteEolTruncation` "refuses
… truncated" test pins exactly that 25-of-38-byte case). For a data-integrity
guard, "never silently drop frontmatter" correctly wins over "never show a
spurious toast."

**Impact:** A save made in the first few seconds after another program removed a
note's frontmatter, on a note whose body now starts with `---`, can fail with a
"save failed" message. The edit stays queued and a later save or Retry goes
through. Rare; surfaced loudly; never silent loss.

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
post-write `vault:stat` **size** equals the bytes it wrote. The `.filo/` config
scheduler (Audit-18 3.6) goes further and reads the bytes **back** to also reject
a *same-byte-count* foreign write that landed in the save→stat gap; the board
writer deliberately does **not**. (Notes work differently: see #15.)

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
hashes, not just mtime/size) remains the backstop and re-surfaces such an edit:
after Filo's own write it moves its snapshot on only when the file holds the
bytes Filo wrote (`advanceReconcileSnapshot` in
[src/main/services/fileWatcher.ts](src/main/services/fileWatcher.ts)), so a
foreign write in the gap, even one carrying an old modification time as a sync
client's does, is still reported. Above the watcher's 10 MB hash ceiling the
snapshot compares size only.
Upgrade to a size-gated or hashed read-back if this ever bites in practice.

**Board encoding:** boards are plain JSON objects (main writes the renderer's
serialised payload verbatim, so the size check above actually matches). A
double-encoded board (a JSON string literal) is not loaded; see #29.

## 15. A foreign write in the last milliseconds before Filo's can be overwritten (boards and `.filo/` settings)

**What:** Notes are covered by a compare-and-swap in the main process: the
note writer passes the stat (and, up to 2 MB, the hash) of the read it builds
on to `vault:write-existing-file-text`, and `atomicWriteFile` re-checks it just
before every rename, refusing with `STALE` if the file changed (gate
`note-write-expects-stat`). What remains there is the gap between that check
and the rename itself, inside one main-process call.

Boards (`board:save`) and `.filo/` settings (`config:save`) have no such check
in main. Their writers stat the file in the renderer against its drift
baseline before writing
([boardWriteScheduler.ts](src/renderer/lib/boards/boardWriteScheduler.ts),
[configDrift.ts](src/renderer/lib/boards/configDrift.ts)); a foreign write that
lands after that stat and before the write's rename is overwritten. The board's
post-write check sees only a size (#14), so a same-size write in that gap goes
unnoticed.

**Why accepted:** The gap is one IPC round trip plus one atomic rename on the
same machine, a few milliseconds. A second writer would have to save the same
board or settings file in that window; with one editing machine and a sync
client that delivers whole files, that doesn't happen in practice.

**Impact:** Very narrow. If it ever bites, pass the pre-write `{ mtimeMs, size }`
(and the hash under 2 MB) into `board:save` / `config:save`, have
`atomicWriteFile({ expectStat })` refuse with `STALE`, and route `STALE` into
the drift question.

## 16. (Closed) `documentStore` mutation-version maps grew per note until vault swap

**Closed.** The document store is gone. Notes are held by `noteStore`
([src/renderer/stores/notes.svelte.ts](src/renderer/stores/notes.svelte.ts)),
one reference-counted `NoteModel` per open note; a model is dropped once its
last view releases it and nothing for it is left to write, and staleness is decided by comparing file content
(the model's base) rather than by per-note version counters that had to outlive
the document.

## 17. Lossy notes open read-only (and bare URLs are plain text)

**What:** When a save from Filo's editor would change what a note says
(`isLossyMarkdownRoundTrip`), the note opens **read-only**: the editor is
non-editable and toolbar commands are refused (a read-only note that only
refused the save would silently discard what was typed). The banner names the
first line a save would change ("Line 12 would change from … to …", "Line 7
(…) would be dropped", "Saving would add a blank line above line 4") and
offers **Edit in Raw view** (opens the whole file with that line selected, to
fix by hand) and **Take ownership**, which re-enables editing after a confirm
listing up to three lines that will change; the next save then rewrites the
formatting Filo can't preserve.

**How "would change" is decided.** Filo serialises the loaded note and
compares it with the file. A difference in the list of spellings below is
cosmetic. Anything else is compared as markdown-it (the parser the note is
loaded with) reads it (`lib/editor/renderedSame.ts`): when both render the same
HTML, the difference is only spelling and the note opens editable. Two things
the HTML doesn't show still count: link reference definitions (a save that
dropped one would pass unseen), and a backslash the file didn't have in front
of a character other Markdown apps give meaning to (`[`, `]`, `!`, `#`, `=`,
`$`, `^`, `|`, `~`…), since Obsidian reads `\[\[Page\]\]` differently from
`[[Page]]`. A line the file already holds is written as the file spells it,
escapes and all (`lib/editor/minimalEscapes.ts`), so `[[wiki links]]`,
`![[embeds]]`, `> [!note]` callouts, `[TODO]`, footnotes `[^1]`,
`C:\Users` paths and `![alt](My Pic.png)` image paths with a space all save
byte for byte. On a line you edit, and in text you type, `*`, `_`, `[`, `]`,
`#`, `~` and `\` are written without a backslash wherever the note reads back
the same, so a wiki link on the line you are typing in stays a wiki link.

Formats that still trigger read-only (a save would change what the note says):

- HTML comments and block HTML (`<div>`, another app's `<p align="center">`),
  which the editor drops;
- link reference definitions (`[1]: https://…`), used or not: they render
  nothing, and a save would drop them (a used one's link written inline);
- inline code inside bold, italic or a link (``**`npm run`**``,
  ``[`CLAUDE.md`](CLAUDE.md)``): the editor's inline code can't carry other
  formatting, so a save would drop the bold or the link from it;
- a **tight** list that mixes bullets and checklist items (`- a` then
  `- [ ] b`), from another app: it loads as two lists (no filler checkbox),
  and Filo would write them as two (`- a`, blank line, `* [ ] b`); the banner
  names the blank line it would add;
- a list item an earlier Filo aligned (below).

No longer read-only: filenames, bare domains, emails and bare URLs
(linkify is off; a bare URL in the file stays text when the note loads, even
as the last word of its first paragraph, and only a URL typed in Filo becomes
a link), `filo://` internal links, tight checklists, GFM table **padding**
differences, the `1)` ordered-list delimiter, a tab before a line break, and
the everyday Keep and Obsidian shapes in the table below (a list, heading,
quote, fence or table straight under a line of text; `1. 1. 1.` numbering; a
lazy continuation line; an unspaced `***`).

Also no longer read-only: **lines separated by a single newline** (notes typed
one line per thought, Keep and Canvas exports, hard-wrapped paragraphs,
multi-line quotes). A single newline inside a paragraph loads as a soft break
(`lib/editor/softBreak.ts`): the editor shows it as a line break, as Obsidian
and Keep do, and writes it back as a bare newline. And **asterisks,
underscores and brackets Markdown reads as text** (`5 * 3`, `2** - notes`, a
`***` or `___` placeholder, `[TODO]`): a save writes them without a backslash
wherever the note reads back the same (`lib/editor/minimalEscapes.ts`), and a
line the file
already holds is written as the file spells it (`5 \* 3` keeps its escape, two
identical lines keep their own escapes each).

Also no longer read-only (each was something Filo itself
wrote and then couldn't read back): an empty checkbox (Enter after the last
task), one bullet turned into a checklist item (Ctrl+Shift+9), spaces typed at
the start of a line, a `|` typed in a table cell, a list or heading in a table
cell (now an HTML table), code holding a line of backticks, a line break in a
heading, a lone `+` or `1.` line, a heading ending in ` #`, lines typed in the
Task List notes box; and from other apps, aligned GFM tables and `~~~` or
longer code fences. A loose mixed list an older Filo wrote (`- a`, `- [ ] b`,
`- c` with blank lines between) now opens editable too, and is split into three
lists on the next save.

**Aligned and indented paragraphs are HTML in the file.** Markdown has no way
to write alignment or indent, so a paragraph or heading aligned or indented from
the toolbar is saved as one HTML line, e.g.
`<p style="text-align: center;">Some <strong>bold</strong></p>`. Inside that line
the formatting is HTML too (a Markdown parser doesn't read Markdown inside a
block HTML tag). Every other block stays Markdown. Most Markdown apps show such
a paragraph aligned; a plain text editor shows the HTML. Filo reads back only
the `style` form it writes: another app's `<p align="center">` is block HTML
Filo can't reproduce, so that note opens read-only (list above). **Text in a
list or checklist item can't be aligned or indented** (the toolbar's Align
control is disabled there, and Indent nests the item instead): as an HTML line
it swallowed the item's sub-items. A list item an earlier Filo did align
(`- <p style="text-align: center;">…</p>`) opens read-only, and Take ownership
saves it as a plain item. Line spacing
applies to the whole note and is saved as one frontmatter key
(`lineSpacing: 1.5`), not in the body; other apps ignore it and show their own
spacing.

**Filo restyles other apps' Markdown on the first edit.** So that notes from
Obsidian and other apps don't open read-only, the lossy check treats these as
the same, and the first body edit rewrites each into Filo's form:

| On disk | Written by Filo |
|---|---|
| `_italic_` | `*italic*` |
| `__bold__` | `**bold**` |
| `* * *`, `***`, `___`, `- - -` | `---` |
| Setext headings (`Title` over `===` / `---`) | `# Title` / `## Title` |
| `1)` ordered lists | `1.` |
| `+` or `*` bullets | `-` |
| two-space hard breaks | backslash hard breaks (`\` at line end) |
| trailing spaces, 3+ blank lines, table cell padding | removed / collapsed |
| `~~~` code fences, or a fence longer than it needs to be | backticks, three unless the code holds a line of backticks |
| table alignment `:--` / `--:` | `:---` / `---:` |
| a list right after another bullet or checklist list | the other bullet (`-` then `*`), so the two stay two lists |
| a list, heading, quote, code fence, rule or table straight under a line of text (or text straight under a heading) | a blank line between them |
| `1. 1. 1.` or `01. 02.` numbering | `1. 2. 3.` |
| a lazy continuation line (`> a` / `b`, `- a` / `b`) or a line indented under a paragraph | the quote's `> ` or the item's indent; the paragraph line unindented |
| `<` / `>` in text, entities such as `&copy;` | `&lt;` / `&gt;`, the character itself |
| a `"` in a link address | `%22` |
| a tab opening a heading or list item, inline code padded with a space each side | removed |

The blank lines between a note's frontmatter and its text are kept as the
file has them.

Nothing is lost, but a note you edit gets a formatting diff that sync tools and
git will show, including lines you didn't touch. A note you only read is never
written.

**Where:** `normaliseForRoundTripCompare` in
[src/renderer/lib/editor/markdownSync.ts](src/renderer/lib/editor/markdownSync.ts)
and `rendersSame` in
[src/renderer/lib/editor/renderedSame.ts](src/renderer/lib/editor/renderedSame.ts);
the editability `$effect` in `TextTile.svelte` / `DocumentEditor.svelte`;
`chainIfEditable` in `lib/editor/toolbarConfig.ts`. Pinned by
gate `editor-body-discipline`.

**Why accepted:** Editing a note Filo would rewrite is the silent-loss class the
open-format principle forbids; making it honest (non-editable) is the safe
default, and Take ownership is an explicit, confirmed opt-in.

**Raw view:** a lossy note can still be edited without Take ownership through
the Document tab's **Raw** toggle. The raw view edits the file's text directly
and never passes it through the editor, so it can't lose formatting (see #30).

**Bare URLs:** with linkify off, a bare `https://…` already on disk round-trips as
plain text and is no longer rendered as a clickable link; wrap it as `<url>` or
`[text](url)` to make it a link. Typing next to a bare URL can still autolink it
once whitespace follows (an explicit scheme is present); opening a note never
does.

---

## 18. Sync conflict copies: only the documented English names are recognised

**What:** Filo recognises the conflict names OneDrive (`Note-<DEVICE>.md`, for a
device that has opened the vault or a Windows default `DESKTOP-XXXXXXX` /
`LAPTOP-XXXXXXX` name), Dropbox / Nextcloud (`(… conflicted copy …)`,
`(Case Conflict)`, `(Selective Sync Conflict)`), Syncthing
(`.sync-conflict-…`), Google Drive (` (1)`) and iCloud (` 2`) give the second
copy of a file. Weak shapes (` (1)`, ` 2`) only count when the original sits
alongside.

**Where:** [src/shared/conflictCopy.ts](src/shared/conflictCopy.ts).

**Why accepted:** Localised client strings (e.g. Dropbox's German
"Kopie mit Konflikt") and arbitrary `-WORD` suffixes are not matched, because
matching them would misread names users pick themselves (`Meeting-Notes.md`,
`Report (2).md`). An unrecognised copy is simply an ordinary file (the pre-Audit-19
behaviour).

**Impact:** A conflict copy with a localised name is not flagged, and could win a
duplicate-board-id tie-break on freshness.

---

## 19. Renames that look like sync-conflict names are not auto-relinked

**What:** When a file disappears and a same-content file appears whose name is a
conflict copy of the missing one (`Note.md` → `Note-<your device>.md`,
`Note (1).md`), the rename correlator refuses to pair them (Audit-19 EXT-2): that
is exactly how OneDrive resolves a conflict, and pairing them would rebind every
tile to the losing copy.

**Where:** `correlateRenames` in
[src/main/services/renameCorrelation.ts](src/main/services/renameCorrelation.ts).

**Why accepted:** A user genuinely renaming a note to such a name is rare; it
degrades to delete + create, which is non-destructive (the missing-file prompt
keeps tiles by default and offers a relink). See also #7 for the size-based
relink limits.

**Impact:** After such a rename the old tiles show as missing until relinked.

---

## 20. Run the same Filo version on every machine that opens a synced vault

**What:** The crash-recovery sentinels in `.filo/` are per machine
(`.filo/.dirty.<machineId>`, `rename-cascade-pending.<machineId>.json`,
`tag-rewrite-pending.<machineId>.json`, `quit-failure.<machineId>.json`), so two
machines syncing one vault never clear, prompt for or resume each other's
recovery state. A bare shared name (`.filo/.dirty`) is not a sentinel: nothing
reads or writes it. The trash purge is per machine too: each machine only purges
the `.filo/trash` items it trashed itself (`machineId` in the manifest).

**Where:** [src/shared/sentinelPaths.ts](src/shared/sentinelPaths.ts),
`assertNotInFiloDir` in [src/main/utils/pathSecurity.ts](src/main/utils/pathSecurity.ts).

**Why accepted:** An older Filo build on another machine uses other file and
board formats. It can't open v8 boards (#29) and may write shared sentinel names
this build ignores. There is no cross-version coordination, because Filo hasn't
shipped a stable format before this one.

**Impact:** Update every machine before opening a synced vault with this build.

## 21. Non-UTF-8 notes are read-only; conversion assumes Windows-1252

Filo reads every note as UTF-8. A file whose bytes aren't valid UTF-8 (a legacy
Windows-1252 note, a "Unicode" UTF-16 Notepad file) is shown with replacement
characters for the bad bytes, is frozen read-only with a "Convert to UTF-8…"
banner, and main refuses every generic text write to it (`NOT_UTF8`). The note
writer never writes it either, the Document tab's Raw view shows it read-only,
and a vault-wide tag rename skips it and names it in a toast.

**Where:** `readFileWithCoherentStat` in [src/main/vault/fileOps.ts](src/main/vault/fileOps.ts),
[src/main/services/nonUtf8Registry.ts](src/main/services/nonUtf8Registry.ts),
[src/main/ipc/vaultEncoding.ipc.ts](src/main/ipc/vaultEncoding.ipc.ts). Pinned by
gate `utf8-validated-read`.

**Why accepted:** There is no reliable way to guess a legacy code page. The
convert action backs up the original bytes to `.filo/recovery/` and decodes them
as Windows-1252, the common Windows default. Other single-byte encodings (e.g.
Latin-2, KOI8-R) will come out wrong, and UTF-16 is refused outright.

**Impact:** For a non-1252 legacy note, re-save it as UTF-8 in another editor
instead of converting. If a conversion comes out wrong, restore the backup from
`.filo/recovery/`.

## 22. Vault paths deeper than 64 folders or longer than 4096 characters are refused

Every renderer-requested path is checked by `assertSafeRelativePath`: at most
64 segments and 4096 characters in total. Deeper or longer paths are refused
on every read, write and rename.

**Where:** `MAX_VAULT_PATH_DEPTH` / `MAX_VAULT_RELATIVE_PATH_LENGTH` in
[src/main/utils/pathSecurity.ts](src/main/utils/pathSecurity.ts).

**Why accepted:** it is a bound on pathological payloads, set far beyond any
real folder structure. Windows MAX_PATH (260) does not apply, because Node uses
`\?\` paths for its own file IO. Separately, a single name is limited to 255
characters: long names still save, because the temporary file of an atomic
write shortens its base name to fit, within 255 UTF-16 units and 255 UTF-8
bytes (`tmpSiblingPath` in
[src/main/vault/filenameUtils.ts](src/main/vault/filenameUtils.ts)). Names that
main generates itself (new board files, new folders, imported fonts) are
trimmed to 200 characters (`sanitizeFilename`).

**Impact:** none for normal vaults. A tree nested more than 64 levels deep
shows in the sidebar but can't be opened from Filo.

## 23. Integer fields above 2^53 − 1 make a board (or tags / template file) invalid

Zod 4's `.int()` accepts only *safe* integers. A board, `.filo/tags.json` or
layout template with an integer above `Number.MAX_SAFE_INTEGER` in one of these
fields fails validation:

- placement `position` (Kanban cards, Task List tasks), Kanban column
  `position` and `wipLimit`, Task List section `position`, tile group
  `displayIndex`;
- the `version` of `.filo/tags.json` and of layout templates, and template
  connection tile indexes.

**Where:** the schemas in [src/renderer/schema/](src/renderer/schema/). Pinned by
`src/tests/unit/zodSafeIntegerBoundary.test.ts`.

**Why accepted:** such a value can't be represented exactly as a JavaScript
number, so every reorder would silently corrupt it. Refusing is the honest
outcome. Filo never writes such values; only a hand-edited or damaged file
has them.

**Impact:** the board is refused on load (`schema-invalid`): its bytes are copied
into `.filo/recovery/` and a toast names the file, and Filo never writes to it.
Fix the number in a text editor and reopen the vault.

## 24. Filo's trash lives in the vault, so it syncs

**What:** Every user-facing delete moves the item into
`.filo/trash/<trashId>/files/<originalPath>` inside the vault, next to a
`manifest.json`. A vault kept in OneDrive, Dropbox or another sync client
therefore uploads trashed items like any other file, and they count against the
sync quota and bandwidth until they leave the trash. Items leave it when you
Restore or Empty trash in Settings → Trash, or through the 30-day purge on vault
open. The purge only takes items the *current* machine trashed (`machineId` in
the manifest), so an item trashed on a machine that never opens the vault again
stays until someone empties the trash by hand.

**Where:** [src/main/vault/trashOps.ts](src/main/vault/trashOps.ts)
(`TRASH_RETENTION_MS`, `purgeTrash`),
[src/renderer/stores/trash.svelte.ts](src/renderer/stores/trash.svelte.ts)
(`purgeExpiredTrash`), [src/renderer/components/settings/TrashSettings.svelte](src/renderer/components/settings/TrashSettings.svelte).

**Why accepted:** Keeping the trash inside the vault makes undo a plain rename
on the same volume: atomic, any file type or size, no copies held in memory. A
trash outside the vault would need a cross-volume copy and would not travel
with the vault. The watcher ignores `.filo/trash/`, so trashed items never show
as vault files.

**Impact:** Large deleted files keep using sync space for up to 30 days. Empty
the trash from Settings → Trash to free it sooner.

## 25. The Recycle Bin hand-off has not been tested on every kind of drive

**What:** Emptying Filo's trash and the 30-day purge hand each item to the OS
Recycle Bin (`shell.trashItem`). On some volumes the Recycle Bin may refuse, or
may delete without saying so.

**Probe results (2026-09-25, Windows 11, OneDrive personal, Electron 44.4.5,
dev binary; the same `shell.trashItem` call the packaged build makes):**

| Item in a OneDrive folder | `shell.trashItem` | Where it went |
|---|---|---|
| A normal (downloaded) file | succeeded | Windows Recycle Bin |
| A folder with two files | succeeded | Windows Recycle Bin |
| An **online-only** placeholder (`attrib +U -P`) | succeeded, no error | **Not** in the Windows Recycle Bin. OneDrive handles the delete itself: the file goes to OneDrive's own recycle bin on the web, per OneDrive's documented behaviour. The probe didn't check the web side. |

The same probe checked the trash **restore** move, which hard-links a file into
place (`fs.link`) and then unlinks it from the trash:
- a hard link works in a OneDrive folder, for a normal file and for an
  online-only one, and stays a placeholder;
- a link onto an existing file fails with `EEXIST`, so a restore never replaces
  a file.

**Not probed:** a mapped network share and a FAT32 USB stick (none on the test
machine). On those, `fs.link` may be unsupported. The restore then falls back to
a re-check just before the rename.

**What Filo does today:** if `trashItem` throws for an item, that item stays in
Filo's trash and Filo shows one confirm listing every such file, titled
"Delete permanently?". Cancel keeps them in Filo's trash (the purge asks again
at the next vault open). Only a confirmed answer deletes them for good, through
a channel that accepts nothing but trash ids.

**Where:** `purgeTrash` in [src/main/vault/trashOps.ts](src/main/vault/trashOps.ts),
`vault:trash-purge` / `vault:trash-delete-permanently` in
[src/main/ipc/vaultTrash.ipc.ts](src/main/ipc/vaultTrash.ipc.ts), the confirm in
[src/renderer/stores/trash.svelte.ts](src/renderer/stores/trash.svelte.ts).

**Impact:**
- On OneDrive, emptying Filo's trash sends an online-only item to OneDrive's
  web recycle bin, not the Windows one. Filo's confirm ("the Recycle Bin can
  [restore it]") is then only true of OneDrive's recycle bin.
- On a network share or FAT32 drive (not probed), `trashItem` may succeed
  while actually deleting, so emptying Filo's trash there may be permanent.
- Undo and Restore are not affected: they only move items within the vault.

## 26. A tag merge can't be undone

**What:** Renaming a tag into one that already exists merges the two. A tag
exists when it is carried anywhere, in any spelling (`Review` for `review`),
even one that is only in a note's frontmatter and was never registered. The
confirm says so ("This can't be undone"), and no Undo is offered afterwards.
Undo of a plain rename is refused too if a tag with the old name has appeared
again in the meantime, because renaming back would merge.

**Where:** `renameTagWithUndo` / `undoRename` in
[src/renderer/stores/tagUndo.svelte.ts](src/renderer/stores/tagUndo.svelte.ts);
the confirm in [src/renderer/lib/tags/tagEditConfirm.ts](src/renderer/lib/tags/tagEditConfirm.ts).

**Why accepted:** After a merge, nothing records which notes, attachments and
tiles carried which of the two tags, so they can't be split apart again.
Recording it would mean a per-item snapshot of every merge for a rare action
that is already confirmed.

**Impact:** Check the name before confirming a merge. To reverse one by hand,
re-tag the affected items.

## 27. Undoing a tag delete may reorder or re-style a note's tag list

**What:** Undo of a vault-wide tag delete re-adds the tag to exactly the notes
the delete rewrote, on a fresh read of each note (so edits made in between are
kept). The tag goes back at the *end* of the note's `tags:` list, not where it
was. A flow-style list (`tags: [a, b]`) can come back in block style
(`- a` on separate lines).

**Where:** `undoRemoval` in
[src/renderer/stores/tagUndo.svelte.ts](src/renderer/stores/tagUndo.svelte.ts)
(uses `addTagToMarkdown` from
[src/renderer/lib/vault/tagRewriter.ts](src/renderer/lib/vault/tagRewriter.ts)).

**Why accepted:** Re-adding through the normal tag rewriter keeps the undo safe
against edits made after the delete; restoring the original bytes would
overwrite them. Tag order carries no meaning in Filo. Board-only tile tags do go
back at their original position.

**Impact:** Cosmetic. A note's frontmatter may look slightly different after
delete + undo; the set of tags is the same.

## 28. The undo toast for tag delete and rename lasts 15 seconds

**What:** Vault-wide tag delete and rename touch many files and belong to no
board, so their undo is an **Undo** button on the toast that reports them, not a
board Ctrl+Z step. Like every toast, it closes after at most 15 seconds.

**Where:** `TAG_UNDO_TOAST_MS` in
[src/renderer/stores/tagUndo.svelte.ts](src/renderer/stores/tagUndo.svelte.ts);
the toast cap in [src/renderer/stores/ui.svelte.ts](src/renderer/stores/ui.svelte.ts).

**Why accepted:** Putting a vault-wide action on one board's history would file
it under whichever board happened to be active, where Ctrl+Z on that board
would unexpectedly rewrite notes elsewhere.

**Impact:** After the toast closes, a deleted tag has to be re-added by hand
(a rename can be reversed by renaming back).

## 29. Only current-format (v8) board files load

**What:** The board loader accepts exactly `version: 8`. A board from an older
Filo (no version, a lower version, or a double-encoded file) or from a newer
one is refused: it is listed as failed with a toast, its bytes are copied to
`.filo/recovery/`, and Filo never writes to it. Notes are unaffected; only the
`.board.json` is refused.

**Where:** `migrateBoardFile` in
[src/renderer/schema/migrations.ts](src/renderer/schema/migrations.ts) (no
migration steps), `CURRENT_BOARD_FILE_VERSION` in
[src/renderer/schema/boardFile.ts](src/renderer/schema/boardFile.ts), the
`no-migration-path` / `from-future` branches in
[src/renderer/lib/boards/boardLoader.ts](src/renderer/lib/boards/boardLoader.ts).
Pinned by gate `no-legacy-board-migration`.

**Why accepted:** Filo hasn't shipped, so there are no user boards in older
formats to carry forward, and each migration step is code that could corrupt a
board. Tolerance for notes written by other apps (no `title:`, CRLF, BOM, odd
YAML, non-UTF-8) stays, because those are user content rather than a Filo
format.

**Impact:** Boards made by earlier development builds must be rebuilt. The notes
they showed are still in the vault.

## 30. The raw view saves the whole file

**What:** The Document tab's **Raw** toggle shows the note's full text,
frontmatter included, and saves it as one whole-file replacement (on blur,
Ctrl+S, switching back, closing the tab, and the save that close, open another
vault and quit run first: text typed there is unsaved work to all of them). A save lands only if the file still holds
exactly the bytes the raw view started from. If another program (or another
Filo view) changed the file meanwhile, nothing is written and a banner offers
**Show the new version** or **Keep mine**. Keep mine first backs the other
version up to `.filo/recovery/`, then replaces it with the raw text.

**Where:** `readRaw` / `writeRaw` in
[src/renderer/stores/notes.svelte.ts](src/renderer/stores/notes.svelte.ts),
`rawTextForDisk` in [src/renderer/lib/notes/noteFile.ts](src/renderer/lib/notes/noteFile.ts),
[src/renderer/components/boards/NoteRawView.svelte](src/renderer/components/boards/NoteRawView.svelte).

**Why accepted:** The raw view exists to edit the file exactly as it is on disk,
so it can't merge key by key the way metadata edits do. The hash check means a
conflicting change is never overwritten unseen, and Keep mine keeps a copy. The
file's BOM and line endings are re-applied on save. Because the text never
passes through the rich editor, the raw view is also allowed on lossy notes
(#17); it is read-only for non-UTF-8 notes (#21).

Switching back to the formatted view waits for the save's answer and stays in
Raw, with the banner, unless the text is on disk. Closing a tab (or leaving
the vault anyway) with raw text that can't be written keeps it as a copy in
`.filo/recovery/<timestamp>-unsaved/` and says so. Frontmatter typed here is
the user's own, so it is written even if it no longer parses.

**Impact:** Choosing Keep mine replaces the other version in the note itself;
it survives only as the backup in `.filo/recovery/`.

---

## 31. A move by another program is followed only if its two halves arrive within about 1.5 s

**What:** The watcher sees a move as "old name gone" plus "new name appeared"
and pairs them back into a rename. A note or attachment that goes missing
without a partner is held for `MISSING_NOTE_HOLD_MS` (1.5 s) so a partner that arrives in a later
batch can still pair with it; after that it is reported as deleted. In the
renderer, a note with a change not yet on disk waits `NOTE_RENAME_GRACE_MS`
(3 s) before the "deleted" or "couldn't save" prompt, and asks nothing if a
rename re-points it meanwhile. A note write hides only its own echo: a rename,
delete or save of the file by another program straight after Filo wrote it is
still reported (`FileWatcher.suppressWrite` drops an event only while the file
holds the bytes Filo wrote; once another program's version has been reported,
Filo's bytes coming back inside the window count as that program's too), and
the watcher's hash cache is updated with the bytes Filo wrote so the pair
still matches.

**Where:** [src/main/services/fileWatcher.ts](src/main/services/fileWatcher.ts)
(`MISSING_NOTE_HOLD_MS`, `suppressWrite`, `recordOwnWrite`),
[src/renderer/lib/vault/externalChangeWindows.ts](src/renderer/lib/vault/externalChangeWindows.ts)
(`NOTE_RENAME_GRACE_MS`), `askUnlessMoved` in
[src/renderer/lib/notes/renameGrace.ts](src/renderer/lib/notes/renameGrace.ts).

**Why accepted:** Holding every delete longer would make a real delete slower
to show. 1.5 s covers Explorer and `git mv`, which move a file in one
operation. It has not yet been measured against OneDrive, whose download of the
new name and removal of the old one can be further apart.

**Impact:**
- A move whose halves are further apart shows as a delete (the prompt keeps
  tiles by default and offers a relink) plus a new file. An unsaved edit is
  kept behind the "deleted" prompt's **Keep mine**, not lost.
- An external delete of a note reaches the app about 1.5 s later than before.
- A case-only rename (`Draft.md` → `draft.md`) made within about 7 s of a Filo
  write to the note is not reported at once (the echo window can't tell the
  two spellings apart). Filo's next write keeps the new spelling on disk, and
  the app shows it after the next reconcile pass (at most 30 s).
- A new note's create reserves the name with an empty file first, so its echo
  window also hides an empty file. Another program emptying that note within
  about 7 s of Filo creating it is not reported at once; the next reconcile
  pass shows it.
- A file with no extension (`LICENSE`, `Makefile`) is not followed as a move:
  from its name alone the watcher can't tell it from a folder, so it shows as
  a delete plus a new file.

---

## 32. `tiptap-markdown` is the write path's most fragile dependency

**What:** Every note body Filo saves is serialised by `tiptap-markdown` (0.9,
which declares TipTap 3 as its peer but was designed in the TipTap 2 era and has
little upstream activity). Filo extends it in several places: the tight-list
rule (`taskListTight.ts`), the aligned or indented block writer
(`blockLayout.ts`), its own writers for lists (`listMarkers.ts`,
`taskItems.ts`), tables (`tableMarkdown.ts`), code fences (`codeFence.ts`),
line breaks (`hardBreak.ts`), quotes (`blockquote.ts`), leading spaces
(`leadSpace.ts`) and text escapes (`textEscapes.ts`), and the lossy check that
opens a note read-only when a round trip would change it (#17). Filo also
replaces its serializer state with prosemirror-markdown's own
(`delimiterRuns.ts`, `prosemirror-markdown` is a direct dependency for it):
tiptap-markdown's delimiter tidy shifted a bold, italic or strikethrough
delimiter that couldn't open or close where it stood, which took the
formatting off a punctuation mark, skipped a run at the start of a note and
could leave a stray `*`. Now such a run is written as `<strong>`, `<em>` or
`<s>`, which reads back as the same formatting. A TipTap upgrade, or a patch
release of either package, can change how a node is written without any type
error.

**Where:** [src/renderer/lib/editor/createEditor.ts](src/renderer/lib/editor/createEditor.ts),
[src/renderer/lib/editor/markdownSync.ts](src/renderer/lib/editor/markdownSync.ts),
[src/renderer/lib/editor/delimiterRuns.ts](src/renderer/lib/editor/delimiterRuns.ts),
`package.json` (`tiptap-markdown`, `prosemirror-markdown`, `@tiptap/*`).

**Why accepted:** Replacing it with a serialiser of our own is a large job, and
the package does what Filo needs today. The guard is the round-trip suites,
which pin its output byte for byte: `markdownBodyRoundTrip.test.ts` (the golden
corpus, LF and CRLF), `toolbarFormattingRoundTrip.test.ts` (every toolbar
command, gate `toolbar-formatting-saved`), `editorRoundTripProperty.test.ts`
(500 documents generated from the editor schema, plus list, table and
line-break commands run in context; gate `editor-round-trip-property`),
`markdownSync.test.ts` and the
component and characterisation specs that save and reopen notes. The property
test compares the reopened document with the one written, so a note that
would reopen editable but different (the silent case) fails it too.

**Impact:** Upgrade `tiptap-markdown`, `prosemirror-markdown` or any `@tiptap/*` package only on its own
branch, with the full `test:unit:strict` run green. A change the suites don't
cover could re-style notes on their next save (nothing is lost: a note whose
round trip changes it opens read-only).

---

## 33. Rescue copies and kept versions in `.filo/recovery/` are never deleted automatically

**What:** When you close the vault, open another one, or quit while some
changes couldn't be saved, and choose **Close anyway**, **Open anyway** or
**Quit anyway**, Filo first writes each unsaved change to
`.filo/recovery/<timestamp>-unsaved/`:
- a note as its last known frontmatter plus the body you typed (with any
  queued frontmatter change applied), named after its flattened vault path
  (`Notes__Draft.md`);
- a board whose save failed as its in-memory `.board.json`;
- Filo's own `.filo/` state that wasn't saved (the tag registry, settings,
  layout, viewports, hotkeys, sidebar order) as `_filo__<name>.json`.

A board deleted while its last save fails is copied there too, as it was in
memory, before its file moves to Filo's trash (with no copy, the board isn't
deleted).

These are the only copy of that text. The same goes for the other version a
**Keep mine** / **Keep local** writes over, a file's original bytes before
**Convert to UTF-8**, and a board's file before a load repair drops unknown
tile types or broken references from it: they go in
`.filo/recovery/<timestamp>-keep/`. The
ordinary recovery snapshots (boards that failed to load, copies taken before a
repair) are pruned to 20 per name and 100 in total, but both prunes skip any
folder ending in `-unsaved` or `-keep`, so Filo never deletes a rescue copy or
a kept version. A board that fails to load is copied again on the next open
only if its bytes changed. The rescue folders written since an unfinished save
show in the recovery modal when the vault next opens, each with **Show in
folder**.

**Where:** `keepUnsavedCopies` and the prunes in
[src/main/services/recoverySnapshot.ts](src/main/services/recoverySnapshot.ts),
`recovery:keep-unsaved` in [src/main/ipc/recovery.ipc.ts](src/main/ipc/recovery.ipc.ts),
[src/renderer/stores/unsavedRescue.ts](src/renderer/stores/unsavedRescue.ts),
[src/renderer/stores/vaultLeaveGuard.ts](src/renderer/stores/vaultLeaveGuard.ts).

**Why accepted:** A rescue copy holds work that exists nowhere else, so any
automatic deletion could lose it. Rescues only happen after a save failed and
you chose to leave anyway, so they should be rare and small.

**Impact:**
- `.filo/recovery/` can grow until you delete old `…-unsaved` / `…-keep` folders by hand
  (any file manager; Filo doesn't need them).
- `.filo/` syncs with the vault, so a rescue copy reaches your other machines
  too.
- A copy isn't written for a change over 25 MB or on a disk error. Filo then
  asks once more ("… and lose them") before leaving.

---

## 34. Linked notes: symbolic links are read-only, hard links are not detected

**What:** Filo saves a note atomically: it writes a temporary file next to it
and renames that over the note. A rename replaces the directory entry, so it
never writes *through* a link:
- A note that is a **symbolic link** would become an ordinary file, and the
  original it pointed at would stop getting the edits. Filo doesn't follow
  links. The read reports the link, and the note opens read-only with the
  banner *"This note is a link; edit the original."* The main process also
  refuses every text write to it (`NOTE_IS_LINK`), both before staging the
  temporary file and again right before each rename attempt. A vault-wide tag
  rename skips it and names it in a toast.
- A note that is a **hard link** (a second name for the same file) is not
  detected. The first save gives that name its own copy of the file, and the
  other names keep the old text. From then on they are separate files.

A symbolic link that points outside the vault can't be read at all (the vault
boundary check follows links).

**Where:** `isSymbolicLink` / `atomicWriteFile({ refuseLink })` in
[src/main/vault/filenameUtils.ts](src/main/vault/filenameUtils.ts), the
`vault:read-file-text` / `vault:write-file-text` /
`vault:write-existing-file-text` handlers in
[src/main/ipc/vault.ipc.ts](src/main/ipc/vault.ipc.ts),
[src/renderer/lib/vault/nonUtf8Paths.svelte.ts](src/renderer/lib/vault/nonUtf8Paths.svelte.ts)
(`isLinkedNote`).

**Why accepted:** Writing through a link in place would give up the atomic
write that keeps a crash from leaving a half-written note. A hard link has no
mark of its own: every name is an equal, ordinary file, and the only hint is a
link count above 1, which network drives and some file systems don't report
reliably. Hard-linked notes are rare, so Filo doesn't try.

**Impact:** Edit a linked note through its original file. Don't hard-link
notes inside a vault; use a symbolic link (read-only in Filo) or a copy.

---

## 35. An attachment's tags are dropped if its file is missing when the vault opens

**What:** An attachment's tags (image, video, audio, any non-note file) live
only in `.filo/tags.json`. After a vault opens, and after the startup prompts
(an unfinished rename's **Retry** among them) are answered, Filo drops the
entries whose file is not in the vault, with a toast saying how many. Paths an
unfinished rename names are spared, whatever the answer to its prompt.

**Where:** `tidyTagsAfterOpen` in
[src/renderer/stores/openTagHousekeeping.ts](src/renderer/stores/openTagHousekeeping.ts),
`namedByPendingRename` in
[src/renderer/lib/vault/renameCascadeSentinel.ts](src/renderer/lib/vault/renameCascadeSentinel.ts).

**Why accepted:** Without the prune, the tags of a file deleted while Filo was
closed would stay in the tag counts, and would land on any new file given the
same name.

**Impact:** If a sync client delivers another machine's `.filo/tags.json`
before an attachment that machine renamed, and this machine opens the vault in
between, the attachment's tags are lost. Syncthing usually applies a rename at
once (it rebuilds the new file from the old one's blocks), so the gap is short.
If the "Pruned … stale tag entries" toast appears for a file that is still
there, add its tags again.

---

## 36. A note over 2 MB is checked for outside changes by its stat alone

**What:** Before Filo writes over a note, the main process checks that the
file is still the version Filo read: same modification time and size, and,
for a file up to 2 MB, the same bytes (a content hash). A note larger than
that is checked by its modification time and size only.

**Where:** `stillHoldsHash` / `STALE_HASH_MAX_BYTES` in
[src/main/vault/filenameUtils.ts](src/main/vault/filenameUtils.ts).

**Why accepted:** Reading a large file again before every save costs time on
each write, and notes that size are rare.

**Impact:** On a file system with a coarse timestamp (FAT / exFAT keep 2 s,
some SMB shares 1 s), another program's save of a note over 2 MB that keeps its
size and lands within one timestamp tick of Filo's read could be overwritten.
Keep large notes on NTFS / APFS / ext4, or close them in other editors while
Filo has them open.

## 37. A board that can't load catches up only on the renames made in the same session

**What:** A board that fails to load (a newer format, a lock, a broken file)
isn't in memory, so a rename or move of a file it links to can't rewrite its
links. Filo keeps a list of every rename made while it is unloaded, and if the
board loads later in the same session (Retry, the file changing, the sidebar),
those renames are applied to it before it opens, and it is saved. A notice
names the boards a rename or delete didn't reach, once per board. Its tab
stays open meanwhile, saying why it can't show the board and offering
**Retry**, so a board that is repaired or finishes syncing comes back in place.

**Where:** [src/renderer/stores/unloadedBoards.ts](src/renderer/stores/unloadedBoards.ts),
`adoptBoardAtRuntime` in [src/renderer/stores/boardDiscovery.ts](src/renderer/stores/boardDiscovery.ts),
`ensureAllLoaded` in [src/renderer/stores/boardCache.svelte.ts](src/renderer/stores/boardCache.svelte.ts).

**Why accepted:** The list lives in memory. Keeping it across sessions would
mean a new `.filo/` journal replayed on every open, against boards that other
machines may have edited meanwhile.

**Impact:**
- A board that loads only after the vault is closed and reopened keeps its
  old links; its tiles show as missing, where **Re-link** points them at the
  moved files.
- Links to files deleted meanwhile are left as they are (never removed
  unseen): the tiles show as missing once the board loads.

## 38. Camera positions and the sidebar order are saved on a best-effort basis

**What:** `.filo/viewports.json` (each Mind Map's camera) and
`.filo/sidebar-order.json` (the manual sidebar order) are view state. When one
can't be saved (Filo can't read the file on disk, so it won't write over it; a
lock), the change is dropped with one notice, instead of being counted as
unsaved work that holds up a close or quit. The next change tries again, and a
file that reads again is saved again (merged with what it holds). Another
program's version of either file is merged in, not asked about: per board the
camera saved last wins, and a folder reordered in this session keeps its order.

**Where:** `droppable` in
[src/renderer/lib/boards/miscWriteScheduler.ts](src/renderer/lib/boards/miscWriteScheduler.ts),
[src/renderer/lib/boards/miscConfigDrift.ts](src/renderer/lib/boards/miscConfigDrift.ts),
[src/renderer/lib/boards/viewportCache.ts](src/renderer/lib/boards/viewportCache.ts),
[src/renderer/stores/sidebarOrder.svelte.ts](src/renderer/stores/sidebarOrder.svelte.ts).

**Why accepted:** Losing a camera position or a drag costs a moment to redo;
a "couldn't be saved" dialog on every close for it would teach users to click
past the dialog that guards their notes.

**Impact:** While either file stays unreadable, the latest camera positions or
sidebar order are lost at quit. Shortcuts (`hotkeys.json`) and the settings
files are not treated this way: they count as unsaved and ask before an
outside version is overwritten.

## 39. A Kanban card shows a static preview until its editor mounts

**What:** A text card doesn't build its editor when the board opens. Until the
card is within about a screen of the column's visible area, its body is the
note rendered as static HTML (markdown-it, laid out with the editor's styles);
near the viewport the real editor mounts in idle time, and a press or Tab onto
the preview mounts it at once. Once mounted, an editor stays until the board
closes.

**Where:** [src/renderer/components/tiles/LazyTextTileBody.svelte](src/renderer/components/tiles/LazyTextTileBody.svelte),
[src/renderer/lib/editor/staticPreview.ts](src/renderer/lib/editor/staticPreview.ts),
[src/renderer/lib/editor/editorMountQueue.ts](src/renderer/lib/editor/editorMountQueue.ts);
gate `components/kanban-cards-mount-lazily`.

**Why accepted:** An editor per card, all at once, froze a 300-card board for
about 20 s on every open and tab switch.

**Impact:** The preview is read-only and approximate: Filo's own editor
extensions (a typed tab, the lead-space mark, aligned blocks, highlight
colours) may look slightly different until the editor mounts, and a note that
would open read-only shows its banner only then. The preview never writes.

## 40. A large sidebar folder fills in over about a second

**What:** Expanding a folder renders its first 150 rows at once and the rest
in idle time, 150 at a time. Until every row is there, dragging to reorder
that folder is paused (as it is while a search or a tag filter is on), and
arrow-key navigation reaches only the rows rendered so far.

**Where:** [src/renderer/lib/utils/progressiveCount.svelte.ts](src/renderer/lib/utils/progressiveCount.svelte.ts),
`VaultFileItem.svelte`.

**Why accepted:** Mounting 2,000 rows in one go held the window for about half
a second. Windowing the tree would also need a new drag-to-reorder, since each
folder's reorder zone needs all its rows in the page.

**Impact:** For about a second after expanding a folder of thousands of notes,
its last rows aren't in the list yet and it can't be reordered.

## 41. Plain text pasted into a note is read as Markdown (without HTML)

**What:** Text pasted with no HTML on the clipboard (from Notepad, a terminal,
a code editor) is read as Markdown with HTML off and every line break kept:
`**x**` becomes bold and `# Title` a heading, while `List<String>` and
`<!-- -->` stay text. **Ctrl+Shift+V** pastes it literally instead (a
paragraph per blank-line-separated block, a line break per newline).

**Where:** [src/renderer/lib/editor/pastePlainText.ts](src/renderer/lib/editor/pastePlainText.ts).

**Why accepted:** Markdown copied from another app (a README, a chat) should
paste with its formatting; that is the more common case in a Markdown
notebook. Text that only looks like Markdown has the literal paste.

**Impact:** To paste `__init__` or `*args` exactly, use Ctrl+Shift+V.

## 42. A file dropped from Explorer by another spelling of the vault's path is copied

**What:** A file dropped from Explorer onto a board is linked by its path when
it is inside the open vault, and copied in otherwise. "Inside" is decided on
the path Explorer reports, ignoring case. A path that reaches the vault
another way (an 8.3 short name such as `C:\MYVAUL~1\`, a junction or a
mapped drive) isn't recognised, so the file is copied as if it came from
outside.

**Where:** `classifyDroppedFile` in
[src/renderer/lib/vault/droppedFiles.ts](src/renderer/lib/vault/droppedFiles.ts).

**Why accepted:** Explorer reports the long path of the folder it shows, which
is the one the vault was opened by in everyday use. Resolving every spelling
would need a main-process round trip per dropped file.

**Impact:** Rare. The copy is a new note (`Plan (1).md`); delete it and drop
the original from the sidebar instead.

## 43. Undoing Replace All from its notification leaves nothing to redo

**What:** Replace All's notification offers **Undo**, which takes the replace
back from any tab, even with other steps on top of it. Undone that way, it is
taken off the undo history and can't be redone (Ctrl+Z on the tab that was
active when it ran undoes it with a redo, while it is the last step there).

**Where:** `historyStore.undoFromToast` in
[src/renderer/stores/history.svelte.ts](src/renderer/stores/history.svelte.ts);
`runReplaceAllCommand` in
[src/renderer/commands/replaceAllCommand.ts](src/renderer/commands/replaceAllCommand.ts).

**Why accepted:** A redo put back on some tab's stack below newer steps would
be out of order. Run Replace All again to redo it.

**Impact:** After an Undo from the notification, repeat the Replace All to
apply it again.

## 44. A subtask's `parent:` in a note written by an older build is read, never removed

**What:** A Task List keeps its subtask hierarchy on the board: each task's
parent is `parentTileId` on its placement in the `.board.json`, a tile id of
that board. Older builds wrote the parent into the note instead
(`parent: <tile id>`). Filo still reads that field when the placement names no
parent, and never writes or removes it: an outdent of such a task records
`parentTileId: ""` on the board, which wins over the note.

**Where:** [src/renderer/lib/tasklist/taskParent.ts](src/renderer/lib/tasklist/taskParent.ts),
`TaskPlacementSchema` in [src/renderer/schema/placement.ts](src/renderer/schema/placement.ts).

**Why accepted:** Removing the field would rewrite every such note just to
move it, and a tile id means nothing outside its board anyway.

**Impact:** The old `parent:` line stays in those notes (harmless; another
app shows it as a plain property). The same note on a second Task List shows
at the top level there, since the id names a tile of the first list.

## 45. A recording whose tile is deleted while it records isn't put back on the board

**What:** Deleting an Audio tile ends its take. The recording is still saved
(in the board's folder), but its tile is gone, so it isn't linked to anything;
a notice names the file and offers **Show in folder**. Undoing the delete
brings the tile back as it was when deleted, without the recording.

**Where:** `saveRecording` in
[src/renderer/lib/media/audioRecording.ts](src/renderer/lib/media/audioRecording.ts).

**Why accepted:** The take finishes after the delete has already been
recorded on the undo stack; changing that step afterwards would make undo
depend on the order of two asynchronous saves. Nothing is lost: the file is in
the vault, and the notice says where.

**Impact:** Drag the recording from the sidebar onto a board to use it.

## 46. Board Browser rows are buttons with buttons inside

**What:** Each row of the Board Browser is a `role="button"` (a click or
Enter opens the board) that holds its own Rename and Delete buttons. A screen
reader treats a button's contents as one label, so in browse mode those two
buttons can be unreachable (axe `nested-interactive`). With the keyboard they
work: Tab reaches each one, and Enter or Space on it renames or deletes. The
row's own Enter opens the board only while the row itself has focus.

**Where:** [src/renderer/components/modals/BoardBrowser.svelte](src/renderer/components/modals/BoardBrowser.svelte);
the E2E axe scan turns the rule off for this view only
([src/tests/e2e/a11y.e2e.ts](src/tests/e2e/a11y.e2e.ts)).

**Why accepted (for now):** The fix is a new row structure, with opening the
board as its own control, and that touches the row's drag and Alt+Arrow
reorder. It waits for a UI pass.

**Impact:** Screen-reader users rename or delete a board from the sidebar
instead.

## 47. Tertiary text is below 4.5:1 contrast in the Light theme

**What:** Hints, counts, dates and the Raw toggle's label use
`--text-tertiary` (`#80868b` in Light), which is 3.7:1 on white. WCAG AA asks
4.5:1 for small text, and the project's own bar for tertiary text is 3:1
(`themeContrast.test.ts`). The Task List's keyboard-hint strip (tertiary at
55% opacity, hidden from screen readers) is about 1.8:1, under either bar.

**Where:** the theme palettes in [src/css/style.css](src/css/style.css);
the E2E axe scan leaves colour contrast to `themeContrast.test.ts`.

**Why accepted (for now):** A darker tertiary makes the secondary /
tertiary hierarchy harder to see. The palette is the owner's decision.

**Impact:** Small grey text can be hard to read on some screens.
