/**
 * POST /api/crm-store/browse/file/<id>/visibility { visible: boolean } — show / hide a NEW-store file for the
 * client. Updates the store AND the CRM documents row together (the portal still reads the row until
 * Stage 1). A staff-only file (the Formation Summary) is refused.
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
  const body = await req.json().catch(() => ({}))
  if (typeof (body as { visible?: unknown }).visible !== "boolean") {
    return NextResponse.json({ error: "visible must be true or false" }, { status: 400 })
  }
  try {
    const { data: { user } } = await createClient().auth.getUser()
    const { setClientVisibility } = await import("@/lib/crm-store/browse")
    // { group: true } = part of a group action: personal documents are refused (they are shown one by one)
    return NextResponse.json(await setClientVisibility(params.id, (body as { visible: boolean }).visible, user?.id ?? null, { refusePersonal: (body as { group?: unknown }).group === true }))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not change who can see this file." }, { status: 400 })
  }
}
