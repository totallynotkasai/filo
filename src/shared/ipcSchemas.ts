import { z } from 'zod';
import type { IpcChannel } from './types';

/**
 * Per-channel payload schemas for `window.filo.invoke`. The renderer's
 * `invoke` wrapper in `preload.ts` validates the variadic args against the
 * matching tuple before forwarding to `ipcRenderer.invoke`. A buggy or
 * compromised renderer that passes the wrong types — e.g. an object where a
 * string path is expected — is rejected with a `BAD_PAYLOAD` rejection
 * before the main process ever sees the call.
 *
 * Each schema is a `z.tuple` matching the channel's positional arguments.
 * `z.unknown()` slots are deliberate — main-side handlers still run their
 * own zod parsing on structured payloads (`board:save` data, `config:save`
 * data, etc.), so re-validating the inner shape here would couple the
 * wrapper to schemas that legitimately live deeper in the renderer / main
 * code.
 *
 * Main→renderer event channels (`vault:files-changed`, `vault:file-renamed`,
 * `vault:tree-updated`, `vault:watcher-failed`, `app:flush-and-quit`) are
 * subscribed to via `window.filo.on(...)`, never invoked — they intentionally
 * have no entry here.
 */

/**
 * Non-empty string. Every IPC string arg that names a path,
 * filename, channel target, URL, or label is required to be at least one
 * character. Catches whitespace-stripped renderer typos before the main
 * process has to detect them via `path.join('') → ''` or `fs.access('')`.
 * Strings that carry file contents — `vault:write-file-text`'s third arg
 * is an explicit exception — are still plain `z.string()`; empty text is
 * a legitimate empty Markdown file.
 */
const nonEmptyString = z.string().min(1);
const optionalString = z.string().optional();

/** `recovery:keep-unsaved`'s copies: each a name and the text to keep. */
const keepUnsavedItems = z.array(z.object({ relPath: nonEmptyString, text: z.string() }).strict()).max(1000);

/**
 * Channels that accept an `unknown` payload typed at the renderer site. We
 * still gate arity (number of args) but the value itself is opaque to the
 * wrapper.
 */
const unknownArg = z.unknown();

/**
 * The schema map. Each entry is `[args] → z.ZodTuple`. Marked as a const
 * `Partial<Record<...>>` so adding a new IpcChannel produces a soft miss
 * (validation falls through, channel still works) rather than a compile
 * error — but every channel listed below has an explicit schema so the
 * coverage is wide.
 */
