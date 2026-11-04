/**
 * "Sort by date" on a folder (dev job 1f4645b6) — new CRM store, staff only.
 *   GET  → the choice saved on this folder (or the default) and whether the folder can be sorted.
 *   POST { mode: "preview" | "apply", settings } → preview writes NOTHING; apply moves up to 15 items and says how many are left (the screen repeats it).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true, folderId: params.id }))
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ folderId: params.id })
  if (noAccess) return noAccess
  try {
    const d = await import("@/lib/crm-store/date-sort")
    return NextResponse.json({ settings: (await d.savedSettings(params.id)) ?? d.DEFAULT_DATE_SORT, remembered: !!(await d.savedSettings(params.id)) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the choice." }, { status: 400 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true, folderId: params.id }))
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ folderId: params.id })
  if (noAccess) return noAccess
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const d = await import("@/lib/crm-store/date-sort")
    if (body.mode === "preview") return NextResponse.json(await d.previewDateSort(params.id, body.settings))
    if (body.mode === "apply") return NextResponse.json(await d.applyDateSort(params.id, body.settings, user?.id ?? null))
    return NextResponse.json({ error: "Choose Preview or Confirm." }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The folder could not be sorted." }, { status: 400 })
  }
}
