/**
 * The server half of the "Where should this be saved?" window (dev job c43a8b2e): what staff chose is CHECKED here, before anything
 * else happens, and only then filed through the ordinary storage writer.
 *
 * - `parseSaveChoice`   pure: the request's choice → a typed choice, or a plain error.
 * - `decideDestination` pure: the facts about the chosen place → allowed, or ONE plain sentence why not.
 * - `validateDestination` reads those facts (live) and decides. The Fax send route calls it BEFORE the fax goes out, so a place that
 *   is not allowed stops the whole send and staff are told in the window.
 * - `saveToDestination` files the bytes: makes the one folder the rule needs (a tax-year folder, Business › Fax) if it is missing,
 *   then writes through `savePilotFile` (the same writer every other save uses). Same file twice = one file; a different file with
 *   the same name gets the writer's " (2)". Nothing here ever touches Google Drive.
 * - `resolveProposal`   turns the pure proposal (`save-where.ts`) into real ids + the real folder names for the window.
 */

import { cleanNewFileName, folderNameProblem } from "./names"
import { NO_STORAGE_REASON_SENTENCE } from "./no-storage"
import { documentTypeFor, proposeFaxPlace, type FaxPurpose, type PlaceProposal, isFaxPurpose, type SaveDocumentType } from "./save-where"
import { personalKind, type PersonalKind } from "@/lib/fax/save-sent-upload"

export interface SaveChoiceSave {
  mode: "save"
  purpose: FaxPurpose
  ownerId: string
  /** the folder the file goes in — or, with `newFolderName`, the folder the new folder is made in */
  folderId: string
  newFolderName: string | null
  fileName: string
  /** set when the place came straight from the window's PROPOSAL (not from "Change place"): who the proposal was for, so the server can re-derive it */
  proposalOf: { accountId: string | null; business: boolean } | null
}
export type SaveChoice = SaveChoiceSave | { mode: "dont_save" }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Pure: the `save_choice` of a request. Missing → null (the old callers); anything malformed → a plain error. */
export function parseSaveChoice(raw: unknown): { ok: boolean; choice: SaveChoice | null; error?: string } {
  if (raw === undefined || raw === null) return { ok: true, choice: null }
  if (typeof raw !== "object") return { ok: false, choice: null, error: "The place to save the fax in was not understood. Please choose it again." }
  const r = raw as Record<string, unknown>
  if (r.mode === "dont_save") return { ok: true, choice: { mode: "dont_save" } }
  if (r.mode !== "save") return { ok: false, choice: null, error: "The place to save the fax in was not understood. Please choose it again." }
  if (!isFaxPurpose(r.purpose)) return { ok: false, choice: null, error: "Say what this fax is, then choose the place again." }
  if (typeof r.ownerId !== "string" || !UUID.test(r.ownerId) || typeof r.folderId !== "string" || !UUID.test(r.folderId)) {
    return { ok: false, choice: null, error: "The place to save the fax in was not understood. Please choose it again." }
  }
  if (typeof r.fileName !== "string" || !r.fileName.trim()) return { ok: false, choice: null, error: "Enter a file name." }
  const nf = typeof r.newFolderName === "string" && r.newFolderName.trim() ? r.newFolderName : null
  let proposalOf: SaveChoiceSave["proposalOf"] = null
  if (r.proposalOf !== undefined && r.proposalOf !== null) {
    const po = r.proposalOf as Record<string, unknown>
    if (typeof po !== "object" || (po.accountId !== null && po.accountId !== undefined && (typeof po.accountId !== "string" || !UUID.test(po.accountId)))) {
      return { ok: false, choice: null, error: "The place to save the fax in was not understood. Please choose it again." }
    }
    proposalOf = { accountId: typeof po.accountId === "string" ? po.accountId : null, business: po.business === true }
  }
  return { ok: true, choice: { mode: "save", purpose: r.purpose, ownerId: r.ownerId, folderId: r.folderId, newFolderName: nf, fileName: r.fileName, proposalOf } }
}

export const IDENTITY_PAPER_SENTENCE =
  "This looks like a person's own paper (passport, ID, visa, ITIN, proof of address …). It can't be saved in a company's or a person's storage from the Fax tool. Choose Business or My files, or use \"Don't save, just send\"."

