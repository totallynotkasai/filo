/**
 * `clearStaleDndStyles` — Svelte action used on every rendered
 * `.tasklist-section` in TaskListBoard.
 *
 * svelte-dnd-action writes inline `visibility: hidden` / `opacity` /
 * `transform` on shadow items during a drag; Svelte's keyed `{#each}` then
 * reuses those DOM nodes after the reorder commit, so the stale inline
 * styles can stick to the section now rendered below the moved one — the
 * "section below goes invisible" symptom.
 *
 * Passing the dnd-mirror as the trigger argument forces the action's
 * `update` callback to run on every reorder commit, on the exact DOM node
 * Svelte just patched — no `queueMicrotask`, no global query, no race
 * against `pointerup`. Cancelled drags don't write a reorder commit, so
 * no stale styles get persisted in that path either.
 */
export function clearStaleDndStyles(
  node: HTMLElement,
  _trigger: unknown,
): { update(next: unknown): void; destroy(): void } {
  const clear = (): void => {
    node.style.visibility = '';
    node.style.opacity = '';
    node.style.transform = '';
    node.classList.remove('tasklist-section-dragging');
  };
  clear();
  return {
    update(_next: unknown): void { clear(); },
    destroy(): void {},
  };
}
