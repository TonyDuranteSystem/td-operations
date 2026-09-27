/**
 * CRM Store — the storage STRUCTURE step (master plan v4.8.2 #94, Part 14):
 *   - the left side, grouped: Clients (automatic from the CRM — by state of formation, People, Companies being
 *     formed, Closed / Cancelled, Missing state, Unfiled) + Business (the firm's own folders) + My files (a
 *     private area for the owner-only login — Antonio);
 *   - folder actions: create / rename / move / trash, the fixed (template) folders LOCKED, "New tax year",
 *     the store's naming rules checked before saving;
 *   - who may open what: a private "My files" area opens only for the login it belongs to.
 * Every folder change goes through here (the database guards stay the last line: same-owner parents, no
 * loops, names without "/" "\" or control characters, one live name per folder).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

/** US state names (data, used only to fold the 2-letter codes some CRM rows carry — "NM" → "New Mexico"). */
const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
}

/** Pure: the state group a CRM state value belongs to ("WY" and "Wyoming" → "Wyoming"; empty → null). */
export function stateGroup(value: string | null | undefined): string | null {
  const v = (value ?? "").trim()
  if (!v) return null
  const up = v.toUpperCase()
  if (US_STATES[up]) return US_STATES[up]
  const hit = Object.values(US_STATES).find((n) => n.toLowerCase() === v.toLowerCase())
  return hit ?? v
}

/** Account statuses that put a company under "Closed / Cancelled" (the CRM's own values — one list, in browse). */
export { CLOSED_ACCOUNT_STATUSES as CLOSED_STATUSES } from "./browse"
import { CLOSED_ACCOUNT_STATUSES } from "./browse"

export interface NavOwner { id: string; kind: string; label: string; status: string | null; fileCount: number }
export interface NavGroup { key: string; label: string; section: "clients" | "business" | "private"; owners: NavOwner[] }

/** Pure: put the owners into the left-side groups (unit-tested). */
export function groupOwners(rows: Array<{ id: string; kind: string; label: string; status: string | null; fileCount: number; state: string | null; accountStatus: string | null }>): NavGroup[] {
  const byState = new Map<string, NavOwner[]>()
  const people: NavOwner[] = [], forming: NavOwner[] = [], closed: NavOwner[] = [], noState: NavOwner[] = [], unfiled: NavOwner[] = []
  const business: NavOwner[] = [], mine: NavOwner[] = []
  for (const r of rows) {
    const o: NavOwner = { id: r.id, kind: r.kind, label: r.label, status: r.status, fileCount: r.fileCount }
    if (r.kind === "business") business.push(o)
    else if (r.kind === "private") mine.push(o)
    else if (r.kind === "person") people.push(o)
    else if (r.kind === "formation") (r.status === "archived" ? closed : forming).push(o)
    else if (r.kind === "unfiled") unfiled.push(o)
    else if (r.accountStatus && CLOSED_ACCOUNT_STATUSES.includes(r.accountStatus)) closed.push(o)
    else {
      const st = stateGroup(r.state)
      if (!st) noState.push(o)
      else byState.set(st, [...(byState.get(st) ?? []), o])
    }
  }
  const sort = (a: NavOwner[]) => a.sort((x, y) => x.label.localeCompare(y.label))
  const groups: NavGroup[] = []
  for (const st of Array.from(byState.keys()).sort()) groups.push({ key: `state:${st}`, label: st, section: "clients", owners: sort(byState.get(st)!) })
  if (people.length) groups.push({ key: "people", label: "People", section: "clients", owners: sort(people) })
  if (forming.length) groups.push({ key: "forming", label: "Companies being formed", section: "clients", owners: sort(forming) })
  if (closed.length) groups.push({ key: "closed", label: "Closed / Cancelled", section: "clients", owners: sort(closed) })
  if (noState.length) groups.push({ key: "nostate", label: "Missing state (fix in the CRM)", section: "clients", owners: sort(noState) })
  if (unfiled.length) groups.push({ key: "unfiled", label: "Unfiled", section: "clients", owners: sort(unfiled) })
  groups.push({ key: "business", label: "Business", section: "business", owners: business })
  if (mine.length) groups.push({ key: "private", label: "My files", section: "private", owners: mine })
  return groups
}

