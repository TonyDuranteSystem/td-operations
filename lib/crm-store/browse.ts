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
  kind: "company" | "person" | "formation" | "unfiled" | "business" | "private"
  label: string
  status: string | null // "being formed" / "archived" / null
  fileCount: number
}

export interface BrowseFolder {
  id: string; name: string; kind: string; trashed: boolean
  /** a fixed folder (made by a template, or a top folder): no rename / move / delete */
  locked?: boolean
}

export interface BrowseFile {
  id: string
  name: string
  documentType: string | null
  state: "live" | "trashed" | "purged" | string
  published: boolean
  /** What the client sees TODAY: a CRM documents row for this file is visible (never for staff-only). */
  clientVisible: boolean
  /** the workspace that always shows this file to the client (it can't be hidden from the storage), else null */
  shownByWorkspace: string | null
  /** The file has a CRM documents row (without one the portal cannot show it at all). */
  listed: boolean
  /** that CRM row (for "View OCR text" / "Run OCR") */
  docId: string | null
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
  /** the current version's content fingerprint (to tell "same name, different content" apart) */
  sha256?: string | null
  /** "Decide later": saved hidden and waiting for staff (the reason shown on the red chip) */
  needsReview?: string | null
  /** a file in My files › Shared with staff: the staff logins it is shared with (null = not a shareable place) */
  sharedWith?: string[] | null
  /** none / draft / filed / amended — a draft of a return type is never shown until marked filed */
  filingStatus?: string | null
}

