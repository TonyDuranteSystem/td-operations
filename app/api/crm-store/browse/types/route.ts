/** GET /api/crm-store/browse/types — the store's document types (catalog), for the upload picker. */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv } from "../_auth"

export async function GET() {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const { listDocumentTypes } = await import("@/lib/crm-store/browse")
  return NextResponse.json({ types: await listDocumentTypes() })
}

/** POST { name, folderKind } — add a staff document type (today's "Custom…"), via the catalog framework. */
export async function POST(req: NextRequest) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv())
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; folderKind?: unknown }
  if (typeof body.name !== "string") return NextResponse.json({ error: "Enter a name for the new document type." }, { status: 400 })
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { addCustomDocumentType } = await import("@/lib/crm-store/custom-types")
    return NextResponse.json(await addCustomDocumentType({ name: body.name, folderKind: typeof body.folderKind === "string" ? body.folderKind : "company", actorId: user?.id ?? null }))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The type could not be added." }, { status: 400 })
  }
}
