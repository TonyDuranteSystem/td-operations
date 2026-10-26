/** GET /api/storage-app/whoami — who the token belongs to (the app's "am I still signed in?" check). Token only. */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { isOwnerOnly } from "@/lib/auth"
import { json, withDevice } from "@/lib/storage-app/guard"
import { getSettings } from "@/lib/storage-app/settings"
import { recordAppVersion } from "@/lib/storage-app/device-auth"
import { latestBuildFor, loadRelease, parseAppVersionHeader } from "@/lib/storage-app/release"

export async function GET(req: NextRequest) {
  return withDevice(req, async ({ user, deviceId }) => {
    const settings = await getSettings()
    const reported = parseAppVersionHeader(req.headers.get("x-td-app-version"))
    if (reported) await recordAppVersion(deviceId, reported)   // best effort: which app version this Mac runs (shown to the owner)
    const latestBuild = latestBuildFor(await loadRelease(), deviceId)   // the newest build offered to THIS Mac: the app checks for it at once
    // leaseHours / resyncMinutes: the values the Mac follows (settings row) — how long it may be away, how often it re-lists everything, how often it looks for a new app version
    return json({ userId: user.id, email: user.email ?? null, role: user.app_metadata?.role ?? null, owner: isOwnerOnly(user), deviceId, leaseHours: settings.leaseHours, resyncMinutes: settings.resyncMinutes, updateCheckMinutes: settings.updateCheckMinutes, updateHintSeconds: settings.updateHintSeconds, latestBuild })
  })
}
