// Applying a live (realtime) change of one chat message to the copy already on screen (dev job 8d077f3b).
//
// A realtime UPDATE carries the raw database row. For `sender_name` that is only the name STORED on the row, which is empty for every message
// that was not typed in the CRM — the name the screen shows for those (a staff row named from its login, a client row named from its contact)
// is worked out by the server when it reads the chat and is not in the row. A plain `{ ...existing, ...updated }` therefore wiped the shown
// name the moment anyone marked a message read, edited or pinned it (Bug-Hunter 2026-11-26). An empty name in the update never overwrites a
// name already shown; a real one still wins.

export function mergeLiveUpdate<T extends { sender_name?: string | null }>(existing: T, updated: T): T {
  const merged: T = { ...existing, ...updated }
  const incoming = typeof updated.sender_name === 'string' ? updated.sender_name.trim() : ''
  const shown = typeof existing.sender_name === 'string' ? existing.sender_name.trim() : ''
  if (!incoming && shown) merged.sender_name = existing.sender_name
  return merged
}
