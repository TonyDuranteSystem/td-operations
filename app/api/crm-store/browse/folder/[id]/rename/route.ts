/**
 * POST /api/crm-store/browse/folder/<id>/rename — rename a folder you created (the fixed folders are locked) (new CRM store, staff only, pilot environment only).
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true, folderId: params.id }))
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ folderId: params.id })
  if (noAccess) return noAccess
  const body = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const s = await import("@/lib/crm-store/structure")
    if (typeof body.name !== "string") return NextResponse.json({ error: "Enter a folder name." }, { status: 400 })
    return NextResponse.json(await s.renameFolder(params.id, body.name, user?.id ?? null))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The folder could not be renamed." }, { status: 400 })
  }
}
