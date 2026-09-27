/**
 * Counts theme applications. Anything that reads a theme colour off `:root`
 * (`getComputedStyle`) reads this first, so a `$derived` or `$effect` built on
 * that colour runs again when the theme changes. Without it, a colour worked
 * out under the old theme (black contrast text for a light tile) stays baked
 * into the view until it remounts.
 */
let version = $state(0);

export const themeVersion = {
  get value(): number {
    return version;
  },
  bump(): void {
    version++;
  },
};
