/**
 * Which vault files a broken tile may be re-linked to. A text tile needs a
 * note and a media tile a file its player can show; a file tile shows any
 * file (it opens in the OS), so it accepts every extension.
 */
export type RelinkTargets = readonly string[] | 'any';

const BY_TYPE: Record<string, RelinkTargets> = {
  text: ['md', 'markdown'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'],
  video: ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv'],
  audio: ['mp3', 'wav', 'ogg', 'aac', 'flac', 'wma', 'm4a'],
  file: 'any',
};

/** The targets for a tile type, or null when that type has no file to re-link. */
export function relinkTargets(tileType: string): RelinkTargets | null {
  return BY_TYPE[tileType] ?? null;
}

/** Whether `rel` (vault-relative) is a valid target. */
export function relinkAccepts(rel: string, targets: RelinkTargets): boolean {
  if (targets === 'any') return !/\.board\.json$/i.test(rel);
  const name = rel.split('/').pop() ?? rel;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return targets.includes(name.slice(dot + 1).toLowerCase());
}

/** The targets in words, for the picker's hint ("a md / markdown file", "any file"). */
export function relinkTargetsLabel(targets: RelinkTargets): string {
  return targets === 'any' ? 'any file' : `a ${targets.join(' / ')} file`;
}
