import { describe, it, expect } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import { KeyedSvelteMap, KeyedVersions } from '@renderer/lib/utils/keyedReactivity.svelte';
import { probeDerived } from '../helpers/derivedProbe.svelte';

describe('KeyedSvelteMap', () => {
  it('a plain SvelteMap re-runs every missing-key reader on any add (why KeyedSvelteMap exists)', () => {
    const map = new SvelteMap<string, number>();
    const a = probeDerived(() => map.get('a'));
    expect(a.runs()).toBe(1);
    map.set('b', 1);
    // If Svelte ever tracks missing keys per key, KeyedSvelteMap can go.
    expect(a.runs()).toBe(2);
    a.stop();
  });

  it('a missing-key reader re-runs only when its own key is added', () => {
    const map = new KeyedSvelteMap<string, number>();
    const a = probeDerived(() => map.get('a'));
    const hasA = probeDerived(() => map.has('a'));
    map.set('b', 1);
    map.set('c', 2);
    expect(a.runs()).toBe(1);
    expect(hasA.runs()).toBe(1);
    map.set('a', 3);
    expect(a.value()).toBe(3);
    expect(hasA.value()).toBe(true);
    a.stop();
    hasA.stop();
  });

  it('a present-key reader follows changes and deletion of that key only', () => {
    const map = new KeyedSvelteMap<string, number>([['a', 1], ['b', 1]]);
    const a = probeDerived(() => map.get('a'));
    map.set('b', 2);
    expect(a.runs()).toBe(1);
    map.set('a', 2);
    expect(a.value()).toBe(2);
    map.delete('a');
    expect(a.value()).toBeUndefined();
    const before = a.runs();
    map.set('b', 3);
    expect(a.runs()).toBe(before);
    map.set('a', 9);
    expect(a.value()).toBe(9);
    a.stop();
  });

  it('iteration still sees every add', () => {
    const map = new KeyedSvelteMap<string, number>();
    const size = probeDerived(() => [...map.keys()].length);
    map.set('x', 1);
    expect(size.value()).toBe(1);
    size.stop();
  });
});

describe('KeyedVersions', () => {
  it('re-runs a reader only for its own key, and every reader on reset', () => {
    const v = new KeyedVersions<string>();
    let aReads = 0;
    const a = probeDerived(() => {
      v.track('a');
      return ++aReads;
    });
    const b = probeDerived(() => {
      v.track('b');
      return 0;
    });
    v.bump('b');
    v.bump('zzz');
    expect(a.runs()).toBe(1);
    expect(b.runs()).toBe(2);
    v.bump('a');
    expect(a.runs()).toBe(2);
    v.reset();
    expect(a.runs()).toBe(3);
    expect(b.runs()).toBe(3);
    // Still tracked after a reset.
    v.bump('a');
    expect(a.runs()).toBe(4);
    v.bumpAll();
    expect(a.runs()).toBe(5);
    expect(b.runs()).toBe(4);
    a.stop();
    b.stop();
  });
});
