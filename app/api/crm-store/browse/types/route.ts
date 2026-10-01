/** GET /api/crm-store/browse/types — the store's document types (catalog), for the upload picker. */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../_auth"

export async function GET() {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const { listDocumentTypes } = await import("@/lib/crm-store/browse")
  return NextResponse.json({ types: await listDocumentTypes() })
}

/** POST { name, folderKind } or { name, fileId } — add a staff document type (today's "Custom…"), via the catalog framework.
 *  With a fileId the folder kind is taken from the folder that file sits in (the Change type box has no folder in hand). */
export async function POST(req: NextRequest) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv({ study: true }))
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; folderKind?: unknown; fileId?: unknown }
  if (typeof body.name !== "string") return NextResponse.json({ error: "Enter a name for the new document type." }, { status: 400 })
  let folderKind = typeof body.folderKind === "string" ? body.folderKind : "company"
  if (typeof body.fileId === "string" && body.fileId) {
    const noAccess = await denyUnlessAreaAccess({ fileId: body.fileId })
    if (noAccess) return noAccess
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
    const { data: f } = await (supabaseAdmin as any).from("store_files").select("store_folders!inner(kind)").eq("id", body.fileId).maybeSingle()
    const k = (f?.store_folders as { kind?: string } | null)?.kind
    if (k) folderKind = k
  }
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { addCustomDocumentType } = await import("@/lib/crm-store/custom-types")
    return NextResponse.json(await addCustomDocumentType({ name: body.name, folderKind, actorId: user?.id ?? null }))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The type could not be added." }, { status: 400 })
  }
}
