/**
 * Characterisation-suite setup: the main-process code under test imports
 * `electron`, so it gets the fake shell (see harness/electronFake.ts); jsdom
 * gets the layout stand-ins the app shell needs; and a runaway editor loop
 * fails the test instead of hanging the run.
 */
import { vi, beforeEach } from 'vitest';
import './harness/domPolyfills';
import { installEditorLoopBreaker, resetEditorLoopBreaker } from '../helpers/editorLoopBreaker';

vi.mock('electron', async () => {
  const { electronFake } = await import('./harness/electronFake');
  return { ...electronFake, default: electronFake };
});

installEditorLoopBreaker();
beforeEach(() => {
  resetEditorLoopBreaker();
});
