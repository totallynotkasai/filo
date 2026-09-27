/**
 * A vault's colour (General settings `vaultColor`, copied into
 * `recent-vaults.json` so Home can show it before the vault opens).
 *
 * Only `#rgb` / `#rrggbb` is kept. The value comes from a file another
 * program can edit and ends up in inline styles, so anything else reads as
 * "no colour" rather than reaching the page.
 */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function safeVaultColor(value: unknown): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : '';
}
