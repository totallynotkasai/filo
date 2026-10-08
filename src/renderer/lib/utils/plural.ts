/**
 * A count and its word, as a message says it: "1 tile", "3 tiles",
 * "2 matches". Every message that names a count goes through here, so none
 * reads "tile(s)".
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
