import { z } from 'zod';
import { BoardSchema } from './board';
import { ConnectionSchema } from './connection';
import { FrameSchema } from './frame';
import { ProjectSettingsSchema } from './settings';
import { uniqueBy } from './schemaUtils';

/**
 * Workspace state captured at save time — which boards are open in tabs and
 * which tab is currently active. Restored when the project is reopened so the
 * user returns to the same set of boards/tab they left.
 *
 * Only the minimum is stored (tab id + board id, and a Document tab's note
 * path); display data like name, emoji, and boardType is derived on load.
 */
export const WorkspaceStateSchema = z.object({
  openTabs: z
    .array(
      z.object({
        id: z.string().min(1),
        boardId: z.string().min(1),
        /** A Document tab's note (vault-relative); the tab's boardId is then an opaque id. */
        notePath: z.string().optional().catch(undefined),
      }).passthrough(),
    )
    .default(() => []),
  activeTabId: z.string().default(''),
}).passthrough();

export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

/**
 * Virtual project — the in-memory view of a Filo vault.
 *
 * The "project" is not stored as a single file on disk; it is reconstructed
 * by `vaultCandidate.openVault` from the vault's `.filo/*` config files
 * plus every loaded `.board.json`. This schema validates the virtual
 * object that gets handed to the renderer stores.
 *
 * The legacy `version` and `tags` fields are gone. There
 * was never a standalone `project.json` to carry a version on, and tag
 * definitions have lived in `.filo/tags.json` since the Obsidian
 * alignment. Both fields are still tolerated on the way in via
 * `.passthrough()` so a stale call site that still passes them won't
 * fail parse — but they no longer appear on the inferred `Project`
 * type and shouldn't be set on new code.
 */
export const ProjectSchema = z.object({
  /** Absolute path to the vault folder (where tiles.json, .md files, and media live). */
  vaultPath: z.string().default(''),
  name: z.string().default(''),
  /** The active theme: a built-in id, or a custom theme's id (`.filo/themes/<id>.json`). */
  theme: z.string().trim().min(1).default('light'),
  settings: ProjectSettingsSchema.prefault({}),
  boards: z.array(BoardSchema).default(() => []).refine(...uniqueBy('id', 'boards')),
  connections: z.record(z.string(), ConnectionSchema).default(() => ({})),
  frames: z.array(FrameSchema).default(() => []).refine(...uniqueBy('id', 'frames')),
  /** Open tabs + active tab, captured at save time. */
  workspace: WorkspaceStateSchema.prefault({}),
  // .finite() rejects NaN / ±Infinity from hand-edited files.
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).passthrough();

export type Project = z.infer<typeof ProjectSchema>;
