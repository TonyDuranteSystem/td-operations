/**
 * POST /api/crm-store/browse/folder/<id>/delete — the folder and everything in it go to the trash (90 days); optional { hideFirst: true } hides its shown files first (new CRM store, staff only, pilot environment only).
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv())
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ folderId: params.id })
  if (noAccess) return noAccess
  const body = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const s = await import("@/lib/crm-store/structure")
    if (body.hideFirst === true) await s.hideAllUnder(params.id, user?.id ?? null)
    return NextResponse.json(await s.deleteFolder(params.id, user?.id ?? null))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The folder could not be deleted." }, { status: 400 })
  }
}
