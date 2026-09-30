/**
 * Characterisation — filtering by tag.
 *
 * Clicking a tag chip on a sidebar row cuts the tree down to the files
 * carrying that tag (or a child tag) and the folders above them, shown open.
 * A "#tag" pill in the search bar says so; the name search still applies on
 * top. The chip again, the pill's ×, or Esc in the search box clears it, and
 * a vault swap drops it. The Tags browser has a search box of its own.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, openOtherVault, type CharApp } from './harness/app';
import {
  sidebarListing,
  clickSidebarTagChip,
  sidebarTagFilterPill,
  clearSidebarTagFilter,
  typeSidebarSearch,
  escInSidebarSearch,
  sidebarMessage,
  openTagsBrowser,
  tagsBrowserOpen,
  tagsBrowserRows,
  tagsBrowserSearch,
  searchTagsBrowser,
  escInTagsBrowserSearch,
  tagsBrowserEmptyText,
  clickSidebarNewFolder,
  sidebarRenameValue,
  sidebarExpandCollapseLabel,
  clickSidebarExpandCollapse,
  clickTagInTagsBrowser,
  tagPopupItems,
  clickTagPopupItem,
  activeTabKind,
  createBoard,
  placeNoteOnBoard,
  openNoteFromSidebar,
  $$,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const note = (tags: string[]): string => `---\ntags: [${tags.join(', ')}]\n---\nBody\n`;

const VAULT = {
  'Loose.md': note(['misc', 'project']),
  'Untagged.md': 'Just text\n',
  'Work/Plan.md': note(['project']),
  'Work/Deep/Sub.md': note(['project/a']),
  'Work/Other.md': note(['misc']),
  'Elsewhere/Projects.md': note(['projects']),
  'Media/pic.png': 'not really a png',
  '.filo/tags.json': JSON.stringify({ version: 1, tags: {}, fileTags: { 'Media/pic.png': ['project'] } }),
};

const PROJECT_FILTERED = [
  'Loose.md',
  'Media', 'Media/pic.png',
  'Work', 'Work/Deep', 'Work/Deep/Sub.md', 'Work/Plan.md',
];

const UNFILTERED = ['Elsewhere', 'Loose.md', 'Media', 'Untagged.md', 'Work'];

function openTabNames(app: CharApp): string[] {
  return $$(app.el, '.tab').map((t) => (t.textContent ?? '').trim());
}

function listing(app: CharApp): string[] {
  return sidebarListing(app).sort();
}

describe('sidebar tag filter', () => {
  it('a chip shows the files with that tag or a child tag, media included, with their folders open', async () => {
    const app = await startApp(VAULT);
    expect(listing(app)).toEqual(UNFILTERED);

    await clickSidebarTagChip(app, 'Loose.md', 'project');
    expect(sidebarTagFilterPill(app)).toBe('#project');
    // `project/a` is a child tag and matches; `projects` is a different tag.
    expect(listing(app)).toEqual(PROJECT_FILTERED);
  });

  it('combines with the name search', async () => {
    const app = await startApp(VAULT);
    await clickSidebarTagChip(app, 'Loose.md', 'project');
    await typeSidebarSearch(app, 'plan');
    expect(listing(app)).toEqual(['Work', 'Work/Plan.md']);

    await typeSidebarSearch(app, 'Other');
    // Work/Other.md matches the name but not the tag.
    expect(listing(app)).toEqual([]);
    expect(sidebarMessage(app)).toBe('No matches found');
  });

  it('clears on the same chip, on the pill ×, and on Esc in the search box (filter first, then text)', async () => {
    const app = await startApp(VAULT);
    await clickSidebarTagChip(app, 'Loose.md', 'project');
    await clickSidebarTagChip(app, 'Loose.md', 'project');
    expect(sidebarTagFilterPill(app)).toBeNull();
    // The user's own folder state is back: nothing was expanded before.
    expect(listing(app)).toEqual(UNFILTERED);

    await clickSidebarTagChip(app, 'Loose.md', 'project');
    await clearSidebarTagFilter(app);
    expect(sidebarTagFilterPill(app)).toBeNull();
    expect(listing(app)).toEqual(UNFILTERED);

    await clickSidebarTagChip(app, 'Loose.md', 'project');
    await typeSidebarSearch(app, 'plan');
    await escInSidebarSearch(app);
    expect(sidebarTagFilterPill(app)).toBeNull();
    // The name search alone still filters, and shows its match's folder open.
    expect(listing(app)).toEqual(['Work', 'Work/Plan.md']);
    await escInSidebarSearch(app);
    expect(listing(app)).toEqual(UNFILTERED);
  });

  it('a different chip replaces the filter, and a chip click neither selects nor opens the file', async () => {
    const app = await startApp(VAULT);
    await clickSidebarTagChip(app, 'Loose.md', 'project');
    await clickSidebarTagChip(app, 'Loose.md', 'misc');
    expect(sidebarTagFilterPill(app)).toBe('#misc');
    expect(listing(app)).toEqual(['Loose.md', 'Work', 'Work/Other.md']);
    expect(app.el.querySelector('.vault-file-item.selected')).toBeNull();
    expect(openTabNames(app)).toEqual([]);
  });

  it('is dropped, with the name search, when another vault opens', async () => {
    const app = await startApp(VAULT);
    await clickSidebarTagChip(app, 'Loose.md', 'project');
    await typeSidebarSearch(app, 'Loose');
    const { done } = await openOtherVault(app, { 'A.md': note(['project']), 'B.md': 'plain\n' });
    expect(done).toBe(true);
    expect(sidebarTagFilterPill(app)).toBeNull();
    expect(sidebarListing(app).sort()).toEqual(['A.md', 'B.md']);
  });
});

describe('sidebar toolbar while a tag filter is on', () => {
  it('New Folder clears the filter, so the new folder shows and its rename starts', async () => {
    const app = await startApp(VAULT);
    await clickSidebarTagChip(app, 'Loose.md', 'project');
    await clickSidebarNewFolder(app);
    expect(sidebarTagFilterPill(app)).toBeNull();
    expect(listing(app)).toContain('New Folder');
    expect(sidebarRenameValue(app)).toBe('New Folder');
  });

  it('Collapse All and Expand All act on the folders the filter shows', async () => {
    const app = await startApp(VAULT);
    await clickSidebarTagChip(app, 'Loose.md', 'project');
    expect(sidebarExpandCollapseLabel(app)).toBe('Collapse All');

    await clickSidebarExpandCollapse(app);
    expect(listing(app)).toEqual(['Loose.md', 'Media', 'Work']);
    expect(sidebarExpandCollapseLabel(app)).toBe('Expand All');

    await clickSidebarExpandCollapse(app);
    expect(listing(app)).toEqual(PROJECT_FILTERED);

    // The user's own folder state was never touched: nothing was expanded.
    await clearSidebarTagFilter(app);
    expect(listing(app)).toEqual(UNFILTERED);
  });
});

describe('sidebar name search', () => {
  it('shows its matches with their folders open, and the user\'s own folders come back after', async () => {
    const app = await startApp(VAULT);
    await typeSidebarSearch(app, 'sub');
    expect(listing(app)).toEqual(['Work', 'Work/Deep', 'Work/Deep/Sub.md']);

    // Collapse All closes what the search shows; a new query opens again.
    await clickSidebarExpandCollapse(app);
    expect(listing(app)).toEqual(['Work']);
    await typeSidebarSearch(app, 'plan');
    expect(listing(app)).toEqual(['Work', 'Work/Plan.md']);

    await escInSidebarSearch(app);
    expect(listing(app)).toEqual(UNFILTERED);
  });
});

describe('Tags browser search', () => {
  const TAGS = {
    'A.md': note(['work', 'work/project', 'home']),
    'B.md': note(['personal/projects', 'misc']),
  };

  it('has focus on open, filters on the full tag path and keeps parent rows', async () => {
    await startApp(TAGS);
    await openTagsBrowser();
    expect(document.activeElement).toBe(tagsBrowserSearch());
    expect(tagsBrowserRows()).toEqual(['home', 'misc', 'personal/projects', 'work', 'work/project']);

    await searchTagsBrowser('PROJ');
    // `work` has no match itself; it stays as the parent of `work/project`.
    expect(tagsBrowserRows()).toEqual(['personal/projects', 'work', 'work/project']);

    await searchTagsBrowser('nothing-like-this');
    expect(tagsBrowserRows()).toEqual([]);
    expect(tagsBrowserEmptyText()).toBe("No tags match 'nothing-like-this'");
  });

  it('lists and finds a note tag that .filo/tags.json has never registered', async () => {
    await startApp({
      ...TAGS,
      '.filo/tags.json': JSON.stringify({ version: 1, tags: { home: { color: '#ff0000' } }, fileTags: {} }),
    });
    await openTagsBrowser();
    expect(tagsBrowserRows()).toEqual(['home', 'misc', 'personal/projects', 'work', 'work/project']);
    await searchTagsBrowser('proj');
    expect(tagsBrowserRows()).toEqual(['personal/projects', 'work', 'work/project']);
  });

  it('Esc clears the search first; a second Esc closes the browser', async () => {
    await startApp(TAGS);
    await openTagsBrowser();
    await searchTagsBrowser('home');
    expect(tagsBrowserRows()).toEqual(['home']);

    await escInTagsBrowserSearch();
    expect(tagsBrowserOpen()).toBe(true);
    expect(tagsBrowserSearch().value).toBe('');
    expect(tagsBrowserRows()).toHaveLength(5);

    await escInTagsBrowserSearch();
    expect(tagsBrowserOpen()).toBe(false);
  });
});

describe('Tags browser popup', () => {
  it('a tag with no board open shows its files, and a file opens as a document', async () => {
    const app = await startApp(VAULT);
    await openTagsBrowser();
    await clickTagInTagsBrowser('misc');
    expect(tagPopupItems()).toEqual({ tiles: [], files: ['Loose', 'Other'] });

    await clickTagPopupItem('Other');
    expect(tagsBrowserOpen()).toBe(false);
    expect(activeTabKind(app)).toBe('document');
  });

  it('a placed tile is listed under Tiles and opens its board, even from a Document tab', async () => {
    const app = await startApp(VAULT);
    await createBoard(app, 'mindmap');
    await placeNoteOnBoard(app, 'mindmap', 'Loose.md');
    await openNoteFromSidebar(app, 'Untagged.md');
    expect(activeTabKind(app)).toBe('document');

    await openTagsBrowser();
    await clickTagInTagsBrowser('misc');
    expect(tagPopupItems()).toEqual({ tiles: ['Loose'], files: ['Other'] });

    await clickTagPopupItem('Loose');
    expect(tagsBrowserOpen()).toBe(false);
    expect(activeTabKind(app)).toBe('mindmap');
  });
});
