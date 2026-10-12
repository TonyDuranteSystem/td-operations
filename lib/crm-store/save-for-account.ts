/**
 * CRM Store — "save a document for a company" (cutover Phase 2, dev job ad09ea91; plan Part 32).
 *
 * ONE question every save point asks first: where do this company's files live? The answer is the company's
 * state (switched-drive-guard.ts):
 *   drive   → `{ route: "drive" }` — the caller carries on with its existing Google Drive code, unchanged;
 *   store   → the file is saved in the company's new storage (and listed in the CRM documents list, where the
 *             portal and the CRM read today), `{ route: "store", … }` — the caller must NOT touch Drive;
 *   moving  → refused with a plain message (a real move is in progress; nothing may land in the wrong place).
 * A failed storage save for a switched company is an ERROR, never a silent fallback to Drive: Drive is read-only
 * for that company (the guard would refuse the write anyway).
 */

import type { CompanyDocState } from "./switched-drive-guard"
import type { DocumentsRow, PilotSave } from "./formation-pilot"
import type { WriteResult } from "./writer"

export type StoreFolderKind = "company" | "tax" | "banking" | "correspondence" | "contacts" | "personal"

/**
 * The storage treats a file with NO type as closed — never shown to a client, never shareable (staffOnlyStorePointers).
 * So a document that is meant for the client must carry a catalogued, non-staff-only type: when the caller did not name
 * a more specific one it gets this plain one (staff can re-type it). An internal file (not shown) may stay untyped.
 */
export const GENERIC_CLIENT_TYPE = "other_document"
function typeFor(documentType: string | null, portalVisible: boolean | undefined): string | null {
  return documentType ?? (portalVisible ? GENERIC_CLIENT_TYPE : null)
}

export class CompanyMovingError extends Error {
  constructor() {
    super("This company's files are being moved to the new storage right now — please try again in a few minutes.")
    this.name = "CompanyMovingError"
  }
}

export interface SaveForAccountInput {
  accountId: string
  name: string
  bytes: Buffer
  mimeType: string | null
  /** Where in the company's storage: the top folders of the standard layout (1. Company, 3. Tax, 4. Banking, 5. Correspondence …). */
  folder: StoreFolderKind
  /** null = not classified yet. A file meant for the CLIENT then gets the generic `other_document` type (an untyped file is closed to clients); an internal one may stay untyped. */
  documentType: string | null
  /** The same value on a retry or a double click: the save is idempotent on it. */
  callerKey: string
  /** Show it to the client in the portal. Default false — nothing becomes visible by accident. */
  portalVisible?: boolean
  periodYear?: number | null
  actor?: string | null
  /** A personal document (passport, ID) goes to the PERSON's own storage, never to the company's. */
  person?: { contactId: string; name: string } | null
  /** Extra columns of the CRM documents row (category, status, flow stage, …). */
  row?: Partial<Omit<DocumentsRow, "file_name" | "mime_type" | "file_size" | "portal_visible" | "account_id">>
}

export type SaveForAccountResult =
  | { route: "drive" }
  | { route: "store"; fileId: string; pointer: string; documentRowId: string; status: WriteResult["status"] }

export interface SaveDeps {
  state: (accountId: string) => Promise<CompanyDocState>
  liveOwner: (accountId: string) => Promise<string | null>
  personOwner: (contactId: string, name: string) => Promise<string>
  save: (p: PilotSave) => Promise<WriteResult>
  upsertRow: (fileId: string, row: DocumentsRow, status?: WriteResult["status"]) => Promise<{ id: string; inserted: boolean }>
  pointer: (fileId: string) => string
}

async function defaultDeps(): Promise<SaveDeps> {
  const guard = await import("./switched-drive-guard")
  const pilot = await import("./formation-pilot")
  const ptr = await import("./document-pointer")
  return {
    state: guard.companyDocState,
    liveOwner: guard.liveOwnerOfAccount,
    personOwner: pilot.ensurePersonOwner,
    save: pilot.savePilotFile,
    upsertRow: pilot.upsertStoreDocumentRow,
    pointer: ptr.storePointer,
  }
}

export async function saveDocumentForAccount(input: SaveForAccountInput, deps?: SaveDeps): Promise<SaveForAccountResult> {
  const d = deps ?? (await defaultDeps())
  const state = await d.state(input.accountId)
  if (state === "drive") return { route: "drive" }
  if (state === "moving") throw new CompanyMovingError()

  // state === "store"
  let ownerId: string
  let folderKind: string = input.folder
  if (input.person) {
    ownerId = await d.personOwner(input.person.contactId, input.person.name)
    folderKind = "personal"
  } else {
    const live = await d.liveOwner(input.accountId)
    if (!live) throw new Error("This company's files live in the new storage, but its storage could not be found — nothing was saved.")
    ownerId = live
  }

  const w = await d.save({
    ownerId, folderKind, name: input.name, bytes: input.bytes, mimeType: input.mimeType,
    documentType: typeFor(input.documentType, input.portalVisible), callerKey: input.callerKey, published: input.portalVisible ?? false,
    periodYear: input.periodYear ?? null, actor: input.actor ?? null,
  })
  const listed = await d.upsertRow(w.fileId, {
    ...(input.row ?? {}),
    file_name: input.name, mime_type: input.mimeType, file_size: input.bytes.length,
    account_id: input.person ? null : input.accountId,
    contact_id: input.person ? input.person.contactId : input.row?.contact_id ?? null,
    portal_visible: input.portalVisible ?? false,
  }, w.status)
  return { route: "store", fileId: w.fileId, pointer: d.pointer(w.fileId), documentRowId: listed.id, status: w.status }
}

