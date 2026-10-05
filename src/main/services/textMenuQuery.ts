/**
 * Asks the renderer, as a right-click menu on text is about to open, whether
 * a link can go where the caret is (`app:text-menu-query`, answered by
 * `app:text-menu-reply`). Only the renderer knows which editor has the focus.
 * It answers at once; a menu waits at most `timeoutMs` for it, then opens
 * without the link item.
 */
import { asTextMenuContext, NO_LINK, type TextMenuContext } from '../utils/textMenu';

interface QueryTarget {
  readonly id: number;
  send(channel: 'app:text-menu-query', id: number): void;
}

export interface TextMenuQuery {
  ask(target: QueryTarget): Promise<TextMenuContext>;
  /** A reply from the renderer; one from any page but the one asked is ignored. */
  onReply(senderId: number, id: unknown, value: unknown): void;
}

export function createTextMenuQuery(timeoutMs: number): TextMenuQuery {
  let nextId = 0;
  const pending = new Map<number, { target: QueryTarget; settle: (context: TextMenuContext) => void }>();

  return {
    ask(target) {
      const id = ++nextId;
      return new Promise<TextMenuContext>((resolve) => {
        const timer = setTimeout(() => settle(NO_LINK), timeoutMs);
        function settle(context: TextMenuContext): void {
          clearTimeout(timer);
          pending.delete(id);
          resolve(context);
        }
        pending.set(id, { target, settle });
        try {
          target.send('app:text-menu-query', id);
        } catch {
          settle(NO_LINK);
        }
      });
    },
    onReply(senderId, id, value) {
      if (typeof id !== 'number') return;
      const entry = pending.get(id);
      if (!entry || entry.target.id !== senderId) return;
      entry.settle(asTextMenuContext(value));
    },
  };
}
