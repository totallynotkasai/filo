declare module 'js-yaml' {
  export function load(src: string, options?: unknown): unknown;
  export function dump(obj: unknown, options?: unknown): string;
  // Resolver schemas. Opaque handles passed through to `load`'s `options.schema`
  // (which is already `unknown`). Audit-4 DI-01 reads frontmatter with
  // CORE_SCHEMA so the parsed object matches the `yaml`-package serializer.
  export const DEFAULT_SCHEMA: unknown;
  export const CORE_SCHEMA: unknown;
  export const JSON_SCHEMA: unknown;
  export const FAILSAFE_SCHEMA: unknown;
  const _default: {
    load: typeof load;
    dump: typeof dump;
    DEFAULT_SCHEMA: unknown;
    CORE_SCHEMA: unknown;
    JSON_SCHEMA: unknown;
    FAILSAFE_SCHEMA: unknown;
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
 * Vite-injected build-time flags. We consume `DEV` (true in dev builds, false in
 * production) for the dev-only invariant guards, plus `MODE` (the literal build
 * mode: `'development'` under `npm run dev`, `'production'` for a packaged build,
 * `'test'` under vitest) so a dev-only tripwire can stay silent in the test
 * runner (Audit-14 6.2). Bringing in the full `vite/client` reference would also
 * pull glob-import / asset-URL types we don't use.
 */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
