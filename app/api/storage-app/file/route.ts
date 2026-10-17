/**
 * GET /api/storage-app/file?id=<file id> — a 60-second signed download link for ONE live file (dev job 1992a087, P1). Same access checks
 * as the Storage page (a file shared with staff may be read too); sensitive documents are REFUSED here (403 open_in_crm) whatever the app
 * does; an hourly per-Mac limit applies; every open is audited. The link itself is never logged or stored. Token only.
 */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { denyUnlessAreaAccess } from "@/app/api/crm-store/browse/_auth"
import { json, withDevice } from "@/lib/storage-app/guard"
import { appItem, isLiveOwner } from "@/lib/storage-app/listing"
import { openFileForDevice } from "@/lib/storage-app/file-open"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  return withDevice(req, async ({ user, deviceId }) => {
    const id = req.nextUrl.searchParams.get("id")
    if (!id || !UUID.test(id)) return json({ error: "Choose a file." }, 400)
    const item = await appItem("file", id)
    if (!item || !(await isLiveOwner(item.ownerId))) return json({ error: "Not found." }, 404)
    // the file's own storage, or a file the owners shared with this staff login
    const noAccess = await denyUnlessAreaAccess({ fileId: id }, { user, allowSharedRead: true })
    if (noAccess) return json({ error: "Not found." }, 404)
    const r = await openFileForDevice({ item, userId: user.id, deviceId })
    return json(r.body, r.status)
  })
}
