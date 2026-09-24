/**
 * jsdom has no layout engine. The app shell asks for observers, media queries
 * and client rects; answer with inert, zero-sized versions so the real
 * components mount headless. Nothing here changes what gets written to disk.
 */
class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.ResizeObserver === 'undefined') g.ResizeObserver = InertObserver;
if (typeof g.IntersectionObserver === 'undefined') g.IntersectionObserver = InertObserver;

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

const zeroRect = (): DOMRect =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
function rectList(rects: DOMRect[]): DOMRectList {
  return Object.assign(rects, { item: (i: number) => rects[i] ?? null }) as unknown as DOMRectList;
}
// An element reports one (zero-sized) box, so focus-trap's visibility check
// counts a rendered dialog's buttons as tabbable; a text range reports none.
Element.prototype.getClientRects = () => rectList([zeroRect()]);
if (typeof Element.prototype.getBoundingClientRect !== 'function') Element.prototype.getBoundingClientRect = zeroRect;
const rangeProto = Range.prototype as { getClientRects?: unknown; getBoundingClientRect?: unknown };
if (typeof rangeProto.getClientRects !== 'function') rangeProto.getClientRects = () => rectList([]);
if (typeof rangeProto.getBoundingClientRect !== 'function') rangeProto.getBoundingClientRect = zeroRect;
if (typeof document.elementFromPoint !== 'function') {
  (document as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => null;
}
if (typeof Element.prototype.scrollIntoView !== 'function') Element.prototype.scrollIntoView = () => {};
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
}

// jsdom's <dialog> has no showModal/show/close.
const dialogProto = (globalThis as unknown as { HTMLDialogElement?: { prototype: HTMLDialogElement } }).HTMLDialogElement?.prototype;
if (dialogProto && typeof dialogProto.showModal !== 'function') {
  dialogProto.show = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  dialogProto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  dialogProto.close = function (this: HTMLDialogElement, returnValue?: string) {
    if (!this.hasAttribute('open')) return;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
