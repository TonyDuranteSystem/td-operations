/**
 * Whether a document must stay hidden from the client because it's a personal
 * document (passport/ID/proof of address/BOI report — category 2, "Contacts")
 * with no resolved single owner.
 *
 * WHY THIS EXISTS (dev job f1dc4048 / ece21c44, 2026-09-14): processFile()
 * (lib/mcp/tools/doc.ts) already decides this correctly at classification time
 * and forces the row hidden — but app/api/accounts/[id]/files/process-and-share
 * unconditionally forced it back to visible in the SAME request, in both of its
 * branches, ignoring that decision. On a multi-member LLC where auto-resolution
 * can't pick a single owner, that meant every co-owner got notified by name of
 * a document that hadn't been confirmed as theirs — a notice with no retraction
 * path, since the client-alert "already notified" guard then blocks the correct
 * notification once a human later resolves the real owner. Extracted as its own
 * pure predicate (matching lib/documents/list-visibility.ts's convention) so
 * both call sites in that route share one implementation instead of two copies
 * of the same condition drifting apart.
 */

import { PERSONAL_CATEGORY } from "@/lib/portal/document-alerts"

export interface DocumentOwnership {
  category: number | null
  contact_id: string | null
}

export function isUnresolvedPersonalDocument(doc: DocumentOwnership): boolean {
  return doc.category === PERSONAL_CATEGORY && !doc.contact_id
}

export const UNRESOLVED_PERSONAL_DOC_MESSAGE =
  "This looks like a personal document (e.g. an ID or passport) that isn't linked to " +
  "one specific member yet, so we can't tell whose it is. Link it to the correct " +
  "contact first — sharing it now would show it to everyone on the account."
