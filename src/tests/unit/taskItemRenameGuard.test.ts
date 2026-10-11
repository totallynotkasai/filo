import { describe, it, expect, vi } from 'vitest';

/**
 * Inline title rename used to double-fire. `commitEdit()` set
 * `isEditing = false`, which unmounts the <input> and fires its `blur` →
 * `handleTitleBlur` → `commitEdit()` a SECOND time (the `cancellingEdit` flag
 * only covered the Cancel path). `renameTask` suspends at an `await`, so on
 * the second pass `tile.title` was still the old value and the duplicate
 * rename hit ENOENT — popping a false "Task file is no longer on disk" warning
 * on essentially every rename.
 *
 * The component can't be mounted here (vitest can't preprocess a Svelte
 * `<style>`), so this models the exact handler closure from `TaskItem.svelte`
 * and drives the Enter / confirm-button / unmount-blur sequences. The
 * `if (!isEditing) return;` guard is what makes the re-entrant blur a no-op.
 */

interface RenameHarness {
  enter(): void; // onTitleKeydown(Enter) → commitEdit
  clickConfirm(): void; // confirm button → commitEdit
  unmountBlur(): void; // input unmount fires blur → handleTitleBlur
  cancel(): void; // Escape / cancel button → cancelEdit
}

/**
 * Verbatim port of TaskItem.svelte's commit/blur/cancel handlers (with the
 * one-shot guard AND the external-mid-edit guard). `titleAtCommit` models
 * `tile.title` as seen at commit time — defaults to the start title (no external
 * change), so the one-shot cases below are unaffected.
 */
function makeHarness(
  onRename: (t: string) => void,
  opts: { editTitle: string; tileTitle: string; titleAtCommit?: string },
): RenameHarness {
  let isEditing = true;
  let cancellingEdit = false;
  const { editTitle, tileTitle } = opts;
  const titleAtEditStart = tileTitle; // captured by startEdit()
  const liveTitle = opts.titleAtCommit ?? tileTitle; // tile.title at commit

  function commitEdit(): void {
    if (!isEditing) return; // one-shot guard — first commit already flipped this
    isEditing = false;
    if (liveTitle !== titleAtEditStart) return; // external rename won; drop the draft
    if (editTitle.trim() && editTitle !== liveTitle) {
      onRename(editTitle.trim());
    }
  }
  function handleTitleBlur(): void {
    if (cancellingEdit) return;
    commitEdit();
  }
  function cancelEdit(): void {
    cancellingEdit = true;
    isEditing = false;
  }
  return {
    enter: () => commitEdit(),
    clickConfirm: () => commitEdit(),
    unmountBlur: () => handleTitleBlur(),
    cancel: () => cancelEdit(),
  };
}

describe('inline rename commit is one-shot', () => {
  it('Enter then the unmount-blur fires onRename exactly once', () => {
    const onRename = vi.fn();
    const h = makeHarness(onRename, { editTitle: 'New', tileTitle: 'Old' });
    h.enter(); // Enter → commitEdit #1 (isEditing → false)
    h.unmountBlur(); // input unmounts → blur → commitEdit #2 (guarded no-op)
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('New');
  });

  it('clicking confirm then the unmount-blur fires onRename exactly once', () => {
    const onRename = vi.fn();
    const h = makeHarness(onRename, { editTitle: 'New', tileTitle: 'Old' });
    h.clickConfirm();
    h.unmountBlur();
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('an unchanged title does not rename', () => {
    const onRename = vi.fn();
    const h = makeHarness(onRename, { editTitle: 'Same', tileTitle: 'Same' });
    h.enter();
    h.unmountBlur();
    expect(onRename).not.toHaveBeenCalled();
  });

  it('cancel suppresses the commit entirely', () => {
    const onRename = vi.fn();
    const h = makeHarness(onRename, { editTitle: 'New', tileTitle: 'Old' });
    h.cancel(); // Escape/cancel → cancellingEdit true, isEditing false
    h.unmountBlur(); // blur sees cancellingEdit → returns
    expect(onRename).not.toHaveBeenCalled();
  });

  it('does NOT overwrite an external mid-edit rename with the stale draft', () => {
    // Editing began while the tile read "Old"; an external rename changed it to
    // "Renamed" before the user pressed Enter. The draft must NOT clobber it.
    const onRename = vi.fn();
    const h = makeHarness(onRename, { editTitle: 'New', tileTitle: 'Old', titleAtCommit: 'Renamed' });
    h.enter();
    expect(onRename).not.toHaveBeenCalled();
  });

  it('still renames when the title was untouched during the edit', () => {
    const onRename = vi.fn();
    const h = makeHarness(onRename, { editTitle: 'New', tileTitle: 'Old' }); // no external change
    h.enter();
    expect(onRename).toHaveBeenCalledWith('New');
  });

  it('WITHOUT the guard, the same sequence double-fires (documents the bug)', () => {
    // Inline the PRE-FIX commitEdit (no `if (!isEditing) return`) to prove the
    // guard is what fixes it. tile.title stays 'Old' because the real rename is
    // async, so the `editTitle !== tileTitle` guard does NOT short-circuit #2.
    const onRename = vi.fn();
    let isEditing = true;
    const editTitle: string = 'New';
    const tileTitle: string = 'Old';
    function buggyCommit(): void {
      isEditing = false;
      if (editTitle.trim() && editTitle !== tileTitle) onRename(editTitle.trim());
    }
    buggyCommit(); // Enter
    buggyCommit(); // unmount-blur
    expect(onRename).toHaveBeenCalledTimes(2); // the double-fire the guard fixes
    expect(isEditing).toBe(false);
  });
});
