/**
 * js-yaml ships no types. Only tests use it, as an independent YAML oracle
 * (the app parses frontmatter with the `yaml` package alone; gate `no-jsyaml`),
 * so the declaration lives with the tests, not in the renderer type space.
 */
declare module 'js-yaml' {
  export function load(src: string, options?: unknown): unknown;
  export function dump(obj: unknown, options?: unknown): string;
  // Resolver schemas. Opaque handles passed through to `load`'s `options.schema`
  // (which is already `unknown`).
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