export interface DestinationFacts {
  owner: { id: string; kind: string; studyOnly: boolean; accountId: string | null; contactId: string | null } | null
  folder: { id: string; ownerId: string; kind: string; trashed: boolean } | null
  /** a company owner only: "moving" when its files are being moved right now */
  companyState: "store" | "moving" | "drive" | null
  /** the plain sentence for a company / person that is not live in the storage (from no-storage.ts) */
  noStorageSentence: string | null
  accessOk: boolean
  newFolderName: string | null
  fileName: string
  /** the uploaded file's own name: renaming a passport to "doc.pdf" must not get past the personal-paper check */
  uploadName?: string
}

const INTERNAL = new Set(["business", "private"])
export const isInternalKind = (k: string | null | undefined) => !!k && INTERNAL.has(k)

export type Decision = { ok: boolean; error?: string; /** keep the CRM row off the company's Documents tab */ unlinked?: boolean }

/** Pure: may the file go there? ONE plain sentence when not. */
export function decideDestination(f: DestinationFacts): Decision {
  const no = (error: string): Decision => ({ ok: false, error })
  if (!f.owner || !f.accessOk) return no("That place no longer exists. Choose another place.")
  // a company in the middle of its move is checked FIRST: it has no live storage yet, but its answer is "try again in a few minutes",
  // never the sentence for a company that stays in its old folder
  if (f.owner.kind === "company" && f.companyState === "moving") return no(NO_STORAGE_REASON_SENTENCE.moving)
  if (f.owner.studyOnly) return no(f.noStorageSentence ?? "This place has no document storage in the CRM, so the file could not be saved there.")
  if (f.owner.kind === "company" && f.companyState === "drive") return no(f.noStorageSentence ?? NO_STORAGE_REASON_SENTENCE.no_folder)
  if (!f.folder || f.folder.ownerId !== f.owner.id) return no("That folder is not in the place you chose. Choose the place again.")
  if (f.folder.trashed) return no("That folder is in the trash. Choose another place.")
  if (f.folder.kind === "contacts") return no("\"2. Contacts\" shows each person's own storage. Open the person to save there.")
  if (f.newFolderName) {
    // a folder of that name that already exists is simply used (a retry, or two people at once): only the name itself is checked
    const problem = folderNameProblem(f.newFolderName, [])
    if (problem) return no(problem)
  } else if (f.folder.kind === "root") {
    return no("Open one of the folders first. Files go inside a folder, not at the top.")
  }
  if (!f.fileName.trim()) return no("Enter a file name.")
  const client = !isInternalKind(f.owner.kind)
  const kinds = [personalKind(f.fileName), f.uploadName ? personalKind(f.uploadName) : null]
  const pk: PersonalKind = kinds.includes("identity") ? "identity" : kinds.includes("form") ? "form" : null
  if (client && pk === "identity") return no(IDENTITY_PAPER_SENTENCE)
  return { ok: true, unlinked: client && pk === "form" }
}

export interface OwnerRow { id: string; kind: string; study_only: boolean; account_id: string | null; contact_id: string | null; service_delivery_id: string | null }

export interface DestinationDeps {
  readOwner(ownerId: string): Promise<OwnerRow | null>
  readFolder(folderId: string): Promise<{ id: string; owner_id: string; kind: string; trashed_at: string | null } | null>
  companyState(accountId: string): Promise<"store" | "moving" | "drive">
  noStorageSentence(owner: OwnerRow): Promise<string>
  access(ownerId: string): Promise<boolean>
}

/**
 * The ONE sentence for a company that has no live storage — moving FIRST (a company mid-move has no live storage yet; it must hear
 * "try again in a few minutes", not the sentence for a company that stays in its old folder), then the true reason from no-storage.ts.
 */
export async function noStorageSentenceFor(
  accountId: string,
  deps: { companyState(id: string): Promise<"store" | "moving" | "drive">; decisionSentence(id: string): Promise<string> },
): Promise<string> {
  if ((await deps.companyState(accountId)) === "moving") return NO_STORAGE_REASON_SENTENCE.moving
  return deps.decisionSentence(accountId)
}
const realDeps = () => ({ companyState: async (id: string) => (await import("./switched-drive-guard")).companyDocState(id) })

