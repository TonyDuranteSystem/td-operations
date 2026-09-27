/**
 * POST /api/crm-store/browse/file/<id>/move — move the file to another folder of the same company / person (new CRM store, staff only, pilot environment only).
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv())
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id })
  if (noAccess) return noAccess
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const { data: { user } } = await createClient().auth.getUser()
  try {
    if (typeof body.folderId !== "string") return NextResponse.json({ error: "Choose a folder." }, { status: 400 })
    const { moveStoreFile } = await import("@/lib/crm-store/file-actions")
    return NextResponse.json(await moveStoreFile(params.id, body.folderId, user?.id ?? null))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The file could not be moved." }, { status: 400 })
  }
}
