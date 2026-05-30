/**
 * Svelte action that re-parents the host element to a target node (default
 * `document.body`) on mount and returns it to its original parent on destroy.
 *
 * Why: an ancestor with `transform`, `filter`, `perspective`, `will-change:
 * transform`, or `contain: paint` becomes the containing block for any
 * descendant using `position: fixed`. The fixed element then anchors to that
 * ancestor's bounding box instead of the viewport. Portaling escapes the
 * containing block by moving the node up to `<body>`.
 *
 * Usage: `<div use:portal style="position: fixed; left: 100px; top: 200px;">…`
 */

export type PortalTarget = HTMLElement | string | null | undefined;

function resolveTarget(target: PortalTarget): HTMLElement {
  if (target instanceof HTMLElement) return target;
  if (typeof target === 'string') {
    const el = document.querySelector(target);
    if (el instanceof HTMLElement) return el;
  }
  return document.body;
}

export function portal(node: HTMLElement, target: PortalTarget = document.body) {
  const originalParent = node.parentNode;
  const originalNextSibling = node.nextSibling;
  let currentTarget = resolveTarget(target);
  currentTarget.appendChild(node);

  return {
    update(newTarget: PortalTarget) {
      const next = resolveTarget(newTarget);
      if (next !== currentTarget) {
        currentTarget = next;
        currentTarget.appendChild(node);
      }
    },
    destroy() {
      if (node.parentNode !== currentTarget) return;
      // Prefer reinserting at the original template position so Svelte's own
      // teardown can find/remove the node. If either the original parent or
      // the captured next-sibling anchor has shifted (common when adjacent
      // {#if} blocks toggle between mount and destroy), `insertBefore` would
      // throw NotFoundError — fall back to a plain remove instead.
      const canRestore =
        originalParent != null &&
        originalParent.isConnected &&
        (originalNextSibling == null ||
          originalNextSibling.parentNode === originalParent);
      if (canRestore) {
        originalParent!.insertBefore(node, originalNextSibling);
      } else {
        currentTarget.removeChild(node);
      }
    },
  };
}
