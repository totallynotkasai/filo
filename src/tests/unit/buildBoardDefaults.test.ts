import { describe, it, expect } from 'vitest';
import {
  buildBoardSettingsFromGlobal,
  buildBoardSettingsFromTheme,
} from '@renderer/lib/styles/buildBoardDefaults';
import { ProjectSettingsSchema } from '@renderer/schema/settings';

describe('buildBoardSettingsFromGlobal', () => {
  function makeGlobals() {
    const defaults = ProjectSettingsSchema.parse({});
    defaults.mindmap.backgroundColor = '#1a1a2e';
    defaults.mindmap.backgroundPattern = 'dots';
    defaults.mindmap.tile.headerColor = '#ff8855';
    defaults.mindmap.tile.bodyColor = '#222244';
    defaults.mindmap.connectionPath.pathColor = '#00aaff';
    defaults.mindmap.connectionLabel.backgroundColor = '#ffaa00';
    defaults.mindmap.frame.headerColor = '#3a3a5e';

    defaults.kanban.backgroundColor = '#0f1923';
    defaults.kanban.accentColor = '#ff5555';
    defaults.kanban.column.headerColor = '#222';
    defaults.kanban.card.backgroundColor = '#444';

    defaults.tasklist.backgroundColor = '#0a1a0a';
    defaults.tasklist.accentColor = '#33ee33';
    defaults.tasklist.task.headerColor = '#88dd88';

    defaults.document.backgroundColor = '#fafafa';
    defaults.document.accentColor = '#0055aa';

    return defaults;
  }

  it('snapshots mindmap top-level + nested defaults block', () => {
    const out = buildBoardSettingsFromGlobal('mindmap', makeGlobals()) as {
      backgroundColor: string;
      backgroundPattern: string;
      semanticZoom: boolean;
      defaults: {
        tile: { headerColor: string; bodyColor: string };
        connectionPath: { pathColor: string };
        connectionLabel: { backgroundColor: string };
        frame: { headerColor: string };
      };
    };
    expect(out.backgroundColor).toBe('#1a1a2e');
    expect(out.backgroundPattern).toBe('dots');
    expect(out.semanticZoom).toBe(true);
    expect(out.defaults.tile.headerColor).toBe('#ff8855');
    expect(out.defaults.tile.bodyColor).toBe('#222244');
    expect(out.defaults.connectionPath.pathColor).toBe('#00aaff');
    expect(out.defaults.connectionLabel.backgroundColor).toBe('#ffaa00');
    expect(out.defaults.frame.headerColor).toBe('#3a3a5e');
  });

  it('snapshots kanban column + card defaults', () => {
    const out = buildBoardSettingsFromGlobal('kanban', makeGlobals()) as {
      backgroundColor: string;
      accentColor: string;
      defaults: {
        column: { headerColor: string };
        card: { backgroundColor: string };
      };
    };
    expect(out.backgroundColor).toBe('#0f1923');
    expect(out.accentColor).toBe('#ff5555');
    expect(out.defaults.column.headerColor).toBe('#222');
    expect(out.defaults.card.backgroundColor).toBe('#444');
  });

  it('snapshots tasklist task defaults', () => {
    const out = buildBoardSettingsFromGlobal('tasklist', makeGlobals()) as {
      backgroundColor: string;
      accentColor: string;
      groupBy: string;
      sortBy: string;
      defaults: { task: { headerColor: string } };
    };
    expect(out.backgroundColor).toBe('#0a1a0a');
    expect(out.accentColor).toBe('#33ee33');
    expect(out.groupBy).toBe('status');
    expect(out.sortBy).toBe('priority');
    expect(out.defaults.task.headerColor).toBe('#88dd88');
  });

  it('snapshots document settings including the document defaults block', () => {
    const out = buildBoardSettingsFromGlobal('document', makeGlobals()) as {
      backgroundColor: string;
      accentColor: string;
      defaults?: { document?: Record<string, unknown> };
    };
    expect(out.backgroundColor).toBe('#fafafa');
    expect(out.accentColor).toBe('#0055aa');
    // The document defaults block must be present so "Apply Current Global
    // Defaults to all Boards" can later overwrite it (and so the per-board
    // → global cascade is symmetric with the other three board types).
    expect(out.defaults).toBeDefined();
    expect(out.defaults?.document).toBeDefined();
  });

  it('does not share nested object identity with the source (deep snapshot)', () => {
    const src = makeGlobals();
    const out = buildBoardSettingsFromGlobal('mindmap', src) as {
      defaults: { tile: { headerColor: string } };
    };
    out.defaults.tile.headerColor = 'mutated';
    expect(src.mindmap.tile.headerColor).toBe('#ff8855');
  });
});

describe('buildBoardSettingsFromTheme', () => {
  it('returns empty/schema-default colours so theme CSS variables show through', () => {
    const out = buildBoardSettingsFromTheme('mindmap') as {
      backgroundColor: string;
      defaults: { tile: { headerColor: string } };
    };
    expect(out.backgroundColor).toBe('');
    expect(out.defaults.tile.headerColor).toBe('');
  });
});
