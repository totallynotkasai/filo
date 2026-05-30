import { nanoid } from 'nanoid';

/**
 * Generates a unique ID for tiles, boards, connections, frames, tags, etc.
 * Uses nanoid with a 12-character default length.
 */
export function createId(length = 12): string {
  return nanoid(length);
}
