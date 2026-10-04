/**
 * textStyleSpans — which `<span>`s become a text-style mark (colour, font,
 * size), and the writer's guard against an empty one.
 *
 * TipTap's TextStyle takes any `<span style="…">`. Pasted HTML is full of
 * spans whose style names none of the three: Word's `mso-spacerun` for two
 * spaces after a full stop, a web page's bold or underline written as a
 * styled span, Google Docs' tab. Each became a mark with no attributes, saved
 * as a bare `<span>…</span>` that the next load doesn't read back as a mark,
 * so the note reopened read-only. A span is a text-style mark only when it
 * carries one of the styles Filo keeps, and an empty mark writes nothing.
 */
import type { MarkdownSerializer } from 'prosemirror-markdown';
import type { Mark } from '@tiptap/pm/model';

type MarkSpecs = ConstructorParameters<typeof MarkdownSerializer>[1];

/** True when `el` sets a colour, font family or font size: the styles Filo keeps. */
export function carriesKeptTextStyle(el: HTMLElement): boolean {
  return el.style.color !== '' || el.style.fontFamily !== '' || el.style.fontSize !== '';
}

function hasAnyStyle(mark: Mark): boolean {
  return Object.values(mark.attrs).some((value) => value !== null && value !== undefined && value !== '');
}

/** `marks` with the text-style writer leaving out a mark that sets nothing. */
export function withEmptyTextStyleUnwritten(marks: MarkSpecs): MarkSpecs {
  const spec = marks.textStyle;
  if (!spec) return marks;
  const { open, close } = spec;
  return {
    ...marks,
    textStyle: {
      ...spec,
      open: (state, mark, parent, index) => {
        if (!hasAnyStyle(mark)) return '';
        return typeof open === 'string' ? open : open(state, mark, parent, index);
      },
      close: (state, mark, parent, index) => {
        if (!hasAnyStyle(mark)) return '';
        return typeof close === 'string' ? close : close(state, mark, parent, index);
      },
    },
  };
}
