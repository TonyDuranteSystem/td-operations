/**
 * POST /api/storage-app/upload-slot — step 1 of saving a NEW file from a Mac (dev job 1992a087, phase P3 step A). Body:
 * { ownerId, folderId, name, size, mimeType, itemKey }. Checks the folder (Business / My files only for now), the name (never replaces an
 * existing file), and the Mac's hourly upload limit; answers with a single-use signed upload address. Token only.
 */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { json, withDevice } from "@/lib/storage-app/guard"
import { createSaveSlot } from "@/lib/storage-app/save"

export async function POST(req: NextRequest) {
  return withDevice(req, async ({ user, deviceId }) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const r = await createSaveSlot({ user, deviceId, ownerId: body.ownerId, folderId: body.folderId, name: body.name, size: body.size, mimeType: body.mimeType, itemKey: body.itemKey })
    return json(r.body, r.status)
  })
}
