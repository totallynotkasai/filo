import { app } from 'electron';
import { join } from 'path';
import { promises as fs } from 'fs';
import { z } from 'zod';
import { atomicWriteFile } from '../vault/filenameUtils';
import { logMainError } from '../utils/mainLogger';

/**
 * Per-machine sidebar state — shown or hidden (Hide Vault), width, in-app
 * floating mode flag, and the last floating-panel bounds.
 *
 * Mirrors `windowState.ts`: persisted at `userData/sidebar-state.json`
 * (NOT in the vault) so the user's preferred sidebar width and floating
 * panel geometry survive vault swaps and live on a per-machine basis.
 * Loaded once at startup by the sidebar IPC handler; saved debounced
 * 300 ms after any change.
 */

const FloatingBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(220),
  height: z.number().min(240),
});

const SidebarStateSchema = z.object({
  open: z.boolean().default(true),
  width: z.number().min(180).max(600).default(240),
  floating: z.boolean().default(false),
  floatingBounds: FloatingBoundsSchema.optional(),
});

export type SidebarState = z.infer<typeof SidebarStateSchema>;
export type SidebarFloatingBounds = z.infer<typeof FloatingBoundsSchema>;

/**
 * Patch shape accepted by `updateSidebarState` over IPC. All fields are
 * optional; unknown extras are stripped before merging.
 */
export const SidebarPatchSchema = z
  .object({
    open: z.boolean().optional(),
    width: z.number().optional(),
    floating: z.boolean().optional(),
    floatingBounds: FloatingBoundsSchema.optional(),
  })
  .strict();
export type SidebarPatch = z.infer<typeof SidebarPatchSchema>;

const DEFAULT_STATE: SidebarState = { open: true, width: 240, floating: false };

function statePath(): string {
  return join(app.getPath('userData'), 'sidebar-state.json');
}

let cached: SidebarState | null = null;
let saveTimer: NodeJS.Timeout | null = null;

/**
 * Promise tracking the most-recent in-flight `writeSidebarState`
 * call. `flushNow` awaits it so a Ctrl+Q after a sidebar resize lands the
 * new geometry before the process exits.
 */
let inFlightWrite: Promise<void> | null = null;

export async function loadSidebarState(): Promise<SidebarState> {
  if (cached) return cached;
  let raw: string;
  try {
    raw = await fs.readFile(statePath(), 'utf-8');
  } catch (err) {
    // ENOENT on first launch is the normal path; surface
    // anything else through mainLogger so the user can diagnose why their
    // sidebar width keeps resetting.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logMainError('sidebarState.read', err);
    }
    cached = { ...DEFAULT_STATE };
    return cached;
  }
  try {
    const parsed = SidebarStateSchema.safeParse(JSON.parse(raw));
    cached = parsed.success ? parsed.data : { ...DEFAULT_STATE };
    if (!parsed.success) {
      logMainError('sidebarState.parse', parsed.error);
    }
  } catch (parseErr) {
    logMainError('sidebarState.parse', parseErr);
    cached = { ...DEFAULT_STATE };
  }
  return cached;
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Capture the in-flight promise so `flushNow` can
    // await both the timer fire AND the disk write.
    inFlightWrite = writeSidebarState().finally(() => {
      inFlightWrite = null;
    });
  }, 300);
}

async function writeSidebarState(): Promise<void> {
  if (!cached) return;
  try {
    // Atomic write so a crash mid-save doesn't leave the
    // sidebar-state file as half-written garbage that fails to parse on
    // next launch.
    await atomicWriteFile(statePath(), JSON.stringify(cached, null, 2));
  } catch (err) {
    logMainError('sidebarState.save', err);
  }
}

/**
 * Drains any pending sidebar-state save (timer or
 * in-flight write) before resolving. Called from `before-quit` so a
 * user resizing the sidebar at T+0 and pressing Ctrl+Q at T+100 ms
 * still gets their geometry persisted before the process exits.
 *
 * Idempotent — safe to call when neither a timer nor an in-flight write
 * is pending.
 */
export async function flushSidebarStateNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    // Force-fire the write synchronously and capture its promise so
    // we can also wait on the disk I/O below.
    inFlightWrite = writeSidebarState().finally(() => {
      inFlightWrite = null;
    });
  }
  if (inFlightWrite) await inFlightWrite;
}

/**
 * Merges the given patch into the cached state, clamps values, and
 * schedules a debounced write to disk.
 */
export async function updateSidebarState(patch: Partial<SidebarState>): Promise<SidebarState> {
  const current = await loadSidebarState();
  const merged: SidebarState = { ...current };
  if (typeof patch.width === 'number') {
    merged.width = Math.max(180, Math.min(600, Math.round(patch.width)));
  }
  if (typeof patch.open === 'boolean') {
    merged.open = patch.open;
  }
  if (typeof patch.floating === 'boolean') {
    merged.floating = patch.floating;
  }
  if (patch.floatingBounds) {
    const parsed = FloatingBoundsSchema.safeParse(patch.floatingBounds);
    if (parsed.success) merged.floatingBounds = parsed.data;
  }
  cached = merged;
  scheduleSave();
  return merged;
}