export interface Validated { decision: Decision; owner: OwnerRow | null; /** the name it will be saved under (the typed name, extension kept) */ finalName: string }

/** Reads the live facts about the chosen place and decides (a read error is an error, never a "yes"). `uploadName` = the file's own name (its extension is kept). */
export async function validateDestination(choice: SaveChoiceSave, deps: DestinationDeps, uploadName: string): Promise<Validated> {
  let finalName = ""
  try { finalName = cleanNewFileName(choice.fileName, uploadName) } catch (e) {
    return { decision: { ok: false, error: e instanceof Error ? e.message : "Enter a file name." }, owner: null, finalName: "" }
  }
  const owner = await deps.readOwner(choice.ownerId)
  const accessOk = owner ? await deps.access(owner.id) : false
  const folder = owner ? await deps.readFolder(choice.folderId) : null
  const companyState = owner && owner.kind === "company" && owner.account_id ? await deps.companyState(owner.account_id) : null
  const noStorageSentence = owner && owner.study_only ? await deps.noStorageSentence(owner) : null
  const decision = decideDestination({
    owner: owner ? { id: owner.id, kind: owner.kind, studyOnly: owner.study_only, accountId: owner.account_id, contactId: owner.contact_id } : null,
    folder: folder ? { id: folder.id, ownerId: folder.owner_id, kind: folder.kind, trashed: !!folder.trashed_at } : null,
    companyState, noStorageSentence, accessOk, newFolderName: choice.newFolderName, fileName: finalName, uploadName,
  })
  return { decision, owner, finalName }
}

// ─────────────────────────────────────────────────────────── real (database) dependencies

// store_* tables are not in the generated types until production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sdb(): Promise<any> { return (await import("@/lib/supabase-admin")).supabaseAdmin }

export function realDestinationDeps(login: { id: string | null; ownerOnly: boolean }): DestinationDeps {
  return {
    readOwner: async (ownerId) => {
      const { data, error } = await (await sdb()).from("store_owners").select("id, kind, study_only, account_id, contact_id, service_delivery_id").eq("id", ownerId).maybeSingle()
      if (error) throw new Error("Could not check the place you chose. Please try again.")
      return (data as OwnerRow | null) ?? null
    },
    readFolder: async (folderId) => {
      const { data, error } = await (await sdb()).from("store_folders").select("id, owner_id, kind, trashed_at").eq("id", folderId).maybeSingle()
      if (error) throw new Error("Could not check the folder you chose. Please try again.")
      return data ?? null
    },
    companyState: async (accountId) => (await import("./switched-drive-guard")).companyDocState(accountId),
    noStorageSentence: async (owner) => {
      if (owner.kind === "person") return (await import("./no-storage")).NO_PERSON_STORAGE_SENTENCE
      if (owner.kind === "company" && owner.account_id) return noStorageSentenceFor(owner.account_id, { companyState: realDeps().companyState, decisionSentence: async (id) => (await (await import("./no-storage")).noStorageDecisionFor(id)).sentence })
      return (await import("./no-storage")).NO_STORAGE_SENTENCE
    },
    access: async (ownerId) => {
      try { await (await import("./structure")).assertOwnerAccess(ownerId, login); return true } catch { return false }
    },
  }
}

// ─────────────────────────────────────────────────────────── filing

export interface FiledCopy {
  fileId: string
  documentRowId: string | null
  write: string
  name: string
  ownerId: string
  folderId: string
  accountId: string | null
  documentType: SaveDocumentType | null
  /** "Company › 3. Tax › 2025" as it really is */
  path: string
}

export interface FileDeps {
  ensureFolder(parentId: string, name: string, actor: string | null): Promise<string>
  save(p: { ownerId: string; folderId: string; name: string; bytes: Buffer; mimeType: string | null; documentType: string | null; callerKey: string; periodYear: number | null; actor: string | null }): Promise<{ fileId: string; status: string; name: string }>
  upsertRow(fileId: string, row: Record<string, unknown>, status: string): Promise<{ id: string }>
  trash(fileId: string): Promise<void>
  rowLinks(owner: OwnerRow): Promise<{ account: string | null; contact: string | null }>
  pathOf(folderId: string, ownerId: string): Promise<string>
  documentTypeLabel(slug: string): Promise<string | null>
}

