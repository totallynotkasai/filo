import { app, BrowserWindow, ipcMain, Menu, MenuItem, protocol, session } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { isAppNavigation } from './utils/navigationGuard';
import { registerAllHandlers } from './ipc/index';
import { registerFiloProtocol } from './protocol/filoMedia';
import {
  loadWindowState,
  saveWindowState,
  flushWindowStateNow,
  type WindowState,
} from './services/windowState';
import { flushSidebarStateNow } from './services/sidebarState';
import { logMainError } from './utils/mainLogger';
import { stopActiveWatcher } from './ipc/vault.ipc';

// Must run before `app.whenReady`. Registers the `filo://` URL scheme as a
// privileged standard scheme so the renderer can load vault-local media
// (images / video / audio) without tripping Chromium's `file://` block.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'filo',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

function resolveWindowIcon(): string | undefined {
  // Linux uses an explicit window icon. On Windows the icon comes from the
  // .exe resources at packaging time; on macOS it comes from the .app bundle.
  // In dev, point at the PNG raster if it exists.
  const candidates = [
    join(__dirname, '..', '..', 'resources', 'icon.png'),
    join(process.resourcesPath ?? '', 'icon.png'),
  ];
  return candidates.find((p) => p && existsSync(p));
}

let mainWindow: BrowserWindow | null = null;
let windowStateSaveTimer: NodeJS.Timeout | null = null;

// Graceful-shutdown coordination. Both the window `close` handler and the
// `before-quit` backstop below set this flag so they don't double-dispatch
// the renderer flush IPC if both fire (e.g. menu-driven quit while a window
// close is also in flight).
let isFlushingForQuit = false;
const FLUSH_TIMEOUT_MS = 5000;

function scheduleWindowStateSave(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    captureAndSaveWindowState();
  }, 300);
}

function captureAndSaveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  // When maximized, `getBounds()` returns the maximized rect; preserve the
  // non-maximized bounds via `getNormalBounds` so unmaximizing on next launch
  // lands at the user's chosen size.
  const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized,
  };
  void saveWindowState(state);
}

/**
 * L4a (AUDIT_REMEDIATION_PLAN_2026-05-29) — enforce the Content-Security-Policy
 * at the HTTP-header level, in addition to the `<meta>` tag in index.html.
 *
 * The `<meta>` CSP governs the app document but does NOT cover web workers or
 * non-document responses; a response header does. The policy string mirrors
 * index.html — keep the two in sync if either changes.
 *
 * Scope: only responses served from the app's own origin (the Vite dev server
 * in dev, `file://` in prod) receive the header. Everything else is passed
 * through untouched so we don't
 *   - clobber the strict per-response CSP the `filo://` media handler sets on
 *     SVGs (see protocol/filoMedia.ts), nor
 *   - impose `default-src 'self'` on third-party `https:` documents loaded
 *     inside Iframe tiles (which the policy's `frame-src https:` permits).
 */
function installContentSecurityPolicy(): void {
  const CSP =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: filo:; media-src 'self' blob: filo:; " +
    "font-src 'self' data:; connect-src 'self' ws://localhost:*; " +
    'frame-src https:; child-src https:;';

  const appOrigin =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? process.env.ELECTRON_RENDERER_URL
      : 'file://';

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith(appOrigin)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const responseHeaders = { ...(details.responseHeaders ?? {}) };
    // Drop any case-variant of an existing CSP header so we emit exactly one.
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase() === 'content-security-policy') {
        delete responseHeaders[key];
      }
    }
    responseHeaders['Content-Security-Policy'] = [CSP];
    callback({ responseHeaders });
  });
}

