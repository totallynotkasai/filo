import { z } from 'zod';

/**
 * The style option enums every style schema shares. These Zod enums are the
 * single source of each option list: the settings panels read their choices
 * from `.options` (`constants/styleOptions.ts`), so adding a value here adds
 * it to the file format and to every picker at once.
 */

export const ShapeSchema = z.enum(['rectangle', 'rounded']);
export const BorderStyleSchema = z.enum(['solid', 'dashed', 'dotted']);
export const BackgroundPatternSchema = z.enum(['grid', 'dots', 'lines', 'none']);
export const PathTypeSchema = z.enum(['curved', 'straight', 'elbow', 'smart']);
export const ArrowTypeSchema = z.enum(['none', 'start', 'end', 'both']);

export type Shape = z.infer<typeof ShapeSchema>;
export type BorderStyle = z.infer<typeof BorderStyleSchema>;
