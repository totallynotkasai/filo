import type { ResolvedTaskStyle } from '../styles/effectiveStyle';

/** A task row's inline styles, one per part of the row. */
export interface TaskRowStyles {
  /** `.task-item-wrap`: border and shadow, one outline around the title strip and the open notes. */
  wrap: string;
  /** `.task-item`: the title strip's background and text colour. */
  strip: string;
  /** `.task-notes-panel-inner`: the notes' own background and text colour, apart from the strip's. */
  notes: string;
}

/** The inline styles a task row paints from its resolved style; '' where it sets nothing. */
export function taskRowStyles(style: ResolvedTaskStyle | undefined): TaskRowStyles {
  if (!style) return { wrap: '', strip: '', notes: '' };
  const wrap: string[] = [];
  if (style.borderColor) wrap.push(`border-color: ${style.borderColor}`);
  if (style.borderStyle) wrap.push(`border-style: ${style.borderStyle}`);
  if (style.borderWidth >= 0) wrap.push(`border-width: ${style.borderWidth}px`);
  if (style.shadowIntensity >= 0) {
    wrap.push(`box-shadow: 0 1px ${6 * style.shadowIntensity}px rgba(0,0,0,${0.25 * style.shadowIntensity})`);
  }
  const strip: string[] = [];
  if (style.headerColor) strip.push(`background-color: ${style.headerColor}`);
  if (style.headerTextColor) strip.push(`color: ${style.headerTextColor}`);
  const notes: string[] = [];
  if (style.bodyColor) notes.push(`background-color: ${style.bodyColor}`);
  if (style.bodyTextColor) notes.push(`color: ${style.bodyTextColor}`);
  return { wrap: wrap.join('; '), strip: strip.join('; '), notes: notes.join('; ') };
}
