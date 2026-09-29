/**
 * The Tags Browser's Rename and Delete wait while a vault-wide tag change is
 * still rewriting notes: a second change started then would wait behind the
 * first unseen, or rename a tag the first is still moving.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import TagsBrowser from '@renderer/components/tags/TagsBrowser.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { withTagSweepProgress } from '@renderer/stores/tagSweepProgress.svelte';

let instance: ReturnType<typeof mount> | null = null;

function button(label: string): HTMLButtonElement {
  const b = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!b) throw new Error(`no ${label} button`);
  return b;
}

describe('Tags Browser while a tag change runs', () => {
  beforeEach(() => {
    // jsdom has no showModal; the Modal calls it on open.
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false; };
    fileTagsStore.reset();
    fileTagsStore.ensureTag('work');
    uiStore.openModal('tags-browser');
    const target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(TagsBrowser, { target });
    flushSync();
  });

  afterEach(() => {
    if (instance) unmount(instance);
    instance = null;
    uiStore.closeModal();
    fileTagsStore.reset();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    document.body.innerHTML = '';
  });

  it('disables Rename and Delete until the sweep ends', async () => {
    expect(button('Rename').disabled).toBe(false);
    expect(button('Delete tag').disabled).toBe(false);

    let finish!: () => void;
    const sweep = withTagSweepProgress('Renaming tag "#work" to "#job"', () => new Promise<void>((r) => { finish = r; }));
    flushSync();
    expect(button('Rename').disabled).toBe(true);
    expect(button('Delete tag').disabled).toBe(true);
    expect(button('Rename').title).toBe('A tag change is still running…');

    finish();
    await sweep;
    flushSync();
    expect(button('Rename').disabled).toBe(false);
    expect(button('Delete tag').disabled).toBe(false);
  });
});
