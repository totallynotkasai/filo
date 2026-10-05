/**
 * The note a Markdown template makes, the same on every board: the Mind
 * Map's Template Browser, a Kanban card "From Template…", and each card, task
 * or tile a board template lists (`boardFromTemplate.ts`).
 */
import { interpolate, type TemplateContent, type TemplateVariables } from './templateService';

export interface NoteFromTemplate {
  title: string;
  /** Every key of the template's frontmatter but `title` (which the note gets apart) and `boardType`. */
  frontmatter: Record<string, unknown>;
  body: string;
}

/** `value` with `{{title}}`, `{{date}}`… filled in wherever it holds text, in lists and maps too. */
function fillIn(value: unknown, vars: TemplateVariables): unknown {
  if (typeof value === 'string') return interpolate(value, vars);
  if (Array.isArray(value)) return value.map((v) => fillIn(v, vars));
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillIn(v, vars)]));
  }
  return value;
}

/**
 * The template's frontmatter, every key kept and filled in (`boardType` is a
 * picker hint, not the note's); its title: the template's own `title:`,
 * filled in, else `fallbackTitle`; its body (without a board block) filled
 * in, `{{title}}` included.
 */
export function noteFromTemplate(content: TemplateContent, fallbackTitle: string, now: Date = new Date()): NoteFromTemplate {
  const { title: ownTitle, boardType: _boardType, ...rest } = content.frontmatter;
  void _boardType;
  const filledTitle = typeof ownTitle === 'string' ? interpolate(ownTitle, { now }).trim() : '';
  const title = filledTitle || fallbackTitle;
  const vars: TemplateVariables = { title, now };
  return {
    title,
    frontmatter: fillIn(rest, vars) as Record<string, unknown>,
    body: interpolate(content.bodyWithoutBoardBlock, vars),
  };
}
