// Draft memory of the Portal Chats message boxes (dev job f1f72ce2, 2026-11-27).
//
// Each conversation keeps its unsent reply in an in-memory map and in the browser's storage. When a conversation opens, an effect puts that
// conversation's draft into the box, and the same effect's cleanup saves the box's draft again when the conversation is left.
//
// The cleanup saves a SNAPSHOT of the box that is refreshed after every render. Right after a restore the snapshot still holds the PREVIOUS
// render's text (empty on a fresh page, the other conversation's words after a switch) until the next render. If React runs the cleanup in that
// gap — it does so on purpose, once, right after every mount in development (strict mode) — it saved that stale text over the real draft: the
// stored draft was erased and the box came up empty, or worse, the other conversation's words were saved under this conversation's key.
// The fix is to put the restored draft into the snapshot at restore time, so a cleanup in that gap saves exactly what was restored.

export interface DraftSnapshot<M, F> {
  replyText: string
  replyToMsg: M | null
  pendingAdminFiles: F[]
}

/** The snapshot for a restored draft (nothing saved = an empty box). Always a fresh object, never the saved entry itself. */
export function draftSnapshotFor<M, F>(
  saved: { replyText?: string | null; replyToMsg?: M | null; pendingAdminFiles?: readonly F[] | null } | null | undefined,
): DraftSnapshot<M, F> {
  return {
    replyText: saved?.replyText ?? '',
    replyToMsg: saved?.replyToMsg ?? null,
    pendingAdminFiles: saved?.pendingAdminFiles ? [...saved.pendingAdminFiles] : [],
  }
}

export interface PersistedDraftParts<M> {
  replyText: string
  replyToMsg: M | null
}

/**
 * What the box should hold when a conversation opens: the in-memory draft if there is one, else the draft saved in the browser's storage for
 * that conversation (also remembered in the map), else an empty box. `key` is null when no conversation is open.
 */
export function restoreClientDraft<M, F>(
  key: string | null,
  map: Map<string, DraftSnapshot<M, F>>,
  loadPersisted: (key: string) => PersistedDraftParts<M> | null,
): DraftSnapshot<M, F> {
  let saved = key ? map.get(key) : undefined
  if (!saved && key) {
    const persisted = loadPersisted(key)
    if (persisted) {
      saved = { replyText: persisted.replyText, replyToMsg: persisted.replyToMsg, pendingAdminFiles: [] }
      map.set(key, saved)
    }
  }
  return draftSnapshotFor(saved)
}

/** Saves the box's current draft for the conversation `key` (in memory and in the browser's storage). A null key (no conversation open) saves nothing. */
export function persistClientDraft<M, F>(
  key: string | null,
  map: Map<string, DraftSnapshot<M, F>>,
  snapshot: DraftSnapshot<M, F>,
  save: (key: string, entry: PersistedDraftParts<M>) => void,
): void {
  if (!key) return
  const copy = { ...snapshot }
  map.set(key, copy)
  save(key, { replyText: copy.replyText, replyToMsg: copy.replyToMsg })
}
