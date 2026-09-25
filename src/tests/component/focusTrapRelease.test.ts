/**
 * Closing a dialog releases its focus trap.
 *
 * Every focus trap shares focus-trap's global stack. A trap left on it after
 * its dialog closed keeps document keydown / mousedown / focusin listeners on
 * a detached container, so the next Tab (e.g. in a text tile) or mousedown
 * (e.g. on the canvas) throws "must have at least one container with at least
 * one tabbable node". This mounts the real AppShell, opens and closes a
 * Modal, a ConfirmDialog and the Board Browser, then presses Tab in a
 * contenteditable and mouses down elsewhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import '../characterisation/harness/domPolyfills';
import AppShell from '@renderer/components/layout/AppShell.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { settle } from './helpers/mountEditor';

// focus-trap's stack is private; its document listeners are not. An active
// trap holds exactly one `checkFocusIn` capture listener, and a paused one
// none, so the live count is the number of traps still activated.
const FOCUS_TRAP_LISTENER = 'checkFocusIn';
let liveTrapListeners = 0;
const realAdd = document.addEventListener.bind(document);
const realRemove = document.removeEventListener.bind(document);

function isTrapListener(type: string, fn: unknown): boolean {
  return type === 'focusin' && typeof fn === 'function' && fn.name === FOCUS_TRAP_LISTENER;
}

describe('focus traps are released when their dialog closes', () => {
  let app: ReturnType<typeof mount> | null = null;
  let host: HTMLDivElement;
  let uncaught: unknown[];
  const onError = (e: ErrorEvent): void => { uncaught.push(e.error ?? e.message); };

  beforeEach(() => {
    liveTrapListeners = 0;
    uncaught = [];
    document.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
      if (isTrapListener(type, fn)) liveTrapListeners++;
      realAdd(type, fn, opts);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) => {
      if (isTrapListener(type, fn)) liveTrapListeners--;
      realRemove(type, fn, opts);
    }) as typeof document.removeEventListener;
    window.addEventListener('error', onError);
    host = document.createElement('div');
    document.body.appendChild(host);
    app = mount(AppShell, { target: host });
    flushSync();
  });

  afterEach(() => {
    uiStore.closeConfirm();
    uiStore.closeModal();
    flushSync();
    if (app) unmount(app);
    app = null;
    host.remove();
    window.removeEventListener('error', onError);
    document.addEventListener = realAdd;
    document.removeEventListener = realRemove;
  });

  function pressTabInEditable(): void {
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.tabIndex = 0;
    document.body.appendChild(editable);
    editable.focus();
    editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, bubbles: true, cancelable: true }));
    editable.remove();
  }

  function mousedownOnCanvas(): void {
    const canvas = document.createElement('div');
    canvas.className = 'canvas-viewport';
    document.body.appendChild(canvas);
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    canvas.remove();
  }

  async function openAndClose(open: () => void, close: () => void, selector: string): Promise<void> {
    open();
    flushSync();
    await settle();
    expect(document.querySelector(selector)).not.toBeNull();
    expect(liveTrapListeners).toBe(1);
    close();
    flushSync();
    await settle();
    expect(document.querySelector(selector)).toBeNull();
    expect(liveTrapListeners).toBe(0);
  }

  it('Modal, ConfirmDialog and Board Browser leave no trap behind', async () => {
    await openAndClose(
      () => uiStore.openModal('keyboard-shortcuts'),
      () => uiStore.closeModal(),
      'dialog.modal-dialog',
    );
    await openAndClose(
      () => uiStore.openConfirm({ title: 'Sure?', body: 'Body', onConfirm: () => {} }),
      () => uiStore.closeConfirm(),
      'dialog.confirm-dialog',
    );
    await openAndClose(
      () => uiStore.openModal('board-browser'),
      () => uiStore.closeModal(),
      '.board-browser-panel',
    );

    pressTabInEditable();
    mousedownOnCanvas();
    expect(uncaught).toEqual([]);
    expect(liveTrapListeners).toBe(0);
  });

  it('a confirm stacked over a modal hands the trap back, then both release', async () => {
    uiStore.openModal('keyboard-shortcuts');
    flushSync();
    await settle();
    uiStore.openConfirm({ title: 'Sure?', body: 'Body', onConfirm: () => {} });
    flushSync();
    await settle();
    // The modal's trap is paused beneath the confirm's.
    expect(liveTrapListeners).toBe(1);
    uiStore.closeConfirm();
    flushSync();
    await settle();
    expect(liveTrapListeners).toBe(1);
    uiStore.closeModal();
    flushSync();
    await settle();
    expect(liveTrapListeners).toBe(0);

    pressTabInEditable();
    mousedownOnCanvas();
    expect(uncaught).toEqual([]);
  });

  it('the Board Browser backdrop is a sibling behind the panel, not an aria-hidden parent', async () => {
    uiStore.openModal('board-browser');
    flushSync();
    await settle();
    const panel = document.querySelector('.board-browser-panel');
    const backdrop = document.querySelector('.board-browser-backdrop');
    expect(panel).not.toBeNull();
    expect(backdrop).not.toBeNull();
    expect(backdrop?.contains(panel)).toBe(false);
    expect(panel?.closest('[aria-hidden="true"]')).toBeNull();

    (backdrop as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    await settle();
    expect(uiStore.activeModal).toBeNull();
    expect(liveTrapListeners).toBe(0);
  });

  it('dismissing the Board Browser returns focus to the control that opened it', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    uiStore.openModal('board-browser');
    flushSync();
    await settle();
    expect(document.activeElement).not.toBe(opener);
    (document.querySelector('.board-browser-panel-close') as HTMLButtonElement).click();
    flushSync();
    await settle();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
