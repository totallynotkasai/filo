/**
 * The message a media tile shows when its file won't load. A missing file is
 * checked first: the browser reports it as an unsupported source, and "format
 * not supported" would send the user looking for a codec when the file is
 * simply gone.
 */
export type MediaKind = 'image' | 'video' | 'audio';

/** `MediaError.code` values (the DOM constants, which jsdom doesn't define). */
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const NOUN: Record<MediaKind, string> = { image: 'Image', video: 'Video', audio: 'Audio' };

export function mediaErrorText(kind: MediaKind, opts: { missing: boolean; code?: number | null }): string {
  if (opts.missing) return 'File not found';
  const noun = NOUN[kind];
  switch (opts.code) {
    case MEDIA_ERR_ABORTED: return 'Playback aborted.';
    case MEDIA_ERR_NETWORK: return `Network error loading ${noun.toLowerCase()}.`;
    case MEDIA_ERR_DECODE: return `${noun} file is corrupt or in an unsupported format.`;
    case MEDIA_ERR_SRC_NOT_SUPPORTED: return `${noun} format not supported by this build.`;
    default: return kind === 'audio' ? 'Audio could not be played.' : `${noun} could not be loaded`;
  }
}
