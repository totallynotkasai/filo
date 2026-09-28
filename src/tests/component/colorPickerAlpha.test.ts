/**
 * The colour picker keeps a value's alpha: a hue picked for a translucent
 * token (a backdrop, a selection tint) stays translucent, and an Opacity
 * slider sets it. The swatch is announced by what it colours.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import ColorPicker from '@renderer/components/shared/ColorPicker.svelte';
import { formatCssColor, parseCssColor } from '@renderer/lib/utils/color';
import { settle } from './helpers/mountEditor';

let component: ReturnType<typeof mount> | null = null;
let changes: string[] = [];

async function mountPicker(props: Record<string, unknown>): Promise<void> {
  changes = [];
  const target = document.createElement('div');
  document.body.appendChild(target);
  component = mount(ColorPicker, {
    target,
    props: { onchange: (c: string) => { changes.push(c); }, ...props } as never,
  });
  await settle();
}

function opacity(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Opacity"]');
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('parseCssColor / formatCssColor', () => {
  it('reads hex, 8-digit hex and rgb()/rgba() in both syntaxes', () => {
    expect(parseCssColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseCssColor('#11223380')).toEqual({ r: 17, g: 34, b: 51, a: 128 / 255 });
    expect(parseCssColor('rgba(10, 20, 30, 0.4)')).toEqual({ r: 10, g: 20, b: 30, a: 0.4 });
    expect(parseCssColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseCssColor('color-mix(in srgb, red 20%, transparent)')).toBeNull();
    expect(parseCssColor('tomato')).toBeNull();
  });

  it('writes hex when opaque, rgba() otherwise', () => {
    expect(formatCssColor({ r: 255, g: 0, b: 0, a: 1 })).toBe('#ff0000');
    expect(formatCssColor({ r: 255, g: 0, b: 0, a: 0.456 })).toBe('rgba(255, 0, 0, 0.46)');
  });
});

describe('ColorPicker alpha', () => {
  it('a preset picked over a translucent value keeps the value\'s opacity', async () => {
    await mountPicker({ value: 'rgba(10, 20, 30, 0.4)', expanded: true, allowAuto: false });
    document.querySelector<HTMLButtonElement>('button[aria-label="#d32f2f"]')?.click();
    await settle();
    expect(changes).toEqual(['rgba(211, 47, 47, 0.4)']);
  });

  it('the Opacity slider shows for a translucent value and sets the alpha', async () => {
    await mountPicker({ value: 'rgba(10, 20, 30, 0.4)', expanded: true, allowAuto: false });
    const slider = opacity();
    expect(slider).not.toBeNull();
    slider!.value = '0.8';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(changes).toEqual(['rgba(10, 20, 30, 0.8)']);
  });

  it('an opaque value has no slider unless asked for, and stays hex', async () => {
    await mountPicker({ value: '#102030', expanded: true, allowAuto: false });
    expect(opacity()).toBeNull();
    document.querySelector<HTMLButtonElement>('button[aria-label="#d32f2f"]')?.click();
    await settle();
    expect(changes).toEqual(['#d32f2f']);
    if (component) await unmount(component);
    await mountPicker({ value: '#102030', expanded: true, allowAuto: false, showAlpha: true });
    expect(opacity()).not.toBeNull();
  });
});

describe('ColorPicker swatch', () => {
  it('is announced by what it colours, and takes an id for a <label for>', async () => {
    await mountPicker({ value: '#102030', ariaLabel: 'Dialog backdrop colour', id: 'backdrop-swatch' });
    const swatch = document.querySelector<HTMLButtonElement>('.color-swatch');
    expect(swatch?.getAttribute('aria-label')).toBe('Dialog backdrop colour');
    expect(swatch?.id).toBe('backdrop-swatch');
  });
});
