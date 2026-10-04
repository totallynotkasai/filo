import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import { undo } from '@codemirror/commands';
import NoteRawView from '@renderer/components/boards/NoteRawView.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { recordingFilo, settle, resetEditorHarness, teardownEditorHarness, VAULT } from './helpers/mountEditor';
import { loadedRawView, typeOver } from './helpers/rawView';

/**
 * The Raw view against a note that changed elsewhere:
 *  - Ctrl+Z after the view loaded text from disk never saves a mix of the
 *    two versions (the load clears the undo history);
 *  - "Use the new version (discard mine)" keeps a copy of the typed text in
 *    `.filo/recovery/` first, and asks before going on without one;
 *  - typing saves by itself once it pauses;
 *  - a save the writer won't take (the note became a link) keeps the text
 *    and a copy of it, instead of reading as saved.
 */
const NOTE = '---\ntitle: Chapter\n---\nThe first draft.\n';
const TYPED = '---\ntitle: Chapter\n---\nThe first draft.\n\nThree new paragraphs the writer typed in Raw view.\n';
const THEIRS = '---\ntitle: Chapter\nstatus: done\n---\nThe first draft.\n';

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

interface RawViewApi {
  save(): Promise<string>;
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await settle();
}

function mountRaw(): { target: HTMLElement; view: RawViewApi } {
  vaultStore.setPath(VAULT);
  const target = document.createElement('div');
  document.body.appendChild(target);
  const view = mount(NoteRawView, { target, props: { path: 'Plan.md' } }) as unknown as RawViewApi;
  return { target, view };
}

function bannerButton(target: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...target.querySelectorAll<HTMLButtonElement>('.raw-banner-action')].find((b) => b.textContent?.trim() === label);
}

const USE_THEIRS = 'Use the new version (discard mine)';

describe('raw view conflict: Use the new version', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('keeps a copy of the typed text, then shows the file', async () => {
    const filo = recordingFilo({ 'Plan.md': NOTE });
    const { target, view } = mountRaw();
    const field = await loadedRawView(target);
    typeOver(field, TYPED);
    await settle();
    filo.setExternal('Plan.md', THEIRS);
    expect(await view.save()).toBe('conflict');
    await settle();

    bannerButton(target, USE_THEIRS)!.click();
    await waitMs(50);

    expect(filo.recovered).toEqual([expect.objectContaining({ relPath: 'Plan.md', text: TYPED })]);
    expect(filo.recovered[0]!.dir).toMatch(/-keep$/);
    expect((await loadedRawView(target)).state.doc.toString()).toBe(THEIRS);
    expect(target.querySelector('.raw-banner')).toBeNull();
    expect(filo.files.get('Plan.md')).toBe(THEIRS);
    await unmount(view as never);
    await settle();
  });

  it('with no copy possible, asks first, and Cancel keeps the typed text', async () => {
    const filo = recordingFilo({ 'Plan.md': NOTE });
    const bridge = (window as unknown as { filo: { invoke: Invoke } }).filo;
    const inner = bridge.invoke;
    bridge.invoke = async (channel, ...args) =>
      channel === 'recovery:keep-unsaved' ? { ok: false, code: 'ENOSPC', error: 'ENOSPC' } : inner(channel, ...args);
    const { target, view } = mountRaw();
    const field = await loadedRawView(target);
    typeOver(field, TYPED);
    await settle();
    filo.setExternal('Plan.md', THEIRS);
    expect(await view.save()).toBe('conflict');
    await settle();

    bannerButton(target, USE_THEIRS)!.click();
    await waitMs(50);
    const asked = uiStore.confirmDialog;
    expect(asked?.title).toMatch(/without a copy/);
    asked?.onCancel?.();
    uiStore.closeConfirm();
    await waitMs(50);

    expect(field.state.doc.toString()).toBe(TYPED);
    expect(target.querySelector('.raw-banner')).not.toBeNull();
    bridge.invoke = inner;
    await unmount(view as never);
    await settle();
  });
});

describe('raw view: Ctrl+Z after the field was loaded from disk', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('after "Use the new version", undo does nothing and the save leaves the file as it is', async () => {
    const filo = recordingFilo({ 'Plan.md': NOTE });
    const { target, view } = mountRaw();
    const field = await loadedRawView(target);
    typeOver(field, TYPED);
    await settle();
    filo.setExternal('Plan.md', THEIRS);
    expect(await view.save()).toBe('conflict');
    await settle();
    bannerButton(target, USE_THEIRS)!.click();
    await waitMs(50);

    const shown = await loadedRawView(target);
    expect(undo(shown)).toBe(false);
    await view.save();
    // Whatever is on disk is one of the versions the user saw, never a mix.
    expect([NOTE, TYPED, THEIRS]).toContain(filo.files.get('Plan.md'));
    expect(filo.files.get('Plan.md')).toBe(THEIRS);
    await unmount(view as never);
    await settle();
  });

  it('after following a change made elsewhere, undo saves no mix', async () => {
    const filo = recordingFilo({ 'Plan.md': NOTE });
    const { target, view } = mountRaw();
    const field = await loadedRawView(target);
    // Type a new last paragraph and save it (as leaving the field does).
    field.dispatch({ changes: { from: field.state.doc.length, insert: '\nA new scene typed here.\n' }, userEvent: 'input.type' });
    await settle();
    expect(['saved', 'clean']).toContain(await view.save());
    const saved = filo.files.get('Plan.md') ?? '';
    // Another view of the note rewrites that paragraph (a card typed in).
    const rewritten = saved.replace('A new scene typed here.', 'A new scene, edited in the card.');
    filo.setExternal('Plan.md', rewritten);
    const other = noteStore.acquire('Plan.md', 'test:other');
    await other.loaded;
    await noteStore.onDiskChanged('Plan.md');
    await waitMs(400);
    expect(field.state.doc.toString()).toBe(rewritten);

    expect(undo(field)).toBe(false);
    await settle();
    await view.save();
    expect(filo.files.get('Plan.md')).toBe(rewritten);
    noteStore.release('Plan.md', 'test:other');
    await unmount(view as never);
    await settle();
  });
});

describe('raw view saving by itself', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('saves once typing pauses, without leaving the field', async () => {
    const filo = recordingFilo({ 'Plan.md': NOTE });
    const { target, view } = mountRaw();
    const field = await loadedRawView(target);
    typeOver(field, TYPED);
    await waitMs(600);
    expect(filo.writesTo('Plan.md')).toHaveLength(0);
    await waitMs(1300);
    expect(filo.files.get('Plan.md')).toBe(TYPED);
    // Undo still works after a save made by the pause.
    expect(undo(field)).toBe(true);
    await unmount(view as never);
    await settle();
  });

  it('a save the writer skips (the note became a link) keeps the text and a copy of it', async () => {
    const filo = recordingFilo({ 'Plan.md': NOTE });
    const { target, view } = mountRaw();
    const field = await loadedRawView(target);
    typeOver(field, TYPED);
    await settle();
    filo.links.add('Plan.md');
    expect(await view.save()).toBe('failed');
    await settle();

    expect(filo.files.get('Plan.md')).toBe(NOTE);
    expect(field.state.doc.toString()).toBe(TYPED);
    expect(filo.recovered).toEqual([expect.objectContaining({ relPath: 'Plan.md', text: TYPED })]);
    expect(uiStore.toasts.some((t) => t.text.includes('because the note is now a link'))).toBe(true);
    await unmount(view as never);
    await settle();
  });
});
