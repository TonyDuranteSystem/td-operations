/**
 * POST /api/crm-store/browse/folder/<id>/hide-chosen — hide from the client the chosen files { fileIds } in the folder (all levels) (new CRM store, staff only, pilot environment only).
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
    const ids = Array.isArray(body.fileIds) ? body.fileIds.filter((x): x is string => typeof x === "string") : []
    return NextResponse.json({ hidden: await s.hideChosenUnder(params.id, ids, user?.id ?? null) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The files could not be hidden." }, { status: 400 })
  }
}
