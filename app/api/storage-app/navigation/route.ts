/** GET /api/storage-app/navigation — the top level of "TD Storage" in Finder: groups → live storages (what this login may open). Token only. */
export const dynamic = "force-dynamic"
import { NextRequest } from "next/server"
import { json, withDevice } from "@/lib/storage-app/guard"
import { appNavigation } from "@/lib/storage-app/listing"

export async function GET(req: NextRequest) {
  return withDevice(req, async ({ user }) => json({ groups: await appNavigation(user) }))
}
