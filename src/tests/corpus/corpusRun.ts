/**
 * The corpus check: loads every note on a list (`npm run corpus:list`) into a
 * real editor and records what opening and saving it would do, so two commits
 * can be compared (`npm run corpus:compare`). Run by `npm run corpus:run`
 * through `vitest.corpus.config.mts`, never by `ci:verify`: a large corpus
 * takes most of an hour.
 *
 *   CORPUS_LIST=<list.txt> CORPUS_OUT=<result.json> npm run corpus:run
 *
 * Per note: the read-only verdict (`lossy`), a hash of the Markdown a save
 * would write, whether that is the file's own body, a hash of the body it was
 * given (so a file edited between two runs isn't mistaken for a change in
 * Filo), and the output itself when under 20 KB.
 */
import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor, parseMarkdownFile } from '../../renderer/lib/editor/markdownSync';

interface CorpusNoteResult {
  lossy: boolean;
  /** sha1 of the Markdown a save would write. */
  hash: string;
  /** sha1 of the body as read (after the frontmatter and BOM). */
  bodyHash: string;
  /** The output is the file's body, line endings and outer blank lines aside. */
  same: boolean;
  out?: string;
  error?: string;
  skipped?: string;
}

const MAX_CHARS = 400_000;
const KEEP_OUTPUT_UNDER = 20_000;
// A fresh editor now and then, so state one note leaves behind can't pile up.
const NOTES_PER_EDITOR = 200;

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');
const comparable = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}: CORPUS_LIST=<list.txt> CORPUS_OUT=<result.json> npm run corpus:run`);
  return value;
}

it('corpus', () => {
  const listPath = requiredEnv('CORPUS_LIST');
  const outPath = requiredEnv('CORPUS_OUT');
  const list = readFileSync(listPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const notes: Record<string, CorpusNoteResult> = {};
  const host = document.createElement('div');
  document.body.appendChild(host);
  let editor: Editor = createTiptapEditor({ element: host, content: '' });
  const started = Date.now();

  list.forEach((path, n) => {
    if (n > 0 && n % NOTES_PER_EDITOR === 0) {
      editor.destroy();
      editor = createTiptapEditor({ element: host, content: '' });
    }
    if (n > 0 && n % 1000 === 0) console.log(`corpus: ${n} of ${list.length} notes`);
    let bodyHash = '';
    try {
      const raw = readFileSync(path, 'utf8');
      if (raw.length > MAX_CHARS) {
        notes[path] = { lossy: true, hash: '', bodyHash: sha1(raw), same: false, skipped: `over ${MAX_CHARS} characters` };
        return;
      }
      const body = parseMarkdownFile(raw).body;
      bodyHash = sha1(body);
      const { lossy } = loadMarkdownIntoEditor(editor, body);
      const md = editorMarkdown(editor);
      notes[path] = {
        lossy,
        hash: sha1(md),
        bodyHash,
        same: comparable(md) === comparable(body),
        out: md.length < KEEP_OUTPUT_UNDER ? md : undefined,
      };
    } catch (e) {
      notes[path] = { lossy: true, hash: '', bodyHash, same: false, error: String(e) };
    }
  });
  editor.destroy();

  const meta = { list: listPath, notes: list.length, ms: Date.now() - started };
  writeFileSync(outPath, JSON.stringify({ meta, notes }));
  console.log(`corpus: ${list.length} notes in ${Math.round(meta.ms / 1000)} s -> ${outPath}`);
}, 6 * 60 * 60 * 1000);