export interface SaveForContactInput {
  contactId: string
  name: string
  bytes: Buffer
  mimeType: string | null
  documentType: string | null
  callerKey: string
  /** The company this document is also listed under, when the person's file belongs to one (the CRM list keeps both links). */
  accountId?: string | null
  /**
   * The company this person belongs to, and the person's name. When that company is switched but the person has no live
   * storage yet, the person's own storage is opened for this document — the same as the portal does — so a staff upload and
   * a client upload of the same passport land in the same place (never in Drive, never in the company's storage).
   */
  viaAccountId?: string | null
  contactName?: string | null
  portalVisible?: boolean
  actor?: string | null
  row?: Partial<Omit<DocumentsRow, "file_name" | "mime_type" | "file_size" | "portal_visible" | "account_id" | "contact_id">>
}

/**
 * A PERSON's own document (passport, ID, ITIN letter …): the same question, asked of the person. A person whose storage is
 * live gets the file in their own "Personal documents" folder (listed against them in the CRM); anyone else carries on with
 * Drive exactly as before. Personal documents never go to a company's storage.
 */
export type ContactDeps = Pick<SaveDeps, "save" | "upsertRow" | "pointer"> & {
  liveOwnerOfContact: (contactId: string) => Promise<string | null>
  companyState?: (accountId: string) => Promise<CompanyDocState>
  ensurePerson?: (contactId: string, name: string) => Promise<string>
}

export async function saveDocumentForContact(input: SaveForContactInput, deps?: ContactDeps): Promise<SaveForAccountResult> {
  let d = deps
  if (!d) {
    const guard = await import("./switched-drive-guard")
    const pilot = await import("./formation-pilot")
    const ptr = await import("./document-pointer")
    d = { liveOwnerOfContact: guard.liveOwnerOfContact, save: pilot.savePilotFile, upsertRow: pilot.upsertStoreDocumentRow, pointer: ptr.storePointer, companyState: guard.companyDocState, ensurePerson: pilot.ensurePersonOwner }
  }
  let ownerId = await d.liveOwnerOfContact(input.contactId)
  if (!ownerId && input.viaAccountId && d.companyState && d.ensurePerson) {
    const viaState = await d.companyState(input.viaAccountId)
    // a company in the middle of its move opens no new storage for anyone: wait for the move to finish
    if (viaState === "moving") throw new CompanyMovingError()
    if (viaState !== "drive") ownerId = await d.ensurePerson(input.contactId, input.contactName || "Member")
  }
  if (!ownerId) return { route: "drive" }

  const w = await d.save({
    ownerId, folderKind: "personal", name: input.name, bytes: input.bytes, mimeType: input.mimeType,
    documentType: typeFor(input.documentType, input.portalVisible), callerKey: input.callerKey, published: input.portalVisible ?? false, actor: input.actor ?? null,
  })
  const listed = await d.upsertRow(w.fileId, {
    ...(input.row ?? {}),
    file_name: input.name, mime_type: input.mimeType, file_size: input.bytes.length,
    account_id: input.accountId ?? null, contact_id: input.contactId,
    portal_visible: input.portalVisible ?? false,
  }, w.status)
  return { route: "store", fileId: w.fileId, pointer: d.pointer(w.fileId), documentRowId: listed.id, status: w.status }
}

/**
 * The one shape most automatic flows share: a SIGNED (or generated) PDF for a company, listed in the portal.
 * Same question first (see saveDocumentForAccount). `callerKey` must be stable per document (e.g. "lease-signed:<lease id>")
 * so a retry or a re-sign becomes a new VERSION of the same file, never a second copy.
 */
export async function saveSignedPdfForAccount(p: {
  accountId: string
  fileName: string
  bytes: Buffer
  /** the label shown in the documents list, e.g. "Lease Agreement" */
  label: string
  /** 1 = Company (default), 3 = Tax, 4 = Banking, 5 = Correspondence */
  category?: number
  callerKey: string
  portalVisible?: boolean
  contactId?: string | null
  actor?: string | null
  /** the storage's document-type slug when one exists (office_lease, operating_agreement, form_ss_4 …); null = staff choose later */
  documentType?: string | null
  /** stamps the CRM record with the service it belongs to (the flow workspace lists documents by it) */
  serviceDeliveryId?: string | null
}, deps?: SaveDeps): Promise<SaveForAccountResult> {
  const category = p.category ?? 1
  return saveDocumentForAccount({
    accountId: p.accountId, name: p.fileName, bytes: p.bytes, mimeType: "application/pdf",
    folder: category === 3 ? "tax" : category === 4 ? "banking" : category === 5 ? "correspondence" : "company",
    documentType: p.documentType ?? null, callerKey: p.callerKey, portalVisible: p.portalVisible ?? true, actor: p.actor ?? null,
    row: { document_type_name: p.label, category, status: "classified", contact_id: p.contactId ?? null, service_delivery_id: p.serviceDeliveryId ?? null },
  }, deps)
}
