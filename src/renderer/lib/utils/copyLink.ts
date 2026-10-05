import { uiStore } from '../../stores/ui.svelte';

/**
 * Puts text on the clipboard. Main writes it (`shell:copy-text`): the
 * permission policy denies the page's own clipboard writes.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    return (await window.filo.invoke('shell:copy-text', text)) === true;
  } catch {
    return false;
  }
}

/**
 * Puts a `filo://` link on the clipboard, as the address and as a link named
 * `label`: pasted into a note it is a link reading `label`, and pasted into
 * Insert Link's address box (or anywhere else) it is the address.
 */
export async function copyFiloLink(href: string, label: string): Promise<void> {
  const name = label.trim() || href;
  let copied = false;
  try {
    copied = (await window.filo.invoke('shell:copy-text', href, name)) === true;
  } catch {
    copied = false;
  }
  if (copied) uiStore.toast(`Link to "${name}" copied. Paste it into a note, or into Insert Link (Ctrl+K).`, 'success', 4000);
  else uiStore.toast(`Couldn't copy the link to "${name}".`, 'error', 4000);
}