/** Pure: the key that makes a retry the same file: the place + the exact bytes. A different file with the same name gets a different key. */
export function saveCallerKey(ownerId: string, folderId: string, name: string, sha256: string): string {
  return `fax-save:${ownerId}:${folderId}:${name.toLowerCase()}:${sha256}`
}

/** Files the bytes at the (already validated) place. Throws on any failure — the caller reports it; the fax has already gone out. */
export async function saveToDestination(
  choice: SaveChoiceSave, owner: OwnerRow, input: { bytes: Buffer; mimeType: string | null; sha256: string; actor: string | null; unlinked: boolean; finalName: string; periodYear?: number | null },
  deps: FileDeps,
): Promise<FiledCopy> {
  const internal = isInternalKind(owner.kind)
  const docType = documentTypeFor(choice.purpose, internal)
  let folderId = choice.folderId
  if (choice.newFolderName) folderId = await deps.ensureFolder(choice.folderId, choice.newFolderName.trim(), input.actor)
  const name = input.finalName
  const year = input.periodYear ?? null
  const w = await deps.save({
    ownerId: owner.id, folderId, name, bytes: input.bytes, mimeType: input.mimeType, documentType: docType,
    callerKey: saveCallerKey(owner.id, folderId, name, input.sha256), periodYear: year,
    actor: input.actor && UUID.test(input.actor) ? input.actor : null,
  })
  const path = await deps.pathOf(folderId, owner.id)
  // The firm's own areas (Business, My files) keep the file in the storage only: no CRM row (nobody outside the firm sees it).
  // A client's storage also lists it in the CRM documents list, hidden from the client — except a person's own form (SS-4, 1040 …),
  // which is listed against NO company.
  if (internal) return { fileId: w.fileId, documentRowId: null, write: w.status, name: w.name, ownerId: owner.id, folderId, accountId: null, documentType: docType, path }
  try {
    const links = input.unlinked ? { account: null, contact: null } : await deps.rowLinks(owner)
    const label = docType ? await deps.documentTypeLabel(docType) : null
    const row = await deps.upsertRow(w.fileId, {
      file_name: w.name, mime_type: input.mimeType, file_size: input.bytes.length, account_id: links.account, contact_id: links.contact,
      portal_visible: false, document_type_name: label, status: "classified",
    }, w.status)
    return { fileId: w.fileId, documentRowId: row.id, write: w.status, name: w.name, ownerId: owner.id, folderId, accountId: links.account, documentType: docType, path }
  } catch (e) {
    // saved but could not be listed: do not leave a hidden orphan behind (best effort)
    if (w.status === "created") { try { await deps.trash(w.fileId) } catch { /* best effort */ } }
    throw e
  }
}

export function realFileDeps(): FileDeps {
  return {
    ensureFolder: async (parentId, name, actor) => {
      const s = await import("./structure")
      const db = await sdb()
      const find = async () => {
        const { data, error } = await db.from("store_folders").select("id, name").eq("parent_id", parentId).is("trashed_at", null)
        if (error) throw new Error("Could not read the folders. Please try again.")
        return ((data ?? []) as Array<{ id: string; name: string }>).find((r) => r.name.trim().toLowerCase() === name.trim().toLowerCase())?.id
      }
      const have = await find()
      if (have) return have
      try {
        // a four-digit name inside a Tax folder is a tax-year folder; anything else is an ordinary folder
        const kind = await s.effectiveKind(parentId)
        if (/^(19|20)\d{2}$/.test(name) && kind === "tax") return (await s.createTaxYear(parentId, name, actor)).id
        return (await s.createFolder(parentId, name, actor)).id
      } catch (e) {
        const again = await find() // made a moment ago by someone else
        if (again) return again
        throw e
      }
    },
    save: async (p) => {
      const pilot = await import("./formation-pilot")
      const w = await pilot.savePilotFile({
        ownerId: p.ownerId, folderKind: "custom", folderId: p.folderId, name: p.name, bytes: p.bytes, mimeType: p.mimeType,
        documentType: p.documentType, callerKey: p.callerKey, published: false,
        // a file in a tax-year folder is for that year (the nearest year folder above, as every staff upload does)
        periodYear: p.periodYear ?? await (await import("./structure")).nearestYear(p.folderId), actor: p.actor,
      })
      return { fileId: w.fileId, status: w.status, name: w.name }
    },
    upsertRow: async (fileId, row, status) => {
      const pilot = await import("./formation-pilot")
      return pilot.upsertStoreDocumentRow(fileId, row as unknown as import("./formation-pilot").DocumentsRow, status as never)
    },
    trash: async (fileId) => { await (await sdb()).rpc("store_trash_file", { p_file_id: fileId, p_actor: null, p_reason: "fax copy could not be listed" }) },
    rowLinks: async (owner) => (await import("./owner-links")).rowLinksForOwner(owner),
    pathOf: async (folderId, ownerId) => pathOfFolder(folderId, ownerId),
    documentTypeLabel: async (slug) => {
      const { data } = await (await sdb()).from("catalog_entries").select("display_name").eq("catalog_id", "storage_document_types").eq("slug", slug).maybeSingle()
      return (data?.display_name as string | undefined) ?? null
    },
  }
}

