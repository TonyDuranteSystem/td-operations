/**
 * GET /api/storage-app/item?kind=file|folder&id=<uuid> — one item by id with its parent (what Finder asks when it only knows an id).
 * Same access checks as the Storage page; an item in a hidden / someone else's private storage is Not found. Token only.
 */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { denyUnlessAreaAccess } from "@/app/api/crm-store/browse/_auth"
import { json, withDevice } from "@/lib/storage-app/guard"
import { appItem, isLiveOwner } from "@/lib/storage-app/listing"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  return withDevice(req, async ({ user }) => {
    const kind = req.nextUrl.searchParams.get("kind")
    const id = req.nextUrl.searchParams.get("id")
    if ((kind !== "file" && kind !== "folder") || !id || !UUID.test(id)) return json({ error: "Choose an item." }, 400)
    const item = await appItem(kind, id)
    if (!item || !(await isLiveOwner(item.ownerId))) return json({ error: "Not found." }, 404)
    const noAccess = await denyUnlessAreaAccess({ ownerId: item.ownerId }, { user })
    if (noAccess) return json({ error: "Not found." }, 404)
    return json(item)
  })
}
