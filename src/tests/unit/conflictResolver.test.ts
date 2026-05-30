import { describe, it, expect } from 'vitest';
import { classifyExternalChange } from '@renderer/lib/vault/conflictResolver';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';

function md(body: string, lastModified = Date.now()) {
  return parseMarkdown('note.md', body, lastModified);
}

describe('classifyExternalChange', () => {
  it('prompts the user when an open editor has unsaved changes', () => {
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: md('# A\nbody'),
      nextMetadata: md('# A\nbody changed externally'),
      editor: { path: 'note.md', isDirty: true },
    });
    expect(result).toEqual({ action: 'prompt-user', reason: 'editor-dirty' });
  });

  it('reloads silently when an open editor is clean', () => {
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: md('# A\nbody'),
      nextMetadata: md('# A\nbody changed externally'),
      editor: { path: 'note.md', isDirty: false },
    });
    expect(result).toEqual({ action: 'reload-silently', reason: 'editor-clean' });
  });

  it('syncs frontmatter silently when body is unchanged and no editor is open', () => {
    const prev = md('---\ntags: [a]\n---\n# A\nbody');
    const next = md('---\ntags: [a, b]\n---\n# A\nbody');
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: null,
    });
    expect(result).toEqual({ action: 'sync-frontmatter', reason: 'frontmatter-only' });
  });

  it('ignores no-op changes (body and frontmatter identical)', () => {
    const meta = md('# A\nbody');
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: meta,
      nextMetadata: meta,
      editor: null,
    });
    expect(result).toEqual({ action: 'ignore', reason: 'noop-change' });
  });

  it('ignores body changes when no editor is open (not a conflict)', () => {
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: md('# A\nold'),
      nextMetadata: md('# A\nnew body'),
      editor: null,
    });
    expect(result).toEqual({ action: 'ignore', reason: 'no-editor-open' });
  });

  it('prompts the user when the file has vanished and an editor is open', () => {
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: md('# A\nbody'),
      nextMetadata: null,
      editor: { path: 'note.md', isDirty: true },
    });
    expect(result.action).toBe('prompt-user');
  });

  it('ignores missing-file events when no editor is open', () => {
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: md('# A\nbody'),
      nextMetadata: null,
      editor: null,
    });
    expect(result).toEqual({ action: 'ignore', reason: 'file-missing' });
  });

  it('open editor + external body edit + dirty editor → prompt-user', () => {
    // Plan 1.1: extend with the open-editor + external edit case so the
    // pipeline is forced to choose between Reload and Keep-local.
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: md('# A\nlocal body'),
      nextMetadata: md('# A\ntheir body'),
      editor: { path: 'note.md', isDirty: true },
    });
    expect(result.action).toBe('prompt-user');
    expect(result.reason).toBe('editor-dirty');
  });

  it('open editor + external frontmatter-only edit + clean editor → sync-frontmatter', () => {
    // Body is unchanged, so the editor doesn't need to reload — only the
    // tile/tag caches need the new frontmatter. Returning 'sync-frontmatter'
    // (instead of 'reload-silently') skips the editor's redundant
    // applyReloadFromDisk call.
    const prev = md('---\ntags: [a]\n---\n# A\nbody');
    const next = md('---\ntags: [a, b]\n---\n# A\nbody');
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'note.md', isDirty: false },
    });
    expect(result.action).toBe('sync-frontmatter');
  });

  it('open editor + external frontmatter-only edit + dirty editor → sync-frontmatter (no toast)', () => {
    // Without this short-circuit, a dirty editor would get a spurious
    // Reload/Keep-local toast even though the body content is identical —
    // the user has nothing to choose between.
    const prev = md('---\ntags: [a]\n---\n# A\nbody');
    const next = md('---\ntags: [a, b]\n---\n# A\nbody');
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'note.md', isDirty: true },
    });
    expect(result.action).toBe('sync-frontmatter');
  });

  it('first-sight file + no editor → sync-frontmatter (Phase 20 / S5)', () => {
    // A file that appears in the vault between sessions — or that the watcher
    // sees before the indexer has had a chance to baseline — would previously
    // be 'ignore'd, leaving its tags unregistered until the next edit.
    // Promoting to sync-frontmatter runs the tag sweep on first sight.
    const next = md('---\ntags: [imported]\n---\n# A\nbody');
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: null,
      nextMetadata: next,
      editor: null,
    });
    expect(result).toEqual({ action: 'sync-frontmatter', reason: 'first-sight' });
  });

  it('first-sight file + clean editor → reload-silently (does not steal the editor branch)', () => {
    // The S5 promotion only applies when no editor is open. With an editor
    // present we still want the body to land in the editor; the existing
    // reload-silently / prompt-user split owns that decision.
    const next = md('# A\nbody');
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: null,
      nextMetadata: next,
      editor: { path: 'note.md', isDirty: false },
    });
    expect(result.action).toBe('reload-silently');
  });

  it('dirty Properties popup + external frontmatter-only edit → prompt-user with properties-popup-dirty (Sprint C / C.1)', () => {
    // Pre-Sprint-C this returned 'sync-frontmatter' and silently overwrote
    // the popup's tile-def cache + tag store + docStore frontmatter for the
    // path. The popup's pending gateway write would then either (a) win and
    // discard the external edit silently, or (b) lose to the external if
    // the user closed the popup before the debounce fired. Either way the
    // user never got to choose. Routing to prompt-user surfaces the
    // Reload/Keep-local toast so the user picks.
    const prev = md('---\ntags: [a]\n---\n# A\nbody');
    const next = md('---\ntags: [a, b]\n---\n# A\nbody');
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'note.md', isDirty: false },
      propertiesPopupDirty: true,
    });
    expect(result.action).toBe('prompt-user');
    expect(result.reason).toBe('properties-popup-dirty');
  });

  it('clean Properties popup + external frontmatter-only edit → sync-frontmatter (Sprint C / C.1 — existing behaviour preserved)', () => {
    // The popup-dirty intercept must be opt-in. When the tracker says the
    // popup is clean (no row edits pending), the sync-frontmatter short-
    // circuit fires as before — silently reconciling tile caches without
    // a spurious toast.
    const prev = md('---\ntags: [a]\n---\n# A\nbody');
    const next = md('---\ntags: [a, b]\n---\n# A\nbody');
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'note.md', isDirty: false },
      propertiesPopupDirty: false,
    });
    expect(result.action).toBe('sync-frontmatter');
    expect(result.reason).toBe('frontmatter-only');
  });

  it('dirty Properties popup + no-op external write → ignore (popup-dirty does not promote noop to prompt) ', () => {
    // The popup-dirty gate is only meaningful when the external edit
    // actually changed something. A no-op (same body + same frontmatter)
    // still routes to 'ignore' so an opaque watcher echo doesn't spam a
    // toast at the user just because the popup happens to be open.
    const meta = md('---\ntags: [a]\n---\n# A\nbody');
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: meta,
      nextMetadata: meta,
      editor: { path: 'note.md', isDirty: false },
      propertiesPopupDirty: true,
    });
    expect(result).toEqual({ action: 'ignore', reason: 'noop-change' });
  });

  it('dirty Properties popup + external body change → existing editor-dirty/reload-silently logic wins (popup gate only covers FM-only)', () => {
    // Per the Sprint C scope: the popup-dirty gate intercepts ONLY the
    // frontmatter-only short-circuit. Body changes still flow through the
    // existing editor.isDirty path so a dirty editor still surfaces its
    // own toast and a clean editor still reloads silently. A popup-dirty +
    // body-change combination is an edge case the popup's own scheduleWrite
    // already handles (it writes the popup's FM atop disk's new body).
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: md('# A\nold body'),
      nextMetadata: md('# A\nnew body'),
      editor: { path: 'note.md', isDirty: false },
      propertiesPopupDirty: true,
    });
    expect(result.action).toBe('reload-silently');
  });

  /**
   * Phase 1 / 1.6 — the partial-read heuristic now requires the shrink
   * to be FRESH. A file shrunk an hour ago has had its rewrite committed
   * already; routing it through `partial-read-retry` would leave the user
   * stuck on stale content while the retry loop waits for content that
   * has already settled.
   */
  it('substantial-shrink + stale mtime (1 h old) routes to reload-silently, not partial-read-retry', () => {
    const prev = md('# A\n' + 'x'.repeat(4096));
    const next = md('# A\n', Date.now() - 60 * 60 * 1000);
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'note.md', isDirty: false },
    });
    expect(result.action).toBe('reload-silently');
  });

  it('substantial-shrink + fresh mtime (now) still routes to partial-read-retry', () => {
    const prev = md('# A\n' + 'x'.repeat(4096));
    const next = md('# A\n'); // lastModified = now
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'note.md', isDirty: false },
    });
    expect(result.action).toBe('partial-read-retry');
  });

  /**
   * M5 (2026-05-28) — the mtime window was widened from 100 ms to 1000 ms so
   * a slow truncate-then-rewrite (the truncate stamps the mtime, the watcher
   * re-reads several hundred ms later, still mid-write) is still caught as a
   * partial read instead of being applied as a real edit. These two cases
   * pin both sides of the contract.
   */
  it('drastic shrink just past the OLD 100ms bound (250ms) is NOT applied as a real edit', () => {
    const prev = md('# A\n' + 'x'.repeat(4096));
    // mtime 250 ms ago — outside the old 100 ms window, inside the new 1000 ms one.
    const next = md('# A\n', Date.now() - 250);
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'note.md', isDirty: false },
    });
    expect(result.action).toBe('partial-read-retry');
  });

  it('a modest shrink (real edit) at a fresh mtime still applies via reload-silently', () => {
    // ~25% smaller — well short of the >90% drastic-shrink bar — so the
    // partial-read heuristic never fires and the edit reloads immediately,
    // regardless of how fresh the mtime is.
    const prev = md('# A\n' + 'x'.repeat(4000));
    const next = md('# A\n' + 'x'.repeat(3000)); // lastModified = now
    const result = classifyExternalChange({
      path: 'note.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'note.md', isDirty: false },
    });
    expect(result.action).toBe('reload-silently');
  });
});
