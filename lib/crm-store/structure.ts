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
  // the owners share ONE "My files" — the primary owner's (never a separate one per owner)
  const ownersArea = isOwnerOnlyUser && user ? await ownersAreaUserId() : null
  if (ownersArea) await ensureArea("private", ownersArea)
  // a private area is listed only for the owners, and only the owners' one (the database function returns no other)
  const { data, error } = await db().rpc("store_navigation", { p_user: ownersArea })
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

/**
 * The owners' shared "My files" (Antonio 2026-09-28): the area of the primary owner's login, opened by EVERY
 * owner-only login (the owner list is code, lib/auth.ts). Any other private area only for its own login.
 */
let primaryOwnerIdCache: { id: string | null; at: number } | null = null
export async function ownersAreaUserId(): Promise<string | null> {
  if (primaryOwnerIdCache && Date.now() - primaryOwnerIdCache.at < 10 * 60_000) return primaryOwnerIdCache.id
  const { PRIMARY_OWNER_EMAIL } = await import("@/lib/auth")
  const { findAuthUserByEmail } = await import("@/lib/auth-admin-helpers")
  const u = await findAuthUserByEmail(PRIMARY_OWNER_EMAIL)
  primaryOwnerIdCache = { id: u?.id ?? null, at: Date.now() }
  return primaryOwnerIdCache.id
}

/** Pure: may this login open this private area? (its own; or the owners' area for an owner-only login) */
export function mayOpenPrivateArea(areaUserId: string | null, login: { id: string | null; ownerOnly: boolean }, ownersAreaUser: string | null): boolean {
  if (!areaUserId || !login.id) return false
  if (areaUserId === login.id) return true
  return login.ownerOnly && !!ownersAreaUser && areaUserId === ownersAreaUser
}

/** A private "My files" area opens only for its login (or, for the owners' area, for every owner) — every route checks this. */
export async function assertOwnerAccess(ownerId: string, login: { id: string | null; ownerOnly: boolean }): Promise<void> {
  const { data: o, error } = await db().from("store_owners").select("kind, private_user_id").eq("id", ownerId).maybeSingle()
  if (error) throw new Error("Could not check access — please try again.")
  if (!o) throw new Error("Not found.")
  if (o.kind === "private" && !mayOpenPrivateArea(o.private_user_id, login, login.ownerOnly ? await ownersAreaUserId() : null)) throw new Error("Not found.")
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

/** The CRM documents-list category for a file saved in this folder (a year folder in "3. Tax" → Tax). ONE rule,
 *  used by upload, file move and folder move. */
export async function categoryForFolder(folderId: string): Promise<{ num: number; name: string }> {
  const { categoryForKind } = await import("./browse")
  return categoryForKind(await effectiveKind(folderId))
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

/** What to hide from the client before a folder move / delete: nothing, every visible file, or the chosen files. */
export type HideChoice = "none" | "all" | { ids: string[] }

async function applyHide(folderId: string, hide: HideChoice | undefined, actorId: string | null): Promise<void> {
  if (!hide || hide === "none") return
  if (hide === "all") await hideAllUnder(folderId, actorId)
  else await hideChosenUnder(folderId, hide.ids, actorId)
}

export async function moveFolder(folderId: string, toParentId: string, actorId: string | null, hide?: HideChoice): Promise<{ parentName: string }> {
  const f = await folder(folderId)
  const to = await folder(toParentId)
  if (f.trashed_at || to.trashed_at) throw new Error("That folder is in the trash.")
  if (isLockedFolder(f)) throw new Error(`"${f.name}" is one of the fixed folders and can't be moved.`)
  if (to.owner_id !== f.owner_id) throw new Error("A folder can only be moved within the same company's or person's storage.")
  if (to.kind === "contacts") throw new Error("\"2. Contacts\" shows each person's own storage — a folder can't go there.")
  if (to.id === f.parent_id) return { parentName: to.name }
  if (to.id === f.id) throw new Error("A folder can't go inside itself.")
  // a year folder keeps its meaning only inside a Tax folder
  if (f.kind === "tax_year" || f.kind === "person_tax_year") {
    const want = f.kind === "tax_year" ? "tax" : "person_tax"
    if ((await effectiveKind(to.id)) !== want) throw new Error(`"${f.name}" is a tax-year folder — it can only go inside a Tax folder.`)
  }
  if (await nameTaken(f.owner_id, to.id, f.name, f.id)) throw new Error(`"${to.name}" already has a folder called "${f.name}".`)
  // "Shared with staff": the files keep their ticks only if the folder stays inside it (private areas only)
  const { data: ownerKindRow } = await db().from("store_owners").select("kind").eq("id", f.owner_id).maybeSingle()
  const wasInsideShare = ownerKindRow?.kind === "private" ? await (await import("./staff-share")).isInStaffShare(folderId) : null
  // every check is done — only now hide what staff chose to hide, so a refused move hides nothing
  await applyHide(folderId, hide, actorId)
  const { error } = await db().from("store_folders").update({ parent_id: to.id }).eq("id", folderId).is("trashed_at", null)
  if (error) throw new Error(/loop/i.test(error.message) ? "A folder can't go inside one of its own sub-folders." : `The folder could not be moved (${error.message}).`)
  // the files inside keep their CRM category in step with the new place, and stop being shared with staff if
  // the folder left "Shared with staff"
  await refreshCategories(f.owner_id, folderId)
  const share = await import("./staff-share")
  if (wasInsideShare !== null) await share.afterMove((await filesUnder(folderId)).map((x) => x.id), wasInsideShare, actorId)
  await logFolder("folder_moved", f, actorId, { from_parent: f.parent_id, to_parent: to.id })
  return { parentName: to.name }
}

/** Every live file under a folder (all levels) and whether the client sees it — ONE database read, no limits. */
export async function filesUnder(folderId: string): Promise<Array<{ id: string; name: string; folder_id: string; visible: boolean }>> {
  const { data, error } = await db().rpc("store_subtree_files", { p_folder: folderId })
  if (error) throw new Error(`Could not read the folder's files (${error.message}).`)
  return (data ?? []) as Array<{ id: string; name: string; folder_id: string; visible: boolean }>
}

const CHUNK = 200
const chunks = <T,>(list: T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK)); return out }

