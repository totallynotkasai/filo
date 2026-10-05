/**
 * The skeleton a Markdown board template's ```filo-board``` block may carry:
 *
 *     { "type": "kanban", "settings": { … },
 *       "columns": [{ "title": "To do", "cards": ["Outline", { "title": "Draft", "body": "…" }] }] }
 *     { "type": "tasklist", "sections": [{ "title": "This week", "tasks": ["Call the editor"] }] }
 *     { "type": "mindmap", "tiles": [{ "title": "Hero", "x": 0, "y": 0, "body": "…" }] }
 *
 * Each card, task and tile becomes a note of its own. Unknown keys are left
 * alone, and a list another board type uses is ignored, so a skeleton written
 * for a newer Filo still makes what this one can.
 */
import { z } from 'zod';

/** A card or task: its title, or its title and first text. */
const ItemSchema = z.union([
  z.string().min(1),
  z.object({ title: z.string().min(1), body: z.string().optional() }).passthrough(),
]);

/** No skeleton makes more than this many notes. */
export const MAX_TEMPLATE_ITEMS = 200;

export const BoardTemplateSkeletonSchema = z.object({
  type: z.string().default('mindmap'),
  settings: z.record(z.string(), z.unknown()).default(() => ({})),
  columns: z.array(z.object({ title: z.string(), cards: z.array(ItemSchema).default(() => []) }).passthrough()).optional(),
  sections: z.array(z.object({ title: z.string(), tasks: z.array(ItemSchema).default(() => []) }).passthrough()).optional(),
  tiles: z.array(z.object({
    title: z.string().min(1),
    body: z.string().optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    width: z.number().finite().positive().optional(),
    height: z.number().finite().positive().optional(),
  }).passthrough()).optional(),
}).passthrough();

export type BoardTemplateSkeleton = z.infer<typeof BoardTemplateSkeletonSchema>;
export type BoardTemplateItem = z.infer<typeof ItemSchema>;
