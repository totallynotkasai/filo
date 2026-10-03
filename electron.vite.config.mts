import { defineConfig } from 'electron-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * The editors' dependencies, pre-bundled when the dev server starts. The
 * boards and the Raw view that use them are lazy chunks, so without this Vite
 * can find them only when one first opens, then re-optimises and reloads the
 * page. Read from package.json so a new TipTap extension or CodeMirror package
 * is covered without an edit here. `@tiptap/pm` has no root entry, so its
 * subpaths are named.
 */
function editorDepsToPrebundle(): string[] {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>;
  };
  const names = Object.keys(pkg.dependencies ?? {});
  const tiptap = names.filter((name) => name.startsWith('@tiptap/') && name !== '@tiptap/pm');
  const codemirror = names.filter((name) => name.startsWith('@codemirror/') || name.startsWith('@lezer/'));
  return [
    ...tiptap,
    ...codemirror,
    '@tiptap/pm/model',
    '@tiptap/pm/state',
    '@tiptap/pm/view',
    'tiptap-markdown',
    'lowlight',
  ];
}

export default defineConfig({
  main: {
    // Bundle `zod` INTO dist/main rather than leaving it an
    // external runtime `require('zod')`. Packaging then carries no runtime
    // node_modules dependency for it (electron-builder 26's module collector
    // *should* find an externalized zod, but bundling removes that reliance
    // entirely — zod is tiny).
    build: {
      externalizeDeps: { exclude: ['zod'] },
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/main/main.ts'),
        },
      },
    },
  },
  preload: {
    // zod bundled in, as for main.
    build: {
      externalizeDeps: { exclude: ['zod'] },
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'src/main/preload.ts'),
        },
      },
    },
  },
  renderer: {
    plugins: [
      svelte(),
      // Strip dev-only `ws://localhost:*` from the
      // Content-Security-Policy `connect-src` directive in production
      // builds. The single `index.html` still ships with the dev-friendly
      // CSP so `npm run dev` can talk to Vite's HMR socket; this plugin
      // patches it during `npm run build` so the packaged artifact's CSP
      // doesn't authorise localhost websocket connections we never make
      // in production.
      {
        name: 'filo-strip-dev-csp',
        apply: 'build',
        transformIndexHtml(html) {
          return html
            .replace(/\s*ws:\/\/localhost:\*/g, '')
            // Collapse any double spaces the strip introduced inside the
            // CSP value so the meta tag stays clean.
            .replace(/connect-src 'self'\s+;/, "connect-src 'self';");
        },
      },
    ],
    root: '.',
    optimizeDeps: {
      include: editorDepsToPrebundle(),
    },
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
        },
        output: {
          // Split heavy third-party deps into their own
          // chunks so the main app bundle drops from a ~4.9 MB monolith
          // toward something the V8 parser can chew through faster on
          // initial paint. Each chunk is cacheable independently of app
          // code, so subsequent launches re-validate small diffs instead
          // of the whole renderer bundle. Order-of-magnitude breakdown:
          //   • tiptap-core    ~1.0 MB (TipTap + ProseMirror)
          //   • lowlight       ~400 KB (syntax highlighting languages)
          //   • codemirror     the Raw view's editor, fetched only when a
          //                    Raw view first opens
          // Per Vite docs, `manualChunks` runs only on the production
          // build — `npm run dev` still uses ESM dynamic imports.
          manualChunks: (id: string) => {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('prosemirror') || id.includes('@tiptap') || id.includes('tiptap-')) {
              return 'tiptap';
            }
            if (id.includes('lowlight') || id.includes('highlight.js')) {
              return 'lowlight';
            }
            if (
              id.includes('@codemirror') ||
              id.includes('@lezer') ||
              id.includes('style-mod') ||
              id.includes('crelt') ||
              id.includes('@marijn')
            ) {
              return 'codemirror';
            }
            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
});
