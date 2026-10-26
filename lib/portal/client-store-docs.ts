/**
 * Client portal — which documents that live in the NEW storage may a client see and open?
 * (Drive cutover Phase A, dev job ad09ea91; master plan Part 33.)
 *
 * ONE rule used by the documents list, the services page, the search AND the download route, so they can never
 * disagree again (the list showed flow documents by their stage but the download refused them: "listed but 404").
 *
 * A `store:` document is shown/opened to a client only when ALL of these hold:
 *   1. the CRM row says so: portal_visible = true, OR it is a flow document at a client-safe stage
 *      (lib/flows/flow-doc-visibility.ts — the same allowlist the list has always used);
 *   2. its stored file is not closed (no type, an unknown type or a staff-only type — document-pointer.ts);
 *   3. it is not a PERSONAL document (passport/ID…) filed outside a person's own storage (it would show one
 *      person's document to every member of the company).
 * Every check fails CLOSED. Rows that are NOT in the new storage (a Drive id, the old `storage:` bucket) are returned
 * untouched — this change is invisible to a company that is still on Drive.
 */

import { isClientSafeFlowDoc } from "@/lib/flows/flow-doc-visibility"
import { isStorePointer } from "@/lib/crm-store/document-pointer"

export interface ClientDocRow {
  id: string
  drive_file_id: string | null
  portal_visible?: boolean | null
  service_delivery_id?: string | null
  flow_stage?: string | null
}

/** Pure rule 1: is this document shown to the client by its CRM row (flag or client-safe flow stage)? */
export function shownToClientByRow(p: {
  portalVisible: boolean | null | undefined
  serviceType: string | null | undefined
  flowStage: string | null | undefined
}): boolean {
  return isClientSafeFlowDoc(p.serviceType, p.flowStage, p.portalVisible)
}

export interface ClientStoreDeps {
  /** service delivery id → service_type (only for the ids asked) */
  serviceTypes(ids: string[]): Promise<Map<string, string | null>>
  /** pointers whose stored file is closed to clients (untyped, unknown or staff-only type) */
  closed(pointers: string[]): Promise<Set<string>>
  /** pointers that are personal documents outside a person's own storage */
  personalOutsidePerson(pointers: string[]): Promise<Set<string>>
  /** pointers of live stored files the signed-in client uploaded themselves through the portal (see isOwnPortalUpload) */
  ownUploads?(pointers: string[], viewerUserId: string, accountId: string): Promise<Set<string>>
}

/**
 * Pure: did THIS signed-in client upload the stored file through the portal? The portal upload route saves the file under the key
 * `portal-upload:<account>:…` with the uploader's user id as the file's creator. A file saved before the creator was recorded has no
 * creator: it is still shown (it is the company's own upload, listed by name only — it can't be opened while it is hidden).
 */
export function isOwnPortalUpload(f: { callerKey: string | null; createdBy: string | null; state?: string | null }, viewerUserId: string, accountId: string): boolean {
  if (f.state && f.state !== "live") return false
  if (!f.callerKey || !f.callerKey.startsWith(`portal-upload:${accountId}:`)) return false
  return f.createdBy === null || f.createdBy === viewerUserId
}

const defaultDeps: ClientStoreDeps = {
  async serviceTypes(ids) {
    const out = new Map<string, string | null>()
    if (ids.length === 0) return out
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    const { data, error } = await supabaseAdmin.from("service_deliveries").select("id, service_type").in("id", ids)
    if (error) throw new Error(`portal: could not read service types (${error.message})`)
    for (const r of (data ?? []) as { id: string; service_type: string | null }[]) out.set(r.id, r.service_type)
    return out
  },
  async closed(pointers) {
    const { staffOnlyStorePointers } = await import("@/lib/crm-store/document-pointer")
    return staffOnlyStorePointers(pointers)
  },
  async personalOutsidePerson(pointers) {
    const { personalStoreFilesOutsidePerson } = await import("@/lib/crm-store/document-pointer")
    return personalStoreFilesOutsidePerson(pointers)
  },
  async ownUploads(pointers, viewerUserId, accountId) {
    const { parseStorePointer, storePointer } = await import("@/lib/crm-store/document-pointer")
    const ids = Array.from(new Set(pointers.map((v) => parseStorePointer(v)).filter((x): x is string => !!x)))
    const out = new Set<string>()
    if (ids.length === 0) return out
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types
    const { data, error } = await (supabaseAdmin as any).from("store_files").select("id, caller_key, created_by, state").in("id", ids)
    if (error) throw new Error(`portal: could not read the uploads (${error.message})`)
    for (const r of (data ?? []) as { id: string; caller_key: string | null; created_by: string | null; state: string }[]) {
      if (isOwnPortalUpload({ callerKey: r.caller_key, createdBy: r.created_by, state: r.state }, viewerUserId, accountId)) out.add(storePointer(r.id))
    }
    return out
  },
}

/**
 * Keep every row a client may see; drop the `store:` rows they may not. Non-store rows are always kept.
 * `applyRowRule: false` is for callers that already filtered by the CRM row (the documents list) and only need
 * the stored-file checks (2 and 3).
 */
