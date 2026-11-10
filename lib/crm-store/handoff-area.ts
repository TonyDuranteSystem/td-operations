/**
 * Where a client's chat file can be saved from the Portal Chats "Save to Storage" pop-up (dev job fb49265a; Antonio 2026-11-10: "if I want to
 * save a document in another folder like Business?"). Pure, no database, safe in the browser.
 *  - 'client'   = that client's own storage (the company, or the person in a person's own thread) — the default;
 *  - 'business' = the firm's own Business folders (no client, no document type — the same plain upload Storage gives Business).
 */
export type HandoffArea = "client" | "business"

/** The part of the Storage navigation answer this needs (`GET /api/crm-store/browse/navigation`). */
export interface NavGroupLike { key: string; owners: Array<{ id: string }> }

/**
 * The Business storage's owner id for this login, or null when the login is not offered Business (the navigation only lists what the
 * person may open). Same lookup the Storage screen's own "Where in the Business folders?" question uses.
 */
export function businessOwnerIdOf(groups: NavGroupLike[] | null | undefined): string | null {
  if (!Array.isArray(groups)) return null
  const g = groups.find((x) => x && x.key === "business")
  const id = g && Array.isArray(g.owners) ? g.owners[0]?.id : null
  return typeof id === "string" && id ? id : null
}
