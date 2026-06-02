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
 * Non-empty string. Phase 25 L7: every IPC string arg that names a path,
 * filename, channel target, URL, or label is required to be at least one
 * character. Catches whitespace-stripped renderer typos before the main
 * process has to detect them via `path.join('') → ''` or `fs.access('')`.
 * Strings that carry file contents — `vault:write-file-text`'s third arg
 * is an explicit exception — are still plain `z.string()`; empty text is
 * a legitimate empty Markdown file.
 */
const nonEmptyString = z.string().min(1);
const optionalString = z.string().optional();

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
  // Sprint B / B24 — no payload; the handler closes the active vault
  // unconditionally (idempotent on already-closed state).
  'vault:close': z.tuple([]),
  // Phase 3 / 3.6 — explicit positional shape (sourcePath, vaultRoot,
  // destFolder?). The previous `.rest(optionalString)` permitted any number
  // of trailing strings — every caller passes at most 3 args (the main
  // handler ignores anything past `destFolder`), so the rest-spread was
  // defensive-only and broadened the validated surface for no benefit.
  // The union models the two real call shapes — 2 args (drop at vault
  // root) and 3 args (explicit subfolder) — without permitting unbounded
  // trailing strings the way `.rest()` did.
  'vault:copy-file': z.union([
    z.tuple([nonEmptyString, nonEmptyString]),
    z.tuple([nonEmptyString, nonEmptyString, optionalString]),
  ]),
  // Phase 37 / 37.6 — canonical (vaultRoot, relativePath). The legacy
  // single-arg absolute-path branch is gone; every renderer caller has been
  // migrated.
  'vault:read-file-text': z.tuple([nonEmptyString, nonEmptyString]),
  // Third arg `content` stays plain z.string(): empty Markdown is legal.
  'vault:write-file-text': z.tuple([nonEmptyString, nonEmptyString, z.string()]),
  'vault:write-existing-file-text': z.tuple([nonEmptyString, nonEmptyString, z.string()]),
  // Phase 2 / 2.5 — `(vaultRoot, relativePath, base64Data)`. The base64
  // string can be empty for an empty file, so the third arg is plain
  // `z.string()` and the handler enforces the decoded byte cap.
  'vault:write-file-binary': z.tuple([nonEmptyString, nonEmptyString, z.string()]),
  'vault:file-exists': z.tuple([nonEmptyString, nonEmptyString]),
  'vault:stat': z.tuple([nonEmptyString, nonEmptyString]),
  'vault:init-config': z.tuple([nonEmptyString]),
  'vault:get-launch-preference': z.tuple([]),
  'vault:set-open-on-launch': z.tuple([unknownArg]),
  'vault:list-recents': z.tuple([]),
  'vault:add-recent': z.tuple([unknownArg, unknownArg]),
  'vault:remove-recent': z.tuple([unknownArg]),
  'vault:pin-recent': z.tuple([unknownArg, unknownArg]),
  'vault:clear-recents': z.tuple([]),
  'vault:reconcile': z.tuple([]),

  // ── Boards ────────────────────────────────────────────────────────────
  'board:list': z.tuple([nonEmptyString]),
  'board:load': z.tuple([nonEmptyString, nonEmptyString]),
  'board:save': z.tuple([nonEmptyString, nonEmptyString, unknownArg]),
  'board:create': z.tuple([nonEmptyString, nonEmptyString, unknownArg]).rest(optionalString),
  'board:delete': z.tuple([nonEmptyString, nonEmptyString]),

  // ── Recovery snapshot ─────────────────────────────────────────────────
  'recovery:snapshot': z.tuple([nonEmptyString, nonEmptyString]),

  // ── Config (.filo/) ───────────────────────────────────────────────────
  'config:load': z.tuple([nonEmptyString, nonEmptyString]),
  'config:save': z.tuple([nonEmptyString, nonEmptyString, unknownArg]),
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
  'dialog:confirm': z.tuple([nonEmptyString]).rest(optionalString),
  // Phase 31 A2.1 — multi-button "Save / Don't Save / Cancel"-style dialog.
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

  // ── Export ────────────────────────────────────────────────────────────
  // Second arg `data` may be a base64 binary blob, plain text, or JSON; an
  // empty string is unusual but legal for "export a board with no content".
  'export:save': z.tuple([nonEmptyString, z.string()]).rest(optionalString),

  // ── Fonts ─────────────────────────────────────────────────────────────
  'font:list-system': z.tuple([]),
  'font:import': z.tuple([]).rest(optionalString),

  // ── Shell / OS ────────────────────────────────────────────────────────
  'shell:show-item-in-folder': z.tuple([nonEmptyString]),

  // ── App lifecycle (renderer → main) ───────────────────────────────────
  'app:ready-to-quit': z.tuple([]),
  // 6.2.H4 — same shape as `app:ready-to-quit`; semantics differ in main.
  'app:cancel-quit': z.tuple([]),
  // Audit-4 DI-04 — quit heartbeat (no args); main clears its flush timer.
  'app:quit-awaiting-user': z.tuple([]),

  // ── Sidebar geometry ──────────────────────────────────────────────────
  'sidebar:get-state': z.tuple([]),
  'sidebar:set-state': z.tuple([unknownArg]),
} as const satisfies Partial<Record<IpcChannel, z.ZodTypeAny>>;

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validates the positional args for an IPC channel against
 * `IPC_PAYLOAD_SCHEMAS`. Channels without a schema fall through as `ok` —
 * better to skip validation than crash a flow when a new channel is added
 * and someone forgets the schema. The `ci:ipc-parity` gate already catches
 * channel-name drift between main + renderer; the schema map is opt-in
 * narrowing on top.
 */
export function validateIpcPayload(
  channel: string,
  args: readonly unknown[],
): ValidationResult {
  const schema = (IPC_PAYLOAD_SCHEMAS as Record<string, z.ZodTypeAny | undefined>)[channel];
  if (!schema) return { ok: true };
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true };
  return { ok: false, error: parsed.error.message };
}
