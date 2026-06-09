import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  main: {
    // Audit-14 6.3 — bundle `zod` INTO dist/main rather than leaving it an
    // external runtime `require('zod')`. Packaging then carries no runtime
    // node_modules dependency for it (electron-builder 26's module collector
    // *should* find an externalized zod, but bundling removes that reliance
    // entirely — zod is tiny). `nanoid` was the previous exclude but it is
    // never imported in the main process, so excluding it was a no-op.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/main/main.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
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
      // Sprint B / B23 — strip dev-only `ws://localhost:*` from the
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
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
        },
        output: {
          // Phase 40 / 40.6 — split heavy third-party deps into their own
          // chunks so the main app bundle drops from a ~4.9 MB monolith
          // toward something the V8 parser can chew through faster on
          // initial paint. Each chunk is cacheable independently of app
          // code, so subsequent launches re-validate small diffs instead
          // of the whole renderer bundle. Order-of-magnitude breakdown:
          //   • tiptap-core    ~1.0 MB (TipTap + ProseMirror)
          //   • lowlight       ~400 KB (syntax highlighting languages)
          //   • markdown-tools ~150 KB (gray-matter, remark, js-yaml)
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
              id.includes('gray-matter') ||
              id.includes('js-yaml') ||
              id.includes('/remark') ||
              id.includes('mdast') ||
              id.includes('micromark') ||
              id.includes('unified') ||
              id.includes('unist-')
            ) {
              return 'markdown-tools';
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
