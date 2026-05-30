import { app, screen } from 'electron';
import { join } from 'path';
import { promises as fs } from 'fs';
import { atomicWriteFile } from '../vault/filenameUtils';
import { logMainError } from '../utils/mainLogger';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = {
  width: 1400,
  height: 900,
  maximized: false,
};

function getWindowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

export async function loadWindowState(): Promise<WindowState> {
  let raw: string;
  try {
    raw = await fs.readFile(getWindowStatePath(), 'utf-8');
  } catch (err) {
    // Phase 21 / M27 — ENOENT on first launch is the normal path; anything
    // else (parse, EACCES) is logged so the user can diagnose why the
    // window keeps reverting to default geometry.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logMainError('windowState.read', err);
    }
    return { ...DEFAULT_STATE };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    const width = typeof parsed.width === 'number' && parsed.width >= 400 ? parsed.width : DEFAULT_STATE.width;
    const height = typeof parsed.height === 'number' && parsed.height >= 300 ? parsed.height : DEFAULT_STATE.height;
    const maximized = parsed.maximized === true;
    const state: WindowState = { width, height, maximized };

    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      // Reject positions on a display that no longer exists (e.g. unplugged
      // secondary monitor). Fall back to centred placement.
      const matched = screen.getDisplayMatching({ x: parsed.x, y: parsed.y, width, height });
      const wa = matched.workArea;
      if (
        parsed.x >= wa.x - 50 &&
        parsed.x <= wa.x + wa.width - 100 &&
        parsed.y >= wa.y - 50 &&
        parsed.y <= wa.y + wa.height - 100
      ) {
        state.x = parsed.x;
        state.y = parsed.y;
      }
    }
    return state;
  } catch (parseErr) {
    logMainError('windowState.parse', parseErr);
    return { ...DEFAULT_STATE };
  }
}

/**
 * Phase 4 / 4.4 — tracks the most-recent in-flight `saveWindowState`
 * call so `flushWindowStateNow` can await disk I/O that started before
 * `before-quit` fired.
 */
let inFlightWrite: Promise<void> | null = null;

export async function saveWindowState(state: WindowState): Promise<void> {
  const write = (async () => {
    try {
      // Phase 21 / M27 — atomic write so a power loss / crash during save
      // can't leave the file as a half-written JSON blob.
      await atomicWriteFile(getWindowStatePath(), JSON.stringify(state, null, 2));
    } catch (err) {
      logMainError('windowState.save', err);
    }
  })();
  inFlightWrite = write.finally(() => {
    inFlightWrite = null;
  });
  await write;
}

/**
 * Phase 4 / 4.4 — drains any in-flight window-state save before
 * resolving. Called from `before-quit` (paired with the synchronous
 * `captureAndSaveWindowState` in main.ts that force-fires the latest
 * geometry). Resolves immediately when no write is pending.
 */
export async function flushWindowStateNow(): Promise<void> {
  if (inFlightWrite) await inFlightWrite;
}