/** "Owner label › folder › folder" as it really is (a few reads; shown to staff, never used to decide anything). */
export async function pathOfFolder(folderId: string, ownerId: string): Promise<string> {
  const db = await sdb()
  const names: string[] = []
  let cur: string | null = folderId
  for (let i = 0; cur && i < 30; i++) {
    const res: { data: { name: string; parent_id: string | null; kind: string } | null } = await db.from("store_folders").select("name, parent_id, kind").eq("id", cur).maybeSingle()
    if (!res.data) break
    names.unshift(res.data.name)
    cur = res.data.parent_id
  }
  const { data: o } = await db.from("store_owners").select("kind, accounts(company_name), contacts(full_name)").eq("id", ownerId).maybeSingle()
  const pick = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null)
  const company = pick(o?.accounts as { company_name: string | null } | Array<{ company_name: string | null }> | null)?.company_name
  const person = pick(o?.contacts as { full_name: string | null } | Array<{ full_name: string | null }> | null)?.full_name
  // the top folder of a client carries the client's name already; Business / My files too
  const label = o?.kind === "business" ? "Business" : o?.kind === "private" ? "My files" : company || person || null
  if (label && names.length > 0 && (o?.kind === "business" || o?.kind === "private")) names[0] = label
  else if (label && names.length === 0) names.push(label)
  return names.join(" › ")
}

// ─────────────────────────────────────────────────────────── proposal → real place

export type ResolvedProposal =
  | { state: "proposed"; ownerId: string; folderId: string; newFolderName: string | null; path: string; why: string; purpose: FaxPurpose; documentType: SaveDocumentType | null }
  | { state: "choose"; why: string; purpose: FaxPurpose }
  | { state: "refused"; why: string; purpose: FaxPurpose }

export interface ResolveDeps {
  liveOwnerOfAccount(accountId: string): Promise<string | null>
  companyState(accountId: string): Promise<"store" | "moving" | "drive">
  noStorageSentenceForAccount(accountId: string): Promise<string>
  folderOfKind(ownerId: string, kind: string): Promise<string>
  businessOwnerId(): Promise<string>
  topFolder(ownerId: string): Promise<string>
  childFolderId(parentId: string, name: string): Promise<string | null>
  pathOf(folderId: string, ownerId: string): Promise<string>
}

