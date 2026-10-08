import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerShortcut,
  initKeyboardShortcuts,
  getAllShortcuts,
  getDefaultBinding,
  getHotkeyOverrides,
  setHotkeyOverrides,
  setHotkeyOverride,
  findBindingConflict,
  formatShortcut,
  parseShortcut,
  bindingFromEvent,
  serializeOverrides,
  deserializeOverrides,
  _resetForTests,
} from '@renderer/core/hotkeys';

describe('hotkeys', () => {
  beforeEach(() => {
    _resetForTests();
  });

  describe('formatShortcut / parseShortcut', () => {
    it('round-trips Ctrl+Shift+N', () => {
      const b = parseShortcut('Ctrl+Shift+N');
      expect(b).toEqual({ key: 'N', ctrl: true, shift: true });
      expect(formatShortcut(b!)).toBe('Ctrl+Shift+N');
    });

    it('handles single-letter no-modifier', () => {
      const b = parseShortcut('Escape');
      expect(b).toEqual({ key: 'Escape' });
      expect(formatShortcut(b!)).toBe('Escape');
    });

    it('handles Cmd alias as ctrl', () => {
      const b = parseShortcut('Cmd+S');
      expect(b?.ctrl).toBe(true);
      expect(b?.key).toBe('S');
    });

    it('returns null for empty / malformed strings', () => {
      expect(parseShortcut('')).toBeNull();
      expect(parseShortcut('Ctrl+')).toBeNull();
    });
  });

  describe('bindingFromEvent', () => {
    it('captures ctrl + key', () => {
      const e = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true });
      expect(bindingFromEvent(e)).toEqual({ key: 'n', ctrl: true, shift: false, alt: false });
    });

    it('skips modifier-only events', () => {
      const e = new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true });
      expect(bindingFromEvent(e)).toBeNull();
    });

    it('treats meta key as ctrl', () => {
      const e = new KeyboardEvent('keydown', { key: 's', metaKey: true });
      const b = bindingFromEvent(e);
      expect(b?.ctrl).toBe(true);
    });
  });

  describe('serialize / deserialize overrides', () => {
    it('round-trips through hotkeys.json shape', () => {
      const map = {
        'tile:new': { key: 'F2', shift: true },
        'history:undo': { key: 'Z', ctrl: true },
      };
      const json = serializeOverrides(map);
      expect(json).toEqual({
        'tile:new': 'Shift+F2',
        'history:undo': 'Ctrl+Z',
      });
      expect(deserializeOverrides(json)).toEqual({
        'tile:new': { key: 'F2', shift: true },
        'history:undo': { key: 'Z', ctrl: true },
      });
    });

    it('skips invalid entries on deserialise', () => {
      const result = deserializeOverrides({ 'tile:new': '', 'history:undo': 'Ctrl+Z' });
      expect(result).toEqual({ 'history:undo': { key: 'Z', ctrl: true } });
    });
  });

  describe('overrides are applied to registered shortcuts', () => {
    it('reflects an override in getAllShortcuts', () => {
      registerShortcut({
        commandId: 'tile:new',
        key: 'n',
        ctrl: true,
        description: 'New Tile',
        action: () => {},
      });
      setHotkeyOverride('tile:new', { key: 'F2' });
      const all = getAllShortcuts();
      const tileNew = all.find((s) => s.commandId === 'tile:new')!;
      expect(tileNew.key).toBe('F2');
      expect(tileNew.ctrl).toBe(false);
    });

    it('reset (null override) returns to default binding', () => {
      registerShortcut({
        commandId: 'tile:new',
        key: 'n',
        ctrl: true,
        description: 'New Tile',
        action: () => {},
      });
      setHotkeyOverride('tile:new', { key: 'F2' });
      setHotkeyOverride('tile:new', null);
      const tileNew = getAllShortcuts().find((s) => s.commandId === 'tile:new')!;
      expect(tileNew.key).toBe('n');
      expect(tileNew.ctrl).toBe(true);
    });

    it('applies overrides to shortcuts registered after the override is set', () => {
      setHotkeyOverrides({ 'tile:new': { key: 'F2' } });
      registerShortcut({
        commandId: 'tile:new',
        key: 'n',
        ctrl: true,
        description: 'New Tile',
        action: () => {},
      });
      const tileNew = getAllShortcuts().find((s) => s.commandId === 'tile:new')!;
      expect(tileNew.key).toBe('F2');
    });

    it('preserves the default binding for reset after registration', () => {
      registerShortcut({
        commandId: 'tile:new',
        key: 'n',
        ctrl: true,
        description: 'New Tile',
        action: () => {},
      });
      setHotkeyOverride('tile:new', { key: 'F2' });
      const def = getDefaultBinding('tile:new');
      expect(def).toEqual({ key: 'n', ctrl: true, shift: undefined, alt: undefined });
    });

    it('exposes current override map via getHotkeyOverrides', () => {
      setHotkeyOverride('tile:new', { key: 'F2' });
      expect(getHotkeyOverrides()).toEqual({ 'tile:new': { key: 'F2' } });
    });
  });

  describe('findBindingConflict', () => {
    beforeEach(() => {
      registerShortcut({
        commandId: 'history:undo',
        key: 'z',
        ctrl: true,
        description: 'Undo',
        action: () => {},
      });
      registerShortcut({
        commandId: 'tile:new',
        key: 'n',
        ctrl: true,
        description: 'New Tile',
        action: () => {},
      });
    });

    it('returns the conflicting commandId', () => {
      const conflict = findBindingConflict({ key: 'z', ctrl: true });
      expect(conflict).toBe('history:undo');
    });

    it('returns null when no conflict', () => {
      const conflict = findBindingConflict({ key: 'x', ctrl: true, shift: true });
      expect(conflict).toBeNull();
    });

    it('ignores the exemption commandId', () => {
      const conflict = findBindingConflict({ key: 'z', ctrl: true }, 'history:undo');
      expect(conflict).toBeNull();
    });

    it('detects conflicts that come from overrides', () => {
      setHotkeyOverride('tile:new', { key: 'z', ctrl: true });
      const conflict = findBindingConflict({ key: 'z', ctrl: true }, 'history:undo');
      expect(conflict).toBe('tile:new');
    });
  });

  describe('enabled (active-pane skip)', () => {
    beforeEach(() => {
      initKeyboardShortcuts();
    });

    function dispatchKey(init: KeyboardEventInit) {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event;
    }

    it('skips a disabled shortcut and fires the next matching enabled one', () => {
      const fired: string[] = [];
      registerShortcut({
        commandId: 'a', key: 'n', description: 'A',
        enabled: () => false,
        action: () => { fired.push('a'); },
      });
      registerShortcut({
        commandId: 'b', key: 'n', description: 'B',
        enabled: () => true,
        action: () => { fired.push('b'); },
      });

      dispatchKey({ key: 'n' });
      expect(fired).toEqual(['b']);
    });

    it('routes to the enabled match regardless of registration order', () => {
      const fired: string[] = [];
      // Enabled one registered FIRST this time — still the only one to fire.
      registerShortcut({
        commandId: 'b', key: 'n', description: 'B',
        enabled: () => true,
        action: () => { fired.push('b'); },
      });
      registerShortcut({
        commandId: 'a', key: 'n', description: 'A',
        enabled: () => false,
        action: () => { fired.push('a'); },
      });

      dispatchKey({ key: 'n' });
      expect(fired).toEqual(['b']);
    });

    it('fires nothing and does not preventDefault when every match is disabled', () => {
      let fired = 0;
      registerShortcut({
        commandId: 'a', key: 'n', description: 'A',
        enabled: () => false,
        action: () => { fired += 1; },
      });
      registerShortcut({
        commandId: 'b', key: 'n', description: 'B',
        enabled: () => false,
        action: () => { fired += 1; },
      });

      const event = dispatchKey({ key: 'n' });
      expect(fired).toBe(0);
      // A skipped shortcut must let the keystroke fall through, not eat it.
      expect(event.defaultPrevented).toBe(false);
    });

    it('treats a missing enabled predicate as always-on', () => {
      let fired = 0;
      registerShortcut({
        commandId: 'a', key: 'n', description: 'A',
        action: () => { fired += 1; },
      });

      const event = dispatchKey({ key: 'n' });
      expect(fired).toBe(1);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe('allowInEditor', () => {
    beforeEach(() => {
      initKeyboardShortcuts();
    });

    // jsdom doesn't implement HTMLElement.isContentEditable (returns undefined
    // even when contenteditable="true"), so we shim the property on a fresh
    // element to exercise the production filter.
    function makeEditable(): HTMLElement {
      const el = document.createElement('div');
      el.setAttribute('contenteditable', 'true');
      Object.defineProperty(el, 'isContentEditable', { value: true, configurable: true });
      document.body.appendChild(el);
      return el;
    }

    function dispatchKey(target: HTMLElement, init: KeyboardEventInit) {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
    }

    it('skips contenteditable-targeted shortcuts that do not opt in', () => {
      let fired = 0;
      registerShortcut({
        commandId: 'history:undo',
        key: 'z',
        ctrl: true,
        description: 'Undo',
        action: () => { fired += 1; },
      });

      const editable = makeEditable();
      try {
        dispatchKey(editable, { key: 'z', ctrlKey: true });
        expect(fired).toBe(0);
      } finally {
        editable.remove();
      }
    });

    it('fires contenteditable-targeted shortcuts that opt in via allowInEditor', () => {
      let fired = 0;
      registerShortcut({
        commandId: 'editor:insert-link',
        key: 'k',
        ctrl: true,
        description: 'Insert Link',
        allowInEditor: true,
        action: () => { fired += 1; },
      });

      const editable = makeEditable();
      try {
        dispatchKey(editable, { key: 'k', ctrlKey: true });
        expect(fired).toBe(1);
      } finally {
        editable.remove();
      }
    });

    it('always blocks shortcuts inside form INPUT regardless of allowInEditor', () => {
      let fired = 0;
      registerShortcut({
        commandId: 'editor:insert-link',
        key: 'k',
        ctrl: true,
        description: 'Insert Link',
        allowInEditor: true,
        action: () => { fired += 1; },
      });

      const input = document.createElement('input');
      document.body.appendChild(input);
      try {
        dispatchKey(input, { key: 'k', ctrlKey: true });
        expect(fired).toBe(0);
      } finally {
        input.remove();
      }
    });

    it('treats a contenteditable inside [data-plain-text-field] as a form field: only Escape passes', () => {
      const fired: string[] = [];
      registerShortcut({
        commandId: 'editor:insert-link',
        key: 'k',
        ctrl: true,
        description: 'Insert Link',
        allowInEditor: true,
        action: () => { fired.push('link'); },
      });
      registerShortcut({
        commandId: 'file:save',
        key: 's',
        ctrl: true,
        description: 'Save',
        allowInEditor: true,
        action: () => { fired.push('save'); },
      });
      registerShortcut({
        commandId: 'app:cancel',
        key: 'Escape',
        description: 'Cancel',
        action: () => { fired.push('cancel'); },
      });

      // The Raw view's text: the attribute sits on the contenteditable itself,
      // and a key can come from a node inside it.
      const field = makeEditable();
      field.setAttribute('data-plain-text-field', '');
      const line = document.createElement('div');
      field.appendChild(line);
      try {
        dispatchKey(field, { key: 'k', ctrlKey: true });
        dispatchKey(line, { key: 's', ctrlKey: true });
        expect(fired).toEqual([]);
        dispatchKey(field, { key: 'Escape' });
        expect(fired).toEqual(['cancel']);
      } finally {
        field.remove();
      }
    });

    it('blocks shortcuts in a read-only [data-plain-text-field] too (contenteditable="false")', () => {
      let fired = 0;
      registerShortcut({
        commandId: 'history:undo',
        key: 'z',
        ctrl: true,
        description: 'Undo',
        action: () => { fired += 1; },
      });
      const field = document.createElement('div');
      field.setAttribute('contenteditable', 'false');
      field.setAttribute('data-plain-text-field', '');
      document.body.appendChild(field);
      try {
        dispatchKey(field, { key: 'z', ctrlKey: true });
        expect(fired).toBe(0);
      } finally {
        field.remove();
      }
    });
  });

  describe('while a modal dialog is open', () => {
    it('skips app shortcuts, but Escape and an allowInDialog command still fire', () => {
      initKeyboardShortcuts();
      const fired: string[] = [];
      registerShortcut({ key: 'z', ctrl: true, description: 'Undo', action: () => { fired.push('undo'); } });
      registerShortcut({ key: 's', ctrl: true, allowInDialog: true, description: 'Save', action: () => { fired.push('save'); } });
      registerShortcut({ key: 'Escape', description: 'Cancel', action: () => { fired.push('cancel'); } });
      const dialog = document.createElement('div');
      dialog.setAttribute('aria-modal', 'true');
      const button = document.createElement('button');
      dialog.appendChild(button);
      document.body.appendChild(dialog);
      try {
        for (const [key, ctrlKey] of [['z', true], ['s', true], ['Escape', false]] as const) {
          const e = new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true });
          button.dispatchEvent(e);
          if (key === 'z') expect(e.defaultPrevented).toBe(false);
        }
        expect(fired).toEqual(['save', 'cancel']);
        dialog.remove();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        expect(fired).toEqual(['save', 'cancel', 'undo']);
      } finally {
        dialog.remove();
      }
    });
  });

  // Save reaches the app from a text field (a task title, a notes box), so its
  // component flush can hand the typed text over; nothing else does.
  describe('allowInField', () => {
    beforeEach(() => {
      initKeyboardShortcuts();
    });

    function press(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    }

    it('fires an allowInField shortcut from an input or a textarea, and no other', () => {
      const fired: string[] = [];
      registerShortcut({ key: 's', ctrl: true, allowInField: true, description: 'Save', action: () => { fired.push('save'); } });
      registerShortcut({ key: 'z', ctrl: true, allowInEditor: true, description: 'Undo', action: () => { fired.push('undo'); } });
      registerShortcut({ key: 'n', description: 'Add card', action: () => { fired.push('add'); } });
      const input = document.createElement('input');
      const textarea = document.createElement('textarea');
      document.body.append(input, textarea);
      try {
        for (const field of [input, textarea]) {
          expect(press(field, { key: 'z', ctrlKey: true }).defaultPrevented).toBe(false);
          expect(press(field, { key: 'n' }).defaultPrevented).toBe(false);
          expect(press(field, { key: 's', ctrlKey: true }).defaultPrevented).toBe(true);
        }
        expect(fired).toEqual(['save', 'save']);
      } finally {
        input.remove();
        textarea.remove();
      }
    });

    // Escape's app:cancel closes the top layer; with none open it says so, and
    // the key stays for the board's own Escape and the Search panel's (BL-03).
    it('leaves a key unprevented when the shortcut found nothing to act on', () => {
      let open = true;
      registerShortcut({ key: 'Escape', description: 'Cancel', action: () => { const was = open; open = false; return was; } });
      expect(press(document.body, { key: 'Escape' }).defaultPrevented).toBe(true);
      expect(press(document.body, { key: 'Escape' }).defaultPrevented).toBe(false);
    });

    it("leaves a key the field already took (the Raw view's own Ctrl+S) alone", () => {
      let fired = 0;
      registerShortcut({ key: 's', ctrl: true, allowInField: true, description: 'Save', action: () => { fired += 1; } });
      const field = document.createElement('div');
      field.setAttribute('contenteditable', 'true');
      field.setAttribute('data-plain-text-field', '');
      field.addEventListener('keydown', (e) => e.preventDefault());
      document.body.appendChild(field);
      try {
        press(field, { key: 's', ctrlKey: true });
        expect(fired).toBe(0);
      } finally {
        field.remove();
      }
    });
  });

  // The Document zoom keys (Audit-29 D-04): Ctrl and + on the number pad, or
  // Ctrl+Shift+=, send `+`, which a binding of `=` takes as browsers and Word do.
  describe('the + key', () => {
    beforeEach(() => {
      initKeyboardShortcuts();
    });

    function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
      const event = new KeyboardEvent('keydown', { ctrlKey: true, ...init, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    }

    function zoomCommands(): string[] {
      const fired: string[] = [];
      for (const [name, key] of [['in', '='], ['out', '-'], ['reset', '0']] as const) {
        registerShortcut({ key, ctrl: true, allowInEditor: true, allowInField: true, description: name, action: () => { fired.push(name); } });
      }
      return fired;
    }

    it('takes Ctrl and + (number pad or Shift+=) as Ctrl+=, and Ctrl and the number pad − as Ctrl+-', () => {
      const fired = zoomCommands();
      press(document.body, { key: '=', code: 'Equal' });
      press(document.body, { key: '+', code: 'NumpadAdd' });
      press(document.body, { key: '+', code: 'Equal', shiftKey: true });
      press(document.body, { key: '-', code: 'NumpadSubtract' });
      expect(fired).toEqual(['in', 'in', 'in', 'out']);
      // Not without Ctrl, and not Ctrl+Shift+- (`_`).
      expect(press(document.body, { key: '+', ctrlKey: false }).defaultPrevented).toBe(false);
      expect(press(document.body, { key: '_', shiftKey: true }).defaultPrevented).toBe(false);
      expect(fired).toEqual(['in', 'in', 'in', 'out']);
    });

    it('leaves + to a shortcut bound to it, and a binding of Shift+= alone', () => {
      const fired = zoomCommands();
      registerShortcut({ key: '+', ctrl: true, description: 'plus', action: () => { fired.push('plus'); } });
      registerShortcut({ key: '=', ctrl: true, alt: true, shift: true, description: 'shifted', action: () => { fired.push('shifted'); } });
      press(document.body, { key: '+', code: 'NumpadAdd' });
      expect(fired).toEqual(['plus']);
      press(document.body, { key: '+', code: 'Equal', shiftKey: true, altKey: true });
      expect(fired, 'a Shift binding of = never takes + by the alias').toEqual(['plus']);
    });

    it('works with the caret in the Raw view, the note and the tag row', () => {
      const fired = zoomCommands();
      const raw = document.createElement('div');
      raw.setAttribute('data-plain-text-field', '');
      raw.contentEditable = 'true';
      const note = document.createElement('div');
      note.contentEditable = 'true';
      const tagRow = document.createElement('input');
      document.body.append(raw, note, tagRow);
      try {
        press(raw, { key: '=', code: 'Equal' });
        press(raw, { key: '+', code: 'NumpadAdd' });
        press(note, { key: '-', code: 'Minus' });
        press(tagRow, { key: '0', code: 'Digit0' });
        expect(fired).toEqual(['in', 'in', 'out', 'reset']);
      } finally {
        raw.remove();
        note.remove();
        tagRow.remove();
      }
    });
  });
});
