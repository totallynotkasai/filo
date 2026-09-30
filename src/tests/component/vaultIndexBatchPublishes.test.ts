/**
 * A tag sweep rewrites every note that carries the tag. Published one by one,
 * each note re-counted every tag view; inside `batchPublishes` the index tells
 * its readers at most every `PUBLISH_THROTTLE_MS`, and once when it ends.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import { vaultIndexStore, PUBLISH_THROTTLE_MS } from '@renderer/stores/vaultIndex.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { probeDerived, type DerivedProbe } from '../helpers/derivedProbe.svelte';

const tagged = (path: string, tag: string): void =>
  vaultIndexStore.restoreMetadata(path, parseMarkdown(path, `---\ntags: [${tag}]\n---\nbody\n`));

describe('vaultIndexStore.batchPublishes', () => {
  let tagCounts: DerivedProbe<number> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vaultIndexStore.clear();
    for (let i = 0; i < 50; i++) tagged(`n${i}.md`, 'idea');
    tagCounts = probeDerived(() => vaultIndexStore.allTags().get('idea') ?? 0);
  });
  afterEach(() => {
    tagCounts?.stop();
    vi.useRealTimers();
  });

  it('re-counts tags once for a batch of fifty tag changes, not fifty times', async () => {
    const probe = tagCounts!;
    expect(probe.value()).toBe(50);
    const before = probe.runs();

    await vaultIndexStore.batchPublishes(async () => {
      for (let i = 0; i < 50; i++) tagged(`n${i}.md`, 'concept');
      flushSync();
      expect(probe.runs()).toBe(before);
    });

    expect(probe.value()).toBe(0);
    expect(probe.runs()).toBe(before + 1);
  });

  it('publishes on the throttle while the batch is still running', async () => {
    const probe = tagCounts!;
    let release: () => void = () => {};
    const batch = vaultIndexStore.batchPublishes(() => new Promise<void>((r) => { release = r; }));
    tagged('n0.md', 'concept');
    expect(probe.value()).toBe(50);
    vi.advanceTimersByTime(PUBLISH_THROTTLE_MS);
    expect(probe.value()).toBe(49);
    release();
    await batch;
  });

  it('outside a batch, a change publishes at once', () => {
    tagged('n0.md', 'concept');
    expect(tagCounts!.value()).toBe(49);
  });
});
