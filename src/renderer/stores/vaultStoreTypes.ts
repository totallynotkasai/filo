import type { FileTreeNode } from '../../shared/types';
import type { Project } from '../schema/index';

/**
 * Closure handed to each vault-store slice so it can read/write the
 * orchestrator's `$state` proxies without owning a parallel `$state`
 * declaration. Sliced helpers (`markMetaDirty`, `refreshTree`) are exposed
 * via the context so slice code never re-imports the orchestrator.
 */
export interface VaultContext {
  getVaultPath(): string;
  setVaultPath(next: string): void;
  getFileTree(): FileTreeNode[];
  setFileTree(next: FileTreeNode[]): void;
  getSearchQuery(): string;
  setSearchQuery(next: string): void;
  getIsLoading(): boolean;
  setIsLoading(next: boolean): void;
  getExpandedFolders(): Set<string>;
  setExpandedFolders(next: Set<string>): void;
  getSelectedPaths(): Set<string>;
  setSelectedPaths(next: Set<string>): void;
  getProject(): Project | null;
  setProject(next: Project | null): void;
  getRecoveryPendingPaths(): string[];
  setRecoveryPendingPaths(next: string[]): void;
  /**
   * Signal that the recovery-files modal was closed. The sequencer wired to
   * this resolver advances to the next pending recovery sentinel. No-op if no
   * sequencer is waiting.
   */
  resolveRecoveryDismissed(): void;
  markMetaDirty(): void;
  refreshTree(): Promise<void>;
  clearSelection(): void;
  clearActiveRootFolderIfMatches(deletedPath: string): void;
  /**
   * The orchestrator's serialised rename queue (arrival order + enqueue-time
   * vault-identity guard), so re-entrant external-change work (the partial-read
   * retry timer) can't race a concurrent rename's path rebind. Optional so test
   * `VaultContext` literals needn't stub it; the consumer falls back to a
   * direct call when absent.
   */
  enqueueRenameQueueWork?<T>(task: () => Promise<T>): Promise<T | undefined>;
}
