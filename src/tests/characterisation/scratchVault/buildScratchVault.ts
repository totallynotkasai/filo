/**
 * Builds the dogfooding scratch vault for the file-model refactor
 * (master plan 2.4) by driving the real app, so the boards are always in the
 * current board format: re-run it after a format change instead of fixing a
 * vault by hand.
 *
 *   npm run scratch-vault                       → ~/Filo Scratch Vault
 *   FILO_SCRATCH_VAULT=<empty dir> npm run scratch-vault
 *
 * The target must be empty or missing. Not part of the test run: its own
 * config (vitest.scratch-vault.config.mts) is the only one that includes it.
 */
import { it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, rmSync } from 'node:fs';
import { TEST_MACHINE_IDENTITY } from '../../helpers/testMachine';
import { startApp, stopApp, quiesce } from '../harness/app';
import {
  createBoard,
  addMindMapTextTile,
  addKanbanColumn,
  addKanbanCard,
  quickAddTask,
  placeNoteOnBoard,
  openNoteFromSidebar,
  kanbanCards,
  taskRows,
  mindMapTiles,
  setCardDueDate,
  setCardPriority,
  addTag,
  toggleTask,
  editors,
  typeAtEnd,
  showBoard,
  $$,
} from '../harness/actions';

const TARGET = process.env.FILO_SCRATCH_VAULT || join(homedir(), 'Filo Scratch Vault');

// A 2×2 PNG, so the vault has a real image to tag.
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const NOTES: Record<string, string | Uint8Array> = {
  'Welcome.md':
    '---\ntitle: Welcome\ntags:\n  - start\n---\n# Welcome\n\nThis vault is rebuilt by `npm run scratch-vault`. Edit freely.\n',
  'No title key.md': '# A note without frontmatter\n\nIts title comes from the filename.\n',
  'Title differs from filename.md': '---\ntitle: The real title\n---\nThe filename and the title disagree on purpose.\n',
  'Windows note.md': '---\r\ntitle: Windows note\r\ntags: [crlf]\r\n---\r\nWritten with CRLF line endings.\r\nSecond line.\r\n',
  'BOM note.md': '\uFEFF---\ntitle: BOM note\n---\nStarts with a UTF-8 byte-order mark.\n',
  'Odd YAML.md':
    "---\n# a comment the app must keep\ntitle: Odd YAML\nzip: 02134\ncolour: 0xFF00FF\nwhen: 2026-01-02\nquoted: 'single'\n---\nExotic scalars that a re-dump would change.\n",
  'Projects/Launch plan.md':
    '---\ntitle: Launch plan\ntags:\n  - project\npriority: high\ndueDate: 2026-10-15\n---\n- [ ] Draft\n- [ ] Review\n',
  'Projects/Budget.md': '---\ntitle: Budget\ntags: [project, money]\npriority: medium\n---\nNumbers go here.\n',
  'Attachments/diagram.png': PNG,
};

it('builds the scratch vault', async () => {
  const app = await startApp(NOTES, { root: TARGET });

  // Mind map: existing notes, a new tile with text, and a tagged image.
  await createBoard(app, 'mindmap');
  for (const rel of ['Welcome.md', 'No title key.md', 'Windows note.md', 'BOM note.md', 'Odd YAML.md']) {
    await placeNoteOnBoard(app, 'mindmap', rel);
  }
  await addMindMapTextTile(app);
  const tiles = $$(app.el, '.mindmap-board .ProseMirror');
  await typeAtEnd(editors(tiles[tiles.length - 1].closest('.tile-container') as HTMLElement)[0], 'Made on the canvas.');
  await placeNoteOnBoard(app, 'mindmap', 'Attachments/diagram.png');
  const image = $$(app.el, '.mindmap-board .tile-container').find((t) => t.querySelector('img'));
  if (!image) throw new Error('the image tile did not appear');
  await addTag(app, image, 'media-tag');

  // Kanban: two columns, notes placed, one new card with fields and a tag.
  await createBoard(app, 'kanban');
  await addKanbanColumn(app);
  await addKanbanColumn(app);
  await placeNoteOnBoard(app, 'kanban', 'Projects/Launch plan.md');
  await placeNoteOnBoard(app, 'kanban', 'Projects/Budget.md');
  await placeNoteOnBoard(app, 'kanban', 'Title differs from filename.md');
  await addKanbanCard(app, 1);
  const card = kanbanCards(app).find((c) => c.title.startsWith('New Card'));
  if (!card) throw new Error('the new card did not appear');
  await setCardDueDate(card.el, '2026-11-05');
  await setCardPriority(app, card.el, 'Low');
  await addTag(app, card.el, 'kanban-tag');

  // Task List: quick-added tasks (one done) and an existing note.
  await createBoard(app, 'tasklist');
  await quickAddTask(app, 'Buy milk !!high #errand tomorrow');
  await quickAddTask(app, 'Call the bank #errand');
  await quickAddTask(app, 'File the report');
  await placeNoteOnBoard(app, 'tasklist', 'Projects/Launch plan.md');
  const done = taskRows(app).find((r) => r.title === 'File the report');
  if (!done) throw new Error('the task row did not appear');
  await toggleTask(done.el);

  // A Document tab left open, so a relaunch restores one.
  await showBoard(app, 'mindmap');
  if (mindMapTiles(app).length === 0) throw new Error('mind map ended up empty');
  await openNoteFromSidebar(app, 'Welcome.md');
  await quiesce();
  await stopApp({ keep: true });

  // A clean close leaves no crash marker. The test machine's record is dropped
  // so the vault only knows the machines that really open it.
  const filo = join(TARGET, '.filo');
  const leftovers = readdirSync(filo).filter((f) => f.startsWith('.dirty'));
  if (leftovers.length > 0) throw new Error(`crash marker left after a clean close: ${leftovers.join(', ')}`);
  rmSync(join(filo, 'machines', `${TEST_MACHINE_IDENTITY.machineId}.json`), { force: true });
  console.log(`Scratch vault written to ${TARGET}`);
}, 300_000);
