/**
 * CRM Store — the TRASH screen and RESTORE (master plan Part 14 "trash view with restore", Antonio "go" 2026-09-28).
 *
 * Deleting (a file, or a folder with everything in it) already moves it to the store's trash as ONE batch,
 * recoverable for 90 days (`store_trash_file` / `store_trash_folder`), and removes its CRM documents listing so the
 * portal stops showing it. This module adds:
 *   - remembering the removed CRM listing (event `crm_rows_removed`) so a restore brings back the SAME listing
 *     (same company / person links, category, type) — but HIDDEN from the client;
 *   - the trash list per storage (what, when, by whom, when it is deleted for good);
 *   - restore (`store_restore_batch`), then: CRM listing back hidden, the store's own "shown" flag off, and never
 *     shared with staff (a restored file always starts hidden and unshared).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

type DocRow = Record<string, unknown>

/**
 * The ONLY listing columns kept for a restore. Never the scanned text (ocr_text / page count / confidence — a
 * passport's number, date of birth …: the event log is permanent and must not outlive the 90-day purge), never
 * the client-visibility columns (portal_visible, client_notified_at), and never flow_stage: the portal shows a
 * workspace document by its stage whatever portal_visible says, so keeping it would make a "hidden" restore visible.
 */
export const REMEMBERED_COLUMNS = [
  "drive_file_id", "file_name", "mime_type", "file_size", "drive_link", "document_type_id", "document_type_name",
  "category", "category_name", "account_id", "account_name", "contact_id", "tax_year", "service_delivery_id", "notify_client", "created_at",
] as const

/** Pure: keep only the remembered columns of a removed listing row. */
export function rememberable(row: DocRow): DocRow {
  const out: DocRow = {}
  for (const k of REMEMBERED_COLUMNS) if (k in row) out[k] = row[k]
  return out
}

/** Remember the CRM listing rows removed when files went to the trash (so a restore can put them back). */
export async function rememberRemovedRows(rows: DocRow[], actorId: string | null): Promise<void> {
  const byFile = new Map<string, DocRow[]>()
  for (const r of rows) {
    const ptr = String(r.drive_file_id ?? "")
    if (!ptr.startsWith("store:")) continue
    const fid = ptr.slice("store:".length)
    byFile.set(fid, [...(byFile.get(fid) ?? []), rememberable(r)])
  }
  for (const [fileId, list] of Array.from(byFile.entries())) {
    const { data: f } = await db().from("store_files").select("owner_id, folder_id, name").eq("id", fileId).maybeSingle()
    if (!f) continue
    const { error } = await db().from("store_events").insert({
      event: "crm_rows_removed", actor: actorId, owner_id: f.owner_id, file_id: fileId, folder_id: f.folder_id, name_snapshot: f.name,
      details: { rows: list },
    })
    if (error) console.error(`[crm-store] the removed CRM listing of ${fileId} was not remembered: ${error.message}`)
  }
}

export interface TrashItem { kind: "file" | "folder"; id: string; name: string; mimeType: string | null }
export interface TrashBatchView {
  batchId: string; trashedAt: string; purgeAfter: string | null; trashedBy: string | null
  topName: string | null; folders: number; files: number; held: number; items: TrashItem[]
}

