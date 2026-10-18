/**
 * POST /api/storage-app/save — step 2 of saving a NEW file from a Mac (dev job 1992a087, phase P3 step A). Body: { intentId, itemKey }.
 * The file has been uploaded to the address from upload-slot; this registers it through the CRM's one writer, hidden from clients.
 * Saving the same file twice returns the same file. Token only.
 */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { json, withDevice } from "@/lib/storage-app/guard"
import { saveFromSlot } from "@/lib/storage-app/save"

export async function POST(req: NextRequest) {
  return withDevice(req, async ({ user, deviceId }) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const r = await saveFromSlot({ user, deviceId, intentId: body.intentId, itemKey: body.itemKey, replaceFileId: body.replaceFileId })
    return json(r.body, r.status)
  })
}
