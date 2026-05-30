import { Mark, mergeAttributes, markInputRule, markPasteRule } from '@tiptap/core';

/**
 * Custom #tag inline mark.
 *
 * Recognises `#tag` and nested `#tag/subtag` while typing or pasting and
 * applies the mark so themes can style the run via the `.filo-tag` class.
 *
 * Markdown round-trip: serialised as the bare `#tag` text — no extra markup
 * — so the tag survives a pass through tiptap-markdown's serializer and any
 * external editor that touches the `.md` file.
 *
 * DESIGN DECISION — Body `#tag` chips are decorative, not canonical.
 *   Tag identity for indexing / rename / delete lives in YAML frontmatter
 *   only. The VaultIndex parser deliberately ignores body tags
 *   (`src/renderer/lib/vault/vaultIndex.ts:78-80`) and the rewriter never
 *   touches body text (`src/renderer/lib/vault/tagRewriter.ts:4-10`). The
 *   `title` attribute below surfaces this to the user on hover so the chips
 *   aren't mistaken for managed tags. See `Filo_Design_Doc_Rework_V5.md`
 *   ("Tag system — frontmatter canonical, body decorative") for the full
 *   rationale.
 */

// Phase 31 C3.1 — Unicode property escapes so non-ASCII tags (e.g. `#café`,
// `#日本語`) get recognised by the input/paste rules. `\p{L}` matches any
// Unicode letter, `\p{N}` any Unicode digit. The `u` flag is required for
// these classes to be parsed as properties rather than literal text.
const INPUT_TAG_RE = /(?:^|\s)(#[\p{L}_][\p{L}\p{N}_/-]*)\s$/u;
const PASTE_TAG_RE = /(?:^|\s)(#[\p{L}_][\p{L}\p{N}_/-]*)(?=\s|$)/gu;

// Phase Sprint B / B2 — hex-color tokens (`#fff`, `#abcdef`, `#abcdef12`)
// would otherwise get matched as tags because the leading character `a-f` is
// a valid Unicode letter. Reject any token whose remaining body is entirely
// hex digits in one of the canonical 3/6/8-char lengths so the user can type
// inline colour literals in prose without producing spurious tag marks.
const HEX_COLOR_BODY_RE = /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isHexColorToken(token: string): boolean {
  if (!token.startsWith('#')) return false;
  return HEX_COLOR_BODY_RE.test(token.slice(1));
}

export const Tag = Mark.create({
  name: 'tag',

  inclusive: false,

  excludes: '_',

  parseHTML() {
    return [
      {
        tag: 'span.filo-tag',
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const value = el.getAttribute('data-tag');
          return value ? { value } : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes, mark }) {
    const value = (mark.attrs.value as string) ?? '';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'filo-tag',
        'data-tag': value,
        title: 'Body tag (decorative) — manage tags from the tile header or sidebar',
      }),
      0,
    ];
  },

  addAttributes() {
    return {
      value: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-tag') ?? '',
        renderHTML: (attrs) => ({ 'data-tag': attrs.value }),
      },
    };
  },

  /**
   * tiptap-markdown bridge — serialise the mark by emitting nothing around
   * the text node. Inner text already begins with `#`, so the bare token
   * round-trips cleanly through markdown-it / prosemirror-markdown.
   */
  addStorage() {
    return {
      markdown: {
        serialize: {
          open: '',
          close: '',
          mixable: true,
          expelEnclosingWhitespace: true,
        },
        parse: { setup() { /* parsing happens via input/paste rules in-editor */ } },
      },
    };
  },

  addInputRules() {
    return [
      markInputRule({
        find: INPUT_TAG_RE,
        type: this.type,
        // C1 — skip the rule inside code blocks / inline code so `#hashtag`
        // appearing in a fenced code sample doesn't get marked as a tag and
        // round-tripped through the tag serializer. Returning null here
        // tells markInputRule to abort, matching the @tiptap/core contract.
        // The arrow function captures `this` (the extension instance)
        // lexically so the rule's deferred call still sees `this.editor`.
        getAttributes: (match) => {
          const editor = this.editor;
          if (editor && (editor.isActive('codeBlock') || editor.isActive('code'))) return null;
          if (isHexColorToken(match[1])) return null;
          return { value: match[1].slice(1) };
        },
      }),
    ];
  },

  addPasteRules() {
    return [
      markPasteRule({
        find: PASTE_TAG_RE,
        type: this.type,
        getAttributes: (match) => {
          const editor = this.editor;
          if (editor && (editor.isActive('codeBlock') || editor.isActive('code'))) return null;
          if (isHexColorToken(match[1])) return null;
          return { value: match[1].slice(1) };
        },
      }),
    ];
  },
});

