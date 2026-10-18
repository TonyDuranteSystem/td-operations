/**
 * What a file saved from a Mac into a CLIENT folder needs besides its bytes (dev job 1992a087, P3 step B): it has NO document type (the Mac cannot
 * ask for one), so it is marked "Needs review — Saved from a Mac, choose its type" and gets its CRM `documents` row (listed hidden: portal_visible
 * false, no flow stage, no service link — so no workspace can show it). Staff then type it in the CRM like any other untyped file.
 *
 * WHAT KEEPS A CLIENT FROM SEEING IT (the real guards, not "unpublishable"): published=false in the store; the documents row hidden; and the portal
 * itself closes any store file that has no document type (dropStoreRowsClientCannotOpen / clientMayOpen → staffOnlyStorePointers), whatever flag a
 * row carries. Never set portal_visible=true on these rows.
 *
 * `ensureClientFileRecords` is IDEMPOTENT and cheap: it does nothing when the file's documents row already exists (so a staff member who typed the
 * file and cleared the mark is never put back in review). It is called after the save, again on every retry path, and by the nightly sweep —
 * so a crash between the write and the mark can never leave an unmarked file in a client folder.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isClientSaveOwner } from "./save-rules"
import { looksSensitiveByName } from "./sensitive"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export const NEEDS_TYPE_REASON = "Saved from a Mac — choose its type"
const ID_NUDGE = " (the name looks like an ID or ITIN paper — it may belong on the person's page)"

interface FileFacts {
  id: string; name: string; owner_id: string; folder_id: string; state: string; document_type: string | null
  ownerKind: string; account_id: string | null; contact_id: string | null; service_delivery_id: string | null
  mime: string | null; size: number | null
}

async function loadFacts(fileId: string): Promise<FileFacts | null> {
  const { data: f, error } = await db().from("store_files").select("id, name, owner_id, folder_id, state, document_type, current_version_id").eq("id", fileId).maybeSingle()
  if (error) throw new Error(`Could not read the file (${error.message}).`)
  if (!f) return null
  const { data: o, error: oErr } = await db().from("store_owners").select("kind, account_id, contact_id, service_delivery_id").eq("id", f.owner_id).maybeSingle()
  if (oErr) throw new Error(`Could not read the storage (${oErr.message}).`)
  if (!o) return null
  const { data: v } = f.current_version_id ? await db().from("store_file_versions").select("size_bytes, mime_type").eq("id", f.current_version_id).maybeSingle() : { data: null }
  return { id: f.id, name: f.name, owner_id: f.owner_id, folder_id: f.folder_id, state: f.state, document_type: f.document_type ?? null,
    ownerKind: o.kind, account_id: o.account_id ?? null, contact_id: o.contact_id ?? null, service_delivery_id: o.service_delivery_id ?? null,
    mime: v?.mime_type ?? null, size: v?.size_bytes == null ? null : Number(v.size_bytes) }
}

async function documentsRowExists(fileId: string): Promise<boolean> {
  const { storePointer } = await import("@/lib/crm-store/document-pointer")
  const { data, error } = await db().from("documents").select("id").eq("drive_file_id", storePointer(fileId)).limit(1)
  if (error) throw new Error(`Could not check the documents list (${error.message}).`)
  return (data ?? []).length > 0
}

async function rowFor(f: FileFacts) {
  const { rowLinksForOwner } = await import("@/lib/crm-store/owner-links")
  const { categoryForFolder } = await import("@/lib/crm-store/structure")
  const links = await rowLinksForOwner({ kind: f.ownerKind, account_id: f.account_id, contact_id: f.contact_id, service_delivery_id: f.service_delivery_id })
  if (!links.account && !links.contact) throw new Error("This storage is not linked to a company or a client — files cannot be added here.")
  const cat = await categoryForFolder(f.folder_id)
  return {
    file_name: f.name, mime_type: f.mime, file_size: f.size, document_type_name: null, category: cat.num, category_name: cat.name,
    account_id: links.account, contact_id: links.contact, portal_visible: false as const,   // NEVER true here
  }
}

/** Make sure a Mac-saved file in a client folder is marked "Needs review" and has its documents row. No-op for other storages and for files that already have the row. */
export async function ensureClientFileRecords(fileId: string, actorId: string | null): Promise<{ applied: boolean }> {
  const f = await loadFacts(fileId)
  if (!f || f.state !== "live" || !isClientSaveOwner(f.ownerKind)) return { applied: false }
  if (await documentsRowExists(fileId)) return { applied: false }
  const reason = NEEDS_TYPE_REASON + (f.ownerKind === "company" && looksSensitiveByName(f.name) ? ID_NUDGE : "")
  const { markNeedsReview } = await import("@/lib/crm-store/structure")
  await markNeedsReview(fileId, reason, actorId)
  // markNeedsReview does nothing (and does not fail) for a file that is not live — look at the result
  const { data: marked, error } = await db().from("store_files").select("needs_review_at").eq("id", fileId).maybeSingle()
  if (error || !marked?.needs_review_at) throw new Error("The file was saved, but it could not be marked \"Needs review\".")
  const { upsertStoreDocumentRow } = await import("@/lib/crm-store/formation-pilot")
  await upsertStoreDocumentRow(fileId, await rowFor(f), "created")
  return { applied: true }
}

/** After a new version of a still-untyped Mac-saved file: the documents row follows the new name / size / type of the stored file. */
export async function refreshClientRow(fileId: string): Promise<void> {
  const f = await loadFacts(fileId)
  if (!f || f.state !== "live" || !isClientSaveOwner(f.ownerKind)) return
  const { upsertStoreDocumentRow } = await import("@/lib/crm-store/formation-pilot")
  await upsertStoreDocumentRow(fileId, await rowFor(f), "versioned")
}

/** Nightly safety net: any Mac-saved file of the last 14 days in a client storage that still has no documents row gets its records. */
export async function sweepClientSaves(limit = 200): Promise<{ checked: number; repaired: number; failed: number }> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const { data, error } = await db().from("store_files").select("id, store_owners(kind)").like("caller_key", "storage-app:%").eq("state", "live").gt("created_at", since).limit(limit)
  if (error) throw new Error(`Could not list recent Mac saves (${error.message}).`)
  const rows = ((data ?? []) as { id: string; store_owners: { kind: string } | { kind: string }[] | null }[])
    .filter((r) => isClientSaveOwner((Array.isArray(r.store_owners) ? r.store_owners[0] : r.store_owners)?.kind))
  let repaired = 0, failed = 0
  for (const r of rows) {
    try { if ((await ensureClientFileRecords(r.id, null)).applied) repaired++ } catch (e) { failed++; console.error("[storage-app sweep]", r.id, e instanceof Error ? e.message : e) }
  }
  return { checked: rows.length, repaired, failed }
}
