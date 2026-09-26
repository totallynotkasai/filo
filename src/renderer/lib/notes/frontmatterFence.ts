/**
 * frontmatterFence — the one place that decides where a note's frontmatter
 * block starts and ends.
 *
 * The editor's parse, the note writer, the vault index, the template reader,
 * the tag rewriter and the line-ending rule all ask this module, so they can
 * never disagree about which bytes are frontmatter and which are body (a
 * disagreement shows one view a key the other writes into the body). Gate
 * `single-fence-parser` keeps every fence regex in this file.
 *
 * It has no imports, so the modules above can all use it without a cycle.
 *
 * The rules:
 *  - A leading BOM is skipped (and reported), so a Notepad-saved note keeps
 *    its frontmatter.
 *  - The opening fence is the file's first line: `---`, optionally followed by
 *    spaces or tabs (editors leave them), then a line break.
 *  - The closing fence is the FIRST later line that is `---` plus optional
 *    spaces or tabs, ending in a line break or the end of the file. A column-0
 *    `---` can never be YAML mapping content (it is a document marker, and a
 *    `---` inside a block scalar is indented), so the first one is the end.
 *    `----` or `--- x` is not a fence.
 *  - A fence pair with nothing between (`---\n---\n`) is an empty block, not
 *    "no frontmatter" (otherwise a tag add would prepend a second block).
 *  - `...` does not close a block: Obsidian and other Markdown tools only
 *    accept `---`.
 *  - Nothing is normalised: the fence lines, the YAML and the body come back
 *    verbatim, so a rewrite can re-emit every byte it didn't change.
 *
 * DECISION: a fenced block whose YAML isn't a mapping (a paragraph or a list
 * between two leading `---` rules) is still frontmatter here, not body. As
 * body it would open with a rule and a setext heading / list, which the editor
 * can't save back byte-for-byte, so the whole note would open read-only; as
 * frontmatter the body stays editable and only a metadata edit is refused
 * (with a toast), the block's bytes kept.
 */

/** The fenced block at the top of a note. */
export interface FrontmatterBlock {
  /** The opening fence line as written, trailing spaces included (`---`, `--- `). */
  open: string;
  /** The opening fence's line break: the ending the block was written in. */
  openEol: '\n' | '\r\n';
  /**
   * The YAML between the fences, verbatim: no fence lines and no line break
   * before the closing fence ('' for an empty block).
   */
  source: string;
  /** The closing fence line as written, trailing spaces included. */
  close: string;
  /** The closing fence's line break; '' when the file ends on the fence. */
  closeEol: '' | '\n' | '\r\n';
}

export interface FrontmatterSplit {
  /** The text started with a UTF-8 BOM (not part of `body` or the block). */
  hadBom: boolean;
  /** Null when the text doesn't open with a closed fenced block. */
  block: FrontmatterBlock | null;
  /**
   * Everything after the block, verbatim; the whole text (without the BOM)
   * when there is no block.
   */
  body: string;
}

// Group 3 is lazily optional (`??`) so the empty block is tried first: without
// that, `---\n---\n` followed later by a `---` rule would take the rule as the
// closing fence and swallow the first lines of the body.
const FENCED_BLOCK = /^(---[ \t]*)(\r?\n)(?:([\s\S]*?)\r?\n)??(---[ \t]*)(\r?\n|$)/;
const OPENING_FENCE = /^---[ \t]*(\r?\n)/;

function withoutBom(raw: string): { hadBom: boolean; text: string } {
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  return { hadBom, text: hadBom ? raw.slice(1) : raw };
}

/** Splits a note's text (raw bytes, BOM allowed) into its frontmatter block and body. */
export function splitFrontmatterFence(raw: string): FrontmatterSplit {
  const { hadBom, text } = withoutBom(raw);
  const m = FENCED_BLOCK.exec(text);
  if (!m) return { hadBom, block: null, body: text };
  return {
    hadBom,
    block: {
      open: m[1] ?? '---',
      openEol: m[2] === '\r\n' ? '\r\n' : '\n',
      source: m[3] ?? '',
      close: m[4] ?? '---',
      closeEol: m[5] === '\r\n' ? '\r\n' : m[5] === '\n' ? '\n' : '',
    },
    body: text.slice(m[0].length),
  };
}

/**
 * The line break of an opening fence line at the top of `raw` (BOM allowed),
 * whether or not a closing fence follows; null when the text doesn't start
 * with one. A torn read (the opening fence written, the rest not yet) is
 * recognised by this, and a block's line ending is read from it.
 */
export function openingFenceEol(raw: string): '\n' | '\r\n' | null {
  const m = OPENING_FENCE.exec(withoutBom(raw).text);
  if (!m) return null;
  return m[1] === '\r\n' ? '\r\n' : '\n';
}
