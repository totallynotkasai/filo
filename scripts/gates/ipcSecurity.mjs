// IPC contract + main-process security ratchets.
import { fail, blank, functionBody, matchBrace, lineAt, markerNear, stripCommentsKeepOffsets } from './lib.mjs';

const MAIN_TO_RENDERER_EVENTS = new Set([
  'vault:files-changed',
  'vault:tree-updated',
  'vault:file-renamed',
  'vault:watcher-failed',
  'vault:watcher-state',
  'vault:tree-too-large',
  'vault:sync-conflict',
  'app:flush-and-quit',
  'app:session-ending',
  'app:text-menu-query',
  'app:insert-link',
]);
const MIN_LITERAL_REGISTRATIONS = 30;

// Channels whose result is an `{ ok | success }` envelope (IpcOk / IpcSuccess in
// src/shared/ipcContracts.ts). ipcEnvelopeAllChannels.test.ts parses this literal.
const ENVELOPE_CHANNELS = new Set([
  'vault:read-tree',
  'vault:init-config',
  'board:save',
  'board:create',
  'recovery:snapshot',
  'config:save',
  'config:save-workspace',
  'theme:save',
  'theme:delete',
  'vault:add-recent',
  'vault:create-folder',
  'vault:suggest-folder-name',
  'vault:rename',
  'vault:delete',
  'vault:watch',
  'vault:reconcile',
  'vault:followed-move',
  'vault:copy-file',
  'vault:read-file-text',
  'vault:write-file-text',
  'vault:write-existing-file-text',
  'vault:create-file-text',
  'vault:stat',
  'vault:set-open-on-launch',
  'vault:sweep-orphan-tmp',
  'vault:trash-move',
  'vault:trash-restore',
  'vault:trash-list',
  'vault:trash-purge',
  'vault:trash-delete-permanently',
  'board:load',
  'board:list-conflicts',
  'recovery:list-sentinels',
  'recovery:keep-unsaved',
  'recovery:preserved-tmp',
  'recovery:open',
  'recovery:delete',
  'vault:convert-to-utf8',
  'media:save-audio',
  'media:read-file',
  'media:open-external',
  'link:fetch-metadata',
  'font:import',
  'font:list-imported',
  'templates:layout:write',
  'templates:layout:rename',
  'templates:layout:delete',
]);

