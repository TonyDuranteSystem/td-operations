/**
 * CRM Store — the Formation pilot (master plan v4.5 §8.9 #6, slice 6, job 685467b5). SANDBOX ONLY.
 *
 * ONE module for every pilot decision, so the rest of the code is visibly today's code with one guarded
 * call per site, and Stage 1 extends or removes one place.
 *
 * THE RULES
 *  1. The switch is read ONCE — when a formation's store owner would first be created. After that every
 *     step asks one lasting question: "does this formation's service case have a store owner?" Changing
 *     the setting mid-flight never splits a formation between the old path and the store.
 *  2. The switch only works in the sandbox: SANDBOX_MODE=1 AND not the production database AND the
 *     contact listed in app_settings `crm_store_pilot` = { "contact_ids": [...] }. Missing / unreadable →
 *     off (today's behaviour).
 *  3. Store first, today's path on failure: a caller skips its Drive / bucket step ONLY after a store
 *     save returned a result. Any store error → the caller runs today's path unchanged, and an alarm is
 *     raised (a file can never end up nowhere).
 *  4. Best-effort: nothing here may change the outcome of the CRM step that calls it.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { isProductionDatabase } from "@/lib/google-drive-guard"
import { saveBytesToStore, type StoreLink, type StoreSubject, type WriteResult } from "./writer"
import { storePointer, storeDocumentLink } from "./document-pointer"
import { storeNameKey } from "./rules"
import { randomUUID } from "crypto"

export const PILOT_SETTINGS_KEY = "crm_store_pilot"
export const COMPANY_TEMPLATE = "company_standard"
export const PERSON_TEMPLATE = "person_standard"

// store_* tables are not in the generated types until they reach production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

type Env = Record<string, string | undefined>

/** The environment half of the switch (pure — unit-tested). */
export function pilotEnvironmentAllowed(env: Env = process.env): boolean {
  return env.SANDBOX_MODE === "1" && !isProductionDatabase(env)
}

/** The setting half of the switch (pure — unit-tested). Anything but a list of ids → nobody. */
export function contactListedInSetting(value: unknown, contactId: string | null | undefined): boolean {
  if (!contactId || !value || typeof value !== "object") return false
  const ids = (value as { contact_ids?: unknown }).contact_ids
  return Array.isArray(ids) && ids.some((x) => typeof x === "string" && x === contactId)
}

/** Is this buyer a pilot contact? Read only when a formation's owner would be created (rule 1). */
export async function isStorePilotContact(contactId: string | null | undefined, env: Env = process.env): Promise<boolean> {
  if (!contactId || !pilotEnvironmentAllowed(env)) return false
  try {
    const { data, error } = await supabaseAdmin.from("app_settings").select("value").eq("key", PILOT_SETTINGS_KEY).maybeSingle()
    if (error || !data) return false
    return contactListedInSetting(data.value, contactId)
  } catch {
    return false
  }
}

export interface FormationCase { id: string; contact_id: string | null; account_id: string | null; service_type?: string | null }

export interface StoreOwnerRef { id: string; kind: "formation" | "company" }

/** The lasting question (rule 1): the store owner of this formation case, if it has one. */
export async function storeOwnerForCase(caseId: string): Promise<StoreOwnerRef | null> {
  if (!pilotEnvironmentAllowed()) return null
  try {
    const { data, error } = await db().from("store_owners").select("id, kind").eq("service_delivery_id", caseId).maybeSingle()
    if (error || !data) return null
    return { id: data.id as string, kind: data.kind as StoreOwnerRef["kind"] }
  } catch {
    return null
  }
}

/**
 * The formation's store owner: the existing one, or — only for a pilot buyer and only while the company
 * does not exist yet — a new in-formation owner with the company folder template. Idempotent; safe at
 * every entry point (payment, wizard submit, any upload on the case). null = not a pilot formation.
 * Throws only for a pilot formation whose owner could not be set up (the caller then runs today's path).
 */
