/**
 * POST /api/crm-store/browse/file/<id>/new-version — save an edited file as the NEXT VERSION of this file (staff only).
 * Body: { storagePath (staged upload), fileName, mimeType, baseVersionNo, acceptWarnings?, keepUnmerged?, reason?, confirmToken? }.
 * Same-origin JSON only (the login cookie alone must not be enough to change a file).
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
  if (typeof b.storagePath !== "string" || typeof b.fileName !== "string" || typeof b.baseVersionNo !== "number" || !Number.isInteger(b.baseVersionNo)) {
    return NextResponse.json({ error: "Choose the edited file again." }, { status: 400 })
  }
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { saveNewVersionFromStaged } = await import("@/lib/crm-store/new-version")
    const r = await saveNewVersionFromStaged({
      fileId: params.id, storagePath: b.storagePath, fileName: b.fileName, mimeType: typeof b.mimeType === "string" ? b.mimeType : null,
      baseVersionNo: b.baseVersionNo, acceptWarnings: b.acceptWarnings === true, keepUnmerged: b.keepUnmerged === true,
      reason: typeof b.reason === "string" ? b.reason.trim().slice(0, 300) : null, confirmToken: typeof b.confirmToken === "string" ? b.confirmToken : null,
      actor: { userId: user?.id ?? null, ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null, userAgent: req.headers.get("user-agent")?.slice(0, 200) ?? null },
    })
    return NextResponse.json(r)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The new version could not be saved." }, { status: 400 })
  }
}
