/**
 * POST /api/crm-store/browse/file/<id>/reviewed — staff settled a "Needs review" file (new CRM store, staff only, pilot environment only).
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true, fileId: params.id }))
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ fileId: params.id })
  if (noAccess) return noAccess
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { clearNeedsReview } = await import("@/lib/crm-store/structure")
    await clearNeedsReview(params.id, user?.id ?? null)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not clear \"Needs review\"." }, { status: 400 })
  }
}
