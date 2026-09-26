/**
 * A Modal with `isolateShortcuts` keeps modifier shortcuts (Ctrl+Tab,
 * Ctrl+W) from reaching the app's window-level shortcut listener, so the
 * Settings dialog's active board can't be switched or closed behind it.
 * Without the flag the shortcut still gets through, as before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRawSnippet, mount, unmount } from 'svelte';
import Modal from '@renderer/components/shared/Modal.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { settle } from './helpers/mountEditor';

let component: ReturnType<typeof mount> | null = null;
let heard: string[] = [];
const listener = (e: KeyboardEvent): void => { heard.push(`${e.ctrlKey ? 'Ctrl+' : ''}${e.key}`); };

async function open(isolateShortcuts: boolean): Promise<HTMLButtonElement> {
  // jsdom has no showModal; the Modal calls it on open.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.open = false; };
  uiStore.openModal('iso');
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(Modal, {
    target,
    props: {
      id: 'iso',
      title: 'Iso',
      isolateShortcuts,
      children: createRawSnippet(() => ({ render: () => '<button id="inside">x</button>' })),
    },
  });
  await settle();
  window.addEventListener('keydown', listener);
  const inside = document.getElementById('inside');
  if (!(inside instanceof HTMLButtonElement)) throw new Error('no content');
  return inside;
}

function press(el: HTMLElement, key: string, ctrlKey: boolean): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true }));
}

afterEach(async () => {
  window.removeEventListener('keydown', listener);
  heard = [];
  if (component) await unmount(component);
  component = null;
  uiStore.closeModal();
  document.body.innerHTML = '';
});

describe('Modal isolateShortcuts', () => {
  it('stops a modifier shortcut but lets plain keys through', async () => {
    const inside = await open(true);
    press(inside, 'Tab', true);
    press(inside, 'a', false);
    expect(heard).toEqual(['a']);
  });

  it('lets shortcuts through when not set', async () => {
    const inside = await open(false);
    press(inside, 'Tab', true);
    expect(heard).toEqual(['Ctrl+Tab']);
  });
});
