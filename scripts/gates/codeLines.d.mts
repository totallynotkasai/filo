// Types for codeLines.mjs, so the unit tests import it type-checked.

/** The lines of `text` holding code. `svelte` scans markup, `<script>` and `<style>` apart. */
export function countCodeLines(text: string, options?: { svelte?: boolean }): number;

/** JS / TS with every comment turned to spaces (newlines kept). */
export function maskScript(src: string): string;

/** CSS with every block comment turned to spaces. */
export function maskStyle(src: string): string;

/** A Svelte component with its markup, script and style comments turned to spaces. */
export function maskSvelte(src: string): string;
