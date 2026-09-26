/**
 * A board's name and emoji, changed from its tab or the Board Browser.
 *
 * The `.board.json` is the only copy that lasts. The project's board list
 * (sidebar, Board Browser, search) and every open tab showing the board hold
 * copies for display, so each change updates all of them at once; changing a
 * copy alone looks right until the vault is reopened.
 */
import { boardCacheStore } from './boardCache.svelte';
import { tabStore } from './tabs.svelte';
import { vaultStore } from './vault.svelte';

export function renameBoard(boardId: string, name: string): void {
  const next = name.trim();
  if (!next) return;
  boardCacheStore.updateBoardIdentity(boardId, { name: next });
  const listed = vaultStore.project?.boards.find((b) => b.id === boardId);
  if (listed) listed.name = next;
  for (const tab of tabStore.tabs) {
    if (tab.boardId === boardId) tabStore.rename(tab.id, next);
  }
}

export function setBoardEmoji(boardId: string, emoji: string): void {
  boardCacheStore.updateBoardIdentity(boardId, { emoji });
  const listed = vaultStore.project?.boards.find((b) => b.id === boardId);
  if (listed) listed.emoji = emoji;
  for (const tab of tabStore.tabs) {
    if (tab.boardId === boardId) tabStore.setEmoji(tab.id, emoji);
  }
}
