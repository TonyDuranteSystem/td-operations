/**
 * POST /api/crm-store/browse/folder/create — a new folder inside { parentId } with { name } (new CRM store, staff only, pilot environment only).
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../_auth"

export async function POST(req: NextRequest) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true }))
  if (denied) return denied
  const body = (req.method === "POST" ? await req.json().catch(() => ({})) : {}) as Record<string, unknown>
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const s = await import("@/lib/crm-store/structure")
    if (typeof body.parentId !== "string" || typeof body.name !== "string") return NextResponse.json({ error: "Enter a folder name." }, { status: 400 })
    const noParent = (await denyUnlessStorePilotEnv({ study: true, folderId: body.parentId })) ?? (await denyUnlessAreaAccess({ folderId: body.parentId }))
    if (noParent) return noParent
    return NextResponse.json(await s.createFolder(body.parentId, body.name, user?.id ?? null))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The folder could not be created." }, { status: 400 })
  }
}
