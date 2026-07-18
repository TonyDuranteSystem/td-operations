import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isAdmin, isDashboardUser } from "@/lib/auth"
import { getAppSetting, setAppSetting } from "@/lib/settings"
import { WORKER_MODEL_OPTIONS, isAllowedWorkerModel } from "@/lib/ai-agent/worker-models"
import { resolveWorkerModel, clearWorkerModelCache } from "@/lib/ai-agent/worker-tools"

export const dynamic = "force-dynamic"

/**
 * The worker's model setting — ONE shared value behind the gear on every worker
 * panel (dev job a6c3d75b, Antonio 2026-07-18).
 *
 * GET  — any staff member: the current model + the options (so the gear can render
 *        and show what answered, without exposing a write path).
 * POST — ADMIN ONLY: change it. It applies on every surface within seconds, costs
 *        real money per question, and affects Luca too — so it is not a
 *        every-staff-member switch. The value must be one of the curated options; a
 *        typo'd or retired id would break the worker everywhere at once.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }
  const stored = await getAppSetting<string | null>("worker_model", null)
  const active = isAllowedWorkerModel(stored) ? stored : resolveWorkerModel()
  return NextResponse.json({
    active,
    // null when it's falling back to env/default rather than an explicit choice.
    chosen: isAllowedWorkerModel(stored) ? stored : null,
    options: WORKER_MODEL_OPTIONS,
    canEdit: isAdmin(user),
  })
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }
  if (!isAdmin(user)) {
    return NextResponse.json(
      { error: "Only an admin can change the assistant's model — it applies to the whole team." },
      { status: 403 },
    )
  }

  let body: { model?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const model = body.model
  if (!isAllowedWorkerModel(model)) {
    return NextResponse.json(
      { error: "That isn't one of the available models. Pick one from the list." },
      { status: 400 },
    )
  }

  try {
    await setAppSetting("worker_model", model.trim())
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Could not save the setting."
    return NextResponse.json({ error: detail }, { status: 500 })
  }
  // Drop the cache so the very next turn uses it (this process at least; other
  // instances pick it up within the short TTL).
  clearWorkerModelCache()

  return NextResponse.json({ ok: true, active: model.trim() })
}
