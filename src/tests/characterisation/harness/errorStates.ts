/**
 * Error-state drivers for the characterisation suite: the Document tab's
 * banners, a tile's broken-reference menu, a media tile that won't load, and
 * where Show in folder pointed.
 */
import type { CharApp } from './app';
import { quiesce, settle, waitFor } from './app';
import { $$, chooseMenuItem, click, findByText } from './actions';
import { shownInFolder } from './electronFake';

/** The Document tab's banner texts (read-only, missing, unreadable…). */
export function documentBanners(app: CharApp): string[] {
  return $$(app.el, '.document-board .readonly-banner .readonly-text').map((t) => (t.textContent ?? '').trim());
}

/** Labels of the buttons on the Document tab's banners. */
export function documentBannerActions(app: CharApp): string[] {
  return $$(app.el, '.document-board .readonly-banner .readonly-action').map((b) => (b.textContent ?? '').trim());
}

/** Click the Document-tab banner button labelled `label`. */
export async function chooseDocumentBannerAction(app: CharApp, label: string): Promise<void> {
  await waitFor(() => findByText(app.el, '.document-board .readonly-banner .readonly-action', label) !== null, `banner button "${label}"`);
  click(findByText(app.el, '.document-board .readonly-banner .readonly-action', label) as HTMLElement);
  await quiesce(1000);
}

/** Whether a tile shows the broken-reference badge. */
export function brokenBadgeShown(tileRoot: HTMLElement): boolean {
  return tileRoot.querySelector('.tile-broken-badge-inline') !== null;
}

/** The labels of a broken tile's quick-action menu (the menu is left open). */
export async function brokenTileMenuLabels(app: CharApp, tileRoot: HTMLElement): Promise<string[]> {
  await waitFor(() => brokenBadgeShown(tileRoot), 'the broken-reference badge');
  click(tileRoot.querySelector('.tile-broken-badge-inline') as HTMLElement);
  await settle();
  return $$(app.el, '.context-menu .menu-item, .context-menu [role="menuitem"]').map((b) => (b.textContent ?? '').trim());
}

/** Broken tile badge → `label`. */
export async function chooseBrokenTileAction(app: CharApp, tileRoot: HTMLElement, label: string): Promise<void> {
  await brokenTileMenuLabels(app, tileRoot);
  await chooseMenuItem(app, label);
  await quiesce(1000);
}

/** The files the Re-link picker offers. */
export async function relinkChoices(): Promise<string[]> {
  await waitFor(() => document.querySelector('.relink-body') !== null, 'the Re-link picker');
  return $$(document, '.relink-list .relink-item').map((b) => (b.textContent ?? '').trim());
}

/** The browser fails to load a media tile's file, as it does for a file that isn't there. */
export async function mediaFailsToLoad(tileRoot: HTMLElement): Promise<void> {
  const media = tileRoot.querySelector('img, video, audio');
  if (!media) throw new Error('no media element in the tile');
  media.dispatchEvent(new Event('error'));
  await settle(100);
}

/** The load error a media tile shows, or '' when none. */
export function mediaErrorShown(tileRoot: HTMLElement): string {
  const shown = tileRoot.querySelector('.load-error span:not(.load-error-path), .playback-error');
  return (shown?.textContent ?? '').trim();
}

/** Every path the app asked the OS to show in a folder window, oldest first. */
export function shownInFolderPaths(): string[] {
  return [...shownInFolder];
}
