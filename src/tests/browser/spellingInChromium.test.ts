import { describe, it, expect, afterEach } from 'vitest';

/**
 * Spelling on or off reaches every text field through the page's own
 * `spellcheck` (AppShell sets it on <html>): a field that doesn't set its own
 * takes its nearest ancestor's, as the HTML spec has it. jsdom doesn't
 * implement that, so the engine Filo ships is asked here (a task's title box
 * and notes box kept their squiggles with Spelling off).
 */
afterEach(() => {
  document.documentElement.removeAttribute('spellcheck');
  document.body.innerHTML = '';
});

describe("a text field's spelling", () => {
  it("follows the page's when it sets none, and its own when it does", () => {
    const textarea = document.createElement('textarea');
    const input = document.createElement('input');
    const own = document.createElement('input');
    own.setAttribute('spellcheck', 'false');
    document.body.append(textarea, input, own);

    document.documentElement.setAttribute('spellcheck', 'false');
    expect(textarea.spellcheck).toBe(false);
    expect(input.spellcheck).toBe(false);

    document.documentElement.setAttribute('spellcheck', 'true');
    expect(textarea.spellcheck).toBe(true);
    expect(input.spellcheck).toBe(true);
    expect(own.spellcheck, 'a field that sets its own keeps it').toBe(false);
  });
});
