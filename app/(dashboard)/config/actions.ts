"use server"

import { revalidatePath } from "next/cache"
import { safeAction, type ActionResult } from "@/lib/server-action"
import {
  updateSOP,
  updateDevTask,
} from "@/lib/operations/config"
import { createClient } from "@/lib/supabase/server"
import { isAdmin } from "@/lib/auth"
import { updateOneStage, type StagePatch } from "@/lib/services/stages"

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export async function saveSOP(
  id: string,
  expectedUpdatedAt: string | null,
  patch: {
    title?: string
    service_type?: string | null
    version?: string | null
    notes?: string | null
    content?: string
  },
): Promise<ActionResult> {
  return safeAction(async () => {
    const result = await updateSOP({
      id,
      patch: patch as never,
      expected_updated_at: expectedUpdatedAt ?? undefined,
      actor: "dashboard:config",
      summary: `SOP edited (${Object.keys(patch).join(", ")})`,
    })
    if (!result.success) throw new Error(result.error || `updateSOP returned ${result.outcome}`)
    revalidatePath("/config")
  })
}

export async function savePipelineStage(
  id: string,
  patch: {
    stage_name?: string
    stage_description?: string | null
    client_description?: string | null
    sla_days?: number | null
    auto_advance?: boolean | null
    requires_approval?: boolean | null
    auto_actions?: unknown[] | null
  },
): Promise<ActionResult> {
  return safeAction(async () => {
    // Same door as the service editor (N1a P2): admin-only, and saved through the guarded step save so a step clients
    // are sitting on can't be renamed from here, and the change lands in the service settings history.
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !isAdmin(user)) throw new Error("Only an admin can change a service's steps.")
    await updateOneStage(id, patch as StagePatch, user.email ?? "app:config")
    revalidatePath("/config")
    revalidatePath("/service-catalog")
  })
}

export async function saveDevTask(
  id: string,
  expectedUpdatedAt: string | null,
  patch: {
    title?: string
    status?: string
    priority?: string
    type?: string
    description?: string | null
    decisions?: string | null
    blockers?: string | null
  },
): Promise<ActionResult> {
  return safeAction(async () => {
    const summary = patch.title
      ? `Dev task edited: ${truncate(patch.title, 60)}`
      : `Dev task edited (${Object.keys(patch).join(", ")})`
    const result = await updateDevTask({
      id,
      patch: patch as never,
      expected_updated_at: expectedUpdatedAt ?? undefined,
      actor: "dashboard:config",
      summary,
    })
    if (!result.success) throw new Error(result.error || `updateDevTask returned ${result.outcome}`)
    revalidatePath("/config")
  })
}
