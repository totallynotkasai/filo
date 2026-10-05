import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_FONT, fontFamilyValue, fontFromStack, fontStack } from '../../shared/fontStack';
import { GENERAL_SETTINGS_DEFAULTS } from '../../shared/generalSettingsDefaults';
import { ProjectSettingsSchema } from '../../renderer/schema/index';

describe('fontStack', () => {
  it('puts the chosen font first, then Arial and the generic fallbacks', () => {
    expect(fontStack('Georgia')).toBe("'Georgia', 'Arial', system-ui, sans-serif");
    expect(fontStack('Arial Rounded MT')).toBe("'Arial Rounded MT', 'Arial', system-ui, sans-serif");
  });

  it('does not name Arial twice when Arial is the choice', () => {
    expect(fontStack('Arial')).toBe("'Arial', system-ui, sans-serif");
    expect(fontStack('arial')).toBe("'arial', system-ui, sans-serif");
  });

  it('leaves a generic family unquoted', () => {
    expect(fontStack('monospace')).toBe("monospace, 'Arial', system-ui, sans-serif");
  });

  it('escapes a quote in a font name', () => {
    expect(fontStack("Bob's Font")).toBe("'Bob\\'s Font', 'Arial', system-ui, sans-serif");
  });
});

describe('fontFromStack', () => {
  it('reads back the font a stack was built for', () => {
    for (const font of ['Arial Rounded MT', 'Georgia', 'Arial', "Bob's Font", 'monospace']) {
      expect(fontFromStack(fontStack(font))).toBe(font);
    }
  });

  it('reads stacks written by hand or by older versions', () => {
    expect(fontFromStack('Inter, system-ui, sans-serif')).toBe('Inter');
    expect(fontFromStack('"Segoe UI", sans-serif')).toBe('Segoe UI');
    expect(fontFromStack('  Courier New  ')).toBe('Courier New');
    expect(fontFromStack('')).toBe('');
  });
});

describe('fontFamilyValue (a font the toolbar sets on text)', () => {
  it('leaves a name CSS reads bare as it is, so notes keep their spelling', () => {
    expect(fontFamilyValue('Georgia')).toBe('Georgia');
    expect(fontFamilyValue('Arial Rounded MT')).toBe('Arial Rounded MT');
    expect(fontFamilyValue('Cinzel-Regular')).toBe('Cinzel-Regular');
    expect(fontFamilyValue(' Times New Roman ')).toBe('Times New Roman');
  });

  it('quotes a name that starts with a digit, or holds a comma, brackets or a keyword', () => {
    expect(fontFamilyValue('28 Days Later')).toBe("'28 Days Later'");
    expect(fontFamilyValue('1942 report')).toBe("'1942 report'");
    expect(fontFamilyValue('Lora[wght]')).toBe("'Lora[wght]'");
    expect(fontFamilyValue('Roboto-VariableFont_wdth,wght')).toBe("'Roboto-VariableFont_wdth,wght'");
    expect(fontFamilyValue('My Default')).toBe("'My Default'");
    expect(fontFamilyValue("Bob's Font")).toBe("'Bob\\'s Font'");
  });

  it('reads back as the font through fontFromStack', () => {
    for (const font of ['28 Days Later', 'Lora[wght]', 'Georgia', "Bob's Font"]) {
      expect(fontFromStack(fontFamilyValue(font))).toBe(font);
    }
  });
});

describe('the default font', () => {
  it('is Arial Rounded MT, with an Arial fallback, in the settings default', () => {
    expect(DEFAULT_FONT).toBe('Arial Rounded MT');
    expect(ProjectSettingsSchema.parse({}).general.globalFont).toBe(fontStack(DEFAULT_FONT));
  });

  it('is also the first-paint font in style.css, before a vault loads', () => {
    const css = readFileSync(join(process.cwd(), 'src/css/style.css'), 'utf-8');
    expect(css).toContain(`--font-system: ${fontStack(DEFAULT_FONT)};`);
  });

  it('heads the default font list, which no longer offers the unbundled Inter', () => {
    expect(GENERAL_SETTINGS_DEFAULTS.systemFonts[0]).toBe(DEFAULT_FONT);
    expect(GENERAL_SETTINGS_DEFAULTS.systemFonts).not.toContain('Inter');
  });
});
