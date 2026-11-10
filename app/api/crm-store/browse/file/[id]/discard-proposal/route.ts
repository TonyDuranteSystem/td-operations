/**
 * POST /api/crm-store/browse/file/<id>/discard-proposal — put a not-applied change (e.g. one Claude proposed) aside. The current copy is not
 * changed and nothing is deleted: the version stays in the list marked discarded. Body: { versionNo }. Staff only, same-origin JSON.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 30

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
  const b = await req.json().catch(() => ({})) as Record<string, unknown>
  if (!Number.isInteger(b.versionNo) || (b.versionNo as number) < 1 || (b.versionNo as number) > 1_000_000) return NextResponse.json({ error: "Say which version to discard." }, { status: 400 })
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { discardProposal } = await import("@/lib/crm-store/proposals")
    return NextResponse.json(await discardProposal({ fileId: params.id, versionNo: b.versionNo as number, actor: user?.id ?? null }))
  } catch (e) {
    console.error("[crm-store] discard route:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "The change could not be discarded — please try again." }, { status: 400 })
  }
}
