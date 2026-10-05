/**
 * The Task List date picker from the keyboard (E-17): it opened with focus
 * left behind it (so Escape and the arrows did nothing there), its days were
 * read out as ISO dates, and every week started on Sunday. Now focus moves to
 * the chosen day, the arrows, Home / End and Page Up / Down move it, Enter
 * picks, Escape closes, and focus goes back where it was.
 *
 * The real picker, mounted in jsdom.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import TaskDatePicker from '@renderer/components/boards/TaskDatePicker.svelte';

let instance: ReturnType<typeof mount> | null = null;

async function open(opts: { value: string; locale?: string; time?: string }) {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null, on: () => () => {}, send: () => {}, systemLocale: opts.locale ?? 'en-GB',
  };
  const opener = document.createElement('button');
  opener.textContent = 'Due';
  document.body.appendChild(opener);
  opener.focus();
  const onPick = vi.fn();
  const onPickTime = vi.fn();
  const onClose = vi.fn(() => {
    if (instance) unmount(instance);
    instance = null;
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(TaskDatePicker, {
    target,
    props: {
      value: opts.value, anchor: { x: 10, y: 10 }, label: 'Due date', onPick, onClear: vi.fn(), onClose,
      ...(opts.time !== undefined ? { withTime: true, time: opts.time, onPickTime } : {}),
    },
  });
  flushSync();
  await tick();
  await tick();
  return { opener, onPick, onPickTime, onClose };
}

const focusedIso = (): string | undefined => (document.activeElement as HTMLElement | null)?.dataset?.iso;

async function press(key: string): Promise<void> {
  (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  flushSync();
  await tick();
  await tick();
}

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  document.body.innerHTML = '';
});

describe('the Task List date picker from the keyboard (E-17)', () => {
  it('opens with focus on the chosen day', async () => {
    await open({ value: '2026-10-12' });
    expect(focusedIso()).toBe('2026-10-12');
  });

  it('moves a day, a week, to the week\'s ends and by a month', async () => {
    await open({ value: '2026-10-12' }); // a Monday
    await press('ArrowRight');
    expect(focusedIso()).toBe('2026-10-13');
    await press('ArrowDown');
    expect(focusedIso()).toBe('2026-10-20');
    await press('ArrowUp');
    await press('ArrowLeft');
    expect(focusedIso()).toBe('2026-10-12');
    await press('End');
    expect(focusedIso()).toBe('2026-10-18'); // the week ends on Sunday in en-GB
    await press('Home');
    expect(focusedIso()).toBe('2026-10-12');
    await press('PageDown');
    expect(focusedIso()).toBe('2026-11-12');
    expect(document.querySelector('.month-label')?.textContent).toBe('November 2026');
  });

  it('Enter picks the focused day', async () => {
    const { onPick, onClose } = await open({ value: '2026-10-12' });
    await press('ArrowRight');
    (document.activeElement as HTMLButtonElement).click();
    expect(onPick).toHaveBeenCalledWith('2026-10-13');
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape closes it, and focus goes back to what opened it', async () => {
    const { opener, onClose } = await open({ value: '2026-10-12' });
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const reachedPage = vi.fn();
    window.addEventListener('keydown', reachedPage);
    (document.activeElement as HTMLElement).dispatchEvent(esc);
    window.removeEventListener('keydown', reachedPage);
    expect(onClose).toHaveBeenCalled();
    expect(reachedPage).not.toHaveBeenCalled();
    await Promise.resolve();
    await tick();
    expect(document.activeElement).toBe(opener);
  });

  it('reads each day out in full, and marks today', async () => {
    await open({ value: '2026-10-12' });
    const label = document.querySelector('[data-iso="2026-10-12"]')?.getAttribute('aria-label') ?? '';
    expect(label).toMatch(/^Monday,? 12 October 2026$/);
    expect(document.querySelectorAll('[aria-current="date"]').length).toBeLessThanOrEqual(1);
  });

  it('starts the week on the regional format\'s first day', async () => {
    await open({ value: '2026-10-12', locale: 'en-GB' });
    expect(document.querySelector('.day-cell')?.getAttribute('data-iso')).toBe('2026-09-28'); // a Monday
    unmount(instance!);
    instance = null;
    document.body.innerHTML = '';
    await open({ value: '2026-10-12', locale: 'en-US' });
    expect(document.querySelector('.day-cell')?.getAttribute('data-iso')).toBe('2026-09-27'); // a Sunday
    expect(document.querySelector('.weekday')?.getAttribute('title')).toBe('Sunday');
  });

  it('opens on today when the task has no date', async () => {
    await open({ value: '' });
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(focusedIso()).toBe(iso);
  });
});

describe('the time box saves once (E-06)', () => {
  function typeTime(...values: string[]): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>('.time-input')!;
    input.focus();
    for (const v of values) {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Chromium fires a change at each part of a time typed.
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    flushSync();
    return input;
  }

  it('saves the time once, on leaving the box', async () => {
    const { onPickTime } = await open({ value: '2026-10-12', time: '' });
    const input = typeTime('09:00', '09:30');
    expect(onPickTime).not.toHaveBeenCalled();
    input.dispatchEvent(new FocusEvent('blur'));
    flushSync();
    expect(onPickTime).toHaveBeenCalledTimes(1);
    expect(onPickTime).toHaveBeenCalledWith('09:30');
  });

  it('Enter saves it once', async () => {
    const { onPickTime } = await open({ value: '2026-10-12', time: '08:00' });
    const input = typeTime('17:00', '17:45');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    input.dispatchEvent(new FocusEvent('blur'));
    flushSync();
    expect(onPickTime).toHaveBeenCalledTimes(1);
    expect(onPickTime).toHaveBeenCalledWith('17:45');
  });

  it('Done saves a time still in the box, and an unchanged one saves nothing', async () => {
    const first = await open({ value: '2026-10-12', time: '08:00' });
    typeTime('10:15');
    document.querySelector<HTMLButtonElement>('.close-btn')!.click();
    expect(first.onPickTime).toHaveBeenCalledWith('10:15');
    expect(first.onClose).toHaveBeenCalled();
    document.body.innerHTML = '';
    const second = await open({ value: '2026-10-12', time: '08:00' });
    typeTime('08:00');
    document.querySelector<HTMLButtonElement>('.close-btn')!.click();
    expect(second.onPickTime).not.toHaveBeenCalled();
  });
});
