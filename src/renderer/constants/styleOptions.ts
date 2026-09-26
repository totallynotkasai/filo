/**
 * Shared option lists for the settings panels (Global Defaults + Current
 * Board). Read from the Zod enums in `schema/styleEnums.ts`, the single
 * source of each list, so a picker can never offer a value the schema
 * rejects on the next load (or miss one it accepts).
 */
import {
  ShapeSchema,
  BorderStyleSchema,
  BackgroundPatternSchema,
  PathTypeSchema,
  ArrowTypeSchema,
} from '../schema/styleEnums';

export const SHAPE_OPTIONS = ShapeSchema.options;
export const BORDER_STYLE_OPTIONS = BorderStyleSchema.options;
export const BACKGROUND_PATTERN_OPTIONS = BackgroundPatternSchema.options;
export const PATH_TYPE_OPTIONS = PathTypeSchema.options;
export const ARROW_TYPE_OPTIONS = ArrowTypeSchema.options;
