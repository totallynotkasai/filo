import type { Tile, TileDefinition } from '../../schema/index';
import { mediaTags, noteTags, noteTitle } from '../../stores/noteMeta';

/**
 * The fields a board def doesn't store but every view of the tile reads,
 * projected from where they live:
 *
 * - a text tile's `title` and `tags` from its note;
 * - a media tile's `tags` from `.filo/tags.json`, and a file tile's name and
 *   extension from its path.
 *
 * Called while a board's tiles are derived, so the views follow the note.
 */
export function projectDefFields(def: TileDefinition): Record<string, unknown> {
  switch (def.type) {
    case 'text':
      return {
        title: noteTitle(def.filePath),
        tags: noteTags(def.filePath),
        content: '',
      };
    case 'image':
    case 'video':
    case 'audio':
      return { tags: mediaTags(def.src) };
    case 'file': {
      const name = def.filePath.split(/[\/]/).pop() ?? def.filePath;
      const dot = name.lastIndexOf('.');
      return {
        tags: mediaTags(def.filePath),
        fileName: name,
        fileExtension: dot > 0 ? name.slice(dot + 1) : '',
      };
    }
    default:
      return {};
  }
}

/** `def` merged with its projected fields, ready for placement fields on top. */
export function projectDef(def: TileDefinition): Partial<Tile> & Record<string, unknown> {
  return { ...def, ...projectDefFields(def) };
}