/** Pure: the label shown for an owner (unit-tested). */
export function ownerLabel(o: { kind: string; company?: string | null; person?: string | null; root?: string | null }): string {
  if (o.kind === "business") return "Business"
  if (o.kind === "private") return "My files"
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
    // a private "My files" area is never listed here (only the navigation lists it, for its own login)
    .neq("kind", "private")
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

/** A folder's children (or the owner's root when folderId is null) + its live files. */
export interface BrowsePerson { contactId: string; name: string; ownerId: string | null; companies: string[] }
export interface BrowseOwnerInfo { kind: string; label: string; accountStatus: string | null; closed: boolean }

/** Pure: a person's folders that may be shown on a COMPANY's page (catalog: shown_through_company) — only when
 *  the catalog says so; a folder kind without the setting is NOT shown (fails closed). */
export function shownThroughCompany(kind: string, kinds: Map<string, { shown_through_company?: boolean }>): boolean {
  return kinds.get(kind)?.shown_through_company === true
}

async function folderKindSettings(): Promise<Map<string, { shown_through_company?: boolean }>> {
  const { data, error } = await db().from("catalog_entries").select("slug, metadata").eq("catalog_id", "storage_folder_kinds")
  if (error) throw new Error(`store browse: ${error.message}`)
  return new Map(((data ?? []) as { slug: string; metadata: { shown_through_company?: boolean } | null }[]).map((k) => [k.slug, k.metadata ?? {}]))
}

/** Account statuses that count as closed (the CRM's own values; the left side groups them the same way). */
export const CLOSED_ACCOUNT_STATUSES = ["Closed", "Cancelled", "Offboarding"]

type FolderRowLite = { id: string; name: string; kind: string; trashed_at: string | null; template_slug: string | null; parent_id: string | null }
const toFolder = (d: FolderRowLite): BrowseFolder => ({ id: d.id, name: d.name, kind: d.kind, trashed: !!d.trashed_at, locked: d.template_slug !== null || d.parent_id === null })

export async function folderContents(ownerId: string, folderId: string | null, opts: { throughCompany?: boolean } = {}): Promise<{ folder: BrowseFolder | null; path: BrowseFolder[]; folders: BrowseFolder[]; files: BrowseFile[]; people?: BrowsePerson[]; owner: BrowseOwnerInfo }> {
  const { data: own, error: oErr } = await db().from("store_owners").select("kind, account_id, lifecycle_override, accounts(company_name, status), contacts(full_name)").eq("id", ownerId).maybeSingle()
  if (oErr) throw new Error(`store browse: ${oErr.message}`)
  if (!own) throw new Error("store browse: owner not found")
  const cols = "id, name, kind, owner_id, trashed_at, template_slug, parent_id"
  let cur: FolderRowLite | null = null
  if (folderId) {
    const { data } = await db().from("store_folders").select(cols).eq("id", folderId).maybeSingle()
    if (!data || data.owner_id !== ownerId) throw new Error("store browse: folder not found for this owner")
    cur = data
  } else {
    const { data } = await db().from("store_folders").select(cols).eq("owner_id", ownerId).is("parent_id", null).maybeSingle()
    cur = data ?? null
  }
  const rootName = cur && !cur.parent_id ? cur.name : null
  const owner: BrowseOwnerInfo = {
    kind: own.kind,
    label: ownerLabel({ kind: own.kind, company: own.accounts?.company_name, person: own.contacts?.full_name, root: rootName }),
    accountStatus: (own.accounts?.status as string | null) ?? null,
    closed: (own.kind === "company" && CLOSED_ACCOUNT_STATUSES.includes(String(own.accounts?.status ?? ""))) || (own.kind === "formation" && own.lifecycle_override === "archived"),
  }
  if (!cur) return { folder: null, path: [], folders: [], files: [], owner }
  const kinds = opts.throughCompany ? await folderKindSettings() : null
  const current = toFolder(cur)

  // breadcrumb (bounded walk up)
  const path: BrowseFolder[] = []
  let walk: string | null = current.id
  for (let i = 0; i < 50 && walk; i++) {
    const { data } = await db().from("store_folders").select(cols).eq("id", walk).maybeSingle()
    if (!data) break
    path.unshift(toFolder(data))
    // a person's ITIN / Tax (and anything under them) is never shown on a company's page
    if (kinds && !shownThroughCompany(data.kind, kinds)) throw new Error("store browse: this folder is only shown on the person's own page")
    walk = data.parent_id
  }

  const { data: subs } = await db().from("store_folders").select(cols).eq("parent_id", current.id).is("trashed_at", null).order("name")
  const fileSelect = "id, name, owner_id, document_type, state, published, updated_at, filing_status, needs_review_at, needs_review_reason, store_file_versions!store_files_current_version_fk(size_bytes, mime_type, sha256)"
  // live files only: the trash is its own view — a trashed file must not sit among the live ones (paged: a
  // folder can hold more than one page of files)
  const fs: Array<Record<string, unknown> & { id: string; name: string; owner_id: string; document_type: string | null; state: string; published: boolean; updated_at: string; needs_review_at: string | null; needs_review_reason: string | null; store_file_versions: unknown }> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from("store_files").select(fileSelect)
      .eq("folder_id", current.id).eq("state", "live").order("name").order("id").range(from, from + 999)
    if (error) throw new Error(`store browse: ${error.message}`)
    fs.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  // "2. Contacts" of a company: one branch per person — each person's OWN storage (#28), opened through the
  // company (only the folders the catalog lets a company show). Never copied into the company.
  const people: BrowsePerson[] = []
  if (current.kind === "contacts" && own.account_id) {
    const { data: links, error: lErr } = await db().from("account_contacts").select("contact_id, contacts(full_name)").eq("account_id", own.account_id)
    if (lErr) throw new Error(`store browse: ${lErr.message}`)
    const cids = ((links ?? []) as { contact_id: string }[]).map((l) => l.contact_id)
    const ownerOf = new Map<string, string>()
    const companiesOf = new Map<string, string[]>()
    if (cids.length > 0) {
      const { data: po, error: poErr } = await db().from("store_owners").select("id, contact_id").eq("kind", "person").in("contact_id", cids)
      if (poErr) throw new Error(`store browse: ${poErr.message}`)
      for (const o of (po ?? []) as { id: string; contact_id: string }[]) ownerOf.set(o.contact_id, o.id)
      const { data: ac, error: acErr } = await db().from("account_contacts").select("contact_id, accounts(company_name)").in("contact_id", cids)
      if (acErr) throw new Error(`store browse: ${acErr.message}`)
      for (const r of (ac ?? []) as { contact_id: string; accounts: { company_name: string | null } | null }[]) {
        if (r.accounts?.company_name) companiesOf.set(r.contact_id, [...(companiesOf.get(r.contact_id) ?? []), r.accounts.company_name])
      }
    }
    for (const l of (links ?? []) as { contact_id: string; contacts: { full_name: string | null } | null }[]) {
      people.push({ contactId: l.contact_id, name: l.contacts?.full_name || "Contact", ownerId: ownerOf.get(l.contact_id) ?? null, companies: (companiesOf.get(l.contact_id) ?? []).sort() })
    }
    people.sort((x, y) => x.name.localeCompare(y.name))
  }
  // What the client sees TODAY is decided by the CRM documents row (the portal reads it) — so the badge
  // comes from the row, not from the store's own flag, and a file with no row says so.
  const all = fs
  const rowsVisible = new Map<string, boolean>()
  const docIdOf = new Map<string, string>()
  const byWorkspace = new Map<string, string>()
  const facts = new Map<string, { is_personal: boolean; staff_only: boolean; version_count: number }>()
  if (all.length > 0) {
    const { storePointer } = await import("./document-pointer")
    for (let i = 0; i < all.length; i += 200) {
      const part = all.slice(i, i + 200)
      const [{ data: rows, error: rErr }, { data: fx, error: fErr }] = await Promise.all([
        db().from("documents").select("id, drive_file_id, portal_visible, service_delivery_id, flow_stage").in("drive_file_id", part.map((f) => storePointer(f.id))),
        // personal? staff-only type? how many versions? — one call for the whole chunk
        db().rpc("store_files_facts", { p_ids: part.map((f) => f.id) }),
      ])
      if (rErr) throw new Error(`store browse: ${rErr.message}`)
      if (fErr) throw new Error(`store browse: ${fErr.message}`)
      // what the client REALLY sees: the visible flag, or a client-facing workspace stage (the portal's own rule)
      const { rowClientVisible } = await import("./client-visibility")
      const sdIds = Array.from(new Set(((rows ?? []) as { service_delivery_id: string | null }[]).map((r) => r.service_delivery_id).filter((x): x is string => !!x)))
      const st = new Map<string, string>()
      if (sdIds.length) {
        const { data: sds, error: sErr } = await db().from("service_deliveries").select("id, service_type").in("id", sdIds)
        // never guess: without the workspace's type the badge could say "hidden" for a file the client sees
        if (sErr) throw new Error(`store browse: ${sErr.message}`)
        for (const x of (sds ?? []) as { id: string; service_type: string | null }[]) if (x.service_type) st.set(x.id, x.service_type)
      }
      for (const r of (rows ?? []) as { id: string; drive_file_id: string; portal_visible: boolean | null; service_delivery_id: string | null; flow_stage: string | null }[]) {
        const fid = String(r.drive_file_id).slice("store:".length)
        const svc = r.service_delivery_id ? st.get(r.service_delivery_id) ?? null : null
        const sees = rowClientVisible(r, svc)
        rowsVisible.set(fid, (rowsVisible.get(fid) ?? false) || sees)
        if (svc && r.flow_stage && rowClientVisible({ portal_visible: false, flow_stage: r.flow_stage }, svc)) byWorkspace.set(fid, svc)
        if (!docIdOf.has(fid)) docIdOf.set(fid, r.id as string)
      }
      for (const x of (fx ?? []) as { id: string; is_personal: boolean; staff_only: boolean; version_count: number }[]) facts.set(x.id, x)
    }
  }
  const isPerson = own.kind === "person"
  let shares: Map<string, string[]> | null = null
  if (own.kind === "private" && all.length > 0) {
    const { isInStaffShare, sharesForFiles } = await import("./staff-share")
    if (await isInStaffShare(current.id)) shares = await sharesForFiles(all.map((f) => f.id))
  }
  const files: BrowseFile[] = []
  for (const f of all) {
    const k = facts.get(f.id)
    // a file whose facts could not be read counts as staff-only (fails closed: never offered to the client)
    const so = k ? k.staff_only : true
    const v = f.store_file_versions as { size_bytes: number | null; mime_type: string | null; sha256: string | null } | null
    files.push({
      id: f.id, name: f.name, documentType: f.document_type, state: f.state, published: !!f.published,
      // exactly what the portal shows (the same rule as the filter and the details panel) — never "hidden" for a
      // file the client sees, whatever its type says
      clientVisible: rowsVisible.get(f.id) === true, shownByWorkspace: byWorkspace.get(f.id) ?? null, listed: rowsVisible.has(f.id), docId: docIdOf.get(f.id) ?? null,
      staffOnly: so, personal: k?.is_personal === true, versions: k?.version_count ?? 0,
      size: v?.size_bytes ?? null, mimeType: v?.mime_type ?? null, updatedAt: f.updated_at, sha256: v?.sha256 ?? null,
      needsReview: f.needs_review_at ? (f.needs_review_reason || "Needs review") : null,
      personName: opts.throughCompany ? owner.label : null,
      inPersonStorage: isPerson,
      sharedWith: shares ? shares.get(f.id) ?? [] : null,
      filingStatus: (f.filing_status as string | null) ?? null,
    })
  }
  return {
    folder: current,
    path,
    folders: ((subs ?? []) as FolderRowLite[]).filter((sf) => !kinds || shownThroughCompany(sf.kind, kinds)).map(toFolder),
    files,
    owner,
    ...(current.kind === "contacts" ? { people } : {}),
  }
}

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
    // a storage made by a study copy is not the company's storage yet (the CRM keeps using Drive for it)
    const { data } = await db().from("store_owners").select("id").eq("account_id", accountId).eq("study_only", false).maybeSingle()
    return (data?.id as string | undefined) ?? null
  } catch {
    return null
  }
}

