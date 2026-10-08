import { version } from '../../../package.json';

/**
 * This build's version, as `package.json` named it when the app was built
 * (electron-builder stamps the installer with the same field). Read at build
 * time, not from `app.getVersion()`: that returns Electron's own version when
 * the app is started from `dist/main/main.js`, as the E2E suite starts it.
 */
export const APP_VERSION: string = version;

/**
 * The commit this build was made from, `+` when it also held uncommitted
 * changes (stamped by `electron.vite.config.mts`). One version spans many
 * builds while a phase is under way; this tells them apart. "dev" where nothing
 * stamped it: the test runner, or a build without git.
 */
export const APP_COMMIT: string = typeof __FILO_COMMIT__ === 'string' ? __FILO_COMMIT__ : 'dev';

/** What the commit beside the version means, for its tooltip. */
export const APP_COMMIT_HINT: string =
  APP_COMMIT === 'dev'
    ? 'Built without a commit id'
    : APP_COMMIT.endsWith('+')
      ? `Built from commit ${APP_COMMIT.slice(0, -1)}, with changes not yet committed`
      : `Built from commit ${APP_COMMIT}`;