export async function ensureFormationOwner(sd: FormationCase, rootName: string): Promise<StoreOwnerRef | null> {
  const existing = await storeOwnerForCase(sd.id)
  if (existing) return existing
  if (sd.service_type && sd.service_type !== "Company Formation") return null
  if (sd.account_id) return null // the company already exists: not a pilot start (Stage 1 territory)
  if (!(await isStorePilotContact(sd.contact_id))) return null
  const { data: ownerId, error } = await db().rpc("store_ensure_owner", { p_kind: "formation", p_ref: sd.id })
  if (error || !ownerId) throw new Error(`store pilot: could not create the formation owner — ${error?.message ?? "no id"}`)
  const { error: tErr } = await db().rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: COMPANY_TEMPLATE, p_root_name: storeSafeFolderName(rootName) })
  if (tErr) throw new Error(`store pilot: could not create the formation folders — ${tErr.message}`)
  return { id: ownerId as string, kind: "formation" }
}

/** A person's store owner with the personal folder template (idempotent). */
export async function ensurePersonOwner(contactId: string, rootName: string): Promise<string> {
  const { data: ownerId, error } = await db().rpc("store_ensure_owner", { p_kind: "person", p_ref: contactId })
  if (error || !ownerId) throw new Error(`store pilot: could not create the person owner — ${error?.message ?? "no id"}`)
  const { error: tErr } = await db().rpc("store_apply_template", { p_owner_id: ownerId, p_template_slug: PERSON_TEMPLATE, p_root_name: storeSafeFolderName(rootName) })
  if (tErr) throw new Error(`store pilot: could not create the personal folders — ${tErr.message}`)
  return ownerId as string
}

/** The live folder of a given kind directly under the owner's root (template folders). */
export async function folderOfKind(ownerId: string, kind: string): Promise<string> {
  const { data, error } = await db().from("store_folders").select("id, parent_id")
    .eq("owner_id", ownerId).eq("kind", kind).is("trashed_at", null)
  if (error) throw new Error(`store pilot: could not read folders — ${error.message}`)
  const rows = (data ?? []) as { id: string; parent_id: string | null }[]
  const hit = rows.find((r) => r.parent_id !== null) ?? rows[0]
  if (!hit) throw new Error(`store pilot: owner ${ownerId} has no "${kind}" folder`)
  return hit.id
}

export interface PilotSave {
  ownerId: string
  folderKind: string
  name: string
  bytes: Buffer
  mimeType: string | null
  documentType: string
  callerKey: string
  contentChanged?: boolean
  published?: boolean | null
  periodYear?: number | null
  links?: StoreLink[]
  subjects?: StoreSubject[]
  actor?: string | null
}

/** Save one file into the store (throws on any failure — the caller then runs today's path). */
export async function savePilotFile(p: PilotSave): Promise<WriteResult> {
  const folderId = await folderOfKind(p.ownerId, p.folderKind)
  return saveBytesToStore({
    ownerId: p.ownerId, folderId, name: p.name, mimeType: p.mimeType, bytes: p.bytes,
    callerKey: p.callerKey, contentChanged: p.contentChanged ?? true, documentType: p.documentType,
    periodYear: p.periodYear ?? null, published: p.published ?? null, actor: p.actor ?? null,
    links: p.links, subjects: p.subjects,
  })
}

export interface DocumentsRow {
  file_name: string
  mime_type?: string | null
  file_size?: number | null
  document_type_name?: string | null
  category?: number | null
  category_name?: string | null
  status?: string
  account_id?: string | null
  contact_id?: string | null
  service_delivery_id?: string | null
  flow_stage?: string | null
  portal_visible: boolean
}

/**
 * The CRM `documents` row for a store file (the CRM and portal still list documents from there until
 * Stage 1). Deduplicated on the pointer: a re-run or a second concurrent run never adds a second row.
 * Returns the row id and whether it was newly inserted.
 */
export async function upsertStoreDocumentRow(fileId: string, row: DocumentsRow, write?: WriteResult["status"]): Promise<{ id: string; inserted: boolean }> {
  const pointer = storePointer(fileId)
  const { data: existing, error: selErr } = await db().from("documents").select("id").eq("drive_file_id", pointer).limit(1)
  if (selErr) throw new Error(`store pilot: could not check the documents list — ${selErr.message}`)
  if (existing && existing.length > 0) {
    // a new version: the listed name / type / size follow it (only these fields — never a whole-row replace)
    if (write === "versioned") {
      const { error: upErr } = await db().from("documents").update({
        file_name: row.file_name, mime_type: row.mime_type ?? null, file_size: row.file_size ?? null, updated_at: new Date().toISOString(),
      }).eq("id", existing[0].id)
      if (upErr) console.error(`[crm-store pilot] documents row ${existing[0].id} not refreshed after a new version: ${upErr.message}`)
    }
    return { id: existing[0].id as string, inserted: false }
  }
  const id = randomUUID()
  const { error } = await db().from("documents").insert({
    id, drive_file_id: pointer, drive_link: storeDocumentLink(id), status: row.status ?? "classified", ...row,
  })
  if (error) {
    // a concurrent run may have inserted the same pointer a moment ago
    const { data: again } = await db().from("documents").select("id").eq("drive_file_id", pointer).limit(1)
    if (again && again.length > 0) return { id: again[0].id as string, inserted: false }
    throw new Error(`store pilot: could not list the document — ${error.message}`)
  }
  return { id, inserted: true }
}

