/**
 * CRM Store — read-only staff browser of the NEW store (job 685467b5).
 *
 * Backs the "New storage" tab on the Storage page so staff can SEE what the new store holds (owners →
 * folders → files) while every flow still lists documents from the old documents list. View only: no
 * upload / rename / move / delete here (those come with the Stage-1 screens).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

// store_* tables are not in the generated types until they reach production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export interface BrowseOwner {
  id: string
  kind: "company" | "person" | "formation" | "unfiled"
  label: string
  status: string | null // "being formed" / "archived" / null
  fileCount: number
}

export interface BrowseFolder { id: string; name: string; kind: string; trashed: boolean }

export interface BrowseFile {
  id: string
  name: string
  documentType: string | null
  state: "live" | "trashed" | "purged" | string
  published: boolean
  /** What the client sees TODAY: a CRM documents row for this file is visible (never for staff-only). */
  clientVisible: boolean
  /** The file has a CRM documents row (without one the portal cannot show it at all). */
  listed: boolean
  /** Set when the file belongs to one of the company's people (shown in the company's "2. Contacts"). */
  personName: string | null
  /** The file is in a PERSON's own storage (a personal document may be shown only from there). */
  inPersonStorage: boolean
  staffOnly: boolean
  personal: boolean
  versions: number
  size: number | null
  mimeType: string | null
  updatedAt: string
}

/** Pure: the label shown for an owner (unit-tested). */
export function ownerLabel(o: { kind: string; company?: string | null; person?: string | null; root?: string | null }): string {
  if (o.kind === "company") return o.company || o.root || "Company"
  if (o.kind === "person") return o.person || o.root || "Person"
  if (o.kind === "formation") return o.root || "Company being formed"
  return "Unfiled"
}

/** Pure: the owner's status badge (unit-tested). */
export function ownerStatus(lifecycleOverride: string | null | undefined): string | null {
  if (lifecycleOverride === "in_formation") return "being formed"
  if (lifecycleOverride === "archived") return "archived"
  return null
}

export async function listOwners(): Promise<BrowseOwner[]> {
  const { data: owners, error } = await db().from("store_owners")
    .select("id, kind, account_id, contact_id, lifecycle_override, accounts(company_name), contacts(full_name)")
    .order("created_at", { ascending: false }).limit(500)
  if (error) throw new Error(`store browse: ${error.message}`)
  const ids = (owners ?? []).map((o: { id: string }) => o.id)
  const roots = new Map<string, string>()
  const counts = new Map<string, number>()
  if (ids.length > 0) {
    const { data: rs } = await db().from("store_folders").select("owner_id, name").in("owner_id", ids).is("parent_id", null)
    for (const r of rs ?? []) roots.set(r.owner_id as string, r.name as string)
    const { data: fs } = await db().from("store_files").select("owner_id").in("owner_id", ids).eq("state", "live")
    for (const f of fs ?? []) counts.set(f.owner_id as string, (counts.get(f.owner_id as string) ?? 0) + 1)
  }
  return (owners ?? []).map((o: { id: string; kind: BrowseOwner["kind"]; lifecycle_override: string | null; accounts: { company_name: string } | null; contacts: { full_name: string } | null }) => ({
    id: o.id,
    kind: o.kind,
    label: ownerLabel({ kind: o.kind, company: o.accounts?.company_name, person: o.contacts?.full_name, root: roots.get(o.id) }),
    status: ownerStatus(o.lifecycle_override),
    fileCount: counts.get(o.id) ?? 0,
  }))
}

/** A folder's children (or the owner's root when folderId is null) + its files, trashed ones included. */
export interface BrowsePerson { contactId: string; name: string }

