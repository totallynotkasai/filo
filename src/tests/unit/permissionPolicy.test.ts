import { describe, it, expect } from 'vitest';
import {
  decidePermission,
  installPermissionHandlers,
  type PermissionContext,
  type PermissionInput,
} from '../../main/utils/permissionPolicy';

const APP_ID = 7;
const DEV_CTX: PermissionContext = { appWebContentsId: APP_ID, appUrlPrefix: 'http://localhost:5173/' };
const PROD_CTX: PermissionContext = {
  appWebContentsId: APP_ID,
  appUrlPrefix: 'file:///C:/Program%20Files/Filo/resources/app.asar/out/renderer/index.html',
};

function appAudioRequest(overrides: Partial<PermissionInput> = {}): PermissionInput {
  return {
    permission: 'media',
    isMainFrame: true,
    requestingUrl: 'http://localhost:5173/',
    webContentsId: APP_ID,
    mediaTypes: ['audio'],
    ...overrides,
  };
}

describe('decidePermission — only the app document may record audio', () => {
  it('allows audio-only media for the app main frame (dev)', () => {
    expect(decidePermission(appAudioRequest(), DEV_CTX)).toBe(true);
  });

  it('allows audio-only media for the packaged file:// document', () => {
    const url = `${PROD_CTX.appUrlPrefix}#/board`;
    expect(decidePermission(appAudioRequest({ requestingUrl: url }), PROD_CTX)).toBe(true);
  });

  it('denies an iframe asking for audio', () => {
    const input = appAudioRequest({ isMainFrame: false, requestingUrl: 'https://mic-test.example/' });
    expect(decidePermission(input, DEV_CTX)).toBe(false);
    // Even an iframe whose URL happens to share the app prefix is not the main frame.
    expect(decidePermission(appAudioRequest({ isMainFrame: false }), DEV_CTX)).toBe(false);
  });

  it('denies audio + video, video alone, and an empty media list', () => {
    expect(decidePermission(appAudioRequest({ mediaTypes: ['audio', 'video'] }), DEV_CTX)).toBe(false);
    expect(decidePermission(appAudioRequest({ mediaTypes: ['video'] }), DEV_CTX)).toBe(false);
    expect(decidePermission(appAudioRequest({ mediaTypes: [] }), DEV_CTX)).toBe(false);
  });

  it('denies a foreign webContents and a request before the window exists', () => {
    expect(decidePermission(appAudioRequest({ webContentsId: 99 }), DEV_CTX)).toBe(false);
    expect(decidePermission(appAudioRequest(), { ...DEV_CTX, appWebContentsId: null })).toBe(false);
  });

  it('denies a main frame that navigated away from the app document', () => {
    expect(decidePermission(appAudioRequest({ requestingUrl: 'https://evil/' }), DEV_CTX)).toBe(false);
    expect(decidePermission(appAudioRequest({ requestingUrl: undefined }), DEV_CTX)).toBe(false);
    // A different file:// document is not the packaged index.html.
    const other = 'file:///C:/Users/me/Downloads/evil.html';
    expect(decidePermission(appAudioRequest({ requestingUrl: other }), PROD_CTX)).toBe(false);
  });

  it('denies every non-media permission from the app main frame', () => {
    for (const permission of [
      'geolocation',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'display-capture',
      'midi',
      'midiSysex',
      'openExternal',
      'fileSystem',
      'hid',
      'usb',
      'serial',
      'unknown',
    ]) {
      expect(decidePermission(appAudioRequest({ permission }), DEV_CTX)).toBe(false);
    }
  });

  it('check handler parity: audio allowed, video / unknown / missing denied', () => {
    const check = (mediaType: string | undefined): PermissionInput => ({
      ...appAudioRequest(),
      mediaTypes: undefined,
      mediaType,
    });
    expect(decidePermission(check('audio'), DEV_CTX)).toBe(true);
    expect(decidePermission(check('video'), DEV_CTX)).toBe(false);
    expect(decidePermission(check('unknown'), DEV_CTX)).toBe(false);
    expect(decidePermission(check(undefined), DEV_CTX)).toBe(false);
    expect(decidePermission({ ...check('audio'), isMainFrame: false }, DEV_CTX)).toBe(false);
  });
});

describe('installPermissionHandlers — both handlers delegate to decidePermission', () => {
  type RequestHandler = (
    wc: { id: number } | null,
    permission: string,
    callback: (granted: boolean) => void,
    details: Record<string, unknown>,
  ) => void;
  type CheckHandler = (
    wc: { id: number } | null,
    permission: string,
    origin: string,
    details: Record<string, unknown>,
  ) => boolean;

  function install(): { request: RequestHandler; check: CheckHandler } {
    let request: RequestHandler | undefined;
    let check: CheckHandler | undefined;
    const fakeSession = {
      setPermissionRequestHandler: (h: RequestHandler) => {
        request = h;
      },
      setPermissionCheckHandler: (h: CheckHandler) => {
        check = h;
      },
    };
    installPermissionHandlers(
      fakeSession as unknown as Parameters<typeof installPermissionHandlers>[0],
      () => DEV_CTX,
    );
    if (!request || !check) throw new Error('handlers not registered');
    return { request, check };
  }

  function requestResult(
    request: RequestHandler,
    wc: { id: number } | null,
    permission: string,
    details: Record<string, unknown>,
  ): boolean | undefined {
    let granted: boolean | undefined;
    request(wc, permission, (g) => {
      granted = g;
    }, details);
    return granted;
  }

  it('grants the app audio request and denies everything else', () => {
    const { request, check } = install();
    const appFrame = { isMainFrame: true, requestingUrl: 'http://localhost:5173/' };
    expect(requestResult(request, { id: APP_ID }, 'media', { ...appFrame, mediaTypes: ['audio'] })).toBe(true);
    expect(requestResult(request, { id: APP_ID }, 'media', appFrame)).toBe(false);
    expect(requestResult(request, { id: APP_ID }, 'geolocation', appFrame)).toBe(false);
    expect(requestResult(request, null, 'media', { ...appFrame, mediaTypes: ['audio'] })).toBe(false);
    const iframe = { isMainFrame: false, requestingUrl: 'https://embedded.example/' };
    expect(requestResult(request, { id: APP_ID }, 'media', { ...iframe, mediaTypes: ['audio'] })).toBe(false);

    expect(check({ id: APP_ID }, 'media', 'http://localhost:5173', { ...appFrame, mediaType: 'audio' })).toBe(true);
    for (const perm of ['media', 'notifications', 'clipboard-read', 'geolocation', 'midi']) {
      expect(check({ id: APP_ID }, perm, 'https://embedded.example', { ...iframe, mediaType: 'audio' })).toBe(false);
    }
  });
});
