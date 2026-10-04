import { version } from '../../../package.json';

/**
 * This build's version, as `package.json` named it when the app was built
 * (electron-builder stamps the installer with the same field). Read at build
 * time, not from `app.getVersion()`: that returns Electron's own version when
 * the app is started from `dist/main/main.js`, as the E2E suite starts it.
 */
export const APP_VERSION: string = version;