const SINK_RULES = [
  {
    name: 'iframe-src',
    dir: 'src/renderer/components',
    ext: ['.svelte'],
    match: /<iframe\b[\s\S]*?\bsrc=\{[^}]+\}/g,
    sanitiser: /(asSafeIframeSrc|SanitisedSrc)\(/,
    nearby: 3,
  },
  {
    name: 'theme-css-var',
    dir: 'src/renderer/lib/themes',
    ext: ['.ts'],
    match: /\.setProperty\(\s*\w+\s*,\s*\w+\s*\)/g,
    sanitiser: /(asSafeThemeValue|SanitisedColor)\(/,
    nearby: 3,
  },
  {
    name: 'media-open-external',
    dir: 'src/renderer',
    ext: ['.ts', '.svelte'],
    match: /(?:window\.filo\.invoke|invokeOk)\(\s*['"]media:open-external['"]/g,
    sanitiser: /(asSafeOpenExternal|SanitisedUrl)\(/,
    nearby: 8,
  },
];

// Content-read channels allowed to read `.filo/` (each with the reason).
const FILO_READ_EXEMPT = new Map([
  ['vault:read-file-text', "trusted text channel the app's own crash recovery + vault index read .filo/ sentinels through"],
]);
const MIN_SWEPT_READ_CHANNELS = 2;

// Handlers behind the renderer's write schedulers (and the other writes their
// Retry covers): a failure here must carry a code (gate ipc-errors-carry-code).
const WRITE_HANDLER_CHANNELS = [
  'vault:init-config',
  'board:save',
  'board:create',
  'config:save',
  'config:save-workspace',
  'theme:save',
  'theme:delete',
  'tags:save',
  'templates:layout:write',
  'templates:layout:rename',
  'templates:layout:delete',
  // Note writes: a lock (EBUSY) must reach the note writer as itself, so the
  // change is kept for Retry instead of folded into IO_ERROR.
  'vault:write-file-text',
  'vault:create-file-text',
  'vault:write-existing-file-text',
];

const VERSIONED_SCHEMAS = ['BoardFileDataSchema', 'TagsFileSchema', 'LayoutTemplateSchema'];
const VERSION_GUARDS = ['loadVersionedFile', 'migrateBoardFile', 'migrateTagsFile', 'migrateLayoutTemplate'];

/** `ipcMain.handle('<channel>', …)` registrations split into segments up to the next one. */
function handlerSegments(raw) {
  const blanked = blank(raw);
  const marks = [...raw.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map((m) => ({ channel: m[1], start: m.index }));
  return marks.map((mark, i) => ({
    channel: mark.channel,
    body: blanked.slice(mark.start, i + 1 < marks.length ? marks[i + 1].start : raw.length),
  }));
}

/** Arrow-body of the handler registered for `'<channel>'` (brace-matched on blanked code). */
function handlerBody(raw, channel) {
  const blanked = blank(raw);
  const idx = raw.indexOf(`'${channel}'`);
  if (idx < 0) return null;
  const arrow = blanked.indexOf('=>', idx);
  const open = arrow < 0 ? -1 : blanked.indexOf('{', arrow);
  const close = open < 0 ? -1 : matchBrace(blanked, open, '{', '}');
  return close < 0 ? null : blanked.slice(open, close + 1);
}

export const checks = [
  {
    id: 'ipc-parity',
    title: 'every ipcMain channel is in the IpcChannel union and vice versa',
    hint: 'Add the literal to IpcChannel in src/shared/types.ts, register it, or list a main→renderer event in MAIN_TO_RENDERER_EVENTS.',
    run(ctx) {
      const out = [];
      const registered = new Map();
      for (const rel of ctx.files('src/main', { ext: ['.ts'] })) {
        for (const m of ctx.read(rel).matchAll(/ipcMain\.(?:handle|on|once)\(\s*['"]([^'"]+)['"]/g)) {
          if (!registered.has(m[1])) registered.set(m[1], rel);
        }
      }
      const TYPES = 'src/shared/types.ts';
      const union = ctx.read(TYPES)?.match(/export\s+type\s+IpcChannel\s*=([\s\S]*?);/);
      if (!union) return [fail(TYPES, undefined, 'could not locate the IpcChannel union')];
      const literals = new Set([...union[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]));
      for (const [c, rel] of registered) if (!literals.has(c)) out.push(fail(rel, undefined, `'${c}' is registered but missing from IpcChannel`));
      for (const c of literals) {
        if (!registered.has(c) && !MAIN_TO_RENDERER_EVENTS.has(c)) out.push(fail(TYPES, undefined, `'${c}' is in IpcChannel but never registered (and not a main→renderer event)`));
      }
      for (const c of MAIN_TO_RENDERER_EVENTS) if (!literals.has(c)) out.push(fail(TYPES, undefined, `MAIN_TO_RENDERER_EVENTS lists '${c}', which is not in IpcChannel`));
      if (registered.size < MIN_LITERAL_REGISTRATIONS) {
        out.push(fail('src/main', undefined, `tripwire: only ${registered.size} literal ipcMain registrations (expected >= ${MIN_LITERAL_REGISTRATIONS})`));
      }
      return out;
    },
  },
  {
    id: 'ipc-envelope-usage',
    title: 'envelope-returning IPC results are never dropped unchecked',
    hint:
      'Ignoring `{ ok: false }` silently swallows failures. Use invokeOk(...) or assertIpcOk(...), inspect .ok/.success, ' +
      'or mark fire-and-forget with `allow-envelope-bare: <reason>` (same line or up to 5 above).',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files('src/renderer', { ext: ['.svelte', '.svelte.ts', '.ts'] })) {
        if (/\/tests?\//.test(rel) || /\/invokeOk\.ts$/.test(rel)) continue;
        const lines = ctx.read(rel).split('\n');
        lines.forEach((line, i) => {
          if (lines.slice(Math.max(0, i - 5), i + 1).join('\n').includes('allow-envelope-bare:')) return;
          for (const m of line.matchAll(/window\.filo\.invoke\(\s*['"]([^'"]+)['"]/g)) {
            if (!ENVELOPE_CHANNELS.has(m[1])) continue;
            const handled =
              /(?:const|let|var)\s+\w+\s*=\s*(?:\(\s*)?await\s+window\.filo\.invoke\b/.test(line) ||
              /window\.filo\.invoke\([^;]*\)[^;]*\.(then|catch)\b/.test(line) ||
              /return\s+(?:await\s+)?window\.filo\.invoke\b/.test(line) ||
              /return\s+\(\s*await\s+window\.filo\.invoke\b/.test(line);
            if (handled) continue;
            const after = lines.slice(i, Math.min(lines.length, i + 7)).join('\n');
            if (/\.success\b/.test(after) || /\.ok\b/.test(after) || /assertIpcOk\s*\(/.test(after)) continue;
            out.push(fail(rel, i + 1, `'${m[1]}' envelope result dropped: ${line.trim()}`));
          }
        });
      }
      return out;
    },
  },
  {
    id: 'untrusted-sinks',
    title: 'iframe src / theme CSS vars / open-external only receive asSafe*-validated values',
    hint: 'Route the raw value through the matching asSafe* validator (src/shared/untrusted.ts), or `// allow-untrusted-sink: <reason>`.',
    run(ctx) {
      const out = [];
      for (const rule of SINK_RULES) {
        for (const rel of ctx.files(rule.dir, { ext: rule.ext })) {
          const text = ctx.read(rel);
          const lines = text.split('\n');
          for (const m of text.matchAll(rule.match)) {
            const line = lineAt(text, m.index);
            if (lines.slice(Math.max(0, line - 4), line).join('\n').includes('allow-untrusted-sink:')) continue;
            const window = lines.slice(Math.max(0, line - 1 - rule.nearby), Math.min(lines.length, line + rule.nearby)).join('\n');
            if (!rule.sanitiser.test(window)) out.push(fail(rel, line, `[${rule.name}] raw value reaches the sink: ${(lines[line - 1] ?? '').trim()}`));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'copy-file-source-guard',
    title: 'vault:copy-file validates its SOURCE and copyFileToVault re-stats + caps bytes',
    hint:
      'Without the source check vault:copy-file is an arbitrary host-file read primitive. Keep isApprovedCopySource, ' +
      'the fd `.isFile()` re-check, the `maxBytes` stream cap, and clearApprovedSources() on vault close/watch.',
    run(ctx) {
      const out = [];
      const COPY = 'src/main/ipc/vaultCopy.ipc.ts';
      const copyRaw = ctx.read(COPY);
      const copyBody = copyRaw === null ? null : handlerBody(copyRaw, 'vault:copy-file');
      if (copyBody === null) out.push(fail(COPY, undefined, "could not locate the 'vault:copy-file' handler"));
      else if (!/\bisApprovedCopySource\s*\(/.test(copyBody)) out.push(fail(COPY, undefined, 'vault:copy-file handler never calls isApprovedCopySource(...)'));

      const OPS = 'src/main/vault/fileOps.ts';
      const opsRaw = ctx.read(OPS);
      const fn = opsRaw === null ? null : functionBody(blank(opsRaw), 'copyFileToVault');
      if (!fn) out.push(fail(OPS, undefined, 'copyFileToVault() not found'));
      else {
        if (!/\bmaxBytes\b/.test(fn.text)) out.push(fail(OPS, undefined, 'copyFileToVault() lost the `maxBytes` streamed-byte cap'));
        if (!/\.isFile\s*\(/.test(fn.text)) out.push(fail(OPS, undefined, 'copyFileToVault() lost the fd `.isFile()` re-check'));
      }

      const VAULT = 'src/main/ipc/vault.ipc.ts';
      const vaultRaw = ctx.read(VAULT);
      for (const channel of ['vault:close', 'vault:watch']) {
        const body = vaultRaw === null ? null : handlerBody(vaultRaw, channel);
        if (body === null) out.push(fail(VAULT, undefined, `could not locate the '${channel}' handler`));
        else if (!/\bclearApprovedSources\s*\(/.test(body)) out.push(fail(VAULT, undefined, `${channel} handler never calls clearApprovedSources()`));
      }
      return out;
    },
  },
  {
    id: 'filo-read-guard',
    title: 'renderer-relpath content reads refuse .filo/; sentinel writes are machine-owned',
    hint:
      'A channel that reads bytes from a renderer-supplied relative path must call assertNotInFiloDir (or be listed in ' +
      'FILO_READ_EXEMPT with a reason). Sentinel writes must check getMachineIdentity().machineId.',
    run(ctx) {
      const out = [];
      const GUARD = /\bassertNotInFiloDir\s*\(/;
      let swept = 0;
      for (const rel of ctx.files('src/main/ipc', { ext: ['.ts'] })) {
        for (const { channel, body } of handlerSegments(ctx.read(rel))) {
          if (!/\b(?:readFile|createReadStream)/.test(body) || !/\bassertSafeRelativePath\s*\(/.test(body)) continue;
          swept++;
          if (FILO_READ_EXEMPT.has(channel) || GUARD.test(body)) continue;
          out.push(fail(rel, undefined, `${channel} reads renderer-relpath content without assertNotInFiloDir(...)`));
        }
      }
      if (swept < MIN_SWEPT_READ_CHANNELS) {
        out.push(fail('src/main/ipc', undefined, `tripwire: only ${swept} content-read handlers swept (expected >= ${MIN_SWEPT_READ_CHANNELS})`));
      }

      const MEDIA = 'src/main/ipc/media.ipc.ts';
      const mediaRaw = ctx.read(MEDIA);
      const seg = mediaRaw === null ? null : handlerSegments(mediaRaw).find((s) => s.channel === 'media:read-file');
      if (!seg) out.push(fail(MEDIA, undefined, "could not locate the 'media:read-file' handler"));
      else if (!GUARD.test(seg.body)) out.push(fail(MEDIA, undefined, 'media:read-file lost assertNotInFiloDir(...)'));

      const PROTO = 'src/main/protocol/mediaPathGuard.ts';
      const protoRaw = ctx.read(PROTO);
      const resolver = protoRaw === null ? null : functionBody(blank(protoRaw), 'resolveServableMediaPath');
      if (!resolver) out.push(fail(PROTO, undefined, 'resolveServableMediaPath() not found'));
      else if (!GUARD.test(resolver.text)) out.push(fail(PROTO, undefined, 'resolveServableMediaPath() lost assertNotInFiloDir(...) — filo:// would stream .filo/ bytes'));

      const SEC = 'src/main/utils/pathSecurity.ts';
      const secRaw = ctx.read(SEC);
      const code = secRaw === null ? '' : blank(secRaw);
      const permitted = functionBody(code, 'isPermittedSentinel');
      const guardFn = functionBody(code, 'assertNotInFiloDir');
      if (!permitted || !guardFn) out.push(fail(SEC, undefined, 'isPermittedSentinel / assertNotInFiloDir not found'));
      else {
        if (!/\baccess\s*===/.test(permitted.text) || !/getMachineIdentity\s*\(\s*\)\s*\.\s*machineId/.test(permitted.text)) {
          out.push(fail(SEC, undefined, "isPermittedSentinel's write arm must compare against getMachineIdentity().machineId"));
        }
        if (!/isPermittedSentinel\s*\([^)]*\baccess\b/.test(guardFn.text)) {
          out.push(fail(SEC, undefined, 'assertNotInFiloDir must route .filo/ sentinels through isPermittedSentinel(…, access)'));
        }
      }
      return out;
    },
  },
  {
    id: 'no-filo-path-on-vault-channels',
    title: 'renderer invokes of a vault:* channel that refuses .filo/ never name a .filo/ path',
    hint:
      'Main refuses .filo/ on the generic vault channels, so the write fails and is reported as unsaved work for the ' +
      'rest of the session. Keep app state in a .filo/ config through its own scheduler (workspace.json, config:save, ' +
      'scheduleMiscWrite), or mark a sentinel helper with `// allow-filo-path: <reason>`.',
    run(ctx) {
      const out = [];
      // The channels whose handler refuses `.filo/`, read from main itself.
      const refusing = new Set();
      for (const rel of ctx.files('src/main/ipc', { ext: ['.ts'] })) {
        for (const { channel, body } of handlerSegments(ctx.read(rel))) {
          // assertSentinelWriteTarget refuses all of `.filo/` but this machine's sentinels, and every other path too.
          if (channel.startsWith('vault:') && /\b(?:assertNotInFiloDir|assertSentinelWriteTarget)\s*\(/.test(body)) refusing.add(channel);
        }
      }
      for (const channel of ['vault:write-file-text', 'vault:write-existing-file-text', 'vault:create-file-text']) {
        if (!refusing.has(channel)) out.push(fail('src/main/ipc', undefined, `tripwire: ${channel} no longer found refusing .filo/ — update this gate`));
      }
      const FILO_LITERAL = /(['"`])\.filo\//;
      const FILO_CONST = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*['"`]\.filo\//g;
      const VAULT_INVOKE = /\b(?:invoke|invokeOk)\s*(?:<[^>]*>)?\(\s*['"](vault:[^'"]+)['"]/g;
      for (const rel of ctx.files('src/renderer', { ext: ['.ts', '.svelte'] })) {
        const src = ctx.read(rel);
        if (!src.includes('vault:')) continue;
        const code = stripCommentsKeepOffsets(src);
        const lines = src.split('\n');
        const filoConsts = [...code.matchAll(FILO_CONST)].map((m) => m[1]);
        for (const m of code.matchAll(VAULT_INVOKE)) {
          if (!refusing.has(m[1])) continue;
          const open = code.indexOf('(', m.index);
          const close = matchBrace(code, open);
          const args = code.slice(open + 1, close < 0 ? code.length : close);
          const named = filoConsts.find((name) => args.split(/[^\w$]+/).includes(name));
          if (!FILO_LITERAL.test(args) && !named) continue;
          const line = lineAt(code, m.index);
          if (markerNear(lines, line - 1, '// allow-filo-path:', 2)) continue;
          out.push(fail(rel, line, `${m[1]} is given a .filo/ path${named ? ` (${named})` : ''}`));
        }
      }
      return out;
    },
  },
  {
    id: 'ipc-errors-carry-code',
    title: 'write handlers answer a failure through errorEnvelope / errorResult (always with a code)',
    hint:
      'The renderer schedulers keep a failed write for Retry only when its failure has a code; a bare ' +
      '`{ ok: false, error }` leaves the path failed with nothing to re-fire. Return errorEnvelope(err) ' +
      '(or errorResult(err) on a `success` channel) from src/main/ipc/ipcErrorCode.ts.',
    run(ctx) {
      const out = [];
      const seen = new Set();
      for (const rel of ctx.files('src/main/ipc', { ext: ['.ts'] })) {
        for (const { channel, body } of handlerSegments(ctx.read(rel))) {
          if (!WRITE_HANDLER_CHANNELS.includes(channel)) continue;
          seen.add(channel);
          if (/\{\s*(?:ok|success)\s*:\s*false\b/.test(body)) {
            out.push(fail(rel, undefined, `${channel} builds a failure literal; return errorEnvelope(err) / errorResult(err)`));
          }
          if (!/\berror(?:Envelope|Result)\s*\(/.test(body)) {
            out.push(fail(rel, undefined, `${channel} never answers through errorEnvelope / errorResult`));
          }
        }
      }
      for (const channel of WRITE_HANDLER_CHANNELS) {
        if (!seen.has(channel)) out.push(fail('src/main/ipc', undefined, `write handler '${channel}' not found`));
      }
      const CODE = 'src/main/ipc/ipcErrorCode.ts';
      const raw = ctx.read(CODE);
      const code = raw === null ? '' : blank(raw, { strings: false });
      for (const name of ['errorEnvelope', 'errorResult']) {
        const fn = functionBody(code, name, { fnKeyword: true });
        if (!fn) out.push(fail(CODE, undefined, `${name}() not found`));
        else if (!/\bcode\s*:\s*failureCode\s*\(/.test(fn.text)) out.push(fail(CODE, undefined, `${name}() must set code: failureCode(err)`));
      }
      return out;
    },
  },
  {
    id: 'no-forcreation-on-read-delete',
    title: 'read/delete/stat IPC handlers never pass `forCreation: true`',
    hint: 'forCreation applies Windows-only filename rules; on a read/delete path it makes legit files (e.g. `CON.md`) unopenable.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files('src/main/ipc', { ext: ['.ts'], recursive: false })) {
        const code = stripCommentsKeepOffsets(ctx.read(rel));
        const regs = [...code.matchAll(/ipcMain\.(?:handle|on|once)\(\s*['"]([^'"]+)['"]/g)];
        regs.forEach((m, i) => {
          if (!/(?:read|delete|stat|exists)/i.test(m[1])) return;
          const body = code.slice(m.index, i + 1 < regs.length ? regs[i + 1].index : code.length);
          if (/forCreation\s*:\s*true/.test(body)) out.push(fail(rel, lineAt(code, m.index), `"${m[1]}" passes forCreation: true`));
        });
      }
      return out;
    },
  },
  {
    id: 'relative-from-canonical',
    title: 'IPC handlers take a vault-relative path only from the spelling containment was decided on',
    hint:
      'Use vaultRelativeWithin(vaultRoot, abs) (or vaultRelativeIfInside for a path that may be outside): ' +
      'path.relative from a canonical root to an 8.3 / junction spelling gives `../..`, which the `.filo/` guards read as outside. ' +
      'Or `// allow-lexical-relative: <reason>` on the line.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files(['src/main/ipc', 'src/main/protocol'], { ext: ['.ts'] })) {
        const code = stripCommentsKeepOffsets(ctx.read(rel));
        const lines = ctx.read(rel).split('\n');
        for (const m of code.matchAll(/\b(?:relativePosix|path\.relative|relative)\s*\(/g)) {
          const line = lineAt(code, m.index);
          if (/\/\/ allow-lexical-relative:/.test(lines[line - 1] ?? '')) continue;
          out.push(fail(rel, line, `lexical relative path: ${(lines[line - 1] ?? '').trim()}`));
        }
      }
      const SEC = 'src/main/utils/pathSecurity.ts';
      const sec = ctx.read(SEC);
      if (!sec) {
        out.push(fail(SEC, undefined, 'missing'));
      } else {
        const code = stripCommentsKeepOffsets(sec);
        if (!/return\s+assertWithinVault\(\s*canonicalRoot\s*,\s*canonicalTarget\s*\)/.test(code)) {
          out.push(fail(SEC, undefined, "assertWithinVault's canonical branch must return the canonical pair"));
        }
        const fn = functionBody(code, 'vaultRelativeWithin');
        if (!fn || !/assertWithinVault\(/.test(fn.text) || !/relativePosix\(\s*root\s*,\s*target\s*\)/.test(fn.text)) {
          out.push(fail(SEC, undefined, 'vaultRelativeWithin must take the relative path from the pair assertWithinVault returns'));
        }
      }
      return out;
    },
  },
  {
    id: 'versioned-config',
    title: 'versioned config schemas are only parsed after migration',
    hint:
      'Load through loadVersionedFile(schema, migrator, raw) so a from-future file is never silently downgraded, ' +
      'or `// allow-unversioned-parse: <reason>` for a hand-built object.',
    run(ctx) {
      const out = [];
      const parseRe = new RegExp(`\\b(${VERSIONED_SCHEMAS.join('|')})\\s*\\.\\s*(?:safeParse|parse)\\s*\\(`);
      for (const rel of ctx.files('src/renderer', { ext: ['.svelte', '.svelte.ts', '.ts'] })) {
        const src = ctx.read(rel);
        if (!VERSIONED_SCHEMAS.some((s) => src.includes(s))) continue;
        if (VERSION_GUARDS.some((t) => src.includes(t))) continue;
        src.split('\n').forEach((line, i) => {
          if (parseRe.test(line) && !/\/\/ allow-unversioned-parse:/.test(line)) out.push(fail(rel, i + 1, `unguarded parse: ${line.trim()}`));
        });
      }
      return out;
    },
  },
];