/** The left side for this login: every client owner grouped, the Business area, and — for the owner-only
 *  login — their private "My files". Both areas are created on first use. */
export async function navigation(user: { id: string; email?: string | null } | null, isOwnerOnlyUser: boolean): Promise<NavGroup[]> {
  await ensureArea("business", null)
  if (isOwnerOnlyUser && user) await ensureArea("private", user.id)
  // a private area is listed only for the owner-only login, and only its own (the database function already
  // returns no one else's)
  const { data, error } = await db().rpc("store_navigation", { p_user: isOwnerOnlyUser ? user?.id ?? null : null })
  if (error) throw new Error(`store navigation: ${error.message}`)
  const { ownerLabel, ownerStatus } = await import("./browse")
  return groupOwners(((data ?? []) as Array<{ id: string; kind: string; lifecycle_override: string | null; company_name: string | null; state_of_formation: string | null; account_status: string | null; person_name: string | null; root_name: string | null; file_count: number | string }>).map((o) => ({
    id: o.id, kind: o.kind,
    label: o.kind === "business" ? "Business" : o.kind === "private" ? "My files" : ownerLabel({ kind: o.kind, company: o.company_name, person: o.person_name, root: o.root_name }),
    status: ownerStatus(o.lifecycle_override), fileCount: Number(o.file_count) || 0,
    state: o.state_of_formation, accountStatus: o.account_status,
  })))
}

/** The Business area (one) or a login's private area (one per login), created with its top folder on first use. */
export async function ensureArea(kind: "business" | "private", userId: string | null): Promise<string> {
  const { data: id, error } = await db().rpc("store_ensure_owner", { p_kind: kind, p_ref: userId })
  if (error || !id) throw new Error(`store: could not open the ${kind === "business" ? "Business" : "My files"} area — ${error?.message ?? "no id"}`)
  const { error: tErr } = await db().rpc("store_apply_template", {
    p_owner_id: id, p_template_slug: kind === "business" ? "business_standard" : "private_standard",
    p_root_name: kind === "business" ? "Business" : "My files", p_actor: userId,
  })
  if (tErr) throw new Error(`store: could not create the ${kind} top folder — ${tErr.message}`)
  return id as string
}

// ───────────────────────────────────────────────────────────── who may open what

/** A private "My files" area opens ONLY for the login it belongs to — every route checks this. */
export async function assertOwnerAccess(ownerId: string, userId: string | null): Promise<void> {
  const { data: o, error } = await db().from("store_owners").select("kind, private_user_id").eq("id", ownerId).maybeSingle()
  if (error) throw new Error("Could not check access — please try again.")
  if (!o) throw new Error("Not found.")
  if (o.kind === "private" && o.private_user_id !== userId) throw new Error("Not found.")
}
export async function ownerOfFolder(folderId: string): Promise<string> {
  const { data, error } = await db().from("store_folders").select("owner_id").eq("id", folderId).maybeSingle()
  if (error || !data) throw new Error("Folder not found.")
  return data.owner_id as string
}
export async function ownerOfFile(fileId: string): Promise<string> {
  const { data, error } = await db().from("store_files").select("owner_id").eq("id", fileId).maybeSingle()
  if (error || !data) throw new Error("File not found.")
  return data.owner_id as string
}

// ───────────────────────────────────────────────────────────── folders

interface FolderRow { id: string; owner_id: string; parent_id: string | null; kind: string; template_slug: string | null; name: string; trashed_at: string | null }

async function folder(folderId: string): Promise<FolderRow> {
  const { data, error } = await db().from("store_folders").select("id, owner_id, parent_id, kind, template_slug, name, trashed_at").eq("id", folderId).maybeSingle()
  if (error) throw new Error(`Could not read the folder — please try again (${error.message}).`)
  if (!data) throw new Error("Folder not found.")
  return data as FolderRow
}