export async function folderContents(ownerId: string, folderId: string | null): Promise<{ folder: BrowseFolder | null; path: BrowseFolder[]; folders: BrowseFolder[]; files: BrowseFile[]; people?: BrowsePerson[] }> {
  let current: BrowseFolder | null = null
  if (folderId) {
    const { data } = await db().from("store_folders").select("id, name, kind, owner_id, trashed_at").eq("id", folderId).maybeSingle()
    if (!data || data.owner_id !== ownerId) throw new Error("store browse: folder not found for this owner")
    current = { id: data.id, name: data.name, kind: data.kind, trashed: !!data.trashed_at }
  } else {
    const { data } = await db().from("store_folders").select("id, name, kind, trashed_at").eq("owner_id", ownerId).is("parent_id", null).maybeSingle()
    if (data) current = { id: data.id, name: data.name, kind: data.kind, trashed: !!data.trashed_at }
  }
  if (!current) return { folder: null, path: [], folders: [], files: [] }

  // breadcrumb (bounded walk up)
  const path: BrowseFolder[] = []
  let walk: string | null = current.id
  for (let i = 0; i < 20 && walk; i++) {
    const { data } = await db().from("store_folders").select("id, name, kind, parent_id, trashed_at").eq("id", walk).maybeSingle()
    if (!data) break
    path.unshift({ id: data.id, name: data.name, kind: data.kind, trashed: !!data.trashed_at })
    walk = data.parent_id
  }

  const { data: subs } = await db().from("store_folders").select("id, name, kind, trashed_at").eq("parent_id", current.id).is("trashed_at", null).order("name")
  const fileSelect = "id, name, owner_id, document_type, state, published, updated_at, store_file_versions!store_files_current_version_fk(size_bytes, mime_type)"
  // live files only: the trash is its own view (Stage 1) — a trashed file must not sit among the live ones
  const { data: fs, error } = await db().from("store_files").select(fileSelect)
    .eq("folder_id", current.id).eq("state", "live").order("name")
  if (error) throw new Error(`store browse: ${error.message}`)
  // "2. Contacts" of a company: the company's people's OWN documents (each person's own storage), shown
  // here read-only so a member's passport is visible on the company page — never copied into the company.
  const peopleFiles: typeof fs = []
  const personName = new Map<string, string>()
  const people: BrowsePerson[] = []
  if (current.kind === "contacts") {
    const { data: own } = await db().from("store_owners").select("account_id").eq("id", ownerId).maybeSingle()
    if (own?.account_id) {
      const { data: links, error: lErr } = await db().from("account_contacts").select("contact_id, contacts(full_name)").eq("account_id", own.account_id)
      if (lErr) throw new Error(`store browse: ${lErr.message}`)
      for (const l of (links ?? []) as { contact_id: string; contacts: { full_name: string | null } | null }[]) {
        people.push({ contactId: l.contact_id, name: l.contacts?.full_name || "Contact" })
      }
      const cids = (links ?? []).map((l: { contact_id: string }) => l.contact_id)
      if (cids.length > 0) {
        const { data: po } = await db().from("store_owners").select("id, contacts(full_name)").eq("kind", "person").in("contact_id", cids)
        const pids = (po ?? []).map((o: { id: string; contacts: { full_name: string } | null }) => {
          personName.set(o.id, o.contacts?.full_name ?? "Person")
          return o.id
        })
        if (pids.length > 0) {
          const { data: pf, error: pErr } = await db().from("store_files").select(fileSelect)
            .in("owner_id", pids).eq("state", "live").order("name")
          if (pErr) throw new Error(`store browse: ${pErr.message}`)
          peopleFiles.push(...(pf ?? []))
        }
      }
    }
  }
  // What the client sees TODAY is decided by the CRM documents row (the portal reads it) — so the badge
  // comes from the row, not from the store's own flag, and a file with no row says so.
  const all = [...(fs ?? []), ...peopleFiles]
  const rowsVisible = new Map<string, boolean>()
  if (all.length > 0) {
    const { storePointer } = await import("./document-pointer")
    const { data: rows, error: rErr } = await db().from("documents").select("drive_file_id, portal_visible")
      .in("drive_file_id", all.map((f: { id: string }) => storePointer(f.id)))
    if (rErr) throw new Error(`store browse: ${rErr.message}`)
    for (const r of rows ?? []) {
      const fid = String(r.drive_file_id).slice("store:".length)
      rowsVisible.set(fid, (rowsVisible.get(fid) ?? false) || r.portal_visible === true)
    }
  }
  const { data: curOwner } = await db().from("store_owners").select("kind").eq("id", ownerId).maybeSingle()
  const currentIsPerson = curOwner?.kind === "person"
  const files: BrowseFile[] = []
  for (const f of all) {
    const [{ data: pers }, { data: so }, { count }] = await Promise.all([
      db().rpc("store_file_is_personal", { p_file_id: f.id }),
      db().rpc("store_type_staff_only", { p_document_type: f.document_type }),
      db().from("store_file_versions").select("id", { count: "exact", head: true }).eq("file_id", f.id),
    ])
    const v = f.store_file_versions as { size_bytes: number | null; mime_type: string | null } | null
    files.push({
      id: f.id, name: f.name, documentType: f.document_type, state: f.state, published: !!f.published,
      clientVisible: so !== true && rowsVisible.get(f.id) === true, listed: rowsVisible.has(f.id),
      staffOnly: so === true, personal: pers === true, versions: count ?? 0,
      size: v?.size_bytes ?? null, mimeType: v?.mime_type ?? null, updatedAt: f.updated_at,
      personName: f.owner_id !== ownerId ? personName.get(f.owner_id as string) ?? null : null,
      inPersonStorage: f.owner_id !== ownerId ? personName.has(f.owner_id as string) : currentIsPerson,
    })
  }
  return {
    folder: current,
    path,
    folders: (subs ?? []).map((s: { id: string; name: string; kind: string; trashed_at: string | null }) => ({ id: s.id, name: s.name, kind: s.kind, trashed: !!s.trashed_at })),
    files,
    ...(current.kind === "contacts" ? { people } : {}),
  }
}

