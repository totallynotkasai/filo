import { describe, it, expect } from 'vitest';
import { isEditableTextTarget } from '@renderer/lib/utils/editableTarget';

describe('isEditableTextTarget', () => {
  it('returns false for null', () => {
    expect(isEditableTextTarget(null)).toBe(false);
  });

  it('returns false for a non-element event target', () => {
    expect(isEditableTextTarget({} as EventTarget)).toBe(false);
  });

  it('returns false for a plain div', () => {
    const el = document.createElement('div');
    expect(isEditableTextTarget(el)).toBe(false);
  });

  it('returns true for a contenteditable div', () => {
    const el = document.createElement('div');
    el.setAttribute('contenteditable', 'true');
    document.body.appendChild(el);
    try {
      expect(isEditableTextTarget(el)).toBe(true);
    } finally {
      el.remove();
    }
  });

  it('returns true for an element nested inside a contenteditable ancestor', () => {
    const parent = document.createElement('div');
    parent.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    child.textContent = 'misspelled';
    parent.appendChild(child);
    document.body.appendChild(parent);
    try {
      expect(isEditableTextTarget(child)).toBe(true);
    } finally {
      parent.remove();
    }
  });

  it('returns false when an ancestor explicitly opts out via contenteditable="false"', () => {
    const outer = document.createElement('div');
    outer.setAttribute('contenteditable', 'true');
    const blocker = document.createElement('div');
    blocker.setAttribute('contenteditable', 'false');
    const inner = document.createElement('span');
    blocker.appendChild(inner);
    outer.appendChild(blocker);
    document.body.appendChild(outer);
    try {
      expect(isEditableTextTarget(inner)).toBe(false);
    } finally {
      outer.remove();
    }
  });

  it('returns true for a textarea', () => {
    const el = document.createElement('textarea');
    expect(isEditableTextTarget(el)).toBe(true);
  });

  it('returns true for input with no explicit type', () => {
    const el = document.createElement('input');
    expect(isEditableTextTarget(el)).toBe(true);
  });

  it('returns true for input[type=text]', () => {
    const el = document.createElement('input');
    el.type = 'text';
    expect(isEditableTextTarget(el)).toBe(true);
  });

  it('returns true for input[type=search]', () => {
    const el = document.createElement('input');
    el.type = 'search';
    expect(isEditableTextTarget(el)).toBe(true);
  });

  it('returns true for input[type=email|url|tel|password|number]', () => {
    for (const type of ['email', 'url', 'tel', 'password', 'number']) {
      const el = document.createElement('input');
      el.type = type;
      expect(isEditableTextTarget(el)).toBe(true);
    }
  });

  it('returns false for input[type=checkbox]', () => {
    const el = document.createElement('input');
    el.type = 'checkbox';
    expect(isEditableTextTarget(el)).toBe(false);
  });

  it('returns false for input[type=button]', () => {
    const el = document.createElement('input');
    el.type = 'button';
    expect(isEditableTextTarget(el)).toBe(false);
  });

  it('returns false for input[type=range]', () => {
    const el = document.createElement('input');
    el.type = 'range';
    expect(isEditableTextTarget(el)).toBe(false);
  });

  it('returns false for a button element', () => {
    const el = document.createElement('button');
    expect(isEditableTextTarget(el)).toBe(false);
  });
});
