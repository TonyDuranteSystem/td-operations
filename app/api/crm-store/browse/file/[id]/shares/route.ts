/**
 * GET  /api/crm-store/browse/file/<id>/shares — who a file in My files › Shared with staff is shared with.
 * POST /api/crm-store/browse/file/<id>/shares { userIds } — set exactly who may open it (owners only,
 * pilot environment only). Every change is logged.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

async function ownersOnly(fileId: string): Promise<{ denied: NextResponse | null; userId: string | null }> {
  const denied = await denyUnlessStoreStaff()
  if (denied) return { denied, userId: null }
  const { data: { user } } = await createClient().auth.getUser()
  if (!isOwnerOnly(user)) return { denied: NextResponse.json({ error: "Not found." }, { status: 404 }), userId: null }
  // the file must be in the owners' own area (not merely shared with them)
  const noAccess = await denyUnlessAreaAccess({ fileId })
  return { denied: noAccess, userId: user?.id ?? null }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { denied } = await ownersOnly(params.id)
  if (denied) return denied
  try {
    const { fileShares } = await import("@/lib/crm-store/staff-share")
    return NextResponse.json({ sharedWith: await fileShares(params.id) }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read who this file is shared with." }, { status: 400 })
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const pilot = await denyUnlessStorePilotEnv()
  if (pilot) return pilot
  const { denied, userId } = await ownersOnly(params.id)
  if (denied) return denied
  const body = await req.json().catch(() => ({})) as { userIds?: unknown }
  if (!Array.isArray(body.userIds)) return NextResponse.json({ error: "Tick who may see it." }, { status: 400 })
  try {
    const { setFileShares } = await import("@/lib/crm-store/staff-share")
    return NextResponse.json(await setFileShares(params.id, body.userIds.filter((x): x is string => typeof x === "string"), userId))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The sharing could not be changed." }, { status: 400 })
  }
}
