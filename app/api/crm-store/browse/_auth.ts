import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isStoreStaffUser } from "@/lib/crm-store/access"

/** Staff allow-list (admin / team) for the read-only new-store browser. null = allowed. */
export async function denyUnlessStoreStaff(): Promise<NextResponse | null> {
  const { data: { user } } = await createClient().auth.getUser()
  if (!isStoreStaffUser(user)) return NextResponse.json({ error: "Staff only" }, { status: 403 })
  return null
}

/** For the routes that CHANGE the new store (upload, show/hide): only where the pilot may run. */
export async function denyUnlessStorePilotEnv(): Promise<NextResponse | null> {
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  if (!pilotEnvironmentAllowed()) return NextResponse.json({ error: "The new storage is not switched on here." }, { status: 403 })
  return null
}

/**
 * A private "My files" area opens ONLY for the login it belongs to — every browse route that names an
 * owner, a folder or a file checks it (a private area is answered as "Not found", never "forbidden").
 */
export async function denyUnlessAreaAccess(ref: { ownerId?: string | null; folderId?: string | null; fileId?: string | null }): Promise<NextResponse | null> {
  const { data: { user } } = await createClient().auth.getUser()
  try {
    const { assertOwnerAccess, ownerOfFolder, ownerOfFile } = await import("@/lib/crm-store/structure")
    const owners = new Set<string>()
    if (ref.ownerId) owners.add(ref.ownerId)
    if (ref.folderId) owners.add(await ownerOfFolder(ref.folderId))
    if (ref.fileId) owners.add(await ownerOfFile(ref.fileId))
    for (const o of Array.from(owners)) await assertOwnerAccess(o, user?.id ?? null)
    return null
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Not found." }, { status: 404 })
  }
}
