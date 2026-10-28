/**
 * GET /api/storage-app/changes[?since=<cursor>][&limit=500] — what changed in the storage since the cursor (rename, move, trash, new
 * file, a storage going live / hidden, an owner's name or group changing). `?head=1` returns the newest cursor to start from after a
 * full listing. `&wait=<seconds>` (the always-running app, max `pushWaitSeconds`, 0 = off) keeps the question open until something changes, so a new
 * file reaches the Mac in about a second instead of at the next once-a-minute check. `resync: true` = the cursor is older than the kept log: list everything again. Token only.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60
import { NextRequest } from "next/server"
import { changesHead, changesSince, changesWaiting, parseCursor } from "@/lib/storage-app/changes"
import { json, withDevice } from "@/lib/storage-app/guard"
import { getSettings } from "@/lib/storage-app/settings"

export async function GET(req: NextRequest) {
  return withDevice(req, async ({ user }) => {
    const q = req.nextUrl.searchParams
    if (q.get("head") === "1") return json({ cursor: await changesHead() })
    const raw = q.get("since")
    const after = raw ? parseCursor(raw) : null
    if (raw && !after) return json({ error: "Bad cursor." }, 400)
    const limit = Math.max(1, Math.min(Number(q.get("limit")) || 500, 2000))
    // resyncMinutes (settings row): how often a Mac re-lists everything — this is how a company / person rename reaches Finder (the core CRM tables carry no trigger)
    const settings = await getSettings()
    const waitMs = Math.min(Math.max(0, Number(q.get("wait")) || 0), settings.pushWaitSeconds) * 1000
    const page = await changesWaiting(after, waitMs, {
      read: (from) => changesSince(user, from, limit), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), aborted: () => req.signal.aborted,
    })
    return json({ ...page, resyncMinutes: settings.resyncMinutes })
  })
}