/** A folder name the store accepts (no "/", "\\" or control characters, 1–255 chars); the company's real
 *  name stays on the CRM record. "A/B Trading LLC" → "A-B Trading LLC". */
export function storeSafeFolderName(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what the store refuses
  const cleaned = name.replace(/[\\/\u0000-\u001f\u007f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 255)
  return cleaned || "Company"
}

export type AttachOutcome =
  | { status: "attached"; ownerId: string }
  | { status: "no_owner" }          // not a pilot formation (or the owner was never created)
  | { status: "failed"; error: string }

/**
 * Company created at Articles: the in-formation owner becomes the company's owner in ONE logged step
 * (store_attach_formation — idempotent for the same company), then the root folder gets the company
 * name (a separate idempotent step). Never throws: a failure is an alarm, never a failed company creation.
 */
export async function attachFormationToCompany(caseId: string, accountId: string, companyName: string, actor?: string | null): Promise<AttachOutcome> {
  const owner = await storeOwnerForCase(caseId)
  if (!owner) return { status: "no_owner" }
  const folderName = storeSafeFolderName(companyName)
  try {
    const { data: ownerId, error } = await db().rpc("store_attach_formation", {
      p_service_delivery_id: caseId, p_account_id: accountId, p_actor: null, p_company_name: folderName,
    })
    if (error) throw new Error(error.message)
    if (!ownerId) throw new Error("the formation has no store owner")
    const { error: rnErr } = await db().rpc("store_rename_root", { p_owner_id: ownerId, p_name: folderName, p_actor: null })
    if (rnErr) throw new Error(`renaming the company folder: ${rnErr.message}`)
    return { status: "attached", ownerId: ownerId as string }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await raisePilotAlarm("formation_attach_failed", { caseId, accountId, error, actor: actor ?? null })
    return { status: "failed", error }
  }
}

/** Workspace upload stage of a Company Formation → the store document type (catalog slugs). */
export const FORMATION_UPLOAD_TYPES: Record<string, string> = {
  "Filed with State": "articles_of_organization",
  "SS-4 Signed": "fax_confirmation",
  "EIN Received": "ein_letter_irs",
}

/** The root folder name of a company being formed: the buyer's name (the company has none yet). */
export async function formationRootName(contactId: string | null): Promise<string> {
  let who = "New client"
  if (contactId) {
    try {
      const { data } = await supabaseAdmin.from("contacts").select("first_name, last_name, full_name").eq("id", contactId).maybeSingle()
      const n = (data?.full_name as string | null) || [data?.first_name, data?.last_name].filter(Boolean).join(" ")
      if (n && n.trim()) who = n.trim()
    } catch { /* keep the neutral name */ }
  }
  return `${who} — company in formation`
}

export type PilotUpload =
  | { status: "not_pilot" }
  | { status: "failed" } // store failed; the caller runs today's path (an alarm was raised)
  | { status: "saved"; fileId: string; pointer: string; documentRowId: string; link: string; write: WriteResult["status"] }

/**
 * A workspace upload on a Company Formation case (Articles, SS-4 fax confirmation, EIN letter).
 * Pilot formation → saved into the company-being-formed's "1. Company", linked to the case and stage,
 * plus its CRM documents row (drive_file_id = store:<id>). The same file name re-uploaded at the same
 * stage is a NEW VERSION of that file (a correction), never "Articles (2).pdf"; a DIFFERENT file name is a
 * separate document (a CP575 and a 147C at "EIN Received" never overwrite each other).
 */
export async function pilotSaveFormationUpload(p: {
  sd: FormationCase & { service_type?: string | null }
  flowStage: string | null
  fileName: string
  bytes: Buffer
  mimeType: string | null
}): Promise<PilotUpload> {
  if (!pilotEnvironmentAllowed() || p.sd.service_type !== "Company Formation") return { status: "not_pilot" }
  // Rule 1: an upload never CREATES the formation's storage — only the wizard step (and, once the
  // workspace plan's S1 lands, payment) does. A formation that started on Drive stays on Drive.
  const owner = await storeOwnerForCase(p.sd.id)
  if (!owner) return { status: "not_pilot" }
  const documentType = p.flowStage ? FORMATION_UPLOAD_TYPES[p.flowStage] : undefined
  if (!documentType) {
    await raisePilotAlarm("store_unmapped_upload", { ownerId: owner.id, caseId: p.sd.id, stage: p.flowStage, fileName: p.fileName })
    return { status: "failed" }
  }
  try {
    const w = await savePilotFile({
      ownerId: owner.id, folderKind: "company", name: p.fileName, bytes: p.bytes, mimeType: p.mimeType,
      documentType, callerKey: `formation-upload:${p.sd.id}:${p.flowStage}:${documentType}:${storeNameKey(p.fileName)}`,
      links: [{ kind: "service_case", recordId: p.sd.id, stage: p.flowStage }],
    })
    const row = await upsertStoreDocumentRow(w.fileId, {
      file_name: w.name, mime_type: p.mimeType, file_size: p.bytes.length,
      account_id: p.sd.account_id, contact_id: p.sd.contact_id,
      service_delivery_id: p.sd.id, flow_stage: p.flowStage, portal_visible: false,
    }, w.status)
    return { status: "saved", fileId: w.fileId, pointer: storePointer(w.fileId), documentRowId: row.id, link: storeDocumentLink(row.id), write: w.status }
  } catch (e) {
    await raisePilotAlarm("store_save_failed", { ownerId: owner.id, caseId: p.sd.id, stage: p.flowStage, error: e instanceof Error ? e.message : String(e) })
    return { status: "failed" }
  }
}

export type PilotSaved =
  | { status: "failed" }
  | { status: "saved"; fileId: string; pointer: string; documentRowId: string; documentRowInserted: boolean; write: WriteResult["status"] }

/**
 * A person's passport → that person's own storage ("Personal documents"). One passport per person
 * (caller key = the person): the same scan again is "unchanged", a new passport is a new version, a
 * second formation adds nothing. The buyer's copy is linked to the formation case; a member's is NOT
 * (the store refuses to link a member's personal file to a formation the member did not buy) — the
 * member's copy names the company as its subject instead. Plus the CRM documents row (same fields as
 * today's). Never throws: failed → the caller runs today's Drive path.
 */
export async function pilotSavePassport(p: {
  contactId: string
  personName: string
  fileName: string
  bytes: Buffer
  mimeType: string | null
  buyerCaseId?: string | null
  companyAccountId?: string | null
  row: Omit<DocumentsRow, "file_name" | "mime_type" | "file_size">
}): Promise<PilotSaved> {
  try {
    const ownerId = await ensurePersonOwner(p.contactId, p.personName)
    const w = await savePilotFile({
      ownerId, folderKind: "personal", name: p.fileName, bytes: p.bytes, mimeType: p.mimeType,
      documentType: "passport", callerKey: `person-passport:${p.contactId}`,
      links: p.buyerCaseId ? [{ kind: "service_case", recordId: p.buyerCaseId }] : [],
      subjects: p.companyAccountId ? [{ kind: "company", accountId: p.companyAccountId, role: "owner_member" }] : [],
    })
    const row = await upsertStoreDocumentRow(w.fileId, { ...p.row, file_name: w.name, mime_type: p.mimeType, file_size: p.bytes.length }, w.status)
    return { status: "saved", fileId: w.fileId, pointer: storePointer(w.fileId), documentRowId: row.id, documentRowInserted: row.inserted, write: w.status }
  } catch (e) {
    await raisePilotAlarm("store_save_failed", { contactId: p.contactId, what: "passport", error: e instanceof Error ? e.message : String(e) })
    return { status: "failed" }
  }
}

/**
 * A file produced by a store-owned formation case (signed SS-4, IRS package …) → the case's owner
 * (the company-in-formation, or the company it became). Not store-owned → not_pilot (today's path).
 * Store failure → failed + alarm (today's path). Plus its CRM documents row.
 */
export async function pilotSaveCaseFile(p: {
  caseId: string
  folderKind: string
  documentType: string
  callerKey: string
  name: string
  bytes: Buffer
  mimeType: string | null
  published?: boolean | null
  row: Omit<DocumentsRow, "file_name" | "mime_type" | "file_size">
}): Promise<PilotSaved | { status: "not_pilot" }> {
  const owner = await storeOwnerForCase(p.caseId)
  if (!owner) return { status: "not_pilot" }
  try {
    const w = await savePilotFile({
      ownerId: owner.id, folderKind: p.folderKind, name: p.name, bytes: p.bytes, mimeType: p.mimeType,
      documentType: p.documentType, callerKey: p.callerKey, published: p.published ?? null,
      links: [{ kind: "service_case", recordId: p.caseId }],
    })
    const row = await upsertStoreDocumentRow(w.fileId, { ...p.row, file_name: w.name, mime_type: p.mimeType, file_size: p.bytes.length }, w.status)
    return { status: "saved", fileId: w.fileId, pointer: storePointer(w.fileId), documentRowId: row.id, documentRowInserted: row.inserted, write: w.status }
  } catch (e) {
    await raisePilotAlarm("store_save_failed", { ownerId: owner.id, caseId: p.caseId, what: p.documentType, error: e instanceof Error ? e.message : String(e) })
    return { status: "failed" }
  }
}

/**
 * Company creation, BEFORE the case is linked: is this formation store-owned? Same candidates as the
 * creation step's own case lookup (active, not yet linked, this buyer). Exactly one candidate with a
 * store owner → that case. Several candidates → null (today's path; the creation step itself refuses to
 * guess which case to link, and so do we).
 */
export async function pilotCaseForCompanyCreation(contactId: string): Promise<{ caseId: string; owner: StoreOwnerRef } | null> {
  if (!pilotEnvironmentAllowed()) return null
  try {
    const { data } = await supabaseAdmin.from("service_deliveries").select("id")
      .eq("contact_id", contactId).eq("service_type", "Company Formation").eq("status", "active").is("account_id", null)
    const rows = (data ?? []) as { id: string }[]
    if (rows.length !== 1) return null
    const owner = await storeOwnerForCase(rows[0].id)
    return owner ? { caseId: rows[0].id, owner } : null
  } catch {
    return null
  }
}

/**
 * The "already a company" re-run: a retry after a partial failure (the company and the case link were
 * written, the handover was not) must still complete the handover. Idempotent — an already attached
 * formation returns at once and logs nothing new.
 */
export async function pilotCompleteHandover(accountId: string, companyName: string): Promise<AttachOutcome | null> {
  if (!pilotEnvironmentAllowed()) return null
  try {
    const { data } = await supabaseAdmin.from("service_deliveries").select("id")
      .eq("account_id", accountId).eq("service_type", "Company Formation")
    for (const r of (data ?? []) as { id: string }[]) {
      const owner = await storeOwnerForCase(r.id)
      if (owner) return attachFormationToCompany(r.id, accountId, companyName)
    }
    return null
  } catch {
    return null
  }
}

export type PilotAlarmKind =
  | "formation_attach_failed"      // the company was created but its files could not be handed over
  | "formation_case_not_linked"    // the company was created but no single formation case was linked
  | "store_save_failed"            // a store save failed; today's path was used instead
  | "formation_owner_failed"       // a pilot formation's store owner could not be set up
  | "store_unmapped_upload"        // an upload on a pilot formation at a stage with no document type
  | "formation_pilot_undecided"    // several open formations: Drive steps ran, the store files were handed over after

/**
 * An alarm: an event in the store's history (owner-scoped when known) + the system error log.
 * Future (workspace plan §1.5, S5): these become the red "something broke" signal on the client's thread.
 */
export async function raisePilotAlarm(kind: PilotAlarmKind, details: Record<string, unknown>): Promise<void> {
  try {
    const ownerId = typeof details.ownerId === "string" ? details.ownerId : null
    await db().from("store_events").insert({ event: "pilot_alarm", owner_id: ownerId, reason: kind, details })
  } catch { /* the error log below still records it */ }
  try {
    const { reportSystemError } = await import("@/lib/system-errors")
    await reportSystemError({
      source: "server",
      route: "crm-store/formation-pilot",
      method: "INTERNAL",
      message: `CRM Store pilot alarm: ${kind}`,
      context: details,
    })
  } catch { /* never throw from an alarm */ }
}
