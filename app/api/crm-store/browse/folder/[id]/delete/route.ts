/**
 * POST /api/crm-store/browse/folder/<id>/delete — the folder and everything in it go to the trash (90 days); optional { hide: "all" | { ids } } hides those files from the client first (new CRM store, staff only, pilot environment only).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

/** { hide: "all" } · { hide: { ids: [...] } } · anything else = hide nothing */
function hideChoice(v: unknown): "none" | "all" | { ids: string[] } {
  if (v === "all") return "all"
  if (v && typeof v === "object" && Array.isArray((v as { ids?: unknown }).ids)) return { ids: ((v as { ids: unknown[] }).ids).filter((x): x is string => typeof x === "string") }
  return "none"
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true }))
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ folderId: params.id })
  if (noAccess) return noAccess
  const body = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const s = await import("@/lib/crm-store/structure")
    return NextResponse.json(await s.deleteFolder(params.id, user?.id ?? null, hideChoice(body.hide)))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The folder could not be deleted." }, { status: 400 })
  }
}
