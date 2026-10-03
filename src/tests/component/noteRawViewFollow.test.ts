import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import NoteRawView from '@renderer/components/boards/NoteRawView.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { recordingFilo, settle, resetEditorHarness, teardownEditorHarness, VAULT } from './helpers/mountEditor';
import { loadedRawView, typeOver } from './helpers/rawView';
import { holdCloseDrainUntilSwap } from '@renderer/lib/editor/closeDrainGate.svelte';

/**
 * The raw view follows a change made elsewhere while nothing is typed in it.
 * Its reload reads the file first; text typed while that read is out is the
 * user's and must survive it, not be replaced by the file.
 */
const NOTE = '---\ntitle: Plan\n---\nOriginal\n';

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** Holds every read of a note until released. */
function holdNoteReads(): { held(): number; release(): void } {
  const filo = (window as unknown as { filo: { invoke: Invoke } }).filo;
  const inner = filo.invoke;
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => { open = r; });
  let held = 0;
  filo.invoke = async (channel, ...args) => {
    if (channel === 'vault:read-file-text' && String(args[1]).endsWith('.md')) {
      held++;
      await gate;
    }
    return inner(channel, ...args);
  };
  return {
    held: () => held,
    release: () => {
      filo.invoke = inner;
      open();
    },
  };
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await settle();
}

describe('raw view following a change made elsewhere', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('text typed while the follow-reload reads the file survives it', async () => {
    recordingFilo({ 'Plan.md': NOTE });
    vaultStore.setPath(VAULT);
    const other = noteStore.acquire('Plan.md', 'test:other');
    await other.loaded;
    const target = document.createElement('div');
    document.body.appendChild(target);
    const view = mount(NoteRawView, { target, props: { path: 'Plan.md' } });
    const field = await loadedRawView(target);
    expect(field.state.doc.toString()).toBe(NOTE);

    const hold = holdNoteReads();
    // Another view changes the note: the raw view schedules its follow.
    noteStore.patchFrontmatter('Plan.md', { set: { status: 'open' }, unset: [] });
    await waitMs(400);
    expect(hold.held()).toBeGreaterThan(0);

    const typed = '---\ntitle: Plan\n---\nTyped during the read\n';
    typeOver(field, typed);
    await settle();
    hold.release();
    await waitMs(600);

    expect(field.state.doc.toString()).toBe(typed);
    await unmount(view);
    await settle();
    noteStore.release('Plan.md', 'test:other');
  });
});

describe('raw view editability', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('a field made before the note is read becomes editable once it is', async () => {
    recordingFilo({ 'Plan.md': NOTE });
    vaultStore.setPath(VAULT);
    const hold = holdNoteReads();
    const target = document.createElement('div');
    document.body.appendChild(target);
    const view = mount(NoteRawView, { target, props: { path: 'Plan.md' } });
    // The field's code is in before the read comes back: it waits, read-only.
    let content: HTMLElement | null = null;
    for (let i = 0; i < 100 && !content; i++) {
      await settle();
      content = target.querySelector<HTMLElement>('.cm-content');
    }
    expect(content?.getAttribute('contenteditable')).toBe('false');
    expect(target.querySelector('.raw-text')?.getAttribute('aria-busy')).toBe('true');
    hold.release();
    const field = await loadedRawView(target);
    expect(field.state.doc.toString()).toBe(NOTE);
    expect(field.contentDOM.getAttribute('contenteditable')).toBe('true');
    await unmount(view);
    await settle();
  });

  it('freezes while a close saves, and thaws if the close is called off', async () => {
    recordingFilo({ 'Plan.md': NOTE });
    vaultStore.setPath(VAULT);
    const target = document.createElement('div');
    document.body.appendChild(target);
    const view = mount(NoteRawView, { target, props: { path: 'Plan.md' } });
    const field = await loadedRawView(target);
    expect(field.state.readOnly).toBe(false);
    const release = holdCloseDrainUntilSwap();
    await settle();
    expect(field.state.readOnly).toBe(true);
    expect(field.contentDOM.getAttribute('contenteditable')).toBe('false');
    release();
    await settle();
    expect(field.state.readOnly).toBe(false);
    await unmount(view);
    await settle();
  });
});
