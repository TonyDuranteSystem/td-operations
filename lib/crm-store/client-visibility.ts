/**
 * CRM Store — what the client REALLY sees of a store file (E2E review 2026-09-28). The portal shows a CRM listing
 * when it is marked visible, OR when it is a workspace document at a client-facing stage (the flow-stage allowlist
 * in lib/flows/flow-doc-visibility.ts shows it whatever the visible flag says). Every store screen that says
 * "client can see" — the row badge, the filter, the folder move/delete question — uses THIS, so it never says
 * "hidden" for a file the client sees; and hiding a file also takes it off its client-facing stage.
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

/** Hiding a file: take its listing off a client-facing workspace stage too (else the portal keeps showing it). */
export async function takeOffClientStage(fileId: string, actorId: string | null): Promise<number> {
  const { rows, serviceType } = await listingsOf([fileId])
  const onStage = rows.filter((r) => r.flow_stage && rowClientVisible({ portal_visible: false, flow_stage: r.flow_stage }, r.service_delivery_id ? serviceType.get(r.service_delivery_id) ?? null : null))
  if (!onStage.length) return 0
  const { error } = await db().from("documents").update({ flow_stage: null, updated_at: new Date().toISOString() }).in("id", onStage.map((r) => r.id))
  if (error) throw new Error(`The file could not be taken off its workspace stage, so the client may still see it (${error.message}) — please try again.`)
  const { data: f } = await db().from("store_files").select("owner_id, folder_id, name").eq("id", fileId).maybeSingle()
  if (f) await db().from("store_events").insert({ event: "unpublished", actor: actorId, owner_id: f.owner_id, file_id: fileId, folder_id: f.folder_id, name_snapshot: f.name, details: { off_workspace_stage: onStage.map((r) => r.flow_stage) } })
  return onStage.length
}