/** Pure: a folder made by a template (the client's top folder, the 5 company folders, a person's 3 folders,
 *  the Business / My files top folders) is locked — it can't be renamed, moved or deleted. */
export function isLockedFolder(f: { template_slug: string | null; parent_id: string | null }): boolean {
  return f.template_slug !== null || f.parent_id === null
}

export { cleanFolderName } from "./names"
import { cleanFolderName } from "./names"

/** The nearest fixed folder kind above a folder (a year folder inside "3. Tax" counts as Tax). */
export async function effectiveKind(folderId: string): Promise<string> {
  let cur: string | null = folderId
  for (let i = 0; i < 50 && cur; i++) {
    const f = await folder(cur)
    if (f.kind !== "custom") return f.kind
    cur = f.parent_id
  }
  return "custom"
}

/** The CRM documents-list category for a file saved in this folder (a year folder in "3. Tax" → Tax). */
export async function categoryForFolder(folderId: string): Promise<{ num: number; name: string }> {
  const { FOLDER_KIND_CATEGORY } = await import("./browse")
  return FOLDER_KIND_CATEGORY[await effectiveKind(folderId)] ?? FOLDER_KIND_CATEGORY.correspondence
}

async function nameTaken(ownerId: string, parentId: string, name: string, exceptId?: string): Promise<boolean> {
  const { data } = await db().from("store_folders").select("id, name").eq("owner_id", ownerId).eq("parent_id", parentId).is("trashed_at", null)
  return ((data ?? []) as { id: string; name: string }[]).some((f) => f.id !== exceptId && f.name.trim().toLowerCase() === name.toLowerCase())
}

async function logFolder(event: string, f: { id: string; owner_id: string; name: string }, actor: string | null, details: Record<string, unknown>) {
  const { error } = await db().from("store_events").insert({ event, actor, owner_id: f.owner_id, folder_id: f.id, name_snapshot: f.name, details })
  if (error) console.error(`[crm-store] ${event} not logged for folder ${f.id}: ${error.message}`)
}

export async function createFolder(parentId: string, name: string, actorId: string | null, kind = "custom"): Promise<{ id: string; name: string }> {
  const p = await folder(parentId)
  if (p.trashed_at) throw new Error("That folder is in the trash.")
  if (p.kind === "contacts") throw new Error("\"2. Contacts\" shows each person's own storage — open the person to add a folder there.")
  const clean = cleanFolderName(name)
  if (await nameTaken(p.owner_id, parentId, clean)) throw new Error(`"${clean}" already exists here.`)
  const { data, error } = await db().from("store_folders").insert({ owner_id: p.owner_id, parent_id: parentId, kind, name: clean, created_by: actorId }).select("id, name").single()
  if (error) throw new Error(/name_key|duplicate/i.test(error.message) ? `"${clean}" already exists here.` : `The folder could not be created (${error.message}).`)
  await logFolder("folder_created", { id: data.id, owner_id: p.owner_id, name: clean }, actorId, { parent: parentId })
  return { id: data.id as string, name: data.name as string }
}

/** "New tax year": a four-digit year folder inside a Tax folder (company or person). */
export async function createTaxYear(taxFolderId: string, year: string, actorId: string | null): Promise<{ id: string; name: string }> {
  const kind = await effectiveKind(taxFolderId)
  if (kind !== "tax" && kind !== "person_tax") throw new Error("A tax-year folder goes inside a Tax folder.")
  if (!/^(19|20)\d{2}$/.test(year.trim())) throw new Error("Enter a four-digit year, e.g. 2025.")
  // a year folder is its own kind (so a file saved in it is known to be for that year) but not locked
  return createFolder(taxFolderId, year.trim(), actorId, kind === "tax" ? "tax_year" : "person_tax_year")
}

export { suggestTaxYear } from "./names"

