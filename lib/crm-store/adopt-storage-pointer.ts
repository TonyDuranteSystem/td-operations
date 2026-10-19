/**
 * CRM Store — bring a client file that is parked in the OLDER bucket into the CRM storage (Stop-Drive S1a, dev job 264bb882;
 * Antonio's decision 2026-10-18: "Articles and any formation-flow upload must go into the CRM storage — not stay in a bucket
 * outside storage and not depend on Drive").
 *
 * A workspace upload made before the company (or the person's storage) exists is kept in the `onboarding-uploads` bucket and the
 * CRM `documents` row carries a `storage:flow-uploads/...` pointer. That file is invisible to the storage's backup. This module
 * files such a row's bytes into the right storage folder and re-points the SAME `documents` row at the store file, so there is
 * still ONE record. Idempotent (same caller key = same store file), never deletes the original bucket object, never uses Drive,
 * and a failure is an error result plus a staff-visible alarm — never "ok".
 *
 * Only `storage:flow-uploads/...` pointers are handled (the formation / ITIN workspace uploads). The other `storage:` shapes
 * (signed-documents, fax-attachments, …) belong to other flows and are left alone.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export const ADOPTABLE_PREFIX = "storage:flow-uploads/"
const BUCKET = "onboarding-uploads"
const GENERIC_CLIENT_TYPE = "other_document"

export interface AdoptRow {
  id: string
  drive_file_id: string
  file_name: string
  mime_type: string | null
  account_id: string | null
  contact_id: string | null
  service_delivery_id: string | null
  flow_stage: string | null
  portal_visible: boolean | null
  document_type_name: string | null
}

export type AdoptOutcome =
  | { status: "adopted"; pointer: string; where: "company" | "person" | "formation" }
  | { status: "already" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string }

export interface AdoptDeps {
  serviceTypeOf: (sdId: string) => Promise<string | null>
  companyState: (accountId: string) => Promise<"store" | "drive" | "moving">
  liveOwnerOfAccount: (accountId: string) => Promise<string | null>
  liveOwnerOfContact: (contactId: string) => Promise<string | null>
  formationOwnerOfCase: (sdId: string) => Promise<string | null>
  download: (path: string) => Promise<{ bytes: Buffer; mimeType: string | null } | null>
  save: (p: import("./formation-pilot").PilotSave) => Promise<{ fileId: string; status: string }>
  typeLabelOf: (slug: string) => Promise<string | null>
  /** point the row at the store file only if it still holds the old pointer; false = someone changed it meanwhile */
  repoint: (rowId: string, oldPointer: string, newPointer: string, link: string, typeLabel: string | null, published: boolean) => Promise<boolean>
  pointer: (fileId: string) => string
  link: (rowId: string) => string
  alarm: (reason: string, details: Record<string, unknown>) => Promise<void>
}

async function defaultDeps(): Promise<AdoptDeps> {
  const guard = await import("./switched-drive-guard")
  const pilot = await import("./formation-pilot")
  const ptr = await import("./document-pointer")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types
  const d = supabaseAdmin as any
  return {
    serviceTypeOf: async (id) => {
      const { data } = await supabaseAdmin.from("service_deliveries").select("service_type").eq("id", id).maybeSingle()
      return (data?.service_type as string | null | undefined) ?? null
    },
    companyState: guard.companyDocState,
    liveOwnerOfAccount: guard.liveOwnerOfAccount,
    liveOwnerOfContact: guard.liveOwnerOfContact,
    formationOwnerOfCase: async (id) => {
      const { data } = await d.from("store_owners").select("id").eq("service_delivery_id", id).eq("study_only", false).maybeSingle()
      return (data?.id as string | undefined) ?? null
    },
    download: async (path) => {
      const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path)
      if (error || !data) return null
      return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: data.type || null }
    },
    save: pilot.savePilotFile,
    typeLabelOf: async (slug) => {
      const { data } = await d.from("catalog_entries").select("display_name").eq("catalog_id", "storage_document_types").eq("slug", slug).maybeSingle()
      return (data?.display_name as string | undefined) ?? null
    },
    repoint: async (rowId, oldPointer, newPointer, link, typeLabel, published) => {
      const patch: Record<string, unknown> = { drive_file_id: newPointer, drive_link: link, portal_visible: published, updated_at: new Date().toISOString() }
      if (typeLabel) patch.document_type_name = typeLabel
      const { data, error } = await d.from("documents").update(patch).eq("id", rowId).eq("drive_file_id", oldPointer).select("id")
      if (error) throw new Error(error.message)
      return (data ?? []).length > 0
    },
    pointer: ptr.storePointer,
    link: ptr.storeDocumentLink,
    alarm: (reason, details) => pilot.raisePilotAlarm("storage_pointer_adopt_failed", { reason, ...details }),
  }
}

/** Workspace upload stage of a Company Formation → the store document type (same table the live upload path uses). */
const FORMATION_STAGE_TYPES: Record<string, string> = {
  "Filed with State": "articles_of_organization",
  "SS-4 Signed": "fax_confirmation",
  "EIN Received": "ein_letter_irs",
}