/** Current version bytes of a file for staff viewing — trashed files too (staff can look inside the trash). */
export async function readFileForStaff(fileId: string): Promise<{ bytes: Buffer; mimeType: string | null; name: string }> {
  const { data: f, error } = await db().from("store_files")
    .select("name, state, store_file_versions!store_files_current_version_fk(storage_bucket, storage_path, mime_type)")
    .eq("id", fileId).maybeSingle()
  if (error || !f || f.state === "purged") throw new Error("store browse: file not available")
  const v = f.store_file_versions as { storage_bucket: string; storage_path: string; mime_type: string | null } | null
  if (!v) throw new Error("store browse: file has no content")
  const { data, error: dl } = await db().storage.from(v.storage_bucket).download(v.storage_path)
  if (dl || !data) throw new Error("store browse: content could not be read")
  return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: v.mime_type ?? data.type ?? null, name: f.name }
}

/** The company's owner in the NEW store (only in the pilot environment; anything else → null). */
export async function storeOwnerForAccount(accountId: string): Promise<string | null> {
  const { pilotEnvironmentAllowed } = await import("./formation-pilot")
  if (!pilotEnvironmentAllowed()) return null
  try {
    const { data } = await db().from("store_owners").select("id").eq("account_id", accountId).maybeSingle()
    return (data?.id as string | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * The store files the company's store view SHOWS: the company's own live/trashed files and the live files
 * of its people (shown in "2. Contacts"). The flat documents list hides exactly these — never a file the
 * store view would not show. Mirrors folderContents; a read error returns null (hide nothing).
 */
export async function storeFilesShownForAccount(accountId: string, ownerId: string): Promise<string[] | null> {
  try {
    const own = await db().from("store_files").select("id").eq("owner_id", ownerId).neq("state", "purged")
    if (own.error) return null
    const ids = (own.data ?? []).map((f: { id: string }) => f.id)
    const links = await db().from("account_contacts").select("contact_id").eq("account_id", accountId)
    if (links.error) return null
    const cids = (links.data ?? []).map((l: { contact_id: string }) => l.contact_id)
    if (cids.length > 0) {
      const po = await db().from("store_owners").select("id").eq("kind", "person").in("contact_id", cids)
      if (po.error) return null
      const pids = (po.data ?? []).map((o: { id: string }) => o.id)
      if (pids.length > 0) {
        const pf = await db().from("store_files").select("id").in("owner_id", pids).eq("state", "live")
        if (pf.error) return null
        ids.push(...(pf.data ?? []).map((f: { id: string }) => f.id))
      }
    }
    return ids
  } catch {
    return null
  }
}

/**
 * Strict form for REFUSALS (Drive folder create/link): a read error throws instead of answering "no",
 * so a store-owned company can never be given a Drive folder because the lookup failed.
 */
export async function assertNotStoreOwnedAccount(accountId: string): Promise<void> {
  const { pilotEnvironmentAllowed } = await import("./formation-pilot")
  if (!pilotEnvironmentAllowed()) return
  const { data, error } = await db().from("store_owners").select("id").eq("account_id", accountId).maybeSingle()
  if (error) throw new Error("Could not check where this company's files live — please try again.")
  const { StoreOwnedAccountError } = await import("./account-uploads")
  if (data) throw new StoreOwnedAccountError("This company's files live in the new CRM storage — it does not get a Google Drive folder.")
  // The window after company creation when the hand-over has not happened (or failed): the company's
  // formation case is store-owned, so its files belong in the store too — still no Drive folder.
  const { data: sds, error: sdErr } = await db().from("service_deliveries").select("id").eq("account_id", accountId)
  if (sdErr) throw new Error("Could not check where this company's files live — please try again.")
  const sdIds = (sds ?? []).map((x: { id: string }) => x.id)
  if (sdIds.length > 0) {
    const { data: fo, error: foErr } = await db().from("store_owners").select("id").eq("kind", "formation").in("service_delivery_id", sdIds).limit(1)
    if (foErr) throw new Error("Could not check where this company's files live — please try again.")
    if (fo && fo.length > 0) throw new StoreOwnedAccountError("This company's formation files live in the new CRM storage (their hand-over to the company is pending) — it does not get a Google Drive folder.")
  }
}

export interface BrowseDocType { slug: string; name: string; staffOnly: boolean; personal: boolean }

export async function listDocumentTypes(): Promise<BrowseDocType[]> {
  const { data, error } = await db().from("catalog_entries").select("slug, display_name, metadata")
    .eq("catalog_id", "storage_document_types").eq("status", "active").order("display_name")
  if (error) throw new Error(`store browse: ${error.message}`)
  return (data ?? []).map((t: { slug: string; display_name: string; metadata: { staff_only?: boolean; personal?: boolean } | null }) => ({
    slug: t.slug, name: t.display_name, staffOnly: t.metadata?.staff_only === true, personal: t.metadata?.personal === true,
  }))
}

/** Folder kind → the CRM documents list's category (same numbers as today's company upload). */
export const FOLDER_KIND_CATEGORY: Record<string, { num: number; name: string }> = {
  company: { num: 1, name: "Company" },
  contacts: { num: 2, name: "Contacts" },
  personal: { num: 2, name: "Contacts" },
  tax: { num: 3, name: "Tax" },
  tax_year: { num: 3, name: "Tax" },
  banking: { num: 4, name: "Banking" },
  correspondence: { num: 5, name: "Correspondence" },
  itin: { num: 2, name: "Contacts" },
  person_tax: { num: 3, name: "Tax" },
}

/**
 * A staff upload into a NEW-store folder. The same name in the same folder = a new version of that file.
 * Listed in the CRM documents list, hidden from the client until staff share it.
 */
/** Staging prefix for staff uploads into the new store (inside the upload guard's allowed "crm-uploads/"). */
export const STAFF_STORE_UPLOAD_PREFIX = "crm-uploads/store-staging/"

export async function staffUploadToStore(p: {
  ownerId: string; folderId: string; storagePath: string; fileName: string; mimeType: string | null; documentType: string; actorId: string | null
  /** uploading from a company's "2. Contacts": whose document it is (saved in that person's own storage) */
  personContactId?: string | null
}): Promise<{ fileId: string; write: string; name: string }> {
  const { saveBytesToStore } = await import("./writer")
  const { storeNameKey } = await import("./rules")
  const { upsertStoreDocumentRow } = await import("./formation-pilot")
  const { data: folder } = await db().from("store_folders").select("id, owner_id, kind, trashed_at").eq("id", p.folderId).maybeSingle()
  if (!folder || folder.owner_id !== p.ownerId || folder.trashed_at) throw new Error("Upload into a live folder of this company or person only.")
  if (!p.storagePath.startsWith(STAFF_STORE_UPLOAD_PREFIX) || p.storagePath.includes("..")) throw new Error("Upload the file through the storage screen.")
  if (folder.kind === "root") throw new Error("Open one of the folders first — files go inside a folder, not at the top.")
  const { data: types } = await db().from("catalog_entries").select("slug, display_name, metadata").eq("catalog_id", "storage_document_types").eq("slug", p.documentType).eq("status", "active")
  if (!types || types.length === 0) throw new Error("Choose a document type from the list.")
  const typeRow = types[0] as { display_name: string; metadata: { personal?: boolean } | null }
  const { data: owner0, error: ownErr } = await db().from("store_owners").select("kind, account_id, contact_id, service_delivery_id").eq("id", p.ownerId).single()
  if (ownErr || !owner0) throw new Error("This storage owner no longer exists.")
  let owner = owner0 as { kind: string; account_id: string | null; contact_id: string | null; service_delivery_id: string | null }
  // Uploading from a company's "2. Contacts" (how staff work today): the document belongs to ONE of the
  // company's people and is saved in that person's own storage (#28), so it shows in "2. Contacts" of every
  // company they are in. Only personal documents go there — company papers go in the company's folders.
  let targetOwnerId = p.ownerId
  let targetFolderId = p.folderId
  let companyAccount: string | null = null
  if (folder.kind === "contacts") {
    if (typeRow.metadata?.personal !== true) {
      throw new Error("\"2. Contacts\" holds the people's own documents (passport, ID, proof of address …). Company papers go in the company's folders.")
    }
    if (owner.kind !== "company" || !owner.account_id) throw new Error("Open the company to upload a person's document.")
    if (!p.personContactId) throw new Error("Choose whose document this is.")
    const { data: link, error: lkErr } = await db().from("account_contacts").select("contact_id, contacts(full_name)")
      .eq("account_id", owner.account_id).eq("contact_id", p.personContactId).maybeSingle()
    if (lkErr) throw new Error(`Could not check the person — please try again (${lkErr.message}).`)
    if (!link) throw new Error("That person is not linked to this company.")
    const { ensurePersonOwner, folderOfKind } = await import("./formation-pilot")
    const personName = (link as { contacts: { full_name: string | null } | null }).contacts?.full_name || "Person"
    targetOwnerId = await ensurePersonOwner(p.personContactId, personName)
    targetFolderId = await folderOfKind(targetOwnerId, "personal")
    companyAccount = owner.account_id
    owner = { kind: "person", account_id: null, contact_id: p.personContactId, service_delivery_id: null }
  }
  // A personal document (passport, ID …) belongs to ONE person — never into a company's folders, where
  // every co-owner would see it once shared.
  if (typeRow.metadata?.personal === true && owner.kind !== "person") {
    throw new Error("This is a personal document — upload it in the company's \"2. Contacts\" and choose whose it is (it is kept in that person's own storage), not in the company's other folders.")
  }
  // Same name in the same folder = a new version of THAT file, whoever saved it first (the Formation
  // pilot, an earlier upload …): reuse its own key. A file saved without a key cannot take a version here.
  const { data: same, error: sameErr } = await db().from("store_files").select("id, caller_key, state")
    .eq("folder_id", targetFolderId).eq("name_key", storeNameKey(p.fileName)).neq("state", "purged")
  if (sameErr) throw new Error(`Could not check this folder — please try again (${sameErr.message}).`)
  const sameLive = (same ?? []).find((f: { state: string }) => f.state === "live") as { caller_key: string | null } | undefined
  if ((same ?? []).length > 0 && !sameLive) throw new Error("A file with this name is in the trash — use another name (restoring from the trash is not on this screen yet).")
  if (sameLive && !sameLive.caller_key) throw new Error("A file with this name is already here and cannot take a new version from this screen — use another name.")
  const callerKey = sameLive?.caller_key ?? `staff-upload:${targetFolderId}:${storeNameKey(p.fileName)}`
  // Who the CRM row belongs to: the company, the person, or — for a company still being formed — the
  // client (and account, once linked) of the formation case, exactly as the Formation pilot links its rows.
  // a person's document uploaded from a company keeps BOTH links, as today's passports do
  let rowAccount: string | null = owner.kind === "company" ? owner.account_id : companyAccount
  let rowContact: string | null = owner.kind === "person" ? owner.contact_id : null
  if (owner.kind === "formation" && owner.service_delivery_id) {
    const { data: sd } = await db().from("service_deliveries").select("account_id, contact_id").eq("id", owner.service_delivery_id).maybeSingle()
    rowAccount = (sd?.account_id as string | null) ?? null
    rowContact = (sd?.contact_id as string | null) ?? null
  }
  if (!rowAccount && !rowContact) throw new Error("This storage owner is not linked to a company or a client — files cannot be added here.")
  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from("onboarding-uploads").download(p.storagePath)
  if (dlErr || !blob) throw new Error(`The uploaded file could not be read (${dlErr?.message ?? "no data"}) — please try again.`)
  const bytes = Buffer.from(await blob.arrayBuffer())
  const mimeType = p.mimeType || blob.type || "application/octet-stream"
  const w = await saveBytesToStore({
    ownerId: targetOwnerId, folderId: targetFolderId, name: p.fileName, mimeType, bytes,
    callerKey, contentChanged: true,
    documentType: p.documentType, published: false, actor: p.actorId,
  })
  if (w.status !== "created" && w.status !== "versioned" && w.status !== "unchanged") {
    throw new Error(w.status === "trashed" ? "A file with this name is in the trash — use another name (restoring from the trash is not on this screen yet)." : `The save ended as "${w.status}".`)
  }
  const cat = typeRow.metadata?.personal === true ? FOLDER_KIND_CATEGORY.personal
    : FOLDER_KIND_CATEGORY[folder.kind as string] ?? FOLDER_KIND_CATEGORY.correspondence
  await upsertStoreDocumentRow(w.fileId, {
    file_name: w.name, mime_type: mimeType, file_size: bytes.length, document_type_name: typeRow.display_name ?? null,
    category: cat.num, category_name: cat.name,
    account_id: rowAccount,
    contact_id: rowContact,
    portal_visible: false,
  }, w.status)
  await supabaseAdmin.storage.from("onboarding-uploads").remove([p.storagePath]).catch(() => {})
  return { fileId: w.fileId, write: w.status, name: w.name }
}

/**
 * Show / hide a NEW-store file for the client: the store's own flag FIRST (it refuses a staff-only type or
 * a never-visible draft), then the CRM documents row(s) the portal reads today — through the shared share
 * step, so the client's "new document" alert and the audit log work exactly as for any other share.
 */
export async function setClientVisibility(fileId: string, visible: boolean, actorId: string | null = null): Promise<{ visible: boolean; crmRowsUpdated: number }> {
  const { storePointer } = await import("./document-pointer")
  const { isUnresolvedPersonalDocument, UNRESOLVED_PERSONAL_DOC_MESSAGE } = await import("@/lib/documents/visibility-guard")
  const { data: f, error: fErr } = await db().from("store_files").select("document_type, state, published, store_owners!inner(kind)").eq("id", fileId).maybeSingle()
  if (fErr) throw new Error(`Could not read the file — please try again (${fErr.message}).`)
  if (!f) throw new Error("File not found.")
  if (f.state !== "live") throw new Error("Restore the file from the trash first.")
  const { data: rows, error: rErr } = await db().from("documents").select("id, category, contact_id, portal_visible").eq("drive_file_id", storePointer(fileId))
  if (rErr) throw new Error(`Could not read the CRM listing — please try again (${rErr.message}).`)
  if (visible) {
    // every check BEFORE anything changes, each failing closed
    const { data: so, error: soErr } = await db().rpc("store_type_staff_only", { p_document_type: f.document_type })
    if (soErr || so !== false) throw new Error(soErr ? "Could not check this document's type — please try again." : "This document is staff-only (it holds other people's personal data) and can never be shown to the client.")
    const { data: pers, error: pErr } = await db().rpc("store_file_is_personal", { p_file_id: fileId })
    if (pErr) throw new Error("Could not check whether this is a personal document — please try again.")
    const ownerKind = (f.store_owners as { kind?: string } | null)?.kind
    if (pers === true && ownerKind !== "person") throw new Error("This is a personal document stored with the company — it must be in the person's own storage before it can be shown.")
    if (!rows || rows.length === 0) throw new Error("This file is not listed in the CRM documents list, so the client portal cannot show it.")
    for (const r of rows as { category: number | null; contact_id: string | null }[]) {
      if (isUnresolvedPersonalDocument(r)) throw new Error(UNRESOLVED_PERSONAL_DOC_MESSAGE)
    }
  }
  const before = !!f.published
  const { error } = await db().rpc("store_set_published", { p_file_id: fileId, p_published: visible, p_actor: actorId })
  if (error) throw new Error(error.message.replace(/^store: /, ""))
  let crmRowsUpdated = 0
  const changed: string[] = []
  try {
    const { updateDocument } = await import("@/lib/operations/document")
    for (const r of (rows ?? []) as { id: string; portal_visible: boolean }[]) {
      if (r.portal_visible === visible) { crmRowsUpdated++; continue } // already so — nothing to change or undo
      const u = await updateDocument({ id: r.id, patch: { portal_visible: visible } } as never)
      if (!u.success) throw new Error(u.error || "The CRM list could not be updated.")
      changed.push(r.id)
      crmRowsUpdated++
    }
  } catch (e) {
    // never leave the store and the CRM list disagreeing: put back the rows already changed AND the store
    if (changed.length > 0) {
      await db().from("documents").update({ portal_visible: !visible, updated_at: new Date().toISOString() }).in("id", changed)
    }
    await db().rpc("store_set_published", { p_file_id: fileId, p_published: before, p_actor: actorId })
    throw e
  }
  return { visible, crmRowsUpdated }
}
