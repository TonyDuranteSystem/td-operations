/**
 * POST /api/crm-store/browse/folder/<id>/ensure-path { path: string[] } — make (or reuse) the sub-folders of a
 * folder dragged in from the computer, under this folder. Staff only, pilot environment only.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../../../_auth"

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true, folderId: params.id }))
  if (denied) return denied
  const noAccess = await denyUnlessAreaAccess({ folderId: params.id })
  if (noAccess) return noAccess
  const body = await req.json().catch(() => ({})) as { path?: unknown }
  if (!Array.isArray(body.path) || !body.path.every((p) => typeof p === "string")) return NextResponse.json({ error: "A folder path is needed." }, { status: 400 })
  if (body.path.length > 20) return NextResponse.json({ error: "That folder goes more than 20 levels deep — drop a smaller part of it." }, { status: 400 })
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { ensureFolderPath } = await import("@/lib/crm-store/extras")
    return NextResponse.json(await ensureFolderPath(params.id, body.path as string[], user?.id ?? null))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The folders could not be created." }, { status: 400 })
  }
}
