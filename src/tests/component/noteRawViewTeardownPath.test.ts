/**
 * A pane switching to another tab tears the Raw view down after its tab has
 * changed, so its `path` prop can by then name the next tab's note, or none
 * (that note is still loading). The text typed there is still saved to the
 * note the view showed, never lost or filed under another name.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import NoteRawView from '@renderer/components/boards/NoteRawView.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { recordingFilo, settle, resetEditorHarness, teardownEditorHarness, VAULT } from './helpers/mountEditor';
import { loadedRawView, typeOver } from './helpers/rawView';

const NOTE = '---\ntitle: Plan\n---\nBody\n';
const TYPED = '---\ntitle: Plan\n---\nBody, typed raw\n';

describe('a raw view torn down after its tab changed', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  for (const next of ['', 'Other.md']) {
    it(`saves to its own note when the prop already says ${next ? `"${next}"` : 'nothing'}`, async () => {
      const filo = recordingFilo({ 'Plan.md': NOTE, 'Other.md': '---\ntitle: Other\n---\nOther\n' });
      vaultStore.setPath(VAULT);
      let shown = 'Plan.md';
      const target = document.createElement('div');
      document.body.appendChild(target);
      // The prop is read when the view asks for it, as a parent's derived is.
      const view = mount(NoteRawView, { target, props: { get path() { return shown; } } });
      const field = await loadedRawView(target);
      field.focus();
      await settle();
      typeOver(field, TYPED);
      await settle();

      shown = next;
      await unmount(view);
      for (let i = 0; i < 8 && filo.files.get('Plan.md') !== TYPED; i++) await settle();

      expect(filo.files.get('Plan.md')).toBe(TYPED);
      expect(filo.files.get('Other.md')).toBe('---\ntitle: Other\n---\nOther\n');
    });
  }
});
