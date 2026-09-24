// Global stylesheets must be imported here so Vite includes them in BOTH
// dev (HMR-served from /src/css/*.css) and prod (bundled into the renderer
// CSS asset). Without these imports, `:root[data-theme='X']` blocks and
// non-component rules like `.skip-link` never load — `--ui-bg` /
// `--canvas-bg` resolve to nothing and the skip-link sits visible in the
// top-left because its `transform: translateY(-100%)` never applies.
// (Svelte component-scoped <style> blocks ARE picked up automatically;
// only the standalone .css files need an explicit import.)
import '../css/style.css';
import '../css/conn.css';

// Eagerly load the BoardScope composer at the app entry. The four store
// facades (boardStore, canvasStore, selectionStore, spatialStore) lazily
// request a default scope on first access via `getActiveScope`; this import
// makes sure the composer has been registered before that happens.
import './lib/boards/boardScopeFactory';

import { mount } from 'svelte';
import App from './App.svelte';
import { reportError } from './lib/utils/errorBus';

// Renderer-wide backstops for unknown-unknowns. Write paths already route
// their failures through trackComponentWrite /
// markPathFailed, but a programming error in a `void`-ed chain or an event
// handler otherwise dies as a console-only unhandled rejection. Routing
// through reportError feeds App.svelte's coalescing errorToastAggregator
// (rate-limited, count-badged), so a rejection storm collapses into one
// toast per context instead of spamming the stack. Registered before mount;
// reports that fire before App.svelte subscribes still hit the console via
// reportError's breadcrumb.
window.addEventListener('unhandledrejection', (event) => {
  reportError('unhandledrejection', event.reason, 'An unexpected background task failed.');
});
window.addEventListener('error', (event) => {
  reportError('window.onerror', event.error ?? event.message, 'An unexpected error occurred.');
});

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