export interface BrowseVersion { id: string; versionNo: number; createdAt: string; size: number | null; mimeType: string | null; current: boolean; by: string | null }

/** Every saved copy of a file, newest first — so an older copy can be opened (and a wrong replacement spotted). */
export async function listFileVersions(fileId: string): Promise<BrowseVersion[]> {
  const { data: f, error: fErr } = await db().from("store_files").select("current_version_id, state").eq("id", fileId).maybeSingle()
  if (fErr) throw new Error(`store browse: ${fErr.message}`)
  if (!f || f.state === "purged") throw new Error("File not found.")
  const { data, error } = await db().from("store_file_versions").select("id, version_no, created_at, size_bytes, mime_type, created_by")
    .eq("file_id", fileId).order("version_no", { ascending: false })
  if (error) throw new Error(`store browse: ${error.message}`)
  const ids: string[] = Array.from(new Set(((data ?? []) as { created_by: string | null }[]).map((v) => v.created_by).filter((x): x is string => !!x)))
  const names = new Map<string, string>()
  for (const id of ids) {
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(id)
    const email = u?.user?.email ?? null
    if (email) names.set(id, email.split("@")[0])
  }
  return (data ?? []).map((v: { id: string; version_no: number; created_at: string; size_bytes: number | null; mime_type: string | null; created_by: string | null }) => ({
    id: v.id, versionNo: v.version_no, createdAt: v.created_at, size: v.size_bytes, mimeType: v.mime_type,
    current: v.id === f.current_version_id, by: v.created_by ? names.get(v.created_by) ?? "staff" : null,
  }))
}

