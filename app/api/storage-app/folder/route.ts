/**
 * GET /api/storage-app/folder?owner=<id>[&folder=<id>] — one folder of a live storage (its top folder when `folder` is missing).
 * Same access checks as the Storage page, called with the token's user. Token only.
 */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { denyUnlessAreaAccess } from "@/app/api/crm-store/browse/_auth"
import { json, withDevice } from "@/lib/storage-app/guard"
import { appFolder, isLiveOwner } from "@/lib/storage-app/listing"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  return withDevice(req, async ({ user }) => {
    const owner = req.nextUrl.searchParams.get("owner")
    const folder = req.nextUrl.searchParams.get("folder")
    if (!owner || !UUID.test(owner) || (folder && !UUID.test(folder))) return json({ error: "Choose a storage." }, 400)
    if (!(await isLiveOwner(owner))) return json({ error: "Not found." }, 404)
    const noAccess = await denyUnlessAreaAccess({ ownerId: owner, folderId: folder }, { user })
    if (noAccess) return noAccess
    const listing = await appFolder(owner, folder)
    return listing ? json(listing) : json({ error: "Not found." }, 404)
  })
}
