/**
 * The `electron` module as the characterisation suite sees it.
 *
 * The suite runs the REAL main-process IPC handlers against a real temp vault,
 * so the renderer under test talks to the same file operations the app does.
 * Only the Electron shell is faked: handler registration is captured,
 * `webContents.send` is routed back to the renderer's `window.filo.on`
 * listeners, file pickers are cancelled (an open picker returns a folder a
 * test queued in `folderPicks`), and a message box is recorded and
 * takes the next scripted answer (its first button when none is scripted).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TEST_MACHINE_IDENTITY } from '../../helpers/testMachine';

export type MainHandler = (event: unknown, ...args: unknown[]) => unknown;
type MainListener = (event: unknown, ...args: unknown[]) => void;

export const mainHandlers = new Map<string, MainHandler>();
export const mainListeners = new Map<string, MainListener[]>();

/** Main → renderer pushes land here; the bridge fans them out to `window.filo.on`. */
export const rendererSink: { send: (channel: string, ...args: unknown[]) => void } = {
  send: () => {},
};

/** One message box the app showed. */
export interface MessageBoxCall {
  message: string;
  detail?: string;
  buttons: string[];
}

/** How many open pickers were shown, and the paths queued for the next ones (cancelled when none). */
export const folderPicks: { shown: number; answers: string[] } = { shown: 0, answers: [] };

/** What the app put on the clipboard, in order (main writes it: `shell:copy-text`). */
export const clipboardWrites: Array<{ text: string; html?: string }> = [];

/** Every message box shown, in order, and the answers (button labels) queued for the next ones. */
export const messageBoxes: { shown: MessageBoxCall[]; answers: string[] } = { shown: [], answers: [] };
/** Every path the app asked the OS to select in a file manager window (Show in folder). */
export const shownInFolder: string[] = [];

const userData = mkdtempSync(join(tmpdir(), 'filo-char-userdata-'));
// This machine is the one the renderer-side test setup pins, so main and the
// renderer agree on whose crash sentinel is whose.
writeFileSync(join(userData, 'machine-id.json'), JSON.stringify({ id: TEST_MACHINE_IDENTITY.machineId }));

const fakeWebContents = {
  id: 1,
  send: (channel: string, ...args: unknown[]) => rendererSink.send(channel, ...args),
  isDestroyed: () => false,
  on: () => {},
  session: {},
};

const fakeWindow = {
  webContents: fakeWebContents,
  isDestroyed: () => false,
  on: () => {},
};

export const electronFake = {
  ipcMain: {
    handle: (channel: string, handler: MainHandler) => {
      mainHandlers.set(channel, handler);
    },
    on: (channel: string, listener: MainListener) => {
      const list = mainListeners.get(channel) ?? [];
      list.push(listener);
      mainListeners.set(channel, list);
    },
    once: () => {},
    removeHandler: (channel: string) => {
      mainHandlers.delete(channel);
    },
    removeListener: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [fakeWindow],
    getFocusedWindow: () => fakeWindow,
    fromWebContents: () => fakeWindow,
  },
  app: {
    isPackaged: false,
    getPath: () => userData,
    getVersion: () => '0.0.0-characterisation',
    getLocale: () => 'en-GB',
    getSystemLocale: () => 'en-GB',
    on: () => {},
    whenReady: async () => {},
    quit: () => {},
    exit: () => {},
  },
  dialog: {
    showOpenDialog: async () => {
      folderPicks.shown++;
      const pick = folderPicks.answers.shift();
      return pick === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [pick] };
    },
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async (_win: unknown, opts: { message: string; detail?: string; buttons?: string[] }) => {
      const buttons = opts.buttons ?? ['OK'];
      messageBoxes.shown.push({ message: opts.message, detail: opts.detail, buttons });
      const answer = messageBoxes.answers.shift();
      const index = answer === undefined ? 0 : buttons.indexOf(answer);
      if (index < 0) throw new Error(`message box has no "${answer}" button: ${buttons.join(', ')}`);
      return { response: index };
    },
  },
  clipboard: {
    writeText: async (text: string) => { clipboardWrites.push({ text }); },
    write: async (items: Array<{ entries: Record<string, string> }>) => {
      const entries = items[0]?.entries ?? {};
      clipboardWrites.push({ text: entries['text/plain'] ?? '', html: entries['text/html'] });
    },
  },
  ClipboardItem: class {
    constructor(readonly entries: Record<string, string>) {}
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
    showItemInFolder: (fullPath: string) => { shownInFolder.push(fullPath); },
    trashItem: async () => {},
  },
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
  protocol: {
    handle: () => {},
    registerSchemesAsPrivileged: () => {},
  },
  session: { defaultSession: {} },
  webUtils: { getPathForFile: () => '' },
};
