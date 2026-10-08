/**
 * Dragging a table column's border in a zoomed note.
 *
 * prosemirror-tables adds the pointer's movement, in screen pixels, to the
 * column's width in the note's own pixels. Under the Document tab's zoom (CSS
 * `zoom`, `DocumentEditor.svelte`) the two differ, so the border ran ahead of
 * the pointer at 150% and lagged it at 75%. While the editor is zoomed, this
 * plugin takes the drag in the library's place, with the movement divided by
 * the zoom; at 100% the library's own drag runs. It must come before the
 * library's `columnResizing` plugin, which it reads and drives through its
 * exported state (`columnResizingPluginKey`).
 */
import { Plugin } from '@tiptap/pm/state';
import type { ResolvedPos } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { columnResizingPluginKey, TableMap, updateColumnsOnResize } from '@tiptap/pm/tables';

/** How much larger the editor is drawn than its own pixels: 1.5 at 150%, 1 at 100% (or when it can't be measured). */
export function editorZoom(view: EditorView): number {
  const dom = view.dom as HTMLElement;
  const own = dom.offsetWidth;
  if (!own) return 1;
  const zoom = dom.getBoundingClientRect().width / own;
  // offsetWidth is whole pixels: a ratio this close to 1 is 100%.
  return Number.isFinite(zoom) && zoom > 0 && Math.abs(zoom - 1) > 0.01 ? zoom : 1;
}

/** The new width, in the note's own pixels, for a drag from `startX` to `clientX` (screen pixels) at `zoom`. */
export function zoomedDragWidth(startWidth: number, startX: number, clientX: number, zoom: number, minWidth: number): number {
  return Math.max(minWidth, startWidth + (clientX - startX) / zoom);
}

/** The cell a resize handle at `cellPos` belongs to, and the column it moves: the cell's last. */
function handleColumn(view: EditorView, cellPos: number): { $cell: ResolvedPos; col: number } {
  const $cell = view.state.doc.resolve(cellPos);
  const col = TableMap.get($cell.node(-1)).colCount($cell.pos - $cell.start(-1)) + ($cell.nodeAfter?.attrs.colspan as number) - 1;
  return { $cell, col };
}

/** The width the column starts at: its set width, else as drawn (as the library measures it). */
function startWidth(view: EditorView, cellPos: number): number {
  const attrs = view.state.doc.nodeAt(cellPos)?.attrs as { colspan: number; colwidth: number[] | null } | undefined;
  if (!attrs) return 0;
  const set = attrs.colwidth?.[attrs.colwidth.length - 1];
  if (set) return set;
  const dom = view.domAtPos(cellPos);
  let width = (dom.node.childNodes[dom.offset] as HTMLElement | undefined)?.offsetWidth ?? 0;
  let parts = attrs.colspan;
  for (const w of attrs.colwidth ?? []) {
    if (w) {
      width -= w;
      parts--;
    }
  }
  return parts > 0 ? width / parts : width;
}

/** Shows the column at `width` while the drag runs (no transaction, as the library does). */
function showWidth(view: EditorView, cellPos: number, width: number, minWidth: number): void {
  const { $cell, col } = handleColumn(view, cellPos);
  let dom: Node | null = view.domAtPos($cell.start(-1)).node;
  while (dom && dom.nodeName !== 'TABLE') dom = dom.parentNode;
  if (!dom || !dom.firstChild) return;
  updateColumnsOnResize($cell.node(-1), dom.firstChild as HTMLTableColElement, dom as HTMLTableElement, minWidth, col, width);
}

/** Sets the column's width on every cell of it (one transaction, one undo step). */
function setWidth(view: EditorView, cellPos: number, width: number): void {
  const { $cell, col } = handleColumn(view, cellPos);
  const table = $cell.node(-1);
  const map = TableMap.get(table);
  const start = $cell.start(-1);
  const tr = view.state.tr;
  for (let row = 0; row < map.height; row++) {
    const index = row * map.width + col;
    if (row && map.map[index] === map.map[index - map.width]) continue;
    const pos = map.map[index]!;
    const attrs = table.nodeAt(pos)!.attrs as { colspan: number; colwidth: number[] | null };
    const at = attrs.colspan === 1 ? 0 : col - map.colCount(pos);
    if (attrs.colwidth && attrs.colwidth[at] === width) continue;
    const colwidth = attrs.colwidth ? attrs.colwidth.slice() : Array<number>(attrs.colspan).fill(0);
    colwidth[at] = width;
    tr.setNodeMarkup(start + pos, null, { ...attrs, colwidth });
  }
  if (tr.docChanged) view.dispatch(tr);
}

export function zoomedColumnDrag(cellMinWidth: number): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        mousedown: (view, event) => {
          if (!view.editable) return false;
          const handle = columnResizingPluginKey.getState(view.state);
          if (!handle || handle.activeHandle === -1 || handle.dragging) return false;
          const zoom = editorZoom(view);
          if (zoom === 1) return false;
          const cellPos = handle.activeHandle;
          const from = startWidth(view, cellPos);
          const startX = event.clientX;
          const win = view.dom.ownerDocument.defaultView ?? window;
          // The library's state says a drag runs: its handle stays drawn, and
          // its own mousedown and mousemove leave the column alone meanwhile.
          view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: { startX, startWidth: from } }));
          const widthAt = (e: MouseEvent): number => zoomedDragWidth(from, startX, e.clientX, zoom, cellMinWidth);
          const finish = (e: MouseEvent): void => {
            win.removeEventListener('mouseup', finish);
            win.removeEventListener('mousemove', move);
            if (!columnResizingPluginKey.getState(view.state)?.dragging) return;
            setWidth(view, cellPos, widthAt(e));
            view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: null }));
          };
          const move = (e: MouseEvent): void => {
            if (!e.buttons) {
              finish(e);
              return;
            }
            if (columnResizingPluginKey.getState(view.state)?.dragging) showWidth(view, cellPos, widthAt(e), cellMinWidth);
          };
          showWidth(view, cellPos, from, cellMinWidth);
          win.addEventListener('mouseup', finish);
          win.addEventListener('mousemove', move);
          event.preventDefault();
          return true;
        },
      },
    },
  });
}
