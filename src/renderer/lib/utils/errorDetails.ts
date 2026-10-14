import type { ReportedError } from './errorBus';
import { copyText } from './copyLink';
import { uiStore } from '../../stores/ui.svelte';
import { APP_COMMIT, APP_VERSION } from '../../constants/appVersion';

/**
 * An error toast's "Copy details": everything the toast summarises, as text
 * to paste into a bug report. The installed app has no console a user can
 * read without turning on the developer tools, so this is where an error's
 * own words (its message, stack and cause) reach the user.
 */

/** One report a toast stands for, and when it came. */
export interface TimedReport {
  report: ReportedError;
  at: number;
}

/** How deep a chain of `cause`s is followed. */
const MAX_CAUSE_DEPTH = 3;

/** The thrown value as text: an Error's stack (or name and message), its code and cause. */
export function describeThrown(error: unknown, depth = 0): string {
  if (error instanceof Error) {
    const head = `${error.name}: ${error.message}`;
    // V8's stack opens with the name and message; another engine's, or one
    // set by hand, may not.
    const stack = error.stack?.trimEnd() ?? '';
    const lines = [stack.trim() === '' ? head : stack.includes(error.message) ? stack : `${head}\n${stack}`];
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') lines.push(`Code: ${code}`);
    if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) lines.push(`Caused by: ${describeThrown(error.cause, depth + 1)}`);
    return lines.join('\n');
  }
  if (typeof error === 'string') return error;
  if (error === undefined) return '(no error value)';
  try {
    return JSON.stringify(error, null, 2) ?? String(error);
  } catch {
    return String(error);
  }
}

/** The text Copy details puts on the clipboard. */
export function errorDetailsText(reports: readonly TimedReport[], build: { version: string; commit: string }): string {
  const lines = [`Filo ${build.version} (${build.commit})`];
  reports.forEach(({ report, at }, i) => {
    lines.push('');
    if (reports.length > 1) lines.push(`Error ${i + 1} of ${reports.length}`);
    lines.push(`Time: ${new Date(at).toISOString()}`);
    lines.push(`Where: ${report.context}`);
    if (report.message) lines.push(`Message: ${report.message}`);
    if (report.path) lines.push(`File: ${report.path}`);
    lines.push(describeThrown(report.error));
  });
  return lines.join('\n');
}

/** Copies a toast's reports and says whether it worked. */
export async function copyErrorDetails(reports: readonly TimedReport[]): Promise<void> {
  const copied = await copyText(errorDetailsText(reports, { version: APP_VERSION, commit: APP_COMMIT }));
  if (copied) uiStore.toast('Error details copied. Paste them into a note or a bug report.', 'success', 4000);
  else uiStore.toast("Couldn't copy the error details.", 'error', 4000);
}
