/**
 * CRM Store — the `store:<file id>` pointer in the CRM's `documents` list (slice 6, job 685467b5).
 *
 * Until Stage 1 moves the screens onto the store, the CRM and the portal keep listing documents from
 * the `documents` table. A document whose bytes live in the new store is listed there with
 * drive_file_id = `store:<store file id>` — the same idea as the older `storage:` pointer, one letter
 * apart, so every reader MUST check `store:` FIRST (a `storage:` check does not match it).
 *
 * The bytes are always read through the file's CURRENT version (a new version is served at once; a
 * trashed or purged file is not served at all) — never through a long-lived signed link.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export const STORE_POINTER_PREFIX = "store:"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function storePointer(fileId: string): string {
  if (!UUID_RE.test(fileId)) throw new Error(`store: not a file id: ${fileId}`)
  return `${STORE_POINTER_PREFIX}${fileId}`
}

/** The store file id inside a `store:` pointer; null for anything else (Drive id, `storage:` pointer). */
export function parseStorePointer(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(STORE_POINTER_PREFIX)) return null
  const id = value.slice(STORE_POINTER_PREFIX.length)
  return UUID_RE.test(id) ? id : null
}

export function isStorePointer(value: string | null | undefined): boolean {
  return parseStorePointer(value) !== null
}

/** The CRM's own link for a `documents` row (staff preview route) — relative, never a signed URL. */
export function storeDocumentLink(documentRowId: string): string {
  return `/api/documents/${documentRowId}/preview`
}

export class StoreFileUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StoreFileUnavailableError"
  }
}

// store_* tables are not in the generated types until they reach production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export interface StoreFileBytes { bytes: Buffer; mimeType: string | null; name: string }

/** Read a live store file's current version. Trashed / purged / missing → StoreFileUnavailableError. */
export async function readStoreFile(fileId: string): Promise<StoreFileBytes> {
  const { data: f, error } = await db()
    .from("store_files")
    .select("id, name, state, store_file_versions!store_files_current_version_fk(storage_bucket, storage_path, mime_type)")
    .eq("id", fileId)
    .maybeSingle()
  if (error) throw new Error(`store: could not read file ${fileId} — ${error.message}`)
  if (!f) throw new StoreFileUnavailableError("This document no longer exists.")
  if (f.state !== "live") throw new StoreFileUnavailableError("This document is in the trash or was removed.")
  const v = f.store_file_versions as { storage_bucket: string; storage_path: string; mime_type: string | null } | null
  if (!v) throw new StoreFileUnavailableError("This document has no saved content.")
  const { data, error: dlErr } = await db().storage.from(v.storage_bucket).download(v.storage_path)
  if (dlErr || !data) throw new StoreFileUnavailableError("This document's content could not be read.")
  return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: v.mime_type ?? data.type ?? null, name: f.name as string }
}

/**
 * Which of these `documents.drive_file_id` values point at a store file of a STAFF-ONLY document type
 * (catalog flag `staff_only` — today only the Formation Summary, which holds every member's personal
 * data). Such a file can never be shown to a client, whatever a CRM row's portal_visible says.
 * Non-store values are ignored. Fails CLOSED: store unreadable, file unknown, or a file whose type has
 * no catalog row → treated as staff-only.
 */
export async function staffOnlyStorePointers(values: Array<string | null | undefined>): Promise<Set<string>> {
  const ids = Array.from(new Set(values.map((v) => parseStorePointer(v)).filter((x): x is string => !!x)))
  const out = new Set<string>()
  if (ids.length === 0) return out
  try {
    const { data, error } = await db().from("store_files").select("id, document_type").in("id", ids)
    if (error) throw error
    const types = Array.from(new Set(((data ?? []) as { document_type: string | null }[]).map((r) => r.document_type).filter((t): t is string => !!t)))
    const staffOnly = new Set<string>()
    const catalogued = new Set<string>()
    if (types.length > 0) {
      const { data: cat, error: cErr } = await db().from("catalog_entries").select("slug, metadata")
        .eq("catalog_id", "storage_document_types").in("slug", types)
      if (cErr) throw cErr
      for (const c of (cat ?? []) as { slug: string; metadata: { staff_only?: boolean } | null }[]) {
        catalogued.add(c.slug)
        if (c.metadata?.staff_only === true) staffOnly.add(c.slug)
      }
    }
    const known = new Set<string>()
    for (const r of (data ?? []) as { id: string; document_type: string | null }[]) {
      known.add(r.id)
      // no type, or a type the catalog does not know → closed (never guess it is shareable)
      if (!r.document_type || !catalogued.has(r.document_type) || staffOnly.has(r.document_type)) out.add(storePointer(r.id))
    }
    for (const id of ids) if (!known.has(id)) out.add(storePointer(id)) // unknown file → closed
  } catch {
    for (const id of ids) out.add(storePointer(id))
  }
  return out
}

/**
 * Which of these pointers are store files of a PERSONAL document type (passport, ID …) that are NOT in a
 * person's own storage (e.g. filed with a company) — sharing those would show one person's document to
 * every co-owner. Fails CLOSED: any read error → every store pointer counts.
 */
export async function personalStoreFilesOutsidePerson(values: Array<string | null | undefined>): Promise<Set<string>> {
  const ids = Array.from(new Set(values.map((v) => parseStorePointer(v)).filter((x): x is string => !!x)))
  const out = new Set<string>()
  if (ids.length === 0) return out
  try {
    const { data, error } = await db().from("store_files").select("id, document_type, store_owners!inner(kind)").in("id", ids)
    if (error) throw error
    const rows = (data ?? []) as { id: string; document_type: string | null; store_owners: { kind: string } | null }[]
    const types = Array.from(new Set(rows.map((r) => r.document_type).filter((t): t is string => !!t)))
    const personal = new Set<string>()
    if (types.length > 0) {
      const { data: cat, error: cErr } = await db().from("catalog_entries").select("slug, metadata")
        .eq("catalog_id", "storage_document_types").in("slug", types)
      if (cErr) throw cErr
      for (const c of (cat ?? []) as { slug: string; metadata: { personal?: boolean } | null }[]) if (c.metadata?.personal === true) personal.add(c.slug)
    }
    for (const r of rows) if (r.document_type && personal.has(r.document_type) && r.store_owners?.kind !== "person") out.add(storePointer(r.id))
  } catch {
    for (const id of ids) out.add(storePointer(id))
  }
  return out
}