/** After a folder move: each file's CRM category from ITS OWN folder (same rule as upload and file move). */
async function refreshCategories(ownerId: string, folderId: string) {
  const { data: o } = await db().from("store_owners").select("kind").eq("id", ownerId).maybeSingle()
  if (o?.kind === "person" || o?.kind === "business" || o?.kind === "private") return
  const { storePointer } = await import("./document-pointer")
  const files = await filesUnder(folderId)
  const byFolder = new Map<string, string[]>()
  for (const x of files) byFolder.set(x.folder_id, [...(byFolder.get(x.folder_id) ?? []), x.id])
  const failed: string[] = []
  for (const [fid, ids] of Array.from(byFolder.entries())) {
    const cat = await categoryForFolder(fid)
    for (const part of chunks(ids)) {
      const { error } = await db().from("documents").update({ category: cat.num, category_name: cat.name, updated_at: new Date().toISOString() })
        .in("drive_file_id", part.map((id) => storePointer(id)))
      if (error) failed.push(error.message)
    }
  }
  if (failed.length) throw new Error(`The folder was moved, but some files' CRM categories were not updated (${failed[0]}) — move it again to retry.`)
}

/** What a folder delete / move would touch: every file (all levels, first 500 listed) and which the client sees. */
export async function folderSummary(folderId: string): Promise<{ name: string; files: number; shown: number; list: Array<{ id: string; name: string; shown: boolean }>; locked: boolean }> {
  const f = await folder(folderId)
  const files = await filesUnder(folderId)
  const list = files.map((x) => ({ id: x.id, name: x.name, shown: x.visible }))
    .sort((a, b) => Number(b.shown) - Number(a.shown) || a.name.localeCompare(b.name)).slice(0, 500)
  return { name: f.name, files: files.length, shown: files.filter((x) => x.visible).length, list, locked: isLockedFolder(f) }
}

/** Hide from the client the given files (all must be under the folder); stops at the first failure and says which. */
async function hideFiles(ids: string[], actorId: string | null): Promise<number> {
  const { setClientVisibility } = await import("./browse")
  let n = 0
  for (const id of ids) {
    try {
      await setClientVisibility(id, false, actorId)
      n++
    } catch (e) {
      throw new Error(`${n} file${n === 1 ? "" : "s"} hidden, then one could not be (${e instanceof Error ? e.message : String(e)}) — nothing else was done.`)
    }
  }
  return n
}

/** Hide from the client only the chosen files under a folder ("Pick which ones to hide"). */
export async function hideChosenUnder(folderId: string, fileIds: string[], actorId: string | null): Promise<number> {
  const inside = new Set((await filesUnder(folderId)).map((x) => x.id))
  return hideFiles(fileIds.filter((id) => inside.has(id)), actorId)
}

/** Hide from the client every file under a folder that the client sees today ("hide the visible ones first"). */
export async function hideAllUnder(folderId: string, actorId: string | null): Promise<number> {
  return hideFiles((await filesUnder(folderId)).filter((x) => x.visible).map((x) => x.id), actorId)
}

/** Delete a folder: the folder and everything in it go to the store TRASH as one batch (recoverable 90 days);
 *  the CRM listings of its files are removed so the portal stops showing them. */
