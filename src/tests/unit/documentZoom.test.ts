import { describe, it, expect, beforeEach } from 'vitest';
import { asDocumentZoom, zoomedIn, zoomedOut, zoomLabel, DOCUMENT_ZOOM_LEVELS } from '@renderer/lib/utils/documentZoom';
import { workspaceStore } from '@renderer/stores/workspace.svelte';

describe('document zoom levels', () => {
  it('steps through the levels and stops at either end', () => {
    expect(zoomedIn(1)).toBe(1.1);
    expect(zoomedOut(1)).toBe(0.9);
    expect(zoomedIn(2)).toBe(2);
    expect(zoomedOut(0.5)).toBe(0.5);
  });

  it('reads a stored zoom as the nearest level, and anything else as 100%', () => {
    expect(asDocumentZoom(1.26)).toBe(1.25);
    expect(asDocumentZoom(9)).toBe(2);
    expect(asDocumentZoom(0.1)).toBe(0.5);
    for (const bad of ['1.5', null, undefined, NaN, -1, 0, {}]) expect(asDocumentZoom(bad)).toBe(1);
    for (const level of DOCUMENT_ZOOM_LEVELS) expect(asDocumentZoom(level)).toBe(level);
  });

  it('labels a level as a percentage', () => {
    expect(zoomLabel(0.67)).toBe('67%');
    expect(zoomLabel(1.25)).toBe('125%');
  });
});

describe('workspaceStore.documentZoom', () => {
  beforeEach(() => {
    workspaceStore.reset();
    workspaceStore.setChangeListener(null);
  });

  it('is 100% until set, and saves a change once', () => {
    let saves = 0;
    workspaceStore.setChangeListener(() => saves++);
    expect(workspaceStore.documentZoom).toBe(1);
    workspaceStore.setDocumentZoom(1.5);
    workspaceStore.setDocumentZoom(1.5);
    expect(workspaceStore.documentZoom).toBe(1.5);
    expect(saves).toBe(1);
  });

  it('comes back from the vault’s layout, an unreadable value as 100%', () => {
    workspaceStore.hydrate({ documentZoom: 0.75 });
    expect(workspaceStore.documentZoom).toBe(0.75);
    expect(workspaceStore.serialize().documentZoom).toBe(0.75);
    workspaceStore.hydrate({ documentZoom: 'big' as unknown as number });
    expect(workspaceStore.documentZoom).toBe(1);
    workspaceStore.hydrate({});
    expect(workspaceStore.documentZoom).toBe(1);
  });
});
