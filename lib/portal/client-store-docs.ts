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