export async function dropStoreRowsClientCannotOpen<T extends ClientDocRow>(
  rows: T[],
  opts: { applyRowRule?: boolean } = {},
  deps: ClientStoreDeps = defaultDeps,
): Promise<T[]> {
  const storeRows = rows.filter((r) => isStorePointer(r.drive_file_id))
  if (storeRows.length === 0) return rows // nothing in the new storage: no lookups, no change
  const applyRowRule = opts.applyRowRule !== false

  let types = new Map<string, string | null>()
  if (applyRowRule) {
    const need = Array.from(new Set(storeRows.filter((r) => r.portal_visible !== true && r.service_delivery_id).map((r) => r.service_delivery_id as string)))
    types = await deps.serviceTypes(need)
  }
  const pointers = storeRows.map((r) => r.drive_file_id as string)
  const [closed, personal] = await Promise.all([deps.closed(pointers), deps.personalOutsidePerson(pointers)])

  const drop = new Set<string>()
  for (const r of storeRows) {
    const ptr = r.drive_file_id as string
    const rowOk = !applyRowRule || shownToClientByRow({
      portalVisible: r.portal_visible,
      serviceType: r.service_delivery_id ? types.get(r.service_delivery_id) ?? null : null,
      flowStage: r.flow_stage,
    })
    if (!rowOk || closed.has(ptr) || personal.has(ptr)) drop.add(r.id)
  }
  return rows.filter((r) => !drop.has(r.id))
}

/** Single-row form for the download route: may this client open this document right now? */
export async function clientMayOpen(row: ClientDocRow, deps?: ClientStoreDeps): Promise<boolean> {
  return (await dropStoreRowsClientCannotOpen([row], {}, deps)).length === 1
}

export interface ListedDocRow extends ClientDocRow {
  category?: number | null
  contact_id?: string | null
}

/**
 * The rule for a page that LISTS documents (names, types, dates) to a client and does not already filter in SQL
 * (the Tax page, a flow's page, the legacy signed-document fallback). Applies the CRM-row rule to EVERY row —
 * not just store rows: shown by the flag, or a flow document at a client-safe stage — then another member's
 * personal document, then the stored-file checks for `store:` rows. A hidden draft is never listed by name.
 */
export async function dropDocsClientCannotSee<T extends ListedDocRow>(
  rows: T[],
  viewerContactId: string | null | undefined,
  deps: ClientStoreDeps = defaultDeps,
): Promise<T[]> {
  if (rows.length === 0) return rows
  const need = Array.from(new Set(rows.filter((r) => r.portal_visible !== true && r.service_delivery_id).map((r) => r.service_delivery_id as string)))
  const types = need.length > 0 ? await deps.serviceTypes(need) : new Map<string, string | null>()
  const { isPersonalDocumentHiddenFrom } = await import("@/lib/documents/visibility-guard")
  const kept = rows.filter((r) => {
    const rowOk = shownToClientByRow({
      portalVisible: r.portal_visible,
      serviceType: r.service_delivery_id ? types.get(r.service_delivery_id) ?? null : null,
      flowStage: r.flow_stage,
    })
    if (!rowOk) return false
    if (r.category !== undefined && isPersonalDocumentHiddenFrom({ category: r.category ?? null, contact_id: r.contact_id ?? null }, viewerContactId)) return false
    return true
  })
  return dropStoreRowsClientCannotOpen(kept, { applyRowRule: false }, deps)
}

/** Pure: may a correspondence file be served? Untyped is normal for correspondence; a typed file must not be staff-only / unknown; a personal paper outside a person's storage never. */
export function correspondenceTypeAllowed(documentType: string | null, closed: boolean, personalOutsidePerson: boolean): boolean {
  if (personalOutsidePerson) return false
  if (!documentType) return true
  return !closed
}

/**
 * Pure: does the stored file still belong to the party the correspondence item names? Staff can re-home a file
 * (person → company, person → person) without touching the correspondence row, so the item alone is not proof.
 * The file's owner must be the item's company (account) or the item's person (contact). Fails CLOSED.
 */
export function correspondenceOwnerMatches(
  item: { account_id: string | null; contact_id: string | null },
  owner: { account_id: string | null; contact_id: string | null } | null | undefined,
): boolean {
  if (!owner) return false
  if (item.account_id && owner.account_id && owner.account_id === item.account_id) return true
  if (item.contact_id && owner.contact_id && owner.contact_id === item.contact_id) return true
  return false
}


/**
 * The Tax page: everything `dropDocsClientCannotSee` keeps, PLUS the client's own fresh uploads, which are saved hidden on purpose
 * until staff review them. Those are listed by name with `waitingIds` marking them "Waiting for review" — they stay unopenable
 * (the download route still applies the row rule). A closed file (staff-only / untyped), another member's personal paper and a file
 * somebody else uploaded stay hidden. Newest first.
 */
export async function listDocsWithOwnUploads<T extends ListedDocRow & { created_at?: string | null }>(
  rows: T[],
  viewer: { contactId: string | null | undefined; userId: string; accountId: string },
  deps: ClientStoreDeps = defaultDeps,
): Promise<{ docs: T[]; waitingIds: Set<string> }> {
  const shown = await dropDocsClientCannotSee(rows, viewer.contactId, deps)
  const shownIds = new Set(shown.map((r) => r.id))
  const rest = rows.filter((r) => !shownIds.has(r.id) && isStorePointer(r.drive_file_id) && r.portal_visible !== true)
  if (rest.length === 0 || !deps.ownUploads) return { docs: shown, waitingIds: new Set() }
  const { isPersonalDocumentHiddenFrom } = await import("@/lib/documents/visibility-guard")
  const own = await deps.ownUploads(rest.map((r) => r.drive_file_id as string), viewer.userId, viewer.accountId)
  const mine = rest.filter((r) => own.has(r.drive_file_id as string)
    && !(r.category !== undefined && isPersonalDocumentHiddenFrom({ category: r.category ?? null, contact_id: r.contact_id ?? null }, viewer.contactId)))
  // the stored-file checks still apply (a file staff made staff-only is closed), the CRM-row rule is what is waived
  const open = await dropStoreRowsClientCannotOpen(mine, { applyRowRule: false }, deps)
  const waitingIds = new Set(open.map((r) => r.id))
  const docs = [...shown, ...open].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
  return { docs, waitingIds }
}
