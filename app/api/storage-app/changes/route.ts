/**
 * GET /api/storage-app/changes[?since=<cursor>][&limit=500] — what changed in the storage since the cursor (rename, move, trash, new
 * file, a storage going live / hidden, an owner's name or group changing). `?head=1` returns the newest cursor to start from after a
 * full listing. `resync: true` = the cursor is older than the kept log: list everything again. Token only.
 */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { changesHead, changesSince, parseCursor } from "@/lib/storage-app/changes"
import { json, withDevice } from "@/lib/storage-app/guard"

export async function GET(req: NextRequest) {
  return withDevice(req, async ({ user }) => {
    const q = req.nextUrl.searchParams
    if (q.get("head") === "1") return json({ cursor: await changesHead() })
    const raw = q.get("since")
    const after = raw ? parseCursor(raw) : null
    if (raw && !after) return json({ error: "Bad cursor." }, 400)
    const limit = Math.max(1, Math.min(Number(q.get("limit")) || 500, 2000))
    return json(await changesSince(user, after, limit))
  })
}
