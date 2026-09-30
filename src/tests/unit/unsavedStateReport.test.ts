import { describe, it, expect, afterEach } from 'vitest';
import { startUnsavedStateReport, type UnsavedStateSources } from '@renderer/lib/vault/unsavedStateReport';

/**
 * What main is told about a Windows shutdown: hold it back only when leaving
 * now could lose work. A caret resting in a note editor is not work; a field
 * whose text changed since it took focus is.
 */

const clean: UnsavedStateSources = {
  nothingUnsaved: () => true,
  heldDecisionCount: () => 0,
  openSettingsEdits: () => false,
};

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = '';
});

function report(sources: UnsavedStateSources = clean): { flags: boolean[]; nudge: () => void } {
  const flags: boolean[] = [];
  const r = startUnsavedStateReport(sources, (flag) => flags.push(flag));
  stop = r.stop;
  return { flags, nudge: r.nudge };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('unsaved-state report', () => {
  it('a focused note editor with nothing unsaved does not hold a shutdown back', async () => {
    document.body.innerHTML = '<div class="ProseMirror" contenteditable="true"><p>text</p></div>';
    const editor = document.querySelector<HTMLElement>('.ProseMirror')!;
    const { flags } = report();
    editor.focus();
    await settle();
    expect(document.activeElement).toBe(editor);
    expect(flags.at(-1)).toBe(false);
  });

  it("a note editor's unserialised keystrokes do, as soon as they are typed", async () => {
    document.body.innerHTML = '<div class="ProseMirror" contenteditable="true"><p>text</p></div>';
    const editor = document.querySelector<HTMLElement>('.ProseMirror')!;
    let unserialised = false;
    const { flags } = report({ ...clean, nothingUnsaved: () => !unserialised });
    editor.focus();
    await settle();
    unserialised = true;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(flags.at(-1)).toBe(true);
  });

  it('a focused input counts only once its text changed', async () => {
    document.body.innerHTML = '<input type="text" value="Title">';
    const input = document.querySelector('input')!;
    const { flags } = report();
    input.focus();
    await settle();
    expect(flags.at(-1)).toBe(false);
    input.value = 'Title edited';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(flags.at(-1)).toBe(true);
    input.blur();
    await settle();
    expect(flags.at(-1)).toBe(false);
  });

  it('anything unsaved still counts with no field focused', () => {
    const { flags } = report({ ...clean, nothingUnsaved: () => false });
    expect(flags).toEqual([true]);
  });
});
