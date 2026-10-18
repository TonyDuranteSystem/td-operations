/** GET /api/storage-app/whoami — who the token belongs to (the app's "am I still signed in?" check). Token only. */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { isOwnerOnly } from "@/lib/auth"
import { json, withDevice } from "@/lib/storage-app/guard"
import { getSettings } from "@/lib/storage-app/settings"

export async function GET(req: NextRequest) {
  return withDevice(req, async ({ user, deviceId }) => {
    const settings = await getSettings()
    // leaseHours / resyncMinutes: the two values the Mac follows (settings row) — how long it may be away, and how often it re-lists everything
    return json({ userId: user.id, email: user.email ?? null, role: user.app_metadata?.role ?? null, owner: isOwnerOnly(user), deviceId, leaseHours: settings.leaseHours, resyncMinutes: settings.resyncMinutes })
  })
}
