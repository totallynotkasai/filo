/**
 * The EyeDropper API ships in Chromium-based browsers (Electron) but
 * isn't in lib.dom yet. Feature-detect with `'EyeDropper' in window`
 * before constructing.
 */
interface EyeDropperResult {
  sRGBHex: string;
}
interface EyeDropper {
  open(): Promise<EyeDropperResult>;
}
interface EyeDropperConstructor {
  new (): EyeDropper;
}
interface Window {
  EyeDropper?: EyeDropperConstructor;
}

/**
 * Vite-injected build-time flags. We consume `DEV` (true in dev builds, false in
 * production) for the dev-only invariant guards. Bringing in the full
 * `vite/client` reference would also pull glob-import / asset-URL types we
 * don't use.
 */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Global stylesheets are imported for their side effect (`import '../css/style.css'`
 * in main.ts). TypeScript 6 enables `noUncheckedSideEffectImports` by default, which
 * requires a declaration for side-effect imports; Vite handles the actual CSS.
 */
declare module '*.css';