/** The trash of one storage: each deletion (batch) with its top items, newest first. */
export async function trashForOwner(ownerId: string): Promise<TrashBatchView[]> {
  const { data: batches, error } = await db().rpc("store_trash_list", { p_owner_id: ownerId })
  if (error) throw new Error(`Could not read the trash (${error.message}).`)
  const list = (batches ?? []) as Array<{ batch_id: string; trashed_at: string; purge_after: string | null; trashed_by: string | null; top_name: string | null; folders: number; files: number; held_files: number }>
  if (!list.length) return []
  const ids = list.map((b) => b.batch_id)
  const [{ data: fs, error: fErr }, { data: ds, error: dErr }] = await Promise.all([
    db().from("store_files").select("id, name, folder_id, trash_batch_id, store_file_versions!store_files_current_version_fk(mime_type)").in("trash_batch_id", ids).eq("state", "trashed"),
    db().from("store_folders").select("id, name, parent_id, trash_batch_id").in("trash_batch_id", ids).not("trashed_at", "is", null),
  ])
  if (fErr || dErr) throw new Error(`Could not read the trash (${(fErr ?? dErr).message}).`)
  const folders = (ds ?? []) as Array<{ id: string; name: string; parent_id: string | null; trash_batch_id: string }>
  const trashedFolderIds = new Set(folders.map((d) => `${d.trash_batch_id}:${d.id}`))
  const items = new Map<string, TrashItem[]>()
  const add = (b: string, it: TrashItem) => items.set(b, [...(items.get(b) ?? []), it])
  // only the TOP of each deletion (a folder's contents come back with it)
  for (const d of folders) if (!trashedFolderIds.has(`${d.trash_batch_id}:${d.parent_id}`)) add(d.trash_batch_id, { kind: "folder", id: d.id, name: d.name, mimeType: null })
  for (const f of (fs ?? []) as Array<{ id: string; name: string; folder_id: string; trash_batch_id: string; store_file_versions: { mime_type: string | null } | null }>) {
    if (!trashedFolderIds.has(`${f.trash_batch_id}:${f.folder_id}`)) add(f.trash_batch_id, { kind: "file", id: f.id, name: f.name, mimeType: f.store_file_versions?.mime_type ?? null })
  }
  const names = await staffNames(list.map((b) => b.trashed_by).filter((x): x is string => !!x))
  return list
    .map((b) => ({
      batchId: b.batch_id, trashedAt: b.trashed_at, purgeAfter: b.purge_after, trashedBy: b.trashed_by ? names.get(b.trashed_by) ?? "a staff member" : null,
      topName: b.top_name, folders: Number(b.folders) || 0, files: Number(b.files) || 0, held: Number(b.held_files) || 0,
      items: (items.get(b.batch_id) ?? []).sort((x, y) => x.name.localeCompare(y.name)),
    }))
    .filter((b) => b.items.length > 0)
    .sort((a, b) => b.trashedAt.localeCompare(a.trashedAt))
}

async function staffNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!ids.length) return out
  try {
    const { listAllAuthUsers } = await import("@/lib/auth-admin-helpers")
    for (const u of await listAllAuthUsers()) if (ids.includes(u.id)) out.set(u.id, (u.user_metadata?.full_name as string | undefined) || u.email || "a staff member")
  } catch { /* names are a nicety — the trash still lists without them */ }
  return out
}

export interface RestoreResult { files: number; folders: number; renamed: string[]; skipped: Array<{ name: string; why: string }>; listingsBack: number; notRelisted: string[] }

/** Restore one deletion. Everything comes back HIDDEN from the client and unshared; the CRM listing comes back. */
export async function restoreFromTrash(batchId: string, actorId: string | null, targetFolderId: string | null): Promise<RestoreResult> {
  if (!actorId) throw new Error("Only a signed-in staff member can restore from the trash.")
  const { data, error } = await db().rpc("store_restore_batch", { p_batch_id: batchId, p_actor: actorId, p_target_folder: targetFolderId })
  if (error) {
    const m = error.message.replace(/^store: /, "")
    if (/is gone — choose where/i.test(m)) throw Object.assign(new Error(m), { code: "NEEDS_TARGET" })
    throw new Error(m)
  }
  const report = (data ?? { restored: [], skipped: [] }) as { restored: Array<{ kind: string; id: string; name: string; renamed: boolean }>; skipped: Array<{ kind: string; name: string; why: string }> }
  const files = report.restored.filter((r) => r.kind === "file").map((r) => r.id)
  // per file: hidden in the store and its CRM listing back — a few at a time, each on its own, so one failure
  // never stops the rest (a file left without a listing simply stays invisible to the client, the safe side)
  let listingsBack = 0
  const failed: string[] = []
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(files.slice(i, i + 8).map(async (fileId) => {
      try {
        const { error: pErr } = await db().rpc("store_set_published", { p_file_id: fileId, p_published: false, p_actor: actorId })
        if (pErr) throw new Error(pErr.message)
        listingsBack += await putListingBack(fileId, actorId)
      } catch (e) {
        failed.push(report.restored.find((r) => r.id === fileId)?.name ?? fileId)
        console.error(`[crm-store] restore: ${fileId} restored, but its listing / hidden flag failed: ${e instanceof Error ? e.message : e}`)
      }
    }))
  }
  const { clearShares } = await import("./staff-share")
  await clearShares(files, actorId, "restored from the trash — starts unshared").catch((e: unknown) => console.error("[crm-store] shares not cleared on restore:", e))
  return {
    files: files.length,
    folders: report.restored.filter((r) => r.kind === "folder").length,
    renamed: report.restored.filter((r) => r.renamed).map((r) => r.name),
    skipped: report.skipped.map((s) => ({ name: s.name, why: s.why })),
    listingsBack,
    notRelisted: failed,
  }
}

