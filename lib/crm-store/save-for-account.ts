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
  /** null = not classified yet (staff choose the type later; such a file cannot be shared until then) */
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
    documentType: input.documentType, callerKey: input.callerKey, published: input.portalVisible ?? false,
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