export async function renameFolder(folderId: string, name: string, actorId: string | null): Promise<{ name: string }> {
  const f = await folder(folderId)
  if (f.trashed_at) throw new Error("That folder is in the trash.")
  if (isLockedFolder(f)) throw new Error(`"${f.name}" is one of the fixed folders and can't be renamed.`)
  const clean = cleanFolderName(name)
  if (clean === f.name) return { name: clean }
  if (await nameTaken(f.owner_id, f.parent_id!, clean, f.id)) throw new Error(`"${clean}" already exists here.`)
  const { error } = await db().from("store_folders").update({ name: clean }).eq("id", folderId).is("trashed_at", null)
  if (error) throw new Error(`The folder could not be renamed (${error.message}).`)
  await logFolder("folder_renamed", { ...f, name: clean }, actorId, { from: f.name, to: clean })
  return { name: clean }
}

export async function moveFolder(folderId: string, toParentId: string, actorId: string | null): Promise<{ parentName: string }> {
  const f = await folder(folderId)
  const to = await folder(toParentId)
  if (f.trashed_at || to.trashed_at) throw new Error("That folder is in the trash.")
  if (isLockedFolder(f)) throw new Error(`"${f.name}" is one of the fixed folders and can't be moved.`)
  if (to.owner_id !== f.owner_id) throw new Error("A folder can only be moved within the same company's or person's storage.")
  if (to.kind === "contacts") throw new Error("\"2. Contacts\" shows each person's own storage — a folder can't go there.")
  if (to.id === f.parent_id) return { parentName: to.name }
  if (to.id === f.id) throw new Error("A folder can't go inside itself.")
  if (await nameTaken(f.owner_id, to.id, f.name, f.id)) throw new Error(`"${to.name}" already has a folder called "${f.name}".`)
  const { error } = await db().from("store_folders").update({ parent_id: to.id }).eq("id", folderId).is("trashed_at", null)
  if (error) throw new Error(/loop/i.test(error.message) ? "A folder can't go inside one of its own sub-folders." : `The folder could not be moved (${error.message}).`)
  // the files inside keep their CRM category in step with the new place
  await refreshCategories(f.owner_id, folderId)
  await logFolder("folder_moved", f, actorId, { from_parent: f.parent_id, to_parent: to.id })
  return { parentName: to.name }
}

/** Every live file under a folder (all levels) — for the move/delete questions and category refresh. */
export async function filesUnder(folderId: string): Promise<Array<{ id: string; name: string; folder_id: string }>> {
  const all: string[] = [folderId]
  for (let i = 0; i < all.length && i < 5000; i++) {
    const { data } = await db().from("store_folders").select("id").eq("parent_id", all[i]).is("trashed_at", null)
    for (const c of data ?? []) all.push(c.id)
  }
  const { data: files, error } = await db().from("store_files").select("id, name, folder_id").in("folder_id", all).eq("state", "live")
  if (error) throw new Error(`Could not read the folder's files (${error.message}).`)
  return (files ?? []) as Array<{ id: string; name: string; folder_id: string }>
}

async function refreshCategories(ownerId: string, folderId: string) {
  const { data: o } = await db().from("store_owners").select("kind").eq("id", ownerId).maybeSingle()
  if (o?.kind === "person") return
  const { FOLDER_KIND_CATEGORY } = await import("./browse")
  const cat = FOLDER_KIND_CATEGORY[await effectiveKind(folderId)]
  if (!cat) return
  const { storePointer } = await import("./document-pointer")
  const files = await filesUnder(folderId)
  if (!files.length) return
  const { error } = await db().from("documents").update({ category: cat.num, category_name: cat.name, updated_at: new Date().toISOString() })
    .in("drive_file_id", files.map((x) => storePointer(x.id)))
  if (error) console.error(`[crm-store] folder move: categories not refreshed: ${error.message}`)
}

