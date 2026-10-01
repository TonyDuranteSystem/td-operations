import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { denyUnlessStoreStaff, denyUnlessAreaAccess, denyUnlessStorePilotEnv } from "../browse/_auth"

/**
 * Who may use the AI check inside the storage screen (Antonio 2026-09-30). Sending a document to the AI is an outward act, so:
 *  · staff only (the same allow-list as every storage route),
 *  · only where the new storage is switched on — the sandbox pilot for any staff, or, in production, a STUDY copy and OWNERS only,
 *  · only inside a storage this login may open (a private "My files" area opens only for its owner).
 * Returns the signed-in user id, or the answer to send back.
 */
export async function gateAiCheck(ref: { fileId?: string | null; ownerId?: string | null; folderId?: string | null }): Promise<{ actor: string } | NextResponse> {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const env = await denyUnlessStorePilotEnv({ study: true, fileId: ref.fileId ?? null, folderId: ref.folderId ?? null, ownerId: ref.ownerId ?? null })
  if (env) return env
  const noAccess = await denyUnlessAreaAccess({ fileId: ref.fileId ?? null, ownerId: ref.ownerId ?? null, folderId: ref.folderId ?? null })
  if (noAccess) return noAccess
  const { data: { user } } = await createClient().auth.getUser()
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 })
  return { actor: user.id }
}
