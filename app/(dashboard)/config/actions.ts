"use server"

import { revalidatePath } from "next/cache"
import { safeAction, type ActionResult } from "@/lib/server-action"
import {
  updateSOP,
  updatePipelineStage,
  updateDevTask,
} from "@/lib/operations/config"

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
  },
): Promise<ActionResult> {
  return safeAction(async () => {
    const result = await updatePipelineStage({
      id,
      patch: patch as never,
      actor: "dashboard:config",
      summary: `Pipeline stage edited (${Object.keys(patch).join(", ")})`,
    })
    if (!result.success) throw new Error(result.error || `updatePipelineStage returned ${result.outcome}`)
    revalidatePath("/config")
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
