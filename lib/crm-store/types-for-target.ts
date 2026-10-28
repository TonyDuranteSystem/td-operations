/**
 * Which Storage document types a place takes — THE Storage rule, in one place (dev job e3215801: a workspace upload that ends up in
 * Storage must follow it, so the Storage page and the workspace upload box both call this, never their own copy).
 *
 *   a company's "2. Contacts" folder            -> only personal types (a person's own papers)
 *   a company storage                           -> only company types (not personal)
 *   a person's storage                          -> every type
 *   a company's person-folder reached "via" it  -> only personal types
 *   a staff member's private "My files"         -> every type
 *
 * Pure: no database, safe in the browser. `all` is the catalog list (`listDocumentTypes`).
 */

export interface TypeTarget {
  /** The kind of storage owner: "person", "company", "private" … */
  ownerKind: string
  /** The kind of folder the file lands in ("contacts", "itin", "personal" …). */
  folderKind?: string | null
  /** A person's folder opened through one of their companies. */
  viaCompany?: boolean
}

export function typesForTarget<T extends { personal: boolean }>(all: readonly T[] | null | undefined, t: TypeTarget): T[] {
  const via = !!t.viaCompany
  const isPerson = t.ownerKind === 'person' || via
  const contacts = t.folderKind === 'contacts'
  return (all ?? []).filter((x) => (via ? x.personal : isPerson ? true : contacts ? x.personal : t.ownerKind === 'private' ? true : !x.personal))
}
