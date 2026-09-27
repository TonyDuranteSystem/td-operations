/**
 * POST /api/crm-store/browse/upload — a staff upload into a NEW-store folder (company page / Storage tab).
 * Body: { ownerId, folderId, storagePath (onboarding-uploads), fileName, mimeType, documentType }.
 * Saves into the store + the CRM documents row (hidden from the client until staff share it).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessStorePilotEnv, denyUnlessAreaAccess } from "../_auth"

export async function POST(req: NextRequest) {
  const denied = (await denyUnlessStoreStaff()) ?? (await denyUnlessStorePilotEnv())
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const { ownerId, folderId, storagePath, fileName, mimeType, documentType, personContactId, displayName } = body as Record<string, string | undefined>
  const visible = (body as { visible?: unknown }).visible === false ? false : true
  if (!ownerId || !folderId || !storagePath || !fileName || !documentType) {
    return NextResponse.json({ error: "Choose a folder, a file and its document type." }, { status: 400 })
  }
  const noAccess = await denyUnlessAreaAccess({ ownerId, folderId })
  if (noAccess) return noAccess
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { staffUploadToStore } = await import("@/lib/crm-store/browse")
    const r = await staffUploadToStore({ ownerId, folderId, storagePath, fileName, mimeType: mimeType ?? null, documentType, actorId: user?.id ?? null, personContactId: personContactId ?? null, displayName: displayName ?? null, visible })
    return NextResponse.json(r)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The upload could not be saved." }, { status: 400 })
  }
}
