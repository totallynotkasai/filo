import { describe, it, expect, afterEach, vi } from 'vitest';
import { listLayoutTemplates } from '@renderer/lib/templates/layoutTemplateStore';
import { CURRENT_LAYOUT_TEMPLATE_VERSION } from '@renderer/schema/layoutTemplate';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import {
  onError,
  __resetErrorBusForTests,
  type ReportedError,
} from '@renderer/lib/utils/errorBus';

/**
 * F6 (2026-05-28) — `listLayoutTemplates` routes each `.template.json`
 * through `migrateLayoutTemplate` before schema validation so a from-future
 * (or un-migratable) template is skipped from the browser rather than parsed
 * and — once the user re-saves over it — silently downgraded.
 */

function makeTemplate(version: number) {
  return {
    id: `tpl_${version}`,
    name: `Template v${version}`,
    version,
    createdAt: 1,
    updatedAt: 1,
    boundingBox: { width: 100, height: 80 },
    tiles: [],
  };
}

describe('listLayoutTemplates — version migration (F6)', () => {
  afterEach(() => {
    restoreFiloDefault();
  });

  it('skips a from-future template and keeps current-version ones', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    installFiloMock({
      'templates:layout:list': () => [
        { filename: 'current.template.json', content: makeTemplate(CURRENT_LAYOUT_TEMPLATE_VERSION) },
        { filename: 'future.template.json', content: makeTemplate(CURRENT_LAYOUT_TEMPLATE_VERSION + 9) },
      ],
    });

    const records = await listLayoutTemplates('/vault');
    expect(records.map((r) => r.filename)).toEqual(['current.template.json']);
    expect(errors.some((e) => e.context === 'layoutTemplate.fromFuture')).toBe(true);
  });

  it('skips a fractional-version template (no migration path)', async () => {
    __resetErrorBusForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    installFiloMock({
      'templates:layout:list': () => [
        { filename: 'weird.template.json', content: makeTemplate(0.5) },
      ],
    });

    const records = await listLayoutTemplates('/vault');
    expect(records).toHaveLength(0);
    expect(errors.some((e) => e.context === 'layoutTemplate.noMigrationPath')).toBe(true);
  });
});