/** What a folder delete / move would touch: every file (all levels, first 500 listed) and which the client sees. */
export async function folderSummary(folderId: string): Promise<{ name: string; files: number; shown: number; list: Array<{ id: string; name: string; shown: boolean }>; locked: boolean }> {
  const f = await folder(folderId)
  const files = await filesUnder(folderId)
  const shownIds = new Set<string>()
  if (files.length) {
    const { storePointer } = await import("./document-pointer")
    for (let i = 0; i < files.length; i += 200) {
      const chunk = files.slice(i, i + 200)
      const { data, error } = await db().from("documents").select("drive_file_id")
        .in("drive_file_id", chunk.map((x) => storePointer(x.id))).eq("portal_visible", true)
      if (error) throw new Error(`Could not check what the client sees (${error.message}).`)
      for (const r of data ?? []) shownIds.add(String(r.drive_file_id).slice("store:".length))
    }
  }
  const list = files.map((x) => ({ id: x.id, name: x.name, shown: shownIds.has(x.id) }))
    .sort((a, b) => Number(b.shown) - Number(a.shown) || a.name.localeCompare(b.name)).slice(0, 500)
  return { name: f.name, files: files.length, shown: shownIds.size, list, locked: isLockedFolder(f) }
}

/** Hide from the client only the chosen files under a folder ("Pick which ones to hide"). */
export async function hideChosenUnder(folderId: string, fileIds: string[], actorId: string | null): Promise<number> {
  const inside = new Set((await filesUnder(folderId)).map((x) => x.id))
  const { setClientVisibility } = await import("./browse")
  let n = 0
  for (const id of fileIds) {
    if (!inside.has(id)) continue
    await setClientVisibility(id, false, actorId)
    n++
  }
  return n
}

/** Hide from the client every file under a folder (the "hide the visible ones first" answer). */
export async function hideAllUnder(folderId: string, actorId: string | null): Promise<number> {
  const { setClientVisibility } = await import("./browse")
  const files = await filesUnder(folderId)
  let n = 0
  const failed: string[] = []
  for (const f of files) {
    try { await setClientVisibility(f.id, false, actorId); n++ } catch (e) {
      // a file with no CRM listing cannot be seen by the client anyway; anything else is a real failure
      if (!/not listed in the CRM documents list/i.test(e instanceof Error ? e.message : "")) failed.push(f.name)
    }
  }
  if (failed.length) throw new Error(`These files could not be hidden, so nothing else was done: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? " …" : ""}`)
  return n
}

/** Delete a folder: the folder and everything in it go to the store TRASH as one batch (recoverable 90 days);
 *  the CRM listings of its files are removed so the portal stops showing them. */
export async function deleteFolder(folderId: string, actorId: string | null): Promise<{ files: number }> {
  if (!actorId) throw new Error("Only a signed-in staff member can delete a folder.")
  const f = await folder(folderId)
  if (f.trashed_at) throw new Error("That folder is already in the trash.")
  if (isLockedFolder(f)) throw new Error(`"${f.name}" is one of the fixed folders and can't be deleted.`)
  const files = await filesUnder(folderId)
  const { storePointer } = await import("./document-pointer")
  const pointers = files.map((x) => storePointer(x.id))
  // listings first (kept in memory) so a refusal by the trash (legal hold …) can put them back
  const { data: removed, error: dErr } = pointers.length
    ? await db().from("documents").delete().in("drive_file_id", pointers).select("*")
    : { data: [], error: null }
  if (dErr) throw new Error(`The CRM list could not be updated, so the folder was not deleted (${dErr.message}).`)
  const { error } = await db().rpc("store_trash_folder", { p_folder_id: folderId, p_actor: actorId, p_reason: "Folder deleted by staff from the CRM" })
  if (error) {
    if ((removed ?? []).length) await db().from("documents").insert(removed)
    throw new Error(error.message.replace(/^store: /, ""))
  }
  return { files: files.length }
}

// ───────────────────────────────────────────────────────────── the questions (Part 16)

export interface StoreQuestion { enabled: boolean; title: string; choices: Record<string, string> }

/** The questions the system asks, from the catalog (a question switched off = the default, no question). */
export async function listQuestions(): Promise<Record<string, StoreQuestion>> {
  const { data, error } = await db().from("catalog_entries").select("slug, display_name, status, metadata").eq("catalog_id", "storage_questions")
  if (error) throw new Error(`store questions: ${error.message}`)
  const out: Record<string, StoreQuestion> = {}
  for (const r of (data ?? []) as { slug: string; display_name: string; status: string; metadata: { enabled?: boolean; choices?: Record<string, string> } | null }[]) {
    out[r.slug] = { enabled: r.status === "active" && r.metadata?.enabled !== false, title: r.display_name, choices: r.metadata?.choices ?? {} }
  }
  return out
}