async function createWindow(): Promise<void> {
  const icon = resolveWindowIcon();
  const savedState = await loadWindowState();
  mainWindow = new BrowserWindow({
    x: savedState.x,
    y: savedState.y,
    width: savedState.width,
    height: savedState.height,
    minWidth: 800,
    minHeight: 600,
    title: 'Filo',
    backgroundColor: '#1a1a2e',
    show: false,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  if (savedState.maximized) mainWindow.maximize();

  Menu.setApplicationMenu(null);

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('move', scheduleWindowStateSave);
  mainWindow.on('maximize', scheduleWindowStateSave);
  mainWindow.on('unmaximize', scheduleWindowStateSave);

  // Window close must intercept BEFORE destruction so the renderer can drain
  // every debounced write. Without this hook, clicking the window's X button
  // fires `closed` → `window-all-closed` → `app.quit()` → `before-quit` only
  // AFTER the window is gone, which short-circuits the flush path below.
  mainWindow.on('close', (event) => {
    // Always capture the latest window geometry before any destruction path
    // — including the early-return branches below where we don't go through
    // the flush sequence.
    captureAndSaveWindowState();

    if (isFlushingForQuit) return;
    if (!mainWindow || mainWindow.webContents.isDestroyed()) return;

    event.preventDefault();
    isFlushingForQuit = true;

    const timer = setTimeout(() => {
      console.warn('[main] flush-and-quit timed out on window close, destroying anyway');
      mainWindow?.destroy();
    }, FLUSH_TIMEOUT_MS);

    ipcMain.once('app:ready-to-quit', () => {
      clearTimeout(timer);
      // Phase 4 / 4.4 — drain windowState + sidebarState before destroying
      // the window. The renderer's flush completed first; now wait on the
      // main-side debounces so the next launch sees the latest geometry.
      // Sprint A / A8 — also stop the file watcher so its reconcile timer
      // and OS-level handle are released before the window destroy.
      void Promise.allSettled([
        flushWindowStateNow(),
        flushSidebarStateNow(),
        stopActiveWatcher(),
      ]).finally(() => {
        mainWindow?.destroy();
      });
    });

    try {
      mainWindow.webContents.send('app:flush-and-quit');
    } catch (err) {
      clearTimeout(timer);
      logMainError('main:flush-and-quit-on-close', err);
      mainWindow?.destroy();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Right-click spell check suggestions
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const { misspelledWord, dictionarySuggestions } = params;
    if (!misspelledWord) return;

    const menu = new Menu();

    dictionarySuggestions.slice(0, 6).forEach((word: string) => {
      menu.append(new MenuItem({
        label: word,
        click: () => mainWindow?.webContents.replaceMisspelling(word),
      }));
    });

    if (dictionarySuggestions.length > 0) {
      menu.append(new MenuItem({ type: 'separator' }));
    }

    menu.append(new MenuItem({
      label: `Add "${misspelledWord}" to Dictionary`,
      click: () => mainWindow?.webContents.session.addWordToSpellCheckerDictionary(misspelledWord),
    }));

    menu.popup({ window: mainWindow! });
  });

  // M4 — navigation hardening (defense-in-depth beyond the CSP).
  //
  // `setWindowOpenHandler` denies every `window.open` / `target=_blank`
  // attempt: the renderer opens external links through the `shell:open-external`
  // IPC (which validates the URL + blocks private addresses), never via a new
  // BrowserWindow. `will-navigate` blocks any top-level navigation that would
  // leave the app's own document — the SPA never legitimately navigates the
  // top frame, so a navigation to another origin is an accident or an attack
  // (injected meta-refresh, a script setting `location.href`, a stray link).
  const appNavigationUrl =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? process.env.ELECTRON_RENDERER_URL
      : pathToFileURL(join(__dirname, '../renderer/index.html')).toString();

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppNavigation(url, appNavigationUrl)) {
      event.preventDefault();
      console.warn(`[main] blocked navigation to ${url}`);
    }
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    // Dev only: auto-open DevTools so the renderer can be inspected. Gated
    // on `app.isPackaged` (belt-and-braces with ELECTRON_RENDERER_URL) so an
    // env-injected production build cannot force DevTools open. The
    // application menu is disabled (so the default Ctrl+Shift+I accelerator
    // does nothing); registering an explicit shortcut here keeps DevTools
    // toggleable without adding a visible menu bar.
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      const isToggleDevtools =
        input.type === 'keyDown' &&
        input.key.toLowerCase() === 'i' &&
        input.control &&
        input.shift;
      if (isToggleDevtools) {
        if (mainWindow?.webContents.isDevToolsOpened()) {
          mainWindow.webContents.closeDevTools();
        } else {
          mainWindow?.webContents.openDevTools({ mode: 'detach' });
        }
      }
    });
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Single instance lock — prevent multiple windows
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  // Configure spellchecker languages from OS locale, falling back to en-US.
  const available = session.defaultSession.availableSpellCheckerLanguages;
  const preferred = [app.getLocale(), 'en-US'].filter((l) => available.includes(l));
  if (preferred.length > 0) {
    session.defaultSession.setSpellCheckerLanguages(preferred);
  }

  installContentSecurityPolicy();
  registerAllHandlers();
  registerFiloProtocol();
  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // Sprint A / A1 — macOS dock-reactivate after every window closed
      // recreates the BrowserWindow on the SAME process. `isFlushingForQuit`
      // was set true by the previous window's close handler and never
      // unset, so the next close would short-circuit the flush sequence
      // and lose any debounced writes the renderer hadn't drained yet.
      // Reset the flag here so the new window starts fresh.
      isFlushingForQuit = false;
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Backstop graceful shutdown for paths that bypass the window `close`
 * handler — typically `app.quit()` invoked from code (menu items, IPC) or
 * unusual platform-specific exit signals. When a window is still alive at
 * this point, give the renderer a single chance to drain every debounced
 * write before the process exits.
 *
 * The primary close path (user clicks the window X) is intercepted earlier
 * by the `close` event handler set up in `createWindow`; that path is what
 * actually fixes the silent-loss bug. This handler exists for completeness.
 *
 * The renderer signals completion (or failure) via `app:ready-to-quit`.
 * A 5s ceiling protects against a stuck renderer holding shutdown forever;
 * the dirty-flag sentinel will then surface what was lost on next launch.
 */
app.on('before-quit', (event) => {
  if (isFlushingForQuit) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;

  event.preventDefault();
  isFlushingForQuit = true;

  // Phase 4 / 4.4 — flush any in-debounce window-state timer so the
  // latest geometry feeds into `flushWindowStateNow` below. Resize at
  // T+0 / Ctrl+Q at T+100ms would otherwise leave the new bounds
  // un-persisted because the 300ms timer never got to fire.
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
  captureAndSaveWindowState();

  // Phase 4 / 4.4 — `finish` now also drains the per-machine state
  // services (windowState + sidebarState) before exit. The renderer
  // flush has already completed; this catches the main-side debounced
  // writes (sidebar resize at T+0, Ctrl+Q at T+100ms) that would
  // otherwise be lost when `app.exit` tore down the event loop.
  // Sprint A / A8 — `stopActiveWatcher` clears the watcher's reconcile
  // timer and OS handle so they don't emit late events after the
  // event loop has torn down.
  const finish = (): void => {
    ipcMain.removeAllListeners('app:ready-to-quit');
    void Promise.allSettled([
      flushWindowStateNow(),
      flushSidebarStateNow(),
      stopActiveWatcher(),
    ]).finally(() => {
      app.exit(0);
    });
  };

  const timer = setTimeout(() => {
    console.warn('[main] flush-and-quit timed out, exiting anyway');
    finish();
  }, FLUSH_TIMEOUT_MS);

  ipcMain.once('app:ready-to-quit', () => {
    clearTimeout(timer);
    finish();
  });

  try {
    win.webContents.send('app:flush-and-quit');
  } catch (err) {
    clearTimeout(timer);
    logMainError('main:flush-and-quit', err);
    finish();
  }
});

// Terminal Ctrl+C / kill: route through the same close path so the renderer
// gets a flush attempt before the process dies. Without this, pressing Ctrl+C
// in the `npm run dev` terminal kills electron mid-debounce and any pending
// board / config writes are lost.
function handleProcessExitSignal(): void {
  // A second SIGINT/SIGTERM while we're already flushing would re-call
  // `mainWindow.close()` and re-enter the close handler. The close handler
  // short-circuits on `isFlushingForQuit`, but the re-entry is wasted work
  // and risks racing the flush timer. Ignore the second signal entirely.
  if (isFlushingForQuit) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  } else {
    app.exit(0);
  }
}
process.on('SIGINT', handleProcessExitSignal);
process.on('SIGTERM', handleProcessExitSignal);