export async function adoptStoragePointerRow(row: AdoptRow, deps?: AdoptDeps): Promise<AdoptOutcome> {
  const d = deps ?? (await defaultDeps())
  const ptr = row.drive_file_id ?? ""
  if (ptr.startsWith("store:")) return { status: "already" }
  if (!ptr.startsWith(ADOPTABLE_PREFIX)) return { status: "skipped", reason: "not a flow upload pointer" }
  const fail = async (reason: string): Promise<AdoptOutcome> => {
    await d.alarm(reason, { documentId: row.id, pointer: ptr, accountId: row.account_id, contactId: row.contact_id, serviceDeliveryId: row.service_delivery_id })
    return { status: "failed", reason }
  }

  try {
    const serviceType = row.service_delivery_id ? await d.serviceTypeOf(row.service_delivery_id) : null
    const isFormation = serviceType === "Company Formation"

    // 1. Where does this file belong, and does that storage exist yet?
    let ownerId: string | null = null
    let folderKind = "company"
    let where: "company" | "person" | "formation" = "company"
    if (row.account_id) {
      const state = await d.companyState(row.account_id)
      if (state === "moving") return { status: "skipped", reason: "the company is being moved to the storage right now — try again later" }
      if (state !== "store") return { status: "skipped", reason: "the company is not in the storage yet" }
      ownerId = await d.liveOwnerOfAccount(row.account_id)
      if (!ownerId) return await fail("the company is in the storage but its storage could not be found")
    } else if (isFormation) {
      // a company being formed: only its in-formation storage will do (a company document never goes into a person's folder)
      ownerId = row.service_delivery_id ? await d.formationOwnerOfCase(row.service_delivery_id) : null
      if (!ownerId) return { status: "skipped", reason: "the company is not formed yet and has no storage" }
      where = "formation"
    } else if (row.contact_id) {
      ownerId = await d.liveOwnerOfContact(row.contact_id)
      if (!ownerId) return { status: "skipped", reason: "the person has no storage yet" }
      folderKind = serviceType === "ITIN" ? "itin" : "personal"
      where = "person"
    } else {
      return { status: "skipped", reason: "no company or person to file it under" }
    }

    // 2. The bytes (the original bucket object is kept — it is never deleted here)
    const path = ptr.slice("storage:".length)
    const file = await d.download(path)
    if (!file) return await fail("the file is missing from the older bucket")

    // 3. Type and visibility follow the live upload path: a formation stage maps to its type; a client-visible file is never untyped
    const published = row.portal_visible === true
    const slug = isFormation && row.flow_stage ? (FORMATION_STAGE_TYPES[row.flow_stage] ?? null) : null
    const documentType = slug ?? (published ? GENERIC_CLIENT_TYPE : null)
    const baseSave = {
      ownerId, name: row.file_name, bytes: file.bytes, mimeType: row.mime_type ?? file.mimeType, documentType,
      callerKey: `adopt-storage:${row.id}`, published,
      // a person's papers are never queued for the AI file reader
      skipAnalysis: where === "person",
    }
    let saved
    try {
      saved = await d.save({ ...baseSave, folderKind })
    } catch (e) {
      // an older person storage may have no ITIN folder: Personal documents instead of a failure
      if (folderKind === "itin" && /has no "itin" folder/i.test(e instanceof Error ? e.message : String(e))) saved = await d.save({ ...baseSave, folderKind: "personal" })
      else throw e
    }

    // 4. ONE record: the same documents row now points at the store file
    const newPointer = d.pointer(saved.fileId)
    const label = row.document_type_name ? null : slug ? await d.typeLabelOf(slug) : null
    const ok = await d.repoint(row.id, ptr, newPointer, d.link(row.id), label, published)
    if (!ok) {
      // the row no longer holds the old pointer: someone else already handled it (a concurrent run) — nothing more to do
      return { status: "already" }
    }
    return { status: "adopted", pointer: newPointer, where }
  } catch (e) {
    return await fail(e instanceof Error ? e.message : String(e))
  }
}

export interface AdoptSummary { adopted: number; already: number; skipped: Array<{ id: string; reason: string }>; failed: Array<{ id: string; reason: string }> }

/** Every adoptable row of one company (best-effort; used when the company has just got its storage). */
export async function adoptStoragePointersForAccount(accountId: string, deps?: AdoptDeps): Promise<AdoptSummary> {
  const rows = await adoptionCandidates({ accountId })
  return adoptRows(rows, deps)
}

export async function adoptRows(rows: AdoptRow[], deps?: AdoptDeps): Promise<AdoptSummary> {
  const d = deps ?? (await defaultDeps())
  const out: AdoptSummary = { adopted: 0, already: 0, skipped: [], failed: [] }
  for (const r of rows) {
    const res = await adoptStoragePointerRow(r, d)
    if (res.status === "adopted") out.adopted++
    else if (res.status === "already") out.already++
    else if (res.status === "skipped") out.skipped.push({ id: r.id, reason: res.reason })
    else out.failed.push({ id: r.id, reason: res.reason })
  }
  return out
}

const COLUMNS = "id, drive_file_id, file_name, mime_type, account_id, contact_id, service_delivery_id, flow_stage, portal_visible, document_type_name"

/** The documents rows that still point into the older flow-uploads bucket (optionally one company). Strict: a read error throws. */
export async function adoptionCandidates(filter: { accountId?: string } = {}): Promise<AdoptRow[]> {
  const out: AdoptRow[] = []
  for (let from = 0; ; from += 500) {
    let q = supabaseAdmin.from("documents").select(COLUMNS).like("drive_file_id", `${ADOPTABLE_PREFIX}%`).order("id").range(from, from + 499)
    if (filter.accountId) q = q.eq("account_id", filter.accountId)
    const { data, error } = await q
    if (error) throw new Error(`adopt: could not read the document records — ${error.message}`)
    out.push(...((data ?? []) as AdoptRow[]))
    if (!data || data.length < 500) break
  }
  return out
}