export interface IdenticalFile { fileId: string; name: string; ownerId: string; where: string; mimeType: string | null }

/** Live files whose CURRENT copy has exactly these bytes (sha256), anywhere this login may open. */
export async function findIdenticalFiles(sha256: string, userId: string | null): Promise<IdenticalFile[]> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Bad fingerprint.")
  const { data, error } = await db().from("store_file_versions").select("id, mime_type, store_files!store_file_versions_file_id_fkey(id, name, owner_id, folder_id, state, current_version_id, store_owners(kind, private_user_id))")
    .eq("sha256", sha256).limit(50)
  if (error) throw new Error(`Could not look for the same file (${error.message}).`)
  const hits: IdenticalFile[] = []
  const labels = new Map<string, string>()
  for (const v of (data ?? []) as Array<{ id: string; mime_type: string | null; store_files: { id: string; name: string; owner_id: string; folder_id: string; state: string; current_version_id: string | null; store_owners: { kind: string; private_user_id: string | null } | null } | null }>) {
    const f = v.store_files
    if (!f || f.state !== "live" || f.current_version_id !== v.id) continue
    if (f.store_owners?.kind === "private" && f.store_owners.private_user_id !== userId) continue
    if (!labels.has(f.owner_id)) {
      const { data: nav } = await db().rpc("store_navigation", { p_user: userId })
      for (const o of (nav ?? []) as Array<{ id: string; kind: string; company_name: string | null; person_name: string | null; root_name: string | null }>) {
        const { ownerLabel } = await import("./browse")
        labels.set(o.id, ownerLabel({ kind: o.kind, company: o.company_name, person: o.person_name, root: o.root_name }))
      }
    }
    hits.push({ fileId: f.id, name: f.name, ownerId: f.owner_id, where: [labels.get(f.owner_id) ?? "Storage", ...(await folderPathNames(f.folder_id))].join(" › "), mimeType: v.mime_type })
  }
  return hits
}

/** Folder names from below the top folder down to this one ("3. Tax", "2025"). */
async function folderPathNames(folderId: string): Promise<string[]> {
  const names: string[] = []
  let cur: string | null = folderId
  for (let i = 0; i < 50 && cur; i++) {
    const f = await folder(cur)
    if (f.parent_id) names.unshift(f.name)
    cur = f.parent_id
  }
  return names
}

/** "Decide later": mark a file red "Needs review" (it stays hidden from the client). */
export async function markNeedsReview(fileId: string, reason: string, actorId: string | null): Promise<void> {
  const { data, error } = await db().from("store_files").update({ needs_review_at: new Date().toISOString(), needs_review_reason: reason.slice(0, 200) })
    .eq("id", fileId).eq("state", "live").select("id, owner_id, folder_id, name")
  if (error) throw new Error(`The file was saved, but could not be marked "Needs review" (${error.message}).`)
  const f = (data ?? [])[0]
  if (f) await db().from("store_events").insert({ event: "needs_review", actor: actorId, owner_id: f.owner_id, file_id: f.id, folder_id: f.folder_id, name_snapshot: f.name, details: { reason } })
}

/** Staff settled a "Needs review" file. */
export async function clearNeedsReview(fileId: string, actorId: string | null): Promise<void> {
  const { data, error } = await db().from("store_files").update({ needs_review_at: null, needs_review_reason: null })
    .eq("id", fileId).eq("state", "live").select("id, owner_id, folder_id, name")
  if (error) throw new Error(`Could not clear "Needs review" (${error.message}).`)
  const f = (data ?? [])[0]
  if (!f) throw new Error("File not found.")
  await db().from("store_events").insert({ event: "reviewed", actor: actorId, owner_id: f.owner_id, file_id: f.id, folder_id: f.folder_id, name_snapshot: f.name, details: {} })
}
