/**
 * POST /api/crm-store/browse/folder/<id>/move — move a folder you created into another folder of the same storage (new CRM store, staff only, pilot environment only).
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
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true, folderId: params.id }))
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ folderId: params.id })
  if (noAccess) return noAccess
  const body = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const s = await import("@/lib/crm-store/structure")
    if (typeof body.toFolderId !== "string") return NextResponse.json({ error: "Choose where to move it." }, { status: 400 })
    const noTarget = await denyUnlessAreaAccess({ folderId: body.toFolderId })
    if (noTarget) return noTarget
    return NextResponse.json(await s.moveFolder(params.id, body.toFolderId, user?.id ?? null, hideChoice(body.hide)))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The folder could not be moved." }, { status: 400 })
  }
}
