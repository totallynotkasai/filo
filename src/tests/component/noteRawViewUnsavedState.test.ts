import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import NoteRawView from '@renderer/components/boards/NoteRawView.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { isUnsavedWorkEmpty, unsavedWork } from '@renderer/lib/boards/writeStateTracking';
import { mayLoseWorkNow, type UnsavedStateSources } from '@renderer/lib/vault/unsavedStateReport';
import { recordingFilo, settle, resetEditorHarness, teardownEditorHarness, VAULT } from './helpers/mountEditor';
import { loadedRawView, typeOver } from './helpers/rawView';

/**
 * Text typed in the Raw view is unsaved work to the Windows shutdown check,
 * as it was in the textarea: through the raw-view registry, the moment it is
 * typed, and no longer once it is saved.
 */
const NOTE = '---\ntitle: Plan\n---\nBody\n';

const sources: UnsavedStateSources = {
  nothingUnsaved: () => isUnsavedWorkEmpty(unsavedWork()),
  heldDecisionCount: () => 0,
  openSettingsEdits: () => false,
};

describe('raw view text and the shutdown check', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('typed text counts while unsaved, and stops counting once saved', async () => {
    const filo = recordingFilo({ 'Plan.md': NOTE });
    vaultStore.setPath(VAULT);
    const target = document.createElement('div');
    document.body.appendChild(target);
    const view = mount(NoteRawView, { target, props: { path: 'Plan.md' } });
    const field = await loadedRawView(target);
    field.focus();
    await settle();
    expect(mayLoseWorkNow(sources)).toBe(false);

    const typed = '---\ntitle: Plan\n---\nBody, typed raw\n';
    typeOver(field, typed);
    expect(unsavedWork().pending).toEqual(['plan.md']);
    expect(mayLoseWorkNow(sources)).toBe(true);

    // Ctrl+S saves it; the field keeps the focus and nothing is left.
    field.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    for (let i = 0; i < 20 && filo.files.get('Plan.md') !== typed; i++) await settle();
    expect(filo.files.get('Plan.md')).toBe(typed);
    await settle();
    expect(field.hasFocus).toBe(true);
    expect(mayLoseWorkNow(sources)).toBe(false);
    await unmount(view);
    await settle();
  });
});
