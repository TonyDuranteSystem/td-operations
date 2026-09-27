/**
 * POST /api/crm-store/browse/file/<id>/delete — move the file to the store trash (recoverable) and remove its CRM listing (new CRM store, staff only, pilot environment only).
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
    void body
    const { deleteStoreFile } = await import("@/lib/crm-store/file-actions")
    return NextResponse.json(await deleteStoreFile(params.id, user?.id ?? null))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The file could not be deleted." }, { status: 400 })
  }
}
