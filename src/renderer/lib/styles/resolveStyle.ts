/**
 * Style cascade resolver.
 *
 * Design Doc V5 §564–626 specifies a three-level override cascade for every
 * styled element on a board:
 *
 *   Per-element style > Current Board Settings > Global Defaults
 *
 * `resolveStyle` walks the three layers and returns the effective style. A
 * field is "set" iff it is not `undefined`, not `null`, and — for string
 * fields — not the empty string. Empty strings are the convention used
 * throughout Filo to mean "Auto / inherit from theme" so they MUST defer to
 * the next layer rather than win the cascade.
 *
 * The function is the single source of truth for style resolution. Every
 * renderer (tile, frame, kanban column, kanban card, task row, document
 * element) reads through here so that changing the cascade rules in one
 * place rebalances the whole app.
 */
export type StyleLayer = Record<string, unknown> | null | undefined;

function isSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value === '') return false;
  return true;
}

/**
 * Returns the effective value for a single key, walking the three layers
 * from most-specific (per-element) to least-specific (global default).
 */
export function resolveField<T = unknown>(
  key: string,
  perElement: StyleLayer,
  boardSettings: StyleLayer,
  globalDefaults: StyleLayer,
): T | undefined {
  if (perElement && isSet((perElement as Record<string, unknown>)[key])) {
    return (perElement as Record<string, unknown>)[key] as T;
  }
  if (boardSettings && isSet((boardSettings as Record<string, unknown>)[key])) {
    return (boardSettings as Record<string, unknown>)[key] as T;
  }
  if (globalDefaults && isSet((globalDefaults as Record<string, unknown>)[key])) {
    return (globalDefaults as Record<string, unknown>)[key] as T;
  }
  return undefined;
}

/**
 * Resolves an entire style object by walking every field across the three
 * layers. The returned object contains the union of keys from any layer; a
 * field is omitted only if every layer is unset.
 *
 * Note: deep nesting is intentionally not collapsed — pass the *flat* style
 * objects (e.g. `tile.style`, `boardSettings.tile`, `globalDefaults.tile`)
 * and the function resolves field-by-field. Nested groups (e.g. the kanban
 * `column` block under board defaults) should be drilled into by the caller
 * before passing to `resolveStyle`.
 */
export function resolveStyle<T extends Record<string, unknown>>(
  perElement: StyleLayer,
  boardSettings: StyleLayer,
  globalDefaults: StyleLayer,
): Partial<T> {
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const layer of [perElement, boardSettings, globalDefaults]) {
    if (!layer) continue;
    for (const key of Object.keys(layer)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const v = resolveField(key, perElement, boardSettings, globalDefaults);
      if (v !== undefined) out[key] = v;
    }
  }
  return out as Partial<T>;
}
