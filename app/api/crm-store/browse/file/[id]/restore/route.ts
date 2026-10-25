/**
 * POST /api/crm-store/browse/file/<id>/restore — make an older copy the current one (saved as a NEW version; nothing is deleted).
 * Body: { versionNo, baseVersionNo }. Staff only, same-origin JSON.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

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
  if (!Number.isInteger(b.versionNo) || !Number.isInteger(b.baseVersionNo)) return NextResponse.json({ error: "Choose the older copy again." }, { status: 400 })
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { restoreVersion } = await import("@/lib/crm-store/new-version")
    return NextResponse.json(await restoreVersion({
      fileId: params.id, versionNo: b.versionNo as number, baseVersionNo: b.baseVersionNo as number, actor: user?.id ?? null,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: req.headers.get("user-agent")?.slice(0, 200) ?? null,
    }))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The older copy could not be restored." }, { status: 400 })
  }
}
