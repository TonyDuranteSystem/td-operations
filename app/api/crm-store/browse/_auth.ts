import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isStoreStaffUser } from "@/lib/crm-store/access"

/** Staff allow-list (admin / team) for the read-only new-store browser. null = allowed. */
export async function denyUnlessStoreStaff(): Promise<NextResponse | null> {
  const { data: { user } } = await createClient().auth.getUser()
  if (!isStoreStaffUser(user)) return NextResponse.json({ error: "Staff only" }, { status: 403 })
  return null
}

/** For the routes that CHANGE the new store (upload, show/hide): only where the pilot may run. `study: true` = an
 *  action that only organises files staff study (type, rename, move, folders, trash) — it also runs where the
 *  STUDY copy is switched on (production, STORE_STUDY_COPY=1); nothing the client could see is ever allowed there. */
export async function denyUnlessStorePilotEnv(opts: { study?: boolean } = {}): Promise<NextResponse | null> {
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  if (pilotEnvironmentAllowed()) return null
  if (opts.study) {
    const { studyCopyAllowed } = await import("@/lib/crm-store/drive-import")
    if (studyCopyAllowed()) return null
  }
  return NextResponse.json({ error: "The new storage is not switched on here." }, { status: 403 })
}

/**
 * A private "My files" area opens ONLY for the login it belongs to — every browse route that names an
 * owner, a folder or a file checks it (a private area is answered as "Not found", never "forbidden").
 */
export async function denyUnlessAreaAccess(ref: { ownerId?: string | null; folderId?: string | null; fileId?: string | null }, opts: { allowSharedRead?: boolean } = {}): Promise<NextResponse | null> {
  const { data: { user } } = await createClient().auth.getUser()
  try {
    // READ-ONLY routes (open / download a file): a staff member may read a file shared with them from "Shared with staff"
    if (opts.allowSharedRead && ref.fileId && !ref.ownerId && !ref.folderId && user) {
      const { canReadSharedFile } = await import("@/lib/crm-store/staff-share")
      if (await canReadSharedFile(ref.fileId, user.id)) return null
    }
    const { assertOwnerAccess, ownerOfFolder, ownerOfFile } = await import("@/lib/crm-store/structure")
    const owners = new Set<string>()
    if (ref.ownerId) owners.add(ref.ownerId)
    if (ref.folderId) owners.add(await ownerOfFolder(ref.folderId))
    if (ref.fileId) owners.add(await ownerOfFile(ref.fileId))
    const { isOwnerOnly } = await import("@/lib/auth")
    const login = { id: user?.id ?? null, ownerOnly: isOwnerOnly(user) }
    for (const o of Array.from(owners)) await assertOwnerAccess(o, login)
    return null
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Not found." }, { status: 404 })
  }
}