/** The CRM listing of a restored file: the remembered rows (hidden), else a fresh hidden row for its storage. */
async function putListingBack(fileId: string, actorId: string | null): Promise<number> {
  const { storePointer } = await import("./document-pointer")
  const ptr = storePointer(fileId)
  const { data: existing } = await db().from("documents").select("id").eq("drive_file_id", ptr).limit(1)
  if ((existing ?? []).length) return 0
  const { data: f } = await db().from("store_files").select("id, name, document_type, folder_id, owner_id, store_owners(kind, account_id, contact_id, service_delivery_id), store_file_versions!store_files_current_version_fk(mime_type, size_bytes)").eq("id", fileId).maybeSingle()
  if (!f) return 0
  const owner = f.store_owners as { kind: string; account_id: string | null; contact_id: string | null; service_delivery_id: string | null } | null
  if (!owner || owner.kind === "business" || owner.kind === "private") return 0 // internal areas have no CRM listing
  const { data: ev } = await db().from("store_events").select("details").eq("file_id", fileId).eq("event", "crm_rows_removed").order("occurred_at", { ascending: false }).limit(1)
  const remembered = (((ev ?? [])[0]?.details?.rows ?? []) as DocRow[]).map(rememberable)
  if (remembered.length) {
    const { categoryForFolder } = await import("./structure")
    const { FOLDER_KIND_CATEGORY } = await import("./browse")
    const { data: tt } = f.document_type ? await db().from("catalog_entries").select("metadata").eq("catalog_id", "storage_document_types").eq("slug", f.document_type).maybeSingle() : { data: null }
    // the category follows where it was restored TO (it may not be its old folder)
    const cat = owner.kind === "person" || tt?.metadata?.personal === true ? null : await categoryForFolder(f.folder_id)
    void FOLDER_KIND_CATEGORY
    const rows = remembered.map((r) => ({ ...r, file_name: f.name, portal_visible: false, updated_at: new Date().toISOString(), ...(cat ? { category: cat.num, category_name: cat.name } : {}) }))
    const { error } = await db().from("documents").insert(rows)
    if (!error) return rows.length
    console.error(`[crm-store] restore: remembered listing of ${fileId} not re-inserted (${error.message}) — a fresh one is made`)
  }
  // no remembered listing (deleted before this was built): a fresh hidden row linked to the storage's client
  let account = owner.kind === "company" ? owner.account_id : null
  let contact = owner.kind === "person" ? owner.contact_id : null
  if (owner.kind === "formation" && owner.service_delivery_id) {
    const { data: sd } = await db().from("service_deliveries").select("account_id, contact_id").eq("id", owner.service_delivery_id).maybeSingle()
    account = sd?.account_id ?? null
    contact = sd?.contact_id ?? null
  }
  if (!account && !contact) return 0
  const { categoryForFolder } = await import("./structure")
  const { FOLDER_KIND_CATEGORY } = await import("./browse")
  const { data: t } = f.document_type ? await db().from("catalog_entries").select("display_name, metadata").eq("catalog_id", "storage_document_types").eq("slug", f.document_type).maybeSingle() : { data: null }
  const cat = t?.metadata?.personal === true ? FOLDER_KIND_CATEGORY.personal : await categoryForFolder(f.folder_id)
  const { upsertStoreDocumentRow } = await import("./formation-pilot")
  const v = f.store_file_versions as { mime_type: string | null; size_bytes: number | null } | null
  await upsertStoreDocumentRow(fileId, {
    file_name: f.name, mime_type: v?.mime_type ?? null, file_size: v?.size_bytes ?? null, document_type_name: t?.display_name ?? null,
    category: cat.num, category_name: cat.name, account_id: account, contact_id: contact, portal_visible: false,
  }, "created")
  void actorId
  return 1
}

/** The storage a trash batch belongs to (for the access check before a restore). */
export async function ownerOfBatch(batchId: string): Promise<string> {
  const { data: f } = await db().from("store_files").select("owner_id").eq("trash_batch_id", batchId).limit(1)
  if ((f ?? []).length) return f[0].owner_id as string
  const { data: d } = await db().from("store_folders").select("owner_id").eq("trash_batch_id", batchId).limit(1)
  if ((d ?? []).length) return d[0].owner_id as string
  throw new Error("Nothing in the trash with that reference.")
}
