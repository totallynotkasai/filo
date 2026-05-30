# Filo — Known Limitations

These are **deliberate, accepted trade-offs**, not bugs. They follow from Filo's
core design principles (open format, local-first, no sidecar files) or from
platform constraints. They are documented here so they aren't repeatedly
re-discovered and "fixed" — changing any of them needs a design discussion, not
a patch. (Cross-referenced from the audit's Appendix C, "do NOT fix".)

If you hit one of these and believe the trade-off should change, open a design
note rather than a quick fix — each entry lists why it is the way it is.

---

## 1. Lossy YAML frontmatter round-trip (non-tag writes)

**What:** When Filo rewrites a `.md` file's YAML frontmatter, it re-serializes
the parsed object through `js-yaml`'s `dump`. A `load → dump` round-trip keeps
only the *data* — YAML comments, blank lines, key ordering, and quote/indent
style are discarded.

**Where:** `serializeMarkdownFile` in
[src/renderer/lib/editor/markdownSync.ts](src/renderer/lib/editor/markdownSync.ts).

**Exceptions (preserved byte-for-byte):** Tag-only edits go through a targeted
line-level rewriter ([src/renderer/lib/vault/tagRewriter.ts](src/renderer/lib/vault/tagRewriter.ts)) —
tag rename, removal, and (as of Phase 7.4) inserting the *first* tag into a file
with frontmatter but no `tags:` field. Adding a tag to a file that already has a
`tags:` field still takes the dump path (its string→array upgrade semantics are
relied upon).

**Why accepted:** A full diff-and-patch of only the changed keys (e.g. via the
`yaml` package's `Document` API) is a meaningful amount of work. Revisit only if
Obsidian round-trip fidelity becomes a priority.

**Impact:** Editing a note's metadata through Filo strips hand-authored YAML
comments/formatting. File *content* is never lost.

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
