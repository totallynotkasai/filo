/**
 * The Raw view's text field in a component test: its CodeMirror view, found
 * from the DOM the component renders, so a test reads and types through the
 * real field.
 */
import { EditorView } from '@codemirror/view';
import { settle } from './mountEditor';

/** The view inside `root` once the note has loaded into it (its host stops being `aria-busy`). */
export async function loadedRawView(root: ParentNode): Promise<EditorView> {
  for (let i = 0; i < 100; i++) {
    const host = root.querySelector('.raw-text');
    const dom = host?.querySelector('.cm-editor');
    if (host?.getAttribute('aria-busy') === 'false' && dom instanceof HTMLElement) {
      const view = EditorView.findFromDOM(dom);
      if (view) return view;
    }
    await settle();
  }
  throw new Error('the raw view never loaded');
}

/** Replaces the whole text as typing does: a user change, not a reload. */
export function typeOver(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' });
}

/** The text the selection covers. */
export function selectedText(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return view.state.sliceDoc(from, to);
}
