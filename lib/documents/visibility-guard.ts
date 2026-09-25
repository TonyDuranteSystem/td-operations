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
 * every place that can flip a document visible shares one implementation
 * instead of copies drifting apart. THREE call sites depend on it today: both
 * branches of that route, and toggleDocumentPortalVisibility
 * (app/(dashboard)/accounts/actions.ts) — the direct per-document toggle used
 * by both the file manager and a contact's own document list, which a live
 * E2E pass (not code review alone) caught still being unguarded on the first
 * pass at this fix. Any new caller that can set portal_visible on a
 * documents row must check this first.
 *
 * Deliberately zero imports: components/accounts/file-manager.tsx and
 * components/contacts/contact-detail.tsx ('use client') both need this same
 * predicate to decide when to show the inline owner-resolution picker
 * (components/documents/resolve-personal-document.tsx) instead of letting the
 * guard just throw. PERSONAL_CATEGORY used to live in
 * lib/portal/document-alerts.ts, which pulls in supabaseAdmin and other
 * server-only code — importing it here would have dragged that into the
 * client bundle. It's defined here instead and re-exported from
 * document-alerts.ts, so this module is safe for a 'use client' file to
 * import directly and there's still exactly one definition.
 */

export const PERSONAL_CATEGORY = 2 // Contacts (personal)

export interface DocumentOwnership {
  category: number | null
  contact_id: string | null
}

export function isUnresolvedPersonalDocument(doc: DocumentOwnership): boolean {
  return doc.category === PERSONAL_CATEGORY && !doc.contact_id
}

/**
 * Portal viewing rule for personal documents (Master Rules MM6: personal docs are
 * visible only to the person they belong to). A category-2 document is hidden from a
 * portal viewer unless it is THEIR OWN: a co-member, a portal teammate (no contact id)
 * or anyone viewing a personal document with no resolved owner never sees it. Mirrors
 * the portal documents page's "My documents" rule; every portal route that lists or
 * serves documents must apply it (dev job 4c20a748, 2026-09-25). Null never matches null.
 */
export function isPersonalDocumentHiddenFrom(
  doc: DocumentOwnership,
  viewerContactId: string | null | undefined,
): boolean {
  if (doc.category !== PERSONAL_CATEGORY) return false
  if (!viewerContactId || !doc.contact_id) return true
  return doc.contact_id !== viewerContactId
}

export const UNRESOLVED_PERSONAL_DOC_MESSAGE =
  "This looks like a personal document (e.g. an ID or passport) that isn't linked to " +
  "one specific member yet, so we can't tell whose it is. Link it to the correct " +
  "contact first — sharing it now would show it to everyone on the account."