export const IPC_PAYLOAD_SCHEMAS = {
  // ── Vault ─────────────────────────────────────────────────────────────
  'vault:select': z.tuple([]),
  'vault:read-tree': z.tuple([nonEmptyString]),
  'vault:create-folder': z.tuple([nonEmptyString, nonEmptyString]),
  'vault:suggest-folder-name': z.tuple([nonEmptyString, nonEmptyString, nonEmptyString]),
  'vault:rename': z.tuple([nonEmptyString, nonEmptyString, nonEmptyString]),
  'vault:delete': z.tuple([nonEmptyString, nonEmptyString]),
  'vault:watch': z.tuple([nonEmptyString]),
  // The vault to release; the handler releases it only while it is the
  // active one (idempotent on already-closed state).
  'vault:close': z.tuple([nonEmptyString]),
  // Explicit positional shape (sourcePath, vaultRoot, destFolder?): the
  // union models the two real call shapes — 2 args (drop at vault root) and
  // 3 args (explicit subfolder) — without permitting unbounded trailing
  // strings the way `.rest()` would.
  'vault:copy-file': z.union([
    z.tuple([nonEmptyString, nonEmptyString]),
    z.tuple([nonEmptyString, nonEmptyString, optionalString]),
  ]),
  // `vault:register-source-path` is preload-INTERNAL: the only
  // legitimate sender is the preload's `getPathForFile` via a direct
  // `ipcRenderer.send` (which bypasses this gate entirely). `z.never()` matches
  // NO argument shape, so any attempt to reach it through the contextBridge
  // `api.send`/`api.invoke` (i.e. `window.filo.send('vault:register-source-path',
  // …)` from hostile renderer JS) fails validation and is dropped before it can
  // self-approve an arbitrary copy source. Do NOT relax this to a real tuple.
  'vault:register-source-path': z.never(),
  // (vaultRoot, relativePath).
  'vault:read-file-text': z.tuple([nonEmptyString, nonEmptyString]),
  // Third arg `content` stays plain z.string(): empty Markdown is legal.
  'vault:write-file-text': z.tuple([nonEmptyString, nonEmptyString, z.string()]),
  // Optional fourth arg: the stat of the version the renderer read. The write
  // is refused with code STALE when the file no longer matches it.
  'vault:write-existing-file-text': z.tuple([
    nonEmptyString,
    nonEmptyString,
    z.string(),
    z.object({
      mtimeMs: z.number().finite(),
      size: z.number().int().nonnegative(),
      hash: z.string().regex(/^[0-9a-f]{8}$/).optional(),
    }).strict().optional(),
  ]),
  // Create-exclusive seed; same shape as write-file-text.
  'vault:create-file-text': z.tuple([nonEmptyString, nonEmptyString, z.string()]),
  // `(vaultRoot, relativePath, base64Data)`. The base64
  // string can be empty for an empty file, so the third arg is plain
  // `z.string()` and the handler enforces the decoded byte cap.
  'vault:file-exists': z.tuple([nonEmptyString, nonEmptyString]),
  'vault:stat': z.tuple([nonEmptyString, nonEmptyString]),
  'vault:init-config': z.tuple([nonEmptyString]),
  'vault:get-launch-preference': z.tuple([]),
  'vault:set-open-on-launch': z.tuple([unknownArg]),
  'vault:list-recents': z.tuple([]),
  'vault:add-recent': z.tuple([unknownArg, unknownArg, optionalString]),
  'vault:remove-recent': z.tuple([unknownArg]),
  'vault:pin-recent': z.tuple([unknownArg, unknownArg]),
  'vault:clear-recents': z.tuple([]),
  // Optional `{ now }`: a walk past the throttle, its findings sent before the reply.
  'vault:reconcile': z.union([
    z.tuple([]),
    z.tuple([z.object({ now: z.boolean().optional() }).strict()]),
  ]),
  // (vaultRoot, old folder, new folder): a folder move the renderer followed.
  'vault:followed-move': z.tuple([nonEmptyString, nonEmptyString, nonEmptyString]),

  // ── Boards ────────────────────────────────────────────────────────────
  'board:list': z.tuple([nonEmptyString]),
  'board:load': z.tuple([nonEmptyString, nonEmptyString]),
  // Optional 4th arg: `{ recreate }` lets the save make the board's folder
  // again (the user's "Save at original location"); otherwise it never does.
  'board:save': z.union([
    z.tuple([nonEmptyString, nonEmptyString, unknownArg]),
    z.tuple([nonEmptyString, nonEmptyString, unknownArg, z.object({ recreate: z.boolean().optional() }).strict()]),
  ]),
  'board:create': z.tuple([nonEmptyString, nonEmptyString, unknownArg]).rest(optionalString),
  'board:list-conflicts': z.tuple([nonEmptyString]),

  // ── Recovery snapshot ─────────────────────────────────────────────────
  // Optional 3rd arg: why the copy is taken (see SnapshotPurpose).
  'recovery:snapshot': z.union([
    z.tuple([nonEmptyString, nonEmptyString]),
    z.tuple([nonEmptyString, nonEmptyString, z.enum(['keep', 'load-failure'])]),
  ]),
  'recovery:list': z.tuple([nonEmptyString]),
  'recovery:list-sentinels': z.tuple([nonEmptyString]),
  // (vaultRoot, [{ relPath, text }], purpose?): the text to keep in .filo/recovery.
  'recovery:keep-unsaved': z.union([
    z.tuple([nonEmptyString, keepUnsavedItems]),
    z.tuple([nonEmptyString, keepUnsavedItems, z.literal('keep')]),
  ]),
  'recovery:preserved-tmp': z.tuple([nonEmptyString]),
  // (vaultRoot, a copy's path in .filo/recovery, as recovery:list gives it).
  'recovery:open': z.tuple([nonEmptyString, nonEmptyString]),
  // (vaultRoot, copies' paths, permanently?): to the Recycle Bin, or for good.
  'recovery:delete': z.union([
    z.tuple([nonEmptyString, z.array(nonEmptyString).min(1).max(10_000)]),
    z.tuple([nonEmptyString, z.array(nonEmptyString).min(1).max(10_000), z.boolean()]),
  ]),
  'app:machine-identity': z.tuple([]),
  'vault:convert-to-utf8': z.tuple([nonEmptyString, nonEmptyString]),
  'vault:sweep-orphan-tmp': z.tuple([nonEmptyString]),
  // (vaultRoot, vault-relative path).
  'vault:trash-move': z.tuple([nonEmptyString, nonEmptyString]),
  // (vaultRoot, trashId, { movedTo }?). The id format and the path are checked main-side.
  'vault:trash-restore': z.union([
    z.tuple([nonEmptyString, nonEmptyString]),
    z.tuple([nonEmptyString, nonEmptyString, z.object({ movedTo: nonEmptyString }).strict()]),
  ]),
  'vault:trash-list': z.tuple([nonEmptyString]),
  // (vaultRoot, trash ids | the retention sweep).
  'vault:trash-purge': z.tuple([nonEmptyString, z.union([z.array(nonEmptyString).max(10_000), z.literal('olderThan30d')])]),
  'vault:trash-delete-permanently': z.tuple([nonEmptyString, z.array(nonEmptyString).max(10_000)]),

  // ── Config (.filo/) ───────────────────────────────────────────────────
  'config:load': z.tuple([nonEmptyString, nonEmptyString]),
  // Optional 4th arg: `{ createOnly }` recreates a config deleted outside Filo
  // without overwriting a copy that came back meanwhile (EEXIST).
  'config:save': z.union([
    z.tuple([nonEmptyString, nonEmptyString, unknownArg]),
    z.tuple([nonEmptyString, nonEmptyString, unknownArg, z.object({ createOnly: z.boolean().optional() }).strict()]),
  ]),
  'config:load-all': z.tuple([nonEmptyString]),
  'config:save-workspace': z.tuple([nonEmptyString, unknownArg]),

  // ── Tags ──────────────────────────────────────────────────────────────
  'tags:load': z.tuple([nonEmptyString]),
  // Second arg `data` is a JSON-stringified payload; an empty JSON literal
  // (`{}`) round-trips through here so we still allow zero-length strings.
  'tags:save': z.tuple([nonEmptyString, z.string()]),

  // ── Themes ────────────────────────────────────────────────────────────
  'theme:list': z.tuple([nonEmptyString]),
  'theme:load': z.tuple([nonEmptyString, nonEmptyString]),
  'theme:save': z.tuple([nonEmptyString, nonEmptyString, unknownArg]),
  'theme:delete': z.tuple([nonEmptyString, nonEmptyString]),

  // ── Layout templates ──────────────────────────────────────────────────
  'templates:layout:list': z.tuple([nonEmptyString]),
  'templates:layout:write': z.tuple([nonEmptyString, nonEmptyString, unknownArg]),
  'templates:layout:rename': z.tuple([nonEmptyString, nonEmptyString, nonEmptyString]),
  'templates:layout:delete': z.tuple([nonEmptyString, nonEmptyString]),

  // ── Dialogs ───────────────────────────────────────────────────────────
  // Dialog options are passed through to Electron's `showMessageBox` /
  // `showOpenDialog` — we don't re-validate the inner shape, just the arity.
  // Multi-button "Save / Don't Save / Cancel"-style dialog.
  // Args: (message, buttons[], options?). Returns the selected button index.
  'dialog:choice': z
    .tuple([nonEmptyString, z.array(nonEmptyString).min(2)])
    .rest(unknownArg),
  'dialog:open-file': z.tuple([]).rest(unknownArg),

  // ── Media ─────────────────────────────────────────────────────────────
  'media:save-audio': z
    .tuple([nonEmptyString, nonEmptyString, nonEmptyString])
    .rest(optionalString),
  'media:read-file': z.tuple([nonEmptyString, nonEmptyString]),
  'media:open-external': z.tuple([nonEmptyString]),

  // ── Link metadata ─────────────────────────────────────────────────────
  'link:fetch-metadata': z.tuple([nonEmptyString]),

  // ── Fonts ─────────────────────────────────────────────────────────────
  'font:list-system': z.tuple([]),
  'font:import': z.tuple([]).rest(optionalString),
  'font:list-imported': z.tuple([nonEmptyString]),

  // ── Shell / OS ────────────────────────────────────────────────────────
  'shell:show-item-in-folder': z.tuple([nonEmptyString]),
  // Text, and for a Filo link the name it reads as (main checks both again).
  'shell:copy-text': z.union([
    z.tuple([nonEmptyString.max(100_000)]),
    z.tuple([nonEmptyString.max(4_000), z.string().max(500)]),
  ]),

  // ── App lifecycle (renderer → main) ───────────────────────────────────
  'app:ready-to-quit': z.tuple([]),
  // Same shape as `app:ready-to-quit`; semantics differ in main.
  'app:cancel-quit': z.tuple([]),
  // Awaiting-user signal (no args); main clears its flush timer.
  'app:quit-awaiting-user': z.tuple([]),
  // Periodic drain heartbeat (no args); main re-arms its timer.
  'app:drain-heartbeat': z.tuple([]),
  // The session-end rescue is done (no args); main lets Windows go on.
  'app:session-ending-done': z.tuple([]),
  // Whether leaving now could lose work.
  'app:unsaved-state': z.tuple([z.boolean()]),
  // The answer to a text menu's query: its id, and whether a link can go at the caret.
  'app:text-menu-reply': z.tuple([z.number().int(), z.object({ link: z.enum(['insert', 'edit', 'none']) })]),

  // ── Sidebar geometry ──────────────────────────────────────────────────
  'sidebar:get-state': z.tuple([]),
  'sidebar:set-state': z.tuple([unknownArg]),
} as const satisfies Partial<Record<IpcChannel, z.ZodType>>;

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validates the positional args for an IPC channel against
 * `IPC_PAYLOAD_SCHEMAS`. Channels without a schema fall through as `ok` —
 * better to skip validation than crash a flow when a new channel is added
 * and someone forgets the schema. The `gates:ipc-parity` gate already catches
 * channel-name drift between main + renderer; the schema map is opt-in
 * narrowing on top.
 */
export function validateIpcPayload(
  channel: string,
  args: readonly unknown[],
): ValidationResult {
  const schema = (IPC_PAYLOAD_SCHEMAS as Record<string, z.ZodType | undefined>)[channel];
  if (!schema) return { ok: true };
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true };
  return { ok: false, error: parsed.error.message };
}
