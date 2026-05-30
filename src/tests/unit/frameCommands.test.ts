/**
 * Phase C / C.3 — frame-delete confirm gate.
 *
 * Both Frame.svelte's trash icon and MindMapBoard.svelte's context menu
 * route delete through `confirmRemoveFrame`. The helper builds the
 * openConfirm config from a tileCount and fires `onConfirmed` only
 * when the user picks Confirm. This test locks the contract.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { confirmRemoveFrame } from '@renderer/lib/frames/confirmRemoveFrame';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { ConfirmDialogConfig } from '@renderer/stores/ui.svelte';

beforeEach(() => {
  uiStore.closeConfirm();
});

describe('confirmRemoveFrame (Phase C / C.3)', () => {
  it('routes through openConfirm with danger=true and a Remove confirm label', () => {
    let captured: ConfirmDialogConfig | null = null;
    confirmRemoveFrame({
      openConfirm: (cfg) => { captured = cfg; },
      onConfirmed: () => {},
      tileCount: 5,
    });
    expect(captured).not.toBeNull();
    expect(captured!.title).toBe('Remove frame?');
    expect(captured!.confirmLabel).toBe('Remove');
    expect(captured!.danger).toBe(true);
    // Surface the tile count so the user knows scope before confirming.
    expect(captured!.body).toContain('5');
  });

  it('uses a softer body line when the frame is empty', () => {
    let captured: ConfirmDialogConfig | null = null;
    confirmRemoveFrame({
      openConfirm: (cfg) => { captured = cfg; },
      onConfirmed: () => {},
      tileCount: 0,
    });
    expect(captured!.body).not.toContain('0');
    expect(captured!.body.toLowerCase()).toContain('tiles inside remain');
  });

  it('Confirm path fires onConfirmed exactly once', () => {
    let calls = 0;
    confirmRemoveFrame({
      openConfirm: (cfg) => { cfg.onConfirm(false); },
      onConfirmed: () => { calls++; },
      tileCount: 2,
    });
    expect(calls).toBe(1);
  });

  it('Cancel path leaves onConfirmed unfired', () => {
    let calls = 0;
    confirmRemoveFrame({
      openConfirm: (cfg) => { cfg.onCancel?.(); },
      onConfirmed: () => { calls++; },
      tileCount: 2,
    });
    expect(calls).toBe(0);
  });

  it('end-to-end through the live uiStore: onConfirmed runs when the dialog config is confirmed', () => {
    let confirmed = false;
    confirmRemoveFrame({
      openConfirm: uiStore.openConfirm,
      onConfirmed: () => { confirmed = true; },
      tileCount: 1,
    });
    expect(uiStore.confirmDialog).not.toBeNull();
    const cfg = uiStore.confirmDialog!;
    uiStore.closeConfirm();
    cfg.onConfirm(false);
    expect(confirmed).toBe(true);
  });
});
