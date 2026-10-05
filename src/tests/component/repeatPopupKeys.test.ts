/**
 * The Repeat menu's "Every…" popup from the keyboard. It opens from a
 * context menu, which hands focus back to what opened it (the repeat chip)
 * as it closes; the popup keeps focus inside, so Escape and Enter reach it.
 * Without that, Escape left the popup (and its backdrop over the app) open.
 *
 * The real popup, mounted in jsdom.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import RepeatPopup from '@renderer/components/boards/RepeatPopup.svelte';

let instance: ReturnType<typeof mount> | null = null;

async function open(recurrence = '') {
  const chip = document.createElement('button');
  chip.textContent = 'Repeat';
  document.body.appendChild(chip);
  chip.focus();
  const onSave = vi.fn();
  const onClose = vi.fn(() => {
    if (instance) unmount(instance);
    instance = null;
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(RepeatPopup, { target, props: { recurrence, anchor: { x: 10, y: 10 }, onSave, onClose } });
  flushSync();
  await tick();
  return { chip, onSave, onClose };
}

const popup = (): HTMLElement => document.querySelector('.repeat-popup') as HTMLElement;

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  document.body.innerHTML = '';
});

describe('the "Every…" popup from the keyboard', () => {
  it('keeps focus when the menu that opened it hands focus back to the chip, so Escape closes it', async () => {
    const { chip, onClose } = await open();
    // What the context menu does as it closes.
    chip.focus();
    await tick();
    expect(popup().contains(document.activeElement)).toBe(true);
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalled();
    await Promise.resolve();
    await tick();
    expect(document.activeElement).toBe(chip);
  });

  it('opens on the task\'s own "every N" rule, and Enter saves the number and unit', async () => {
    const { onSave } = await open('every 3 days');
    const count = document.querySelector<HTMLInputElement>('.repeat-count')!;
    expect(count.value).toBe('3');
    expect(document.activeElement).toBe(count);
    count.value = '5';
    count.dispatchEvent(new Event('input', { bubbles: true }));
    const unit = document.querySelector<HTMLSelectElement>('.repeat-unit')!;
    unit.value = 'm';
    unit.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    count.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onSave).toHaveBeenCalledWith('every 5 months');
  });

  it('refuses a number it can\'t keep', async () => {
    const { onSave } = await open();
    const count = document.querySelector<HTMLInputElement>('.repeat-count')!;
    count.value = '0';
    count.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    count.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLButtonElement>('.repeat-btn.primary')!.disabled).toBe(true);
  });
});
