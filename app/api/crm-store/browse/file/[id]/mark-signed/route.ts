/**
 * POST /api/crm-store/browse/file/<id>/mark-signed — a person says "this file is a signed document": it is never edited in place again
 * (only a replacement is added). One-way from here. Staff only, same-origin JSON.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isSameOriginJson } from "@/lib/storage-app/request-checks"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  if (!isSameOriginJson(req.headers, req.nextUrl.host)) return NextResponse.json({ error: "This request did not come from the storage page." }, { status: 403 })
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true, fileId: params.id }))
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id })
  if (noAccess) return noAccess
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { markFileSigned } = await import("@/lib/crm-store/file-actions")
    return NextResponse.json(await markFileSigned(params.id, user?.id ?? null))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The file could not be marked as signed." }, { status: 400 })
  }
}
