import { describe, it, expect } from 'vitest';
import { localeIsDayFirst } from '@renderer/lib/tasks/dateOrder';
import { systemLocaleFromArgv } from '@shared/systemLocale';

describe('localeIsDayFirst', () => {
  it('en-GB is day-first', () => {
    expect(localeIsDayFirst('en-GB')).toBe(true);
  });

  it('en-US is month-first', () => {
    expect(localeIsDayFirst('en-US')).toBe(false);
  });

  it('de-DE is day-first', () => {
    expect(localeIsDayFirst('de-DE')).toBe(true);
  });

  it('an invalid locale tag falls back to month-first instead of throwing', () => {
    expect(localeIsDayFirst('not a locale!!')).toBe(false);
  });
});

describe('systemLocaleFromArgv', () => {
  it('reads the locale main passed as a process argument', () => {
    expect(systemLocaleFromArgv(['electron', '--type=renderer', '--filo-system-locale=en-GB'])).toBe('en-GB');
  });

  it('is empty when the argument is missing or not a locale tag', () => {
    expect(systemLocaleFromArgv(['electron'])).toBe('');
    expect(systemLocaleFromArgv(['--filo-system-locale='])).toBe('');
    expect(systemLocaleFromArgv(['--filo-system-locale=en GB;x'])).toBe('');
  });
});
