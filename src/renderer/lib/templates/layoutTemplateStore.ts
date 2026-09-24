import { LayoutTemplateSchema, type LayoutTemplate } from '../../schema/index';
import {
  migrateLayoutTemplate,
  CURRENT_LAYOUT_TEMPLATE_VERSION,
} from '../../schema/layoutTemplate';
import { trackComponentWrite } from '../boards/boardSaver';
import { reportError } from '../utils/errorBus';
import { invokeOk } from '../utils/invokeOk';
import { loadVersionedFile } from '../vault/loadVersionedFile';

/**
 * Renderer-side wrapper over the `templates:layout:*` IPC channels.
 * Provides typed list / save / rename / delete operations for layout
 * templates and runs Zod validation on read.
 *
 * Filenames take the form `<slug>--<id>.template.json` so two templates
 * with the same display name (e.g. "Untitled") don't collide on disk.
 * Lookup happens by the LayoutTemplate's `id` field — the filename is
 * just a stable handle.
 */

export interface LayoutTemplateRecord {
  filename: string;
  template: LayoutTemplate;
}

function slugify(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'template';
}

export function filenameFor(template: LayoutTemplate): string {
  return `${slugify(template.name)}--${template.id}.template.json`;
}

export async function listLayoutTemplates(vaultRoot: string): Promise<LayoutTemplateRecord[]> {
  const entries = await window.filo.invoke('templates:layout:list', vaultRoot);
  if (!Array.isArray(entries)) return [];
  const out: LayoutTemplateRecord[] = [];
  for (const { filename, content } of entries) {
    // Route through the shared migrate→validate helper so
    // a from-future / un-migratable template is skipped (not silently
    // re-saved at the current version). Templates are only ever written
    // individually on explicit user save/rename/delete, so skipping one here
    // can't clobber it — it just won't appear in the browser.
    const loaded = loadVersionedFile(LayoutTemplateSchema, migrateLayoutTemplate, content);
    if (loaded.status === 'from-future') {
      reportError(
        'layoutTemplate.fromFuture',
        null,
        `Skipping layout template ${filename}: it was saved by a newer version of Filo ` +
          `(file version ${loaded.migratedFrom}, this build understands up to ${CURRENT_LAYOUT_TEMPLATE_VERSION}). Update Filo to use it.`,
      );
      continue;
    }
    if (loaded.status === 'no-migration-path') {
      reportError(
        'layoutTemplate.noMigrationPath',
        null,
        `Skipping layout template ${filename}: it declares an unrecognized format version (${loaded.migratedFrom}).`,
      );
      continue;
    }
    if (loaded.status === 'invalid') {
      reportError(
        'layoutTemplate.parse',
        loaded.error,
        `Skipping malformed layout template ${filename}`,
      );
      continue;
    }
    out.push({ filename, template: loaded.data });
  }
  return out.sort((a, b) => a.template.name.localeCompare(b.template.name));
}

export async function saveLayoutTemplate(
  vaultRoot: string,
  template: LayoutTemplate,
): Promise<{ filename: string }> {
  const filename = filenameFor(template);
  await trackComponentWrite(
    vaultRoot,
    `.filo/templates/${filename}`,
    async () => {
      await invokeOk('templates:layout:write', vaultRoot, filename, template);
    },
    'config',
  );
  return { filename };
}

export async function renameLayoutTemplate(
  vaultRoot: string,
  oldFilename: string,
  next: LayoutTemplate,
): Promise<{ filename: string }> {
  const newFilename = filenameFor(next);
  if (newFilename !== oldFilename) {
    await trackComponentWrite(
      vaultRoot,
      `.filo/templates/${oldFilename}`,
      async () => {
        await invokeOk('templates:layout:rename', vaultRoot, oldFilename, newFilename);
      },
      'config',
    );
  }
  await trackComponentWrite(
    vaultRoot,
    `.filo/templates/${newFilename}`,
    async () => {
      await invokeOk('templates:layout:write', vaultRoot, newFilename, next);
    },
    'config',
  );
  return { filename: newFilename };
}

export async function deleteLayoutTemplate(
  vaultRoot: string,
  filename: string,
): Promise<void> {
  await trackComponentWrite(
    vaultRoot,
    `.filo/templates/${filename}`,
    async () => {
      await invokeOk('templates:layout:delete', vaultRoot, filename);
    },
    'config',
  );
}
