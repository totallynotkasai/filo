import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { isAppNavigation } from './utils/navigationGuard';
import { embedPopupTarget } from './utils/embedPopup';
import { isPrivateUrl } from './utils/pathSecurity';
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
import { releaseActiveVault, stopActiveWatcher } from './ipc/vault.ipc';
import { vaultRegistry } from './services/vaultRegistry';
import { writeQuitFailureBreadcrumb } from './services/quitFailureBreadcrumb';
import { attachRendererCrashHandlers, isRendererGone } from './services/rendererCrashHandler';
import { decideWindowClose } from './utils/windowCloseDecision';
import { createSessionEndHandlers } from './services/sessionEnd';
import { buildAppContentSecurityPolicy } from './utils/contentSecurityPolicy';
import { installPermissionHandlers } from './utils/permissionPolicy';
import { SYSTEM_LOCALE_ARG } from '../shared/systemLocale';
import { textMenuItems, type TextMenuItem } from './utils/textMenu';
import { createTextMenuQuery } from './services/textMenuQuery';

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

// The permission handler grants microphone audio only to this webContents'
// own main-frame document; see utils/permissionPolicy.ts.
let appWebContentsId: number | null = null;

/** The app document URL prefix (dev server origin, or the packaged index.html href). */
function appDocumentUrlPrefix(): string {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    return new URL(process.env.ELECTRON_RENDERER_URL).origin + '/';
  }
  return pathToFileURL(join(__dirname, '../renderer/index.html')).href;
}

// Graceful-shutdown coordination. Both the window `close` handler and the
// `before-quit` backstop below set this flag so they don't double-dispatch
// the renderer flush IPC if both fire (e.g. menu-driven quit while a window
// close is also in flight).
let isFlushingForQuit = false;
const FLUSH_TIMEOUT_MS = 5000;
// Ceiling on the teardown before a window close destroys the window.
const TEARDOWN_BOUND_MS = 2000;

// Windows ending the session (shutdown, restart, sign-out): see sessionEnd.ts.
const sessionEnd = createSessionEndHandlers({
  rendererAlive: () => !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && !isRendererGone(),
  sendSessionEnding: () => {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('no window');
    mainWindow.webContents.send('app:session-ending');
  },
  onceDone: (listener) => {
    const once = (): void => listener();
    ipcMain.once('app:session-ending-done', once);
    return () => ipcMain.removeListener('app:session-ending-done', once);
  },
  markQuitting: () => {
    isFlushingForQuit = true;
  },
  teardown: () => {
    captureAndSaveWindowState();
    return Promise.allSettled([
      flushWindowStateNow(),
      flushSidebarStateNow(),
      stopActiveWatcher(),
      writeQuitFailureBreadcrumb(vaultRegistry.currentVaultPath),
    ]);
  },
  teardownBoundMs: TEARDOWN_BOUND_MS,
  exit: () => app.exit(0),
  writeBreadcrumb: () => writeQuitFailureBreadcrumb(vaultRegistry.currentVaultPath),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
});
ipcMain.on('app:unsaved-state', (_event, mayLoseWork: unknown) => {
  sessionEnd.noteUnsavedState(mayLoseWork === true);
});

// The right-click menu on text asks the renderer whether a link can go at
// the caret, and opens without that item if no answer comes within this.
const textMenuQuery = createTextMenuQuery(300);
ipcMain.on('app:text-menu-reply', (event, id: unknown, context: unknown) => {
  textMenuQuery.onReply(event.sender.id, id, context);
});

