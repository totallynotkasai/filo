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

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
