/**
 * TaskTitleEdit — a Task List row's title while it is being typed: the draft,
 * and when it is committed or dropped.
 *
 * Enter, the confirm button, clicking away and a save (Ctrl+S, close, quit)
 * commit it; Escape and the cancel button drop it. A save reaches the draft
 * through `registerComponentFlush`, so a title still in its box is handed to
 * the note before the save looks for unsaved work.
 */
import { registerComponentFlush } from '../boards/componentFlush';

export interface TaskTitleEditDeps {
  /** The task's title now. */
  title(): string;
  /** Renames the task (writes its note's `title:`). */
  rename(title: string): void;
}

export class TaskTitleEdit {
  editing = $state(false);
  draft = $state('');
  /** The title when editing began, to notice a rename made elsewhere meanwhile. */
  private titleAtStart = '';
  /** Set while a cancel runs, so the box's blur doesn't commit what was dropped. */
  private cancelling = false;

  constructor(private readonly deps: TaskTitleEditDeps) {
    this.draft = deps.title();
  }

  start(): void {
    this.draft = this.deps.title();
    this.titleAtStart = this.draft;
    this.editing = true;
  }

  /** Renames the task to the draft. One-shot: the blur that follows a commit finds nothing to do. */
  commit(): void {
    if (!this.editing) return;
    this.editing = false;
    const title = this.deps.title();
    // Renamed elsewhere while being typed: that title stands, the draft goes.
    if (title !== this.titleAtStart) return;
    const next = this.draft.trim();
    if (next && this.draft !== title) this.deps.rename(next);
  }

  cancel(): void {
    this.cancelling = true;
    this.editing = false;
    this.draft = this.deps.title();
    queueMicrotask(() => {
      this.cancelling = false;
    });
  }

  /** The box lost focus: commit, unless a cancel is what took it away. */
  blurred(): void {
    if (!this.cancelling) this.commit();
  }

  keydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commit();
    } else if (e.key === 'Escape') {
      this.cancel();
    }
  }

  /** While mounted, a save commits a title still being typed; returns the teardown. */
  track(): () => void {
    return registerComponentFlush('task title', () => this.commit());
  }
}
