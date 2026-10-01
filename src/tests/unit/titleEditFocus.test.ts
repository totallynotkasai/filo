import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { commitWhenLeft, keepsEditing, TITLE_FOCUS_LEAVE_MS } from '@renderer/lib/editor/titleEditFocus';

/**
 * When a title or label edit ends: a press outside it, or focus moving
 * outside it, except into the app toolbar or a popup it opened. A window
 * switch (focus stays on the editor) doesn't end it.
 */

let host: HTMLElement;
let inside: HTMLElement;
let toolbarButton: HTMLButtonElement;
let popupInput: HTMLInputElement;
let elsewhere: HTMLButtonElement;
let stop: (() => void) | null = null;

beforeEach(() => {
  document.body.innerHTML = `
    <header class="global-toolbar"><button id="bold">B</button></header>
    <div data-keeps-editor-focus="true"><input id="hex"></div>
    <div id="host"><div id="inside" contenteditable="true">Title</div></div>
    <button id="elsewhere">Other</button>`;
  host = document.getElementById('host')!;
  inside = document.getElementById('inside')!;
  toolbarButton = document.getElementById('bold') as HTMLButtonElement;
  popupInput = document.getElementById('hex') as HTMLInputElement;
  elsewhere = document.getElementById('elsewhere') as HTMLButtonElement;
  inside.focus();
  vi.useFakeTimers();
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function watch(): { commits: () => number } {
  let n = 0;
  stop = commitWhenLeft(host, () => { n++; });
  return { commits: () => n };
}

function press(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
}

describe('keepsEditing', () => {
  it('the edit itself, the toolbar and its popups keep it open; anything else does not', () => {
    expect(keepsEditing(host, inside)).toBe(true);
    expect(keepsEditing(host, toolbarButton)).toBe(true);
    expect(keepsEditing(host, popupInput)).toBe(true);
    expect(keepsEditing(host, elsewhere)).toBe(false);
    expect(keepsEditing(host, document.body)).toBe(false);
    expect(keepsEditing(host, null)).toBe(false);
  });
});

describe('commitWhenLeft', () => {
  it('a press outside commits at once', () => {
    const w = watch();
    press(elsewhere);
    expect(w.commits()).toBe(1);
  });

  it('a press inside the edit, on the toolbar or in its popup does not', () => {
    const w = watch();
    press(inside);
    press(toolbarButton);
    press(popupInput);
    vi.advanceTimersByTime(TITLE_FOCUS_LEAVE_MS * 2);
    expect(w.commits()).toBe(0);
  });

  it('focus moving elsewhere commits once the check has run', () => {
    const w = watch();
    elsewhere.focus();
    vi.advanceTimersByTime(TITLE_FOCUS_LEAVE_MS - 1);
    expect(w.commits()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(w.commits()).toBe(1);
  });

  it('focus going to nothing (a click on a spot that takes no focus) commits', () => {
    const w = watch();
    inside.blur();
    vi.advanceTimersByTime(TITLE_FOCUS_LEAVE_MS);
    expect(w.commits()).toBe(1);
  });

  it('focus into the toolbar does not, but on from there it does', () => {
    const w = watch();
    toolbarButton.focus();
    vi.advanceTimersByTime(TITLE_FOCUS_LEAVE_MS);
    expect(w.commits()).toBe(0);
    elsewhere.focus();
    vi.advanceTimersByTime(TITLE_FOCUS_LEAVE_MS);
    expect(w.commits()).toBe(1);
  });

  it('focus that comes back to the edit within the check does not', () => {
    const w = watch();
    elsewhere.focus();
    inside.focus();
    vi.advanceTimersByTime(TITLE_FOCUS_LEAVE_MS);
    expect(w.commits()).toBe(0);
  });

  it('a window switch, which leaves the edit focused, does not', () => {
    const w = watch();
    inside.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    vi.advanceTimersByTime(TITLE_FOCUS_LEAVE_MS);
    expect(document.activeElement).toBe(inside);
    expect(w.commits()).toBe(0);
  });

  it('stopping drops a pending check and stops watching', () => {
    const w = watch();
    elsewhere.focus();
    stop!();
    stop = null;
    vi.advanceTimersByTime(TITLE_FOCUS_LEAVE_MS);
    press(elsewhere);
    expect(w.commits()).toBe(0);
  });
});