// `at`: where the menu opened, so the Insert Link popup opens there too.
function textMenuEntry(item: TextMenuItem, contents: WebContents, at: { x: number; y: number }): MenuItemConstructorOptions {
  switch (item.kind) {
    case 'suggestion':
      return { label: item.word, click: () => contents.replaceMisspelling(item.word) };
    case 'add-word':
      return {
        label: `Add "${item.word}" to Dictionary`,
        click: () => contents.session.addWordToSpellCheckerDictionary(item.word),
      };
    case 'role':
      return { role: item.role, enabled: item.enabled };
    case 'link':
      return { label: item.label, click: () => contents.send('app:insert-link', at) };
    case 'separator':
      return { type: 'separator' };
  }
}

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
 * Enforce the Content-Security-Policy at the HTTP-header level, in addition
 * to the `<meta>` tag in index.html.
 *
 * The `<meta>` CSP governs the app document but does NOT cover web workers or
 * non-document responses; a response header does. The policy string mirrors
 * index.html with ONE deliberate prod divergence: the dev-only
 * `ws://localhost:*` (Vite HMR socket) is dropped from `connect-src` when
 * `app.isPackaged`. The `filo-strip-dev-csp` Vite plugin strips the same token
 * from the index.html `<meta>` at build time, so in a packaged build the header
 * and the `<meta>` agree (no `ws://`); in dev both keep it for HMR. Keep the two
 * in sync if either changes.
 *
 * Scope: only responses served from the app's own origin (the Vite dev server
 * in dev, `file://` in prod) receive the header. Everything else is passed
 * through untouched so we don't
 *   - clobber the strict per-response CSP the `filo://` media handler sets on
 *     SVGs (see protocol/filoMedia.ts), nor
 *   - impose `default-src 'self'` on third-party `https:` documents loaded
 *     inside Iframe tiles (which the policy's `frame-src https:` permits).
 *
 * `frame-src https:` is intentionally broad: Iframe tiles let the
 * user embed ANY https origin (YouTube, CodePen, etc.), so a fixed origin
 * allowlist isn't possible. It's accepted defense-in-depth — the tile iframe is
 * sandboxed (`allow-scripts` WITHOUT `allow-same-origin`) and every src is run
 * through `asSafeIframeSrc`. See KNOWN_LIMITATIONS.md #10.
 */
function installContentSecurityPolicy(): void {
  // Assembled by a single pure builder so the packaged header never
  // authorises a localhost websocket the app doesn't open.
  const CSP = buildAppContentSecurityPolicy(app.isPackaged);

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
      // The regional-format locale (e.g. en-GB) for date order. Chromium's own
      // `navigator.language` follows the Windows DISPLAY language instead, so
      // a UK region with a US display language would read as month-first.
      additionalArguments: [`${SYSTEM_LOCALE_ARG}${app.getSystemLocale()}`],
    },
  });

  appWebContentsId = mainWindow.webContents.id;

  attachRendererCrashHandlers(mainWindow, {
    writeBreadcrumb: () => writeQuitFailureBreadcrumb(vaultRegistry.currentVaultPath),
    isQuitting: () => isFlushingForQuit,
    releaseVault: releaseActiveVault,
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

    // A second X-click while a drain is already in flight MUST keep
    // blocking the close (preventDefault), not fall through to Electron's
    // destroy and abort the in-flight write drain. `decideWindowClose` is the
    // pure guard; see windowCloseDecision.ts.
    const decision = decideWindowClose({
      isFlushing: isFlushingForQuit,
      windowAlive: !!mainWindow && !mainWindow.webContents.isDestroyed(),
      rendererAlive: !isRendererGone(),
    });
    if (decision.preventDefault) event.preventDefault();
    if (!decision.startDrain) return;

    isFlushingForQuit = true;

    // Both ends of the close (the renderer's ready, or its silence past the
    // ceiling) tear down the same way before the window goes: the listeners,
    // the main-side geometry debounces, the watcher, and the quit-failure
    // breadcrumb that tells the next launch where preserved bytes are.
    // Bounded, so a wedged volume can't keep a timed-out window alive.
    const teardownAndDestroy = (): void => {
      clearTimeout(timer);
      ipcMain.removeListener('app:ready-to-quit', onReady);
      ipcMain.removeListener('app:cancel-quit', onCancel);
      ipcMain.removeListener('app:quit-awaiting-user', onAwaitingUser);
      ipcMain.removeListener('app:drain-heartbeat', onHeartbeat);
      const teardown = Promise.allSettled([
        flushWindowStateNow(),
        flushSidebarStateNow(),
        stopActiveWatcher(),
        // No-op unless a write preserved a partial this session.
        writeQuitFailureBreadcrumb(vaultRegistry.currentVaultPath),
      ]);
      const bound = new Promise<void>((resolve) => setTimeout(resolve, TEARDOWN_BOUND_MS));
      void Promise.race([teardown, bound]).finally(() => {
        mainWindow?.destroy();
      });
    };
    const destroyOnTimeout = (): void => {
      console.warn('[main] flush-and-quit timed out on window close, destroying anyway');
      teardownAndDestroy();
    };
    let timer = setTimeout(destroyOnTimeout, FLUSH_TIMEOUT_MS);

    // Drain heartbeat. The renderer beats immediately and then every ~2 s
    // while its flush drains. Re-arm the auto-destroy timer on each beat so
    // an honest drain longer than FLUSH_TIMEOUT_MS (a large vault on a
    // contended volume, e.g. OneDrive) isn't destroyed mid-write. The ceiling
    // bounds inter-beat SILENCE (a wedged renderer), not total drain time.
    const onHeartbeat = (): void => {
      clearTimeout(timer);
      timer = setTimeout(destroyOnTimeout, FLUSH_TIMEOUT_MS);
    };

    // Sent right before the renderer opens an open-ended "Save failed"
    // confirm. Clear the auto-destroy timer so the ceiling bounds only the
    // automated flush, not the human's decision time — otherwise the window
    // destroys under the dialog and the edits are discarded. A renderer that
    // never replies just leaves the window open (the safe direction). Drop
    // the heartbeat listener too so a late beat can't re-arm the timer.
    const onAwaitingUser = (): void => {
      clearTimeout(timer);
      ipcMain.removeListener('app:drain-heartbeat', onHeartbeat);
    };

    // Two terminal signals from the renderer: ready (proceed to
    // destroy) and cancel (user picked "Stay open and retry" on the save-
    // failure confirm; rewind isFlushingForQuit so they can keep editing).
    // Whichever fires first wins and removes the other listener.
    const onReady = (): void => {
      teardownAndDestroy();
    };
    const onCancel = (): void => {
      clearTimeout(timer);
      ipcMain.removeListener('app:ready-to-quit', onReady);
      ipcMain.removeListener('app:quit-awaiting-user', onAwaitingUser);
      ipcMain.removeListener('app:drain-heartbeat', onHeartbeat);
      isFlushingForQuit = false;
    };
    ipcMain.once('app:ready-to-quit', onReady);
    ipcMain.once('app:cancel-quit', onCancel);
    ipcMain.once('app:quit-awaiting-user', onAwaitingUser);
    // Persistent (`on`, not `once`) so every periodic beat lands;
    // removed in onReady/onCancel/onAwaitingUser and the catch below.
    ipcMain.on('app:drain-heartbeat', onHeartbeat);

    try {
      // startDrain is only true when the window was alive (see decideWindowClose
      // above); the guard narrows the nullable ref and routes the impossible
      // null case through the existing catch → destroy path.
      if (!mainWindow) throw new Error('mainWindow released before flush-and-quit');
      mainWindow.webContents.send('app:flush-and-quit');
    } catch (err) {
      clearTimeout(timer);
      ipcMain.removeListener('app:ready-to-quit', onReady);
      ipcMain.removeListener('app:cancel-quit', onCancel);
      ipcMain.removeListener('app:quit-awaiting-user', onAwaitingUser);
      ipcMain.removeListener('app:drain-heartbeat', onHeartbeat);
      logMainError('main:flush-and-quit-on-close', err);
      mainWindow?.destroy();
    }
  });

  // Windows is ending the session: neither `close` nor `before-quit` runs.
  // Held back only while the renderer saves and keeps rescue copies.
  mainWindow.on('query-session-end', (event) => {
    if (sessionEnd.onQuerySessionEnd()) event.preventDefault();
  });
  mainWindow.on('session-end', () => {
    sessionEnd.onSessionEnd();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    appWebContentsId = null;
  });

  // The right-click menu on text (utils/textMenu.ts): spelling, Cut, Copy,
  // Paste, Select All and, in a note's text, Insert Link. The renderer shows
  // its own menus everywhere else, so this fires only on editable text (or
  // text selected in an embed's page).
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const contents = mainWindow?.webContents;
    if (!contents) return;
    void textMenuQuery.ask(contents).then((context) => {
      const items = textMenuItems(params, context);
      if (items.length === 0 || !mainWindow || mainWindow.isDestroyed()) return;
      const at = { x: params.x, y: params.y };
      Menu.buildFromTemplate(items.map((item) => textMenuEntry(item, contents, at))).popup({ window: mainWindow });
    });
  });

  // Navigation hardening (defense-in-depth beyond the CSP).
  //
  // `setWindowOpenHandler` denies every `window.open` / `target=_blank`
  // attempt: the renderer opens external links through the `media:open-external`
  // IPC (which validates the URL + blocks private addresses), never via a new
  // BrowserWindow. A link inside an iframe tile's page that asks for a new
  // window goes to the default browser instead (`embedPopupTarget`: public
  // https only, one a second). `will-navigate` blocks any top-level navigation that would
  // leave the app's own document — the SPA never legitimately navigates the
  // top frame, so a navigation to another origin is an accident or an attack
  // (injected meta-refresh, a script setting `location.href`, a stray link).
  const appNavigationUrl =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL
      ? process.env.ELECTRON_RENDERER_URL
      : pathToFileURL(join(__dirname, '../renderer/index.html')).toString();

  let lastEmbedPopupAt = 0;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const target = embedPopupTarget(url, Date.now(), lastEmbedPopupAt, isPrivateUrl);
    if (target) {
      lastEmbedPopupAt = Date.now();
      void shell.openExternal(target).catch((err: unknown) => logMainError('embed-popup', err));
    }
    return { action: 'deny' };
  });
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
  // Deny-by-default permission handler on the shared session, so an embedded
  // https iframe (CSP allows any origin) can't be granted geolocation /
  // camera / mic / notifications / clipboard by a version-dependent Electron
  // default. The app document alone may record audio (the Audio tile).
  const appUrlPrefix = appDocumentUrlPrefix();
  installPermissionHandlers(session.defaultSession, () => ({ appWebContentsId, appUrlPrefix }));
  registerAllHandlers();
  registerFiloProtocol();
  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // macOS dock-reactivate recreates the window on the SAME process, with
      // `isFlushingForQuit` still set by the previous window's close. Reset
      // it, or the next close would skip the flush and lose debounced writes.
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
 * by the `close` event handler set up in `createWindow`; this handler is the
 * backstop.
 *
 * The renderer signals completion (or failure) via `app:ready-to-quit`.
 * A 5s ceiling protects against a stuck renderer holding shutdown forever;
 * the dirty-flag sentinel will then surface what was lost on next launch.
 */
