/**
 * CRM Store — working with many files (Antonio "go on both" 2026-09-28): the filters across one storage, the
 * file details panel, the folder zip download (logged) and the folder structure of a folder dragged in from the
 * computer. The group actions (move / show / hide / delete several files) reuse the one-file routes on the screen,
 * so every file still follows its own rules.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export type FilterKind = "shown" | "review" | "untyped"
export interface FilteredFile { id: string; name: string; folderId: string; where: string; mimeType: string | null; size: number | null; updatedAt: string; needsReview: string | null; documentType: string | null }

/** Pure: a folder's path (names under the storage's top folder) from a map of the storage's folders. */
export function pathOf(folderId: string, folders: Map<string, { name: string; parent_id: string | null }>): string {
  const names: string[] = []
  let cur: string | null = folderId
  for (let i = 0; i < 60 && cur; i++) {
    const f = folders.get(cur)
    if (!f) break
    if (f.parent_id) names.unshift(f.name) // the storage's top folder is not part of the path
    cur = f.parent_id
  }
  return names.join(" › ")
}

/** One storage's files that match a filter, across all its folders, each with where it lives. */
export async function filterFiles(ownerId: string, kind: FilterKind): Promise<FilteredFile[]> {
  const { data: fs, error: fErr } = await db().from("store_folders").select("id, name, parent_id").eq("owner_id", ownerId).is("trashed_at", null)
  if (fErr) throw new Error(`Could not read the folders (${fErr.message}).`)
  const folders = new Map(((fs ?? []) as { id: string; name: string; parent_id: string | null }[]).map((f) => [f.id, f]))
  const rows: Array<{ id: string; name: string; folder_id: string; updated_at: string; needs_review_at: string | null; needs_review_reason: string | null; document_type: string | null; store_file_versions: { mime_type: string | null; size_bytes: number | null } | null }> = []
  for (let from = 0; ; from += 1000) {
    let q = db().from("store_files").select("id, name, folder_id, updated_at, needs_review_at, needs_review_reason, document_type, store_file_versions!store_files_current_version_fk(mime_type, size_bytes)")
      .eq("owner_id", ownerId).eq("state", "live")
    if (kind === "review") q = q.not("needs_review_at", "is", null)
    if (kind === "untyped") q = q.is("document_type", null)
    const { data, error } = await q.order("id").range(from, from + 999)
    if (error) throw new Error(`Could not read the files (${error.message}).`)
    rows.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  let keep = rows
  if (kind === "shown") {
    const { storePointer } = await import("./document-pointer")
    const shown = new Set<string>()
    for (let i = 0; i < rows.length; i += 200) {
      const { data, error } = await db().from("documents").select("drive_file_id").in("drive_file_id", rows.slice(i, i + 200).map((r) => storePointer(r.id))).eq("portal_visible", true)
      if (error) throw new Error(`Could not check what the client sees (${error.message}).`)
      for (const d of data ?? []) shown.add(String(d.drive_file_id).slice("store:".length))
    }
    keep = rows.filter((r) => shown.has(r.id))
  }
  return keep.map((r) => ({
    id: r.id, name: r.name, folderId: r.folder_id, where: pathOf(r.folder_id, folders), mimeType: r.store_file_versions?.mime_type ?? null,
    size: r.store_file_versions?.size_bytes ?? null, updatedAt: r.updated_at, needsReview: r.needs_review_at ? (r.needs_review_reason || "Needs review") : null, documentType: r.document_type,
  })).sort((a, b) => a.where.localeCompare(b.where) || a.name.localeCompare(b.name))
}

export interface FileDetails {
  id: string; name: string; where: string; state: string
  type: string | null; typeName: string | null; year: number | null; filingStatus: string | null
  createdAt: string; createdBy: string | null; updatedAt: string
  versions: Array<{ versionNo: number; createdAt: string; size: number | null; by: string | null; current: boolean }>
  clientCanSee: boolean; listed: boolean; sharedWithStaff: string[] | null; needsReview: string | null
  links: Array<{ kind: string; taxYear: number | null }>
}

/** Everything the details panel shows about one file (read-only). */
export async function fileDetails(fileId: string): Promise<FileDetails> {
  const { data: f, error } = await db().from("store_files")
    .select("id, name, state, owner_id, folder_id, document_type, period_year, filing_status, created_at, created_by, updated_at, needs_review_at, needs_review_reason, store_owners(kind)")
    .eq("id", fileId).maybeSingle()
  if (error) throw new Error(`Could not read the file (${error.message}).`)
  if (!f) throw new Error("File not found.")
  const { data: fs } = await db().from("store_folders").select("id, name, parent_id").eq("owner_id", f.owner_id)
  const where = pathOf(f.folder_id, new Map(((fs ?? []) as { id: string; name: string; parent_id: string | null }[]).map((x) => [x.id, x])))
  const [{ data: t }, { listFileVersions }, { storePointer }] = await Promise.all([
    f.document_type ? db().from("catalog_entries").select("display_name").eq("catalog_id", "storage_document_types").eq("slug", f.document_type).maybeSingle() : Promise.resolve({ data: null }),
    import("./browse"), import("./document-pointer"),
  ])
  const versions = await listFileVersions(fileId)
  const { data: rows } = await db().from("documents").select("portal_visible").eq("drive_file_id", storePointer(fileId))
  const { data: links } = await db().from("store_record_links").select("link_kind, tax_year").eq("file_id", fileId)
  let sharedWith: string[] | null = null
  if ((f.store_owners as { kind: string } | null)?.kind === "private") {
    const { isInStaffShare, fileShares, listStaffLogins } = await import("./staff-share")
    if (await isInStaffShare(f.folder_id)) {
      const ids = await fileShares(fileId)
      const names = new Map((await listStaffLogins()).map((l) => [l.userId, l.name]))
      sharedWith = ids.map((id) => names.get(id) ?? "a staff login")
    }
  }
  let createdBy: string | null = null
  if (f.created_by) {
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(f.created_by)
    createdBy = (u?.user?.user_metadata?.full_name as string | undefined) || u?.user?.email || null
  }
  return {
    id: f.id, name: f.name, where, state: f.state,
    type: f.document_type, typeName: (t as { display_name?: string } | null)?.display_name ?? null, year: f.period_year, filingStatus: f.filing_status,
    createdAt: f.created_at, createdBy, updatedAt: f.updated_at,
    versions: versions.map((v) => ({ versionNo: v.versionNo, createdAt: v.createdAt, size: v.size, by: v.by, current: v.current })),
    clientCanSee: ((rows ?? []) as { portal_visible: boolean | null }[]).some((r) => r.portal_visible === true), listed: (rows ?? []).length > 0,
    sharedWithStaff: sharedWith, needsReview: f.needs_review_at ? (f.needs_review_reason || "Needs review") : null,
    links: ((links ?? []) as { link_kind: string; tax_year: number | null }[]).map((l) => ({ kind: l.link_kind, taxYear: l.tax_year })),
  }
}

/** Pure: a dragged-in folder's sub-folder path of one file ("Taxes/2024/w2.pdf" → ["Taxes","2024"]); names checked. */
export function draggedFolderPath(relativePath: string): string[] {
  const parts = relativePath.split("/").map((p) => p.trim()).filter(Boolean)
  parts.pop() // the file name itself
  return parts
}

/**
 * Make (or reuse) the folder path of a folder dragged in from the computer, under a folder. Inside a Tax folder a
 * four-digit level ("2024") becomes a real tax-year folder (reused if it exists); every other level is a staff
 * folder. Returns the last folder and its EFFECTIVE kind (so the upload still asks the tax-year question when the
 * files land under Tax without a year).
 */
export async function ensureFolderPath(parentId: string, path: string[], actorId: string | null): Promise<{ id: string; kind: string }> {
  const { cleanFolderName } = await import("./names")
  const { effectiveKind, createTaxYear } = await import("./structure")
  const clean = path.map((p) => cleanFolderName(p))
  const { data: parent, error: pErr } = await db().from("store_folders").select("id, owner_id, kind, trashed_at").eq("id", parentId).maybeSingle()
  if (pErr) throw new Error(`Could not read the folder (${pErr.message}).`)
  if (!parent || parent.trashed_at) throw new Error("That folder is not available.")
  if (parent.kind === "contacts") throw new Error("\"2. Contacts\" shows each person's own storage — drop the folder into one of the person's folders.")
  if (parent.kind === "root") throw new Error("Drop the folder into one of the fixed folders, not at the very top.")
  let cur: string = parentId
  for (const seg of clean) {
    const k = await effectiveKind(cur)
    if ((k === "tax" || k === "person_tax") && /^(19|20)\d{2}$/.test(seg)) {
      const { data: kids, error: kErr } = await db().from("store_folders").select("id, name").eq("parent_id", cur).is("trashed_at", null)
      if (kErr) throw new Error(`Could not read the folder (${kErr.message}).`)
      const same = ((kids ?? []) as { id: string; name: string }[]).find((x) => x.name.trim() === seg)
      cur = same ? same.id : (await createTaxYear(cur, seg, actorId)).id
      continue
    }
    const { data, error } = await db().rpc("store_ensure_folder_path", { p_owner: parent.owner_id, p_parent: cur, p_path: [seg], p_actor: actorId })
    if (error) throw new Error(`The folders could not be created (${error.message.replace(/^store: /, "")}).`)
    cur = data as string
  }
  const { data: last } = await db().from("store_folders").select("kind").eq("id", cur).maybeSingle()
  // the kind the screen needs: a year folder is a year folder; a staff folder counts as the fixed folder above it
  const own = (last?.kind as string | undefined) ?? "custom"
  return { id: cur, kind: own === "custom" ? await effectiveKind(cur) : own }
}

/** Log a folder zip download (it can carry personal documents off the CRM). */
/** Record a folder zip download BEFORE it streams (the record says the download was started, with its size). */
export async function logZipDownload(folderId: string, files: number, bytes: number, actorId: string | null): Promise<string> {
  const { data: f, error: fErr } = await db().from("store_folders").select("id, owner_id, name").eq("id", folderId).maybeSingle()
  // no record, no download — also when the folder can't even be read
  if (fErr) throw new Error(`The download could not be recorded (${fErr.message}) — please try again.`)
  if (!f) throw new Error("Folder not found.")
  const { error } = await db().from("store_events").insert({ event: "zip_downloaded", actor: actorId, owner_id: f.owner_id, folder_id: f.id, name_snapshot: f.name, details: { files, bytes, note: "recorded when the download started" } })
  // no log, no download: a download that can carry personal documents must always be on record
  if (error) throw new Error(`The download could not be recorded (${error.message}) — please try again.`)
  return f.name as string
}