/** One saved copy's bytes (staff only) — an older version opens exactly like the current file. */
export async function readVersionForStaff(fileId: string, versionId: string): Promise<{ bytes: Buffer; mimeType: string | null; name: string }> {
  const { data: f } = await db().from("store_files").select("name, state").eq("id", fileId).maybeSingle()
  if (!f || f.state === "purged") throw new Error("store browse: file not available")
  const { data: v, error } = await db().from("store_file_versions").select("storage_bucket, storage_path, mime_type, version_no")
    .eq("id", versionId).eq("file_id", fileId).maybeSingle()
  if (error || !v) throw new Error("store browse: version not found")
  const { data, error: dl } = await db().storage.from(v.storage_bucket).download(v.storage_path)
  if (dl || !data) throw new Error("store browse: content could not be read")
  return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: v.mime_type ?? data.type ?? null, name: `v${v.version_no} - ${f.name}` }
}

/** A person's own storage in the NEW store (pilot environment only), or null. */
export async function storeOwnerForContact(contactId: string): Promise<string | null> {
  const { pilotEnvironmentAllowed } = await import("./formation-pilot")
  if (!pilotEnvironmentAllowed()) return null
  try {
    const { data } = await db().from("store_owners").select("id").eq("contact_id", contactId).eq("kind", "person").eq("study_only", false).maybeSingle()
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
    const ids: string[] = []
    const page = async (q: () => { range: (a: number, b: number) => Promise<{ data: { id: string }[] | null; error: unknown }> }) => {
      for (let from = 0; ; from += 1000) {
        const r = await q().range(from, from + 999)
        if (r.error) throw r.error
        ids.push(...(r.data ?? []).map((f) => f.id))
        if ((r.data ?? []).length < 1000) return
      }
    }
    await page(() => db().from("store_files").select("id").eq("owner_id", ownerId).neq("state", "purged").order("id"))
    const links = await db().from("account_contacts").select("contact_id").eq("account_id", accountId)
    if (links.error) return null
    const cids = (links.data ?? []).map((l: { contact_id: string }) => l.contact_id)
    if (cids.length > 0) {
      const po = await db().from("store_owners").select("id").eq("kind", "person").in("contact_id", cids)
      if (po.error) return null
      const pids = (po.data ?? []).map((o: { id: string }) => o.id)
      if (pids.length > 0) {
        // only the person folders the company page shows (never a person's ITIN / Tax — those stay on their own page)
        const kinds = await folderKindSettings()
        const { data: folders, error: fErr } = await db().from("store_folders").select("id, parent_id, kind").in("owner_id", pids).is("trashed_at", null)
        if (fErr) return null
        const byId = new Map(((folders ?? []) as { id: string; parent_id: string | null; kind: string }[]).map((f) => [f.id, f]))
        const okFolder = (id: string): boolean => {
          for (let cur = byId.get(id), i = 0; cur && i < 50; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined, i++) {
            if (!shownThroughCompany(cur.kind, kinds)) return false
            if (!cur.parent_id) return true
          }
          return false
        }
        const allowed = Array.from(byId.keys()).filter(okFolder)
        for (let i = 0; i < allowed.length; i += 200) {
          const part = allowed.slice(i, i + 200)
          await page(() => db().from("store_files").select("id").in("folder_id", part).eq("state", "live").order("id"))
        }
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
  const { data, error } = await db().from("store_owners").select("id").eq("account_id", accountId).eq("study_only", false).maybeSingle()
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

export interface BrowseDocType { slug: string; name: string; staffOnly: boolean; personal: boolean; defaultFolderKind: string | null; draftNeverVisible: boolean }

export async function listDocumentTypes(): Promise<BrowseDocType[]> {
  const { data, error } = await db().from("catalog_entries").select("slug, display_name, metadata")
    .eq("catalog_id", "storage_document_types").eq("status", "active").order("display_name")
  if (error) throw new Error(`store browse: ${error.message}`)
  return (data ?? []).map((t: { slug: string; display_name: string; metadata: { staff_only?: boolean; personal?: boolean; default_folder_kind?: string; draft_never_visible?: boolean } | null }) => ({
    slug: t.slug, name: t.display_name, staffOnly: t.metadata?.staff_only === true, personal: t.metadata?.personal === true,
    defaultFolderKind: t.metadata?.default_folder_kind ?? null, draftNeverVisible: t.metadata?.draft_never_visible === true,
  }))
}

/** Folder kind → the CRM documents list's category (same numbers as today's company upload). Every folder kind
 *  has an explicit answer — nothing falls through by accident. */
export const FOLDER_KIND_CATEGORY: Record<string, { num: number; name: string }> = {
  company: { num: 1, name: "Company" },
  contacts: { num: 2, name: "Contacts" },
  personal: { num: 2, name: "Contacts" },
  itin: { num: 2, name: "Contacts" },
  tax: { num: 3, name: "Tax" },
  tax_year: { num: 3, name: "Tax" },
  person_tax: { num: 3, name: "Tax" },
  person_tax_year: { num: 3, name: "Tax" },
  banking: { num: 4, name: "Banking" },
  correspondence: { num: 5, name: "Correspondence" },
  // a staff folder made directly under the client's top folder, and Unfiled: Correspondence (today's catch-all)
  root: { num: 5, name: "Correspondence" },
  unfiled: { num: 5, name: "Correspondence" },
  custom: { num: 5, name: "Correspondence" },
  // Business / My files have no CRM rows; listed for completeness
  business_root: { num: 5, name: "Correspondence" },
  private_root: { num: 5, name: "Correspondence" },
}

/** The category for a folder kind; an unknown (new catalog) kind → Correspondence, the catch-all. */
export function categoryForKind(kind: string): { num: number; name: string } {
  return FOLDER_KIND_CATEGORY[kind] ?? FOLDER_KIND_CATEGORY.correspondence
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
  /** optional display name (today's "Display name"); the original extension is kept */
  displayName?: string | null
  /** show to the client straight away (today's upload does — default true); never for a staff-only type */
  visible?: boolean | null
  /** the tax year the staff member chose (saved on the file) */
  periodYear?: number | null
  /** a prepared tax return: the staff member's answer — "filed" (may be shown) or "draft" (never shown) */
  filingAnswer?: "filed" | "draft" | null
  /** "Decide later": save it hidden and mark it red "Needs review" with this reason */
  needsReview?: string | null
  /** uploading straight into a person's folder shown in a company's "2. Contacts": that company's owner
   *  (the CRM row keeps BOTH links, as an upload through "2. Contacts" does) */
  viaCompanyOwnerId?: string | null
}): Promise<{ fileId: string; write: string; name: string; visible: boolean; identity?: string | null }> {
  const { saveBytesToStore } = await import("./writer")
  const { storeNameKey } = await import("./rules")
  const { upsertStoreDocumentRow } = await import("./formation-pilot")
  const { data: folder } = await db().from("store_folders").select("id, owner_id, kind, trashed_at").eq("id", p.folderId).maybeSingle()
  if (!folder || folder.owner_id !== p.ownerId || folder.trashed_at) throw new Error("Upload into a live folder of this company or person only.")
  if (!p.storagePath.startsWith(STAFF_STORE_UPLOAD_PREFIX) || p.storagePath.includes("..")) throw new Error("Upload the file through the storage screen.")
  if (folder.kind === "root") throw new Error("Open one of the folders first — files go inside a folder, not at the top.")
  const { data: types } = await db().from("catalog_entries").select("slug, display_name, metadata").eq("catalog_id", "storage_document_types").eq("slug", p.documentType).eq("status", "active")
  if (!types || types.length === 0) throw new Error("Choose a document type from the list.")
  const typeRow = types[0] as { slug: string; display_name: string; metadata: { personal?: boolean; staff_only?: boolean; draft_never_visible?: boolean } | null }
  let fileName = p.fileName
  if (p.displayName && p.displayName.trim()) {
    const { cleanNewFileName } = await import("./file-actions")
    fileName = cleanNewFileName(p.displayName, p.fileName)
  }
  const { data: owner0, error: ownErr } = await db().from("store_owners").select("kind, account_id, contact_id, service_delivery_id").eq("id", p.ownerId).single()
  if (ownErr || !owner0) throw new Error("This storage owner no longer exists.")
  let owner = owner0 as { kind: string; account_id: string | null; contact_id: string | null; service_delivery_id: string | null }
  // The firm's own "Business" folders and a staff member's private "My files": no client, so no CRM
  // documents row and never shown to anyone outside the firm. Same versioning rule as everywhere else.
  if (owner.kind === "business" || owner.kind === "private") {
    if (typeRow.metadata?.personal === true && owner.kind === "business") {
      throw new Error("This is a personal document — it belongs in the person's own storage, not in the Business folders.")
    }
    return saveInternalAreaFile(p, fileName, typeRow.slug)
  }
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
  if (p.viaCompanyOwnerId && folder.kind !== "contacts") {
    if (owner.kind !== "person" || !owner.contact_id) throw new Error("Upload into the person's folder from the company's \"2. Contacts\".")
    // only a person's OWN document goes into their storage from a company page — a company paper there would be
    // listed with the company and shown to every member
    if (typeRow.metadata?.personal !== true) throw new Error("From a company page only the person's own documents (passport, ID, proof of address …) go into their storage. Company papers go in the company's folders.")
    try { await folderContents(targetOwnerId, targetFolderId, { throughCompany: true }) } catch {
      throw new Error("That folder is only shown on the person's own page — upload it there.")
    }
    const { data: co, error: coErr } = await db().from("store_owners").select("kind, account_id").eq("id", p.viaCompanyOwnerId).maybeSingle()
    if (coErr) throw new Error(`Could not check the company — please try again (${coErr.message}).`)
    if (co?.kind === "company" && co.account_id) {
      const { data: link, error: lkErr } = await db().from("account_contacts").select("contact_id").eq("account_id", co.account_id).eq("contact_id", owner.contact_id).maybeSingle()
      if (lkErr) throw new Error(`Could not check the person — please try again (${lkErr.message}).`)
      if (!link) throw new Error("That person is not linked to this company.")
      companyAccount = co.account_id
    }
  }
  // A personal document (passport, ID …) belongs to ONE person — never into a company's folders, where
  // every co-owner would see it once shared.
  if (typeRow.metadata?.personal === true && owner.kind !== "person") {
    throw new Error("This is a personal document — upload it in the company's \"2. Contacts\" and choose whose it is (it is kept in that person's own storage), not in the company's other folders.")
  }
  // Same name in the same folder = a new version of THAT file, whoever saved it first (the Formation
  // pilot, an earlier upload …): reuse its own key. A file saved without a key cannot take a version here.
  const { data: same, error: sameErr } = await db().from("store_files").select("id, caller_key, state")
    .eq("folder_id", targetFolderId).eq("name_key", storeNameKey(fileName)).neq("state", "purged")
  if (sameErr) throw new Error(`Could not check this folder — please try again (${sameErr.message}).`)
  const sameLive = (same ?? []).find((f: { state: string }) => f.state === "live") as { caller_key: string | null } | undefined
  if ((same ?? []).length > 0 && !sameLive) throw new Error("A file with this name is in the trash — restore it from the Trash (top of this storage) or use another name.")
  if (sameLive && !sameLive.caller_key) throw new Error("A file with this name is already here and cannot take a new version from this screen — use another name.")
  // A NEW file gets its own unique key: a key built from folder + name would later match a file that was
  // renamed or moved away (overwriting it as a "version") or a trashed one (refusing the name for ever).
  const { randomUUID } = await import("crypto")
  const callerKey = sameLive?.caller_key ?? `staff-upload:${randomUUID()}`
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
  const filedReturn = typeRow.metadata?.draft_never_visible === true && p.filingAnswer === "filed" && !p.needsReview
  const wantVisible = !p.needsReview && p.visible !== false && typeRow.metadata?.staff_only !== true
    && (typeRow.metadata?.draft_never_visible !== true || filedReturn)
  // replacing a file the client sees with an answer of "hidden": hide it BEFORE the new copy is saved, so the
  // client never sees the new copy, not even for a moment (and not at all if a later step fails)
  if (sameLive && !wantVisible) {
    const sameId = (same ?? []).find((f: { state: string }) => f.state === "live")?.id as string | undefined
    if (sameId) {
      await removeStagedOnFailure(p.storagePath, async () => {
        const { data: old, error: oErr } = await db().from("store_files").select("name, filing_status").eq("id", sameId).maybeSingle()
        if (oErr || !old) throw new Error(`Could not read the file being replaced — please try again${oErr ? ` (${oErr.message})` : ""}.`)
        // a filed return can't take a new copy: refuse BEFORE touching the old one (it stays as the client saw it)
        if (old.filing_status === "filed") throw new Error(saveRefusalMessage("frozen"))
        // a workspace document the client always sees: a new copy would be shown too — say so, change nothing
        const { workspaceShownFiles, workspaceShownMessage } = await import("./client-visibility")
        const ws = (await workspaceShownFiles([sameId])).get(sameId)
        if (ws) throw new Error(`${workspaceShownMessage(old.name as string, ws)} A new copy would be shown too — use "Keep both" to save it as a separate hidden file.`)
        await setClientVisibility(sameId, false, p.actorId)
      })
    }
  }
  // the year the staff member chose, else the nearest year folder above (Tax › 2024 › Bank → 2024)
  const yearToSave = p.periodYear ?? await (await import("./structure")).nearestYear(targetFolderId)
  const w = await removeStagedOnFailure(p.storagePath, () => saveBytesToStore({
    ownerId: targetOwnerId, folderId: targetFolderId, name: fileName, mimeType, bytes,
    callerKey, contentChanged: true,
    // a prepared tax return / 5472 / 1120 … is saved as a DRAFT (never shown until filed); every type starts
    // unpublished and follows the CRM row below
    documentType: p.documentType, published: false, actor: p.actorId,
    ...(yearToSave ? { periodYear: yearToSave } : {}),
    // a type that is never shown as a draft is a DRAFT unless staff said it is the filed return
    ...(typeRow.metadata?.draft_never_visible === true ? { filingStatus: (p.filingAnswer === "filed" && !p.needsReview ? "filed" : "draft") as "filed" | "draft" } : {}),
  }))
  if (w.status !== "created" && w.status !== "versioned" && w.status !== "unchanged") {
    await supabaseAdmin.storage.from("onboarding-uploads").remove([p.storagePath]).catch(() => {})
    throw new Error(saveRefusalMessage(w.status))
  }
  const { categoryForFolder } = await import("./structure")
  const cat = typeRow.metadata?.personal === true ? FOLDER_KIND_CATEGORY.personal : await categoryForFolder(targetFolderId)
  const row = await upsertStoreDocumentRow(w.fileId, {
    file_name: w.name, mime_type: mimeType, file_size: bytes.length, document_type_name: typeRow.display_name ?? null,
    category: cat.num, category_name: cat.name,
    account_id: rowAccount,
    contact_id: rowContact,
    // today's upload shows the file to the client straight away (with the new-document alert); a staff-only
    // type never; staff can untick it
    portal_visible: wantVisible,
  }, w.status)
  await supabaseAdmin.storage.from("onboarding-uploads").remove([p.storagePath]).catch(() => {})
  if (p.needsReview) {
    const { markNeedsReview } = await import("./structure")
    await markNeedsReview(w.fileId, p.needsReview, p.actorId)
  }
  // A REPLACED file (a new version, or the same bytes again) keeps its CRM row — and that row's visibility.
  // This upload's answer wins: unticked "Show to client" / "Decide later" hide it; ticked shows it (when allowed).
  if (!row.inserted) {
    const { data: before } = await db().from("documents").select("portal_visible").eq("id", row.id).maybeSingle()
    if ((before?.portal_visible === true) !== wantVisible) {
      if (!wantVisible) await setClientVisibility(w.fileId, false, p.actorId)
      else await setClientVisibility(w.fileId, true, p.actorId).catch((e: unknown) => console.warn("[crm-store] replaced file kept hidden:", e instanceof Error ? e.message : e))
    }
  }
  const { data: rowNow } = await db().from("documents").select("id, portal_visible").eq("id", row.id).maybeSingle()
  const visibleNow = rowNow?.portal_visible === true
  if (row.inserted && visibleNow) {
    const { notifyClientsOfNewDocument } = await import("@/lib/portal/document-alerts")
    void notifyClientsOfNewDocument(row.id).catch((e: unknown) => console.error("[crm-store] new-document alert failed:", e))
  }
  // today's contact upload reads a passport / ITIN letter and fills the person's record
  let identity: string | null = null
  if (owner.kind === "person" && owner.contact_id && (typeRow.slug === "passport" || typeRow.slug === "itin_letter")) {
    // bounded: a slow read must not turn a saved upload into a timed-out "failed" upload
    identity = await Promise.race([
      readIdentityIntoContact(owner.contact_id, typeRow.slug, bytes, mimeType, fileName, rowAccount),
      new Promise<string>((r) => setTimeout(() => r("The document was saved; its details are still being read — if the contact's fields stay empty, use Run OCR on the file."), 25_000)),
    ])
  }
  return { fileId: w.fileId, write: w.status, name: w.name, visible: visibleNow, identity }
}

/** A save that throws (frozen, refused …) must not leave the staged upload behind. */
async function removeStagedOnFailure<T>(storagePath: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    await supabaseAdmin.storage.from("onboarding-uploads").remove([storagePath]).catch(() => {})
    throw e
  }
}

/** Plain words for a save the store refused. */
export function saveRefusalMessage(status: string): string {
  if (status === "trashed") return "A file with this name is in the trash — restore it from the Trash (top of this storage) or use another name."
  if (status === "frozen") return "A file with this name is a FILED document and can't be replaced — upload the amended one under another name."
  return `The file was not saved (the storage answered "${status}") — please try again.`
}

/** A file in the Business area or a private "My files" area: saved in the store only (no CRM row, never shown). */
async function saveInternalAreaFile(p: { ownerId: string; folderId: string; storagePath: string; mimeType: string | null; actorId: string | null; needsReview?: string | null }, fileName: string, documentType: string): Promise<{ fileId: string; write: string; name: string; visible: boolean; identity?: string | null }> {
  const { saveBytesToStore } = await import("./writer")
  const { storeNameKey } = await import("./rules")
  const { data: same, error: sameErr } = await db().from("store_files").select("id, caller_key, state")
    .eq("folder_id", p.folderId).eq("name_key", storeNameKey(fileName)).neq("state", "purged")
  if (sameErr) throw new Error(`Could not check this folder — please try again (${sameErr.message}).`)
  const sameLive = (same ?? []).find((f: { state: string }) => f.state === "live") as { caller_key: string | null } | undefined
  if ((same ?? []).length > 0 && !sameLive) throw new Error("A file with this name is in the trash — restore it from the Trash (top of this storage) or use another name.")
  if (sameLive && !sameLive.caller_key) throw new Error("A file with this name is already here and cannot take a new version from this screen — use another name.")
  const { randomUUID } = await import("crypto")
  const { data: blob, error: dlErr } = await supabaseAdmin.storage.from("onboarding-uploads").download(p.storagePath)
  if (dlErr || !blob) throw new Error(`The uploaded file could not be read (${dlErr?.message ?? "no data"}) — please try again.`)
  const bytes = Buffer.from(await blob.arrayBuffer())
  const w = await removeStagedOnFailure(p.storagePath, () => saveBytesToStore({
    ownerId: p.ownerId, folderId: p.folderId, name: fileName, mimeType: p.mimeType || blob.type || "application/octet-stream", bytes,
    callerKey: sameLive?.caller_key ?? `staff-upload:${randomUUID()}`, contentChanged: true,
    documentType, published: false, actor: p.actorId,
  }))
  if (w.status !== "created" && w.status !== "versioned" && w.status !== "unchanged") {
    await supabaseAdmin.storage.from("onboarding-uploads").remove([p.storagePath]).catch(() => {})
    throw new Error(saveRefusalMessage(w.status))
  }
  await supabaseAdmin.storage.from("onboarding-uploads").remove([p.storagePath]).catch(() => {})
  if (p.needsReview) {
    const { markNeedsReview } = await import("./structure")
    await markNeedsReview(w.fileId, p.needsReview, p.actorId)
  }
  return { fileId: w.fileId, write: w.status, name: w.name, visible: false, identity: null }
}

const PASSPORT_FIELD_WORDS: Record<string, string> = { passport_number: "passport number", passport_expiry_date: "expiry date", date_of_birth: "date of birth" }

/** Pure: the passport reader's result in plain words for staff (never the reader's technical text). */
export function passportReadNote(r: { status: string; extracted_fields?: string[] | null; manual_task_created?: boolean }): string {
  const got = (r.extracted_fields ?? []).map((f) => PASSPORT_FIELD_WORDS[f] ?? f.replace(/_/g, " "))
  if (r.status === "ok" && got.length) return `Passport read — ${got.join(", ")} saved on the contact.`
  if (r.status === "error") return "The passport was saved, but its details could not be saved on the contact — enter them by hand."
  if (r.manual_task_created) return "The passport was saved; this file type can't be read automatically — enter the details on the contact by hand."
  return "The passport was saved, but its details could not be read automatically (check the scan quality) — enter them on the contact by hand."
}

/** Passport → number / expiry / date of birth; ITIN letter → ITIN + issue date (same helpers as today's upload). */
async function readIdentityIntoContact(contactId: string, slug: string, bytes: Buffer, mimeType: string, fileName: string, accountId: string | null): Promise<string | null> {
  try {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    if (slug === "passport") {
      const { extractAndStorePassportData } = await import("@/lib/jobs/passport-writeback")
      const r = await extractAndStorePassportData({ contact_id: contactId, content: ab, file_name: fileName, mime_type: mimeType, account_id: accountId })
      return passportReadNote(r)
    }
    const { ocrRawContent } = await import("@/lib/docai")
    const { extractItinFromOcr, parseItinIssueDateFromOcr } = await import("@/lib/ocr-helpers")
    const { writeITINFields } = await import("@/lib/itin/write-itin-fields")
    const ocr = await ocrRawContent(ab, mimeType, fileName)
    const itin = extractItinFromOcr(ocr.fullText)
    if (!itin) return "ITIN letter saved — no ITIN number found in the text (check the image quality)"
    await writeITINFields(contactId, { itin_number: itin, itin_issue_date: parseItinIssueDateFromOcr(ocr.fullText) })
    return `ITIN ${itin} saved on the contact`
  } catch (e) {
    return `The document was saved, but its details could not be read (${e instanceof Error ? e.message : String(e)})`
  }
}

/**
 * Show / hide a NEW-store file for the client: the store's own flag FIRST (it refuses a staff-only type or
 * a never-visible draft), then the CRM documents row(s) the portal reads today — through the shared share
 * step, so the client's "new document" alert and the audit log work exactly as for any other share.
 */
export async function setClientVisibility(fileId: string, visible: boolean, actorId: string | null = null, opts: { refusePersonal?: boolean } = {}): Promise<{ visible: boolean; crmRowsUpdated: number }> {
  const { storePointer } = await import("./document-pointer")
  const { isUnresolvedPersonalDocument, UNRESOLVED_PERSONAL_DOC_MESSAGE } = await import("@/lib/documents/visibility-guard")
  const { data: f, error: fErr } = await db().from("store_files").select("document_type, state, published, needs_review_at, store_owners!inner(kind)").eq("id", fileId).maybeSingle()
  if (fErr) throw new Error(`Could not read the file — please try again (${fErr.message}).`)
  if (!f) throw new Error("File not found.")
  if (f.state !== "live") throw new Error("Restore the file from the trash first.")
  const areaKind = (f.store_owners as { kind?: string } | null)?.kind
  if (visible && f.needs_review_at) throw new Error("This file is marked \"Needs review\" — settle it (and use \"Mark reviewed\") before showing it to the client.")
  // a group "Show": a personal document is never shown in a group — only from its own button (with its question)
  if (visible && opts.refusePersonal) {
    const { data: pers, error: pErr } = await db().rpc("store_file_is_personal", { p_file_id: fileId })
    if (pErr || pers !== false) throw new Error(pErr ? "Could not check whether this is a personal document — please try again." : "A personal document is shown one by one, from its own button.")
  }
  // hiding a file its workspace always shows would change nothing for the client — refuse BEFORE any change
  if (!visible) {
    const { workspaceShownFiles, workspaceShownMessage } = await import("./client-visibility")
    const ws = (await workspaceShownFiles([fileId])).get(fileId)
    if (ws) {
      const { data: n } = await db().from("store_files").select("name").eq("id", fileId).maybeSingle()
      throw new Error(workspaceShownMessage((n?.name as string | undefined) ?? "this file", ws))
    }
  }
  if (visible && (areaKind === "business" || areaKind === "private")) throw new Error("Files in the Business folders and in My files are internal — they can never be shown to a client.")
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
