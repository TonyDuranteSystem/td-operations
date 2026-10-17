/** GET /api/storage-app/whoami — who the token belongs to (the app's "am I still signed in?" check). Token only. */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { isOwnerOnly } from "@/lib/auth"
import { json, withDevice } from "@/lib/storage-app/guard"

export async function GET(req: NextRequest) {
  return withDevice(req, async ({ user, deviceId }) =>
    json({ userId: user.id, email: user.email ?? null, role: user.app_metadata?.role ?? null, owner: isOwnerOnly(user), deviceId }))
}
