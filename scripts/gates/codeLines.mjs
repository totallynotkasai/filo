// Lines of code for the `file-sizes` gate: a line counts only when it holds
// code, so blank lines and comment-only lines don't. A file's size then
// measures its logic, and explaining a hazard in a comment never pushes a
// file toward a hurried split.
//
// The scanners are string- and template-aware, so a `//` or `/*` inside a
// string, template or regex literal is code, and a template line that looks
// like a comment still counts. A misread regex is bounded to its own line, so
// it can't swallow the lines after it.

/** The lines of `text` holding code. `svelte` scans markup, `<script>` and `<style>` apart. */
export function countCodeLines(text, { svelte = false } = {}) {
  const masked = svelte ? maskSvelte(text) : maskScript(text);
  let count = 0;
  for (const line of masked.split('\n')) if (/\S/.test(line)) count++;
  return count;
}

const spaces = (s) => s.replace(/[^\n]/g, ' ');

// Words after which a `/` starts a regex literal rather than a division.
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'case', 'do', 'else', 'in', 'of', 'new',
  'delete', 'void', 'throw', 'yield', 'await',
]);
const REGEX_AFTER_CHAR = '(,=:[!&|?{};+-*%<>~^';

/** End of the regex literal opening at `start`, or -1 when none closes on its line. */
function regexEnd(src, start) {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') return -1;
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') inClass = true;
    else if (c === '/') {
      let end = i + 1;
      while (end < src.length && /[a-z]/i.test(src[end])) end++;
      return end;
    }
  }
  return -1;
}

/** JS / TS with every comment turned to spaces (newlines kept). */
export function maskScript(src) {
  let out = '';
  // One brace depth per open `${ … }` inside a template literal.
  const templates = [];
  let state = 'code';
  let quote = '';
  // The last code character and identifier before the scan position, which
  // tell a regex literal from a division.
  let lastChar = '';
  let lastWord = '';
  let inWord = false;
  let i = 0;
  const code = (s) => {
    out += s;
    for (const ch of s) {
      if (/\s/.test(ch)) { inWord = false; continue; }
      const ident = /[\w$]/.test(ch);
      lastWord = ident ? (inWord ? lastWord + ch : ch) : '';
      inWord = ident;
      lastChar = ch;
    }
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; } else out += ' ';
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? c : ' ';
      i++;
      continue;
    }
    if (state === 'string') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      out += c;
      i++;
      if (c === quote || c === '\n') { state = 'code'; lastChar = c; lastWord = ''; inWord = false; }
      continue;
    }
    if (state === 'template') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { state = 'code'; code(c); i++; continue; }
      if (c === '$' && n === '{') { templates.push(0); state = 'code'; code('${'); i += 2; continue; }
      out += c;
      i++;
      continue;
    }
    // code
    if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
    if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
    if (c === '"' || c === "'") { state = 'string'; quote = c; out += c; i++; continue; }
    if (c === '`') { state = 'template'; out += c; i++; continue; }
    if (c === '/' && (lastChar === '' || REGEX_AFTER_CHAR.includes(lastChar) || REGEX_AFTER_WORD.has(lastWord))) {
      const end = regexEnd(src, i);
      if (end > 0) { code(src.slice(i, end)); lastChar = ')'; lastWord = ''; inWord = false; i = end; continue; }
    }
    if (templates.length > 0) {
      const top = templates.length - 1;
      if (c === '{') templates[top]++;
      else if (c === '}') {
        if (templates[top] === 0) { templates.pop(); state = 'template'; out += c; i++; continue; }
        templates[top]--;
      }
    }
    code(c);
    i++;
  }
  return out;
}

/** CSS with every `/* … *\/` comment turned to spaces (`//` isn't a CSS comment). */
export function maskStyle(src) {
  let out = '';
  let state = 'code';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i++; continue; }
      out += c === '\n' ? c : ' ';
      continue;
    }
    if (state === 'string') {
      if (c === '\\') { out += src.slice(i, i + 2); i++; continue; }
      if (c === quote || c === '\n') state = 'code';
      out += c;
      continue;
    }
    if (c === '/' && n === '*') { state = 'block'; out += '  '; i++; continue; }
    if (c === '"' || c === "'") { state = 'string'; quote = c; }
    out += c;
  }
  return out;
}

/**
 * A Svelte component with its comments turned to spaces: `<!-- … -->` in the
 * markup, JS comments in `<script>`, CSS comments in `<style>`.
 */
export function maskSvelte(src) {
  const lower = src.toLowerCase();
  const re = /<!--|<(script|style)\b[^>]*>/gi;
  let out = '';
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) { out += src.slice(i); break; }
    out += src.slice(i, m.index);
    if (m[0] === '<!--') {
      const close = src.indexOf('-->', m.index + 4);
      const stop = close < 0 ? src.length : close + 3;
      out += spaces(src.slice(m.index, stop));
      i = stop;
      continue;
    }
    const tag = m[1].toLowerCase();
    const bodyStart = m.index + m[0].length;
    const close = lower.indexOf(`</${tag}`, bodyStart);
    const bodyEnd = close < 0 ? src.length : close;
    const body = src.slice(bodyStart, bodyEnd);
    out += m[0] + (tag === 'script' ? maskScript(body) : maskStyle(body));
    i = bodyEnd;
  }
  return out;
}
