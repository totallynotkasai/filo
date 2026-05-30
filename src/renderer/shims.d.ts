declare module 'js-yaml' {
  export function load(src: string, options?: unknown): unknown;
  export function dump(obj: unknown, options?: unknown): string;
  const _default: {
    load: typeof load;
    dump: typeof dump;
  };
  export default _default;
}

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
 * Vite-injected build-time flags. We only consume `DEV` (true in dev builds,
 * false in production) for the dev-only invariant guards — bringing in the
 * full `vite/client` reference would also pull glob-import / asset-URL types
 * we don't use.
 */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