app.on('before-quit', (event) => {
  if (isFlushingForQuit) return;
  // A crashed renderer can't drain; its breadcrumb was written at crash time.
  if (isRendererGone()) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;

  event.preventDefault();
  isFlushingForQuit = true;

  // Flush any in-debounce window-state timer so the
  // latest geometry feeds into `flushWindowStateNow` below. Resize at
  // T+0 / Ctrl+Q at T+100ms would otherwise leave the new bounds
  // un-persisted because the 300ms timer never got to fire.
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = null;
  }
  captureAndSaveWindowState();

  // `finish` drains the main-side debounced writes (windowState +
  // sidebarState — e.g. a sidebar resize at T+0, Ctrl+Q at T+100ms) that
  // `app.exit` would otherwise lose, and stops the watcher so it can't emit
  // late events after teardown.
  const finish = (): void => {
    ipcMain.removeAllListeners('app:ready-to-quit');
    // Also drain the cancel-quit listener so a late renderer signal can't
    // bring the (already torn down) flush state out of sync.
    ipcMain.removeAllListeners('app:cancel-quit');
    ipcMain.removeAllListeners('app:quit-awaiting-user');
    ipcMain.removeAllListeners('app:drain-heartbeat');
    void Promise.allSettled([
      flushWindowStateNow(),
      flushSidebarStateNow(),
      stopActiveWatcher(),
      // See the close-event path above.
      writeQuitFailureBreadcrumb(vaultRegistry.currentVaultPath),
    ]).finally(() => {
      app.exit(0);
    });
  };

  const exitOnTimeout = (): void => {
    console.warn('[main] flush-and-quit timed out, exiting anyway');
    finish();
  };
  let timer = setTimeout(exitOnTimeout, FLUSH_TIMEOUT_MS);

  // Drain heartbeat (see the close-event path). Each beat re-arms the
  // auto-exit timer; the ceiling bounds inter-beat silence, not drain time.
  const onHeartbeat = (): void => {
    clearTimeout(timer);
    timer = setTimeout(exitOnTimeout, FLUSH_TIMEOUT_MS);
  };

  // See the close-event path. Clear the auto-exit timer when the renderer signals a human
  // is reading the open-ended save-failure confirm, so the 5 s ceiling bounds
  // only the automated flush. The ready/cancel reply still drives the exit.
  const onAwaitingUser = (): void => {
    clearTimeout(timer);
    ipcMain.removeListener('app:drain-heartbeat', onHeartbeat);
  };

  // Same two-signal handshake as the close-event path. On Cancel
  // we don't exit, we rewind `isFlushingForQuit` and remove the listeners.
  const onReady = (): void => {
    clearTimeout(timer);
    ipcMain.removeListener('app:cancel-quit', onCancel);
    ipcMain.removeListener('app:quit-awaiting-user', onAwaitingUser);
    finish();
  };
  const onCancel = (): void => {
    clearTimeout(timer);
    ipcMain.removeListener('app:ready-to-quit', onReady);
    ipcMain.removeListener('app:quit-awaiting-user', onAwaitingUser);
    ipcMain.removeListener('app:drain-heartbeat', onHeartbeat);
    isFlushingForQuit = false;
  };
  ipcMain.once('app:ready-to-quit', onReady);
  ipcMain.once('app:cancel-quit', onCancel);
  ipcMain.once('app:quit-awaiting-user', onAwaitingUser);
  // Persistent (`on`) drain heartbeat; drained by finish() /
  // onCancel / onAwaitingUser / the catch below.
  ipcMain.on('app:drain-heartbeat', onHeartbeat);

  try {
    win.webContents.send('app:flush-and-quit');
  } catch (err) {
    clearTimeout(timer);
    ipcMain.removeListener('app:ready-to-quit', onReady);
    ipcMain.removeListener('app:cancel-quit', onCancel);
    ipcMain.removeListener('app:quit-awaiting-user', onAwaitingUser);
    ipcMain.removeListener('app:drain-heartbeat', onHeartbeat);
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
