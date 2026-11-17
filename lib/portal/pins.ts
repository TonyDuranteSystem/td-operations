/**
 * Pinned messages in Portal Chat (Antonio, 2026-11-17): the "Pinned" strip used to be built only from the messages already loaded on screen
 * (the newest 50 plus any older pages opened by hand), so a pin older than that was invisible, and clicking a pin did nothing when its
 * message was not on screen. The strip now also reads the conversation's pins from the server (`GET /api/portal/chat?...&pinned=1`) and
 * these pure helpers decide what the strip shows.
 */

/** The most pins one conversation's strip loads. Newest pin first. */
export const PINS_LIMIT = 50

/** After this many pages (50 messages each) a click on a pin gives up looking for its message and says so. */
export const PIN_JUMP_MAX_PAGES = 30

export interface PinLike {
  id: string
  pinned_at?: string | null
  deleted_at?: string | null
}

const isLivePin = (m: PinLike): boolean => !!m.pinned_at && !m.deleted_at

/**
 * What the Pinned strip shows: the pins the server returned, kept honest by the live message window (which realtime updates the moment
 * someone pins, unpins or deletes). A message in the live window decides for itself: pinned → shown (its fresher copy wins), not
 * pinned or deleted → removed. A copy in an older page opened earlier is never trusted — it can be stale. Newest pin first.
 * With no server list yet (still loading, or it failed) the strip falls back to the pins in what is loaded, as before.
 */
export function mergePins<T extends PinLike>(serverPins: readonly T[] | undefined, liveWindow: readonly T[], loadedAll: readonly T[]): T[] {
  const byId = new Map<string, T>()
  if (serverPins) {
    for (const p of serverPins) if (isLivePin(p)) byId.set(p.id, p)
    for (const m of liveWindow) {
      if (isLivePin(m)) byId.set(m.id, m)
      else byId.delete(m.id)
    }
  } else {
    for (const m of loadedAll) if (isLivePin(m)) byId.set(m.id, m)
  }
  return Array.from(byId.values()).sort((a, b) => Date.parse(b.pinned_at as string) - Date.parse(a.pinned_at as string))
}

/**
 * Does this realtime change to a message change WHICH messages are pinned? (Read marks and edits fire constantly and must not refetch the list.)
 * True when it became pinned and is not in the pins list, or stopped being pinned / was deleted and is in it.
 */
export function pinSetChanged(currentPins: readonly PinLike[] | undefined, updated: PinLike): boolean {
  if (!currentPins) return false
  const inList = currentPins.some(p => p.id === updated.id)
  return isLivePin(updated) !== inList
}