/** Turns the pure proposal into real ids (and the real folder names to show). A company that cannot take a file becomes "refused" + the plain sentence. */
export async function resolveProposal(p: PlaceProposal, deps: ResolveDeps): Promise<ResolvedProposal> {
  if (p.state === "choose") return p
  let ownerId: string
  let parentId: string
  let leaf: string | null = null
  if (p.owner.kind === "company") {
    // moving FIRST: a company mid-move has no live storage yet, and must not get the "stays in its old folder" sentence
    if ((await deps.companyState(p.owner.accountId)) === "moving") return { state: "refused", purpose: p.purpose, why: NO_STORAGE_REASON_SENTENCE.moving }
    const own = await deps.liveOwnerOfAccount(p.owner.accountId)
    if (!own) return { state: "refused", purpose: p.purpose, why: await deps.noStorageSentenceForAccount(p.owner.accountId) }
    ownerId = own
    if (p.folder.kind === "tax") {
      parentId = await deps.folderOfKind(ownerId, "tax")
      leaf = p.folder.year ? String(p.folder.year) : null
    } else if (p.folder.kind === "company") {
      parentId = await deps.folderOfKind(ownerId, "company")
    } else {
      parentId = await deps.topFolder(ownerId)
      leaf = p.folder.name
    }
  } else {
    ownerId = await deps.businessOwnerId()
    parentId = await deps.topFolder(ownerId)
    leaf = p.folder.kind === "named" ? p.folder.name : null
  }
  let folderId = parentId
  let newFolderName: string | null = null
  if (leaf) {
    const have = await deps.childFolderId(parentId, leaf)
    if (have) folderId = have
    else newFolderName = leaf
  }
  const base = await deps.pathOf(folderId, ownerId)
  return {
    state: "proposed", purpose: p.purpose, ownerId, folderId, newFolderName,
    path: newFolderName ? `${base} › ${newFolderName}` : base,
    why: p.why, documentType: documentTypeFor(p.purpose, p.owner.kind === "business"),
  }
}

export function realResolveDeps(): ResolveDeps {
  return {
    liveOwnerOfAccount: async (id) => (await import("./switched-drive-guard")).liveOwnerOfAccount(id),
    companyState: async (id) => (await import("./switched-drive-guard")).companyDocState(id),
    noStorageSentenceForAccount: async (id) => noStorageSentenceFor(id, { companyState: realDeps().companyState, decisionSentence: async (x) => (await (await import("./no-storage")).noStorageDecisionFor(x)).sentence }),
    folderOfKind: async (ownerId, kind) => (await import("./formation-pilot")).folderOfKind(ownerId, kind),
    businessOwnerId: async () => (await import("./structure")).ensureArea("business", null),
    topFolder: async (ownerId) => {
      const { data, error } = await (await sdb()).from("store_folders").select("id").eq("owner_id", ownerId).is("parent_id", null).is("trashed_at", null).limit(1)
      if (error || !data || data.length === 0) throw new Error("The top folder of this place could not be found. Please try again.")
      return data[0].id as string
    },
    childFolderId: async (parentId, name) => {
      const { data, error } = await (await sdb()).from("store_folders").select("id").eq("parent_id", parentId).eq("name", name).is("trashed_at", null).limit(1)
      if (error) throw new Error("Could not read the folders. Please try again.")
      return ((data ?? [])[0]?.id as string | undefined) ?? null
    },
    pathOf: pathOfFolder,
  }
}

export const PROPOSAL_CHANGED_SENTENCE = "The proposed place changed while you were choosing. Please look at it again, then save."

/**
 * A choice that came straight from the window's PROPOSAL is re-derived here from the CURRENT inputs (purpose, company, file name): if
 * the place the browser sends is not the place the rules give now (e.g. the file name was edited from 2025 to 2019 and the old 2025
 * folder was sent), the save is refused BEFORE the fax is sent. A choice made with "Change place" (proposalOf = null) is staff's own
 * and is only checked by `validateDestination`. A tax-year folder that did not exist when the proposal was made but exists now is the
 * same place (a retry, or two people at once), so it still matches.
 */
export async function verifyProposalStillHolds(choice: SaveChoiceSave, deps: ResolveDeps): Promise<{ ok: boolean; error?: string }> {
  if (!choice.proposalOf) return { ok: true }
  const bad = { ok: false, error: PROPOSAL_CHANGED_SENTENCE }
  try {
    const company = choice.proposalOf.business
      ? ({ kind: "business" } as const)
      : choice.proposalOf.accountId ? ({ kind: "company", accountId: choice.proposalOf.accountId, name: "Company" } as const) : null
    const now = await resolveProposal(proposeFaxPlace({ purpose: choice.purpose, company, fileName: choice.fileName }), deps)
    if (now.state !== "proposed" || now.ownerId !== choice.ownerId) return bad
    if (now.folderId === choice.folderId && (now.newFolderName ?? null) === (choice.newFolderName ?? null)) return { ok: true }
    // the folder to be made has been made since: the proposal then points at the new folder itself
    if (choice.newFolderName && !now.newFolderName && (await deps.childFolderId(choice.folderId, choice.newFolderName)) === now.folderId) return { ok: true }
    return bad
  } catch {
    return bad
  }
}
