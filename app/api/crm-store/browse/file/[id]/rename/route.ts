/**
 * POST /api/crm-store/browse/file/<id>/rename — rename the file (its CRM listing follows) (new CRM store, staff only, pilot environment only).
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
    if (typeof body.name !== "string") return NextResponse.json({ error: "Enter a file name." }, { status: 400 })
    const { renameStoreFile } = await import("@/lib/crm-store/file-actions")
    return NextResponse.json(await renameStoreFile(params.id, body.name, user?.id ?? null))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The file could not be renamed." }, { status: 400 })
  }
}
