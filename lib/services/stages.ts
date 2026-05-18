/**
 * Pipeline stages — read/write helpers for the Service Catalog editor.
 *
 * `pipeline_stages` rows define the lifecycle a Service Delivery moves through
 * for a given service_type (e.g. Company Formation → Data Collection → State
 * Filing → EIN Application → ... → Closing). Before this helper, the only way
 * to manage these rows was raw SQL migrations.
 *
 * The Service Catalog Add/Edit page uses these to let Antonio define stages
 * inline when authoring a new service, instead of needing an engineer.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface StageRow {
  stage_order: number
  stage_name: string
  stage_description?: string | null
  sla_days?: number | null
  auto_advance?: boolean | null
  notify_client_email?: boolean
  client_description?: string | null
}

export async function getStagesForService(serviceType: string): Promise<StageRow[]> {
  const { data, error } = await supabaseAdmin
    .from("pipeline_stages")
    .select(
      "stage_order, stage_name, stage_description, sla_days, auto_advance, notify_client_email, client_description",
    )
    .eq("service_type", serviceType)
    .order("stage_order", { ascending: true })
  if (error) throw new Error(`getStagesForService(${serviceType}): ${error.message}`)
  return (data ?? []) as StageRow[]
}

/**
 * Replace ALL stages for a service_type atomically (delete-then-insert).
 *
 * Why replace rather than diff: stage_order is critical and indexed; a partial
 * update with reordering means temporary unique-constraint violations. Delete
 * + bulk insert avoids that and matches existing migration patterns.
 *
 * Concurrency: the editor isn't multi-user-per-row (admin-only, low volume).
 * If two admins edit the same service's stages concurrently, last-write wins.
 * Acceptable at our scale.
 */
export async function replaceStagesForService(
  serviceType: string,
  stages: StageRow[],
): Promise<void> {
  if (!serviceType || !serviceType.trim()) {
    throw new Error("replaceStagesForService: serviceType is required")
  }

  // Delete existing rows for this service_type.
  const { error: delErr } = await supabaseAdmin
    .from("pipeline_stages")
    .delete()
    .eq("service_type", serviceType)
  if (delErr) {
    throw new Error(`replaceStagesForService(${serviceType}) delete: ${delErr.message}`)
  }

  if (stages.length === 0) return

  // Insert new rows. Stage_order is set from the array index + 1 to guarantee
  // density (no gaps), regardless of what the editor passed.
  const insertRows = stages.map((s, idx) => ({
    service_type: serviceType,
    stage_order: idx + 1,
    stage_name: s.stage_name,
    stage_description: s.stage_description ?? null,
    sla_days: s.sla_days ?? null,
    auto_advance: s.auto_advance ?? false,
    notify_client_email: s.notify_client_email ?? false,
    client_description: s.client_description ?? null,
  }))

  const { error: insErr } = await supabaseAdmin.from("pipeline_stages").insert(insertRows)
  if (insErr) {
    throw new Error(`replaceStagesForService(${serviceType}) insert: ${insErr.message}`)
  }
}
