/**
 * Enter in the Tags Browser's rename field takes the key for itself. The
 * merge confirm it can open puts focus on Cancel, and in Chromium the same
 * key's keypress then activates that button: the confirm flashed and was
 * cancelled, so a merge couldn't be made with Enter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import TagsBrowser from '@renderer/components/tags/TagsBrowser.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';

let instance: ReturnType<typeof mount> | null = null;

describe('Tags Browser rename field', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false; };
    fileTagsStore.reset();
    fileTagsStore.ensureTag('blocked');
    uiStore.openModal('tags-browser');
    const target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(TagsBrowser, { target });
    flushSync();
  });

  afterEach(() => {
    if (instance) unmount(instance);
    instance = null;
    uiStore.closeConfirm();
    uiStore.closeModal();
    vi.restoreAllMocks();
    fileTagsStore.reset();
    document.body.innerHTML = '';
  });

  it('Enter is kept from the confirm it opens', () => {
    vi.spyOn(fileTagsStore, 'renameTagEverywhere').mockResolvedValue({ committed: false, writtenPaths: [] });
    document.querySelector<HTMLButtonElement>('button[aria-label="Rename"]')!.click();
    flushSync();
    const input = document.querySelector<HTMLInputElement>('.col-name input')!;
    input.value = 'waiting';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });
});
