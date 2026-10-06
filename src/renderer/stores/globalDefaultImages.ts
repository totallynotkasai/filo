/**
 * The Global Defaults' frame background image (`.filo/defaults.json`,
 * `mindmap.frame.backgroundImage`) names a vault file by path, as a frame's
 * own background does. It follows a rename of the file or a folder above it,
 * in Filo or by another program, and a delete that takes the file clears it
 * (that delete's undo puts it back). Otherwise every new frame would show a
 * broken image, and the next file given the old name would turn up in them.
 */
import { isAtOrUnder } from '@shared/vaultPath';
import { rebasePath, registerPathRenamable } from '../lib/vault/renamePathKeys';
import { vaultStore } from './vault.svelte';

/**
 * A default image a delete cleared. Named `backgroundImage` so a command
 * holding it follows renames (`PATH_FIELDS`): its undo puts the image back
 * under the name it has by then.
 */
export interface ClearedDefaultImage {
  backgroundImage: string;
}

function frameDefaults(): { backgroundImage?: string } | undefined {
  return vaultStore.project?.settings?.mindmap?.frame;
}

registerPathRenamable('globalDefaultImages', (oldRel, newRel) => {
  const frame = frameDefaults();
  if (!frame?.backgroundImage) return;
  const next = rebasePath(frame.backgroundImage, oldRel, newRel);
  if (next === null || next === frame.backgroundImage) return;
  frame.backgroundImage = next;
  vaultStore.markMetaDirty();
});

/** The default images at or under `deletedRel`, which a delete of it clears. */
export function defaultImagesAt(deletedRel: string): ClearedDefaultImage[] {
  const image = frameDefaults()?.backgroundImage;
  return image && isAtOrUnder(image, deletedRel) ? [{ backgroundImage: image }] : [];
}

/** Clears each image in `cleared` that the defaults still name. */
export function clearDefaultImages(cleared: readonly ClearedDefaultImage[]): void {
  const frame = frameDefaults();
  if (!frame?.backgroundImage) return;
  const current = frame.backgroundImage;
  if (!cleared.some((c) => c.backgroundImage === current)) return;
  frame.backgroundImage = '';
  vaultStore.markMetaDirty();
}

/** Puts `cleared` back, unless the user has picked another image meanwhile. */
export function restoreDefaultImages(cleared: readonly ClearedDefaultImage[]): void {
  const frame = frameDefaults();
  const [image] = cleared;
  if (!frame || !image || frame.backgroundImage) return;
  frame.backgroundImage = image.backgroundImage;
  vaultStore.markMetaDirty();
}
