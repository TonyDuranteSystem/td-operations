/**
 * CRM Store — what the client REALLY sees of a store file (E2E review 2026-09-28). The portal shows a CRM listing
 * when it is marked visible, OR when it is a workspace document at a client-facing stage (the flow-stage allowlist
 * in lib/flows/flow-doc-visibility.ts shows it whatever the visible flag says). Every store screen that says
 * "client can see" — the row badge, the filter, the folder move/delete question — uses THIS, so it never says
 * "hidden" for a file the client sees. A file shown by its workspace stage can't be hidden from the storage
 * (the stage is never erased — other flows find documents by it).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isClientSafeFlowDoc } from "@/lib/flows/flow-doc-visibility"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export interface ListingRow { id: string; drive_file_id: string; portal_visible: boolean | null; service_delivery_id: string | null; flow_stage: string | null }

/** Pure: does the client see this listing, given its workspace's service type. */
export function rowClientVisible(row: Pick<ListingRow, "portal_visible" | "flow_stage">, serviceType: string | null): boolean {
  return isClientSafeFlowDoc(serviceType, row.flow_stage, row.portal_visible)
}

/** The listing rows of these store files (200 at a time) with their workspace's service type. */
export async function listingsOf(fileIds: string[]): Promise<{ rows: ListingRow[]; serviceType: Map<string, string> }> {
  const { storePointer } = await import("./document-pointer")
  const rows: ListingRow[] = []
  for (let i = 0; i < fileIds.length; i += 200) {
    const { data, error } = await db().from("documents").select("id, drive_file_id, portal_visible, service_delivery_id, flow_stage")
      .in("drive_file_id", fileIds.slice(i, i + 200).map((id) => storePointer(id)))
    if (error) throw new Error(`Could not read the CRM listing (${error.message}).`)
    rows.push(...((data ?? []) as ListingRow[]))
  }
  const sdIds = Array.from(new Set(rows.map((r) => r.service_delivery_id).filter((x): x is string => !!x)))
  const serviceType = new Map<string, string>()
  for (let i = 0; i < sdIds.length; i += 200) {
    const { data, error } = await db().from("service_deliveries").select("id, service_type").in("id", sdIds.slice(i, i + 200))
    if (error) throw new Error(`Could not read the workspaces (${error.message}).`)
    for (const s of (data ?? []) as { id: string; service_type: string | null }[]) if (s.service_type) serviceType.set(s.id, s.service_type)
  }
  return { rows, serviceType }
}

/** Store file ids the client sees today (visible flag OR a client-facing workspace stage). */
export async function clientVisibleFileIds(fileIds: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (!fileIds.length) return out
  const { rows, serviceType } = await listingsOf(fileIds)
  for (const r of rows) {
    if (rowClientVisible(r, r.service_delivery_id ? serviceType.get(r.service_delivery_id) ?? null : null)) out.add(r.drive_file_id.slice("store:".length))
  }
  return out
}

/**
 * Files the client sees THROUGH a workspace stage (e.g. the Articles on "Filed with State"): the workspace shows
 * them whatever the visible flag says, so the storage cannot hide them — and must never erase the stage to try
 * (the SS-4 lookup and the stage-revert clean-up find documents by it). Returns file id → the workspace's name.
 */
export async function workspaceShownFiles(fileIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!fileIds.length) return out
  const { rows, serviceType } = await listingsOf(fileIds)
  for (const r of rows) {
    const st = r.service_delivery_id ? serviceType.get(r.service_delivery_id) ?? null : null
    if (st && r.flow_stage && rowClientVisible({ portal_visible: false, flow_stage: r.flow_stage }, st)) out.set(r.drive_file_id.slice("store:".length), st)
  }
  return out
}

/** Pure: the message when a workspace-shown file can't be hidden. */
export function workspaceShownMessage(name: string, workspace: string): string {
  return `The client sees "${name}" through the ${workspace} workspace (it is one of the documents that workspace always shows), so it can't be hidden from the storage.`
}