export async function deleteFolder(folderId: string, actorId: string | null, hide?: HideChoice): Promise<{ files: number }> {
  if (!actorId) throw new Error("Only a signed-in staff member can delete a folder.")
  const f = await folder(folderId)
  if (f.trashed_at) throw new Error("That folder is already in the trash.")
  if (isLockedFolder(f)) throw new Error(`"${f.name}" is one of the fixed folders and can't be deleted.`)
  await applyHide(folderId, hide, actorId)
  const files = await filesUnder(folderId)
  const { storePointer } = await import("./document-pointer")
  // listings first (kept in memory) so a refusal by the trash (legal hold …) can put them back
  const removed: Record<string, unknown>[] = []
  for (const part of chunks(files.map((x) => storePointer(x.id)))) {
    const { data, error } = await db().from("documents").delete().in("drive_file_id", part).select("*")
    if (error) {
      if (removed.length) await db().from("documents").insert(removed)
      throw new Error(`The CRM list could not be updated, so the folder was not deleted (${error.message}).`)
    }
    removed.push(...(data ?? []))
  }
  const { data: batch, error } = await db().rpc("store_trash_folder", { p_folder_id: folderId, p_actor: actorId, p_reason: "Folder deleted by staff from the CRM" })
  if (error) {
    const lost: string[] = []
    for (const part of chunks(removed)) {
      const { error: iErr } = await db().from("documents").insert(part)
      if (iErr) lost.push(iErr.message)
    }
    if (lost.length) console.error(`[crm-store] folder delete refused AND ${lost.length} CRM listing chunk(s) could not be put back: ${lost[0]}`)
    throw new Error(`${error.message.replace(/^store: /, "")}${lost.length ? " — and some CRM listings could not be put back; tell the tech team." : ""}`)
  }
  // a trashed file is never shared with staff again (not even after a restore)
  {
    const { clearShares } = await import("./staff-share")
    const { data: inBatch } = batch ? await db().from("store_files").select("id").eq("trash_batch_id", batch) : { data: [] }
    await clearShares(Array.from(new Set([...files.map((x) => x.id), ...((inBatch ?? []) as { id: string }[]).map((x) => x.id)])), actorId, "trashed").catch((e: unknown) => console.error("[crm-store] shares not cleared on folder delete:", e))
  }
  // a file saved into the folder while this ran is in the same trash batch — its listing goes too
  if (batch) {
    const { data: late } = await db().from("store_files").select("id").eq("trash_batch_id", batch)
    const extra = ((late ?? []) as { id: string }[]).map((x) => storePointer(x.id)).filter((ptr) => !removed.some((r) => r.drive_file_id === ptr))
    for (const part of chunks(extra)) {
      const { data: lateRows, error: lErr } = await db().from("documents").delete().in("drive_file_id", part).select("*")
      if (lErr) console.error(`[crm-store] folder delete: a late file's listing was not removed: ${lErr.message}`)
      removed.push(...(lateRows ?? []))
    }
  }
  // remember the removed listings so a restore from the trash brings them back (hidden)
  const { rememberRemovedRows } = await import("./trash")
  await rememberRemovedRows(removed as Array<Record<string, unknown> & { drive_file_id?: string }>, actorId)
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
export async function findIdenticalFiles(sha256: string, login: { id: string | null; ownerOnly: boolean }): Promise<IdenticalFile[]> {
  const userId = login.id
  const ownersArea = login.ownerOnly ? await ownersAreaUserId() : null
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Bad fingerprint.")
  // only CURRENT copies of LIVE files (the join is on the file's current version), so old versions never crowd them out
  const { data, error } = await db().from("store_files")
    .select("id, name, owner_id, folder_id, store_owners(kind, private_user_id), store_file_versions!store_files_current_version_fk!inner(sha256, mime_type)")
    .eq("state", "live").eq("store_file_versions.sha256", sha256).limit(50)
  if (error) throw new Error(`Could not look for the same file (${error.message}).`)
  const rows = ((data ?? []) as Array<{ id: string; name: string; owner_id: string; folder_id: string; store_owners: { kind: string; private_user_id: string | null } | null; store_file_versions: { mime_type: string | null } | null }>)
    // an unreadable owner counts as private (fails closed); a private area only for its own login
    .filter((f) => !!f.store_owners && (f.store_owners.kind !== "private" || mayOpenPrivateArea(f.store_owners.private_user_id, login, ownersArea)))
  if (rows.length === 0) return []
  const { data: nav, error: nErr } = await db().rpc("store_navigation", { p_user: ownersArea ?? userId })
  if (nErr) throw new Error(`Could not look for the same file (${nErr.message}).`)
  const { ownerLabel } = await import("./browse")
  const labels = new Map<string, string>()
  for (const o of (nav ?? []) as Array<{ id: string; kind: string; company_name: string | null; person_name: string | null; root_name: string | null }>) {
    labels.set(o.id, ownerLabel({ kind: o.kind, company: o.company_name, person: o.person_name, root: o.root_name }))
  }
  const hits: IdenticalFile[] = []
  for (const f of rows) {
    hits.push({ fileId: f.id, name: f.name, ownerId: f.owner_id, where: [labels.get(f.owner_id) ?? "Storage", ...(await folderPathNames(f.folder_id))].join(" › "), mimeType: f.store_file_versions?.mime_type ?? null })
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
