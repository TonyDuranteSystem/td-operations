/**
 * POST /api/storage-app/new-folder — a Mac makes a NEW folder (dev job 1992a087, 2026-11-03). Body: { ownerId, parentId, name }. Same destination
 * rules as saving a file (Business / My files, never a storage's top folder); a folder of that name that is already there is REUSED, so a repeated
 * paste or a retry never makes a second one. Answers { folderId, ownerId, name, created }. Token only.
 */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { json, withDevice } from "@/lib/storage-app/guard"
import { createFolderFromMac } from "@/lib/storage-app/new-folder"

export async function POST(req: NextRequest) {
  return withDevice(req, async ({ user, deviceId }) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const r = await createFolderFromMac({ user, deviceId, ownerId: body.ownerId, parentId: body.parentId, name: body.name })
    return json(r.body, r.status)
  })
}
