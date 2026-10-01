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
export async function denyUnlessStorePilotEnv(opts: { study?: boolean; fileId?: string | null; folderId?: string | null; ownerId?: string | null } = {}): Promise<NextResponse | null> {
  const { pilotEnvironmentAllowed } = await import("@/lib/crm-store/formation-pilot")
  if (pilotEnvironmentAllowed()) return null
  // The firm's OWN areas (Business, a staff member's My files) are a normal storage everywhere (Antonio 2026-10-01): no client, no
  // CRM row, never shown to anyone outside the firm — so they need no "study copy" mode. Client storage stays strict, below.
  if (opts.fileId || opts.folderId || opts.ownerId) {
    try {
      const { ownerOfFile, ownerOfFolder } = await import("@/lib/crm-store/structure")
      const oid = opts.ownerId ?? (opts.folderId ? await ownerOfFolder(opts.folderId) : opts.fileId ? await ownerOfFile(opts.fileId) : null)
      if (oid) {
        const { supabaseAdmin } = await import("@/lib/supabase-admin")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
        const { data: o } = await (supabaseAdmin as any).from("store_owners").select("kind").eq("id", oid).maybeSingle()
        const { isInternalOwnerKind } = await import("@/lib/crm-store/plain-drop")
        if (isInternalOwnerKind(o?.kind)) return null
      }
    } catch { /* an unreadable owner is never treated as internal — fall through to the strict rules */ }
  }
  if (opts.study) {
    const { studyCopyAllowed } = await import("@/lib/crm-store/drive-import")
    if (studyCopyAllowed()) {
      // study mode: owners only, and never a file a CRM record points at (study copies have none — a real one would)
      const { data: { user } } = await createClient().auth.getUser()
      const { isOwnerOnly } = await import("@/lib/auth")
      if (!user || !isOwnerOnly(user)) return NextResponse.json({ error: "Owners only while the new storage holds study copies." }, { status: 403 })
      const { supabaseAdmin } = await import("@/lib/supabase-admin")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
      const sdb = supabaseAdmin as any
      // only a STUDY storage (one a copy created) can be changed here — never a real one
      if (opts.fileId || opts.folderId || opts.ownerId) {
        const { data: row, error } = opts.fileId
          ? await sdb.from("store_files").select("store_owners!inner(study_only)").eq("id", opts.fileId).maybeSingle()
          : opts.folderId
            ? await sdb.from("store_folders").select("store_owners!inner(study_only)").eq("id", opts.folderId).maybeSingle()
            : await sdb.from("store_owners").select("study_only").eq("id", opts.ownerId).maybeSingle()
        if (error) return NextResponse.json({ error: "Could not check the storage — please try again." }, { status: 503 })
        const study = opts.ownerId && !opts.fileId && !opts.folderId ? (row as { study_only?: boolean } | null)?.study_only : (row?.store_owners as { study_only?: boolean } | undefined)?.study_only
        if (study !== true) return NextResponse.json({ error: "Only a study copy can be changed here." }, { status: 403 })
      }
      if (opts.fileId) {
        const { count, error } = await supabaseAdmin.from("documents").select("id", { count: "exact", head: true }).eq("drive_file_id", `store:${opts.fileId}`)
        if (error) return NextResponse.json({ error: "Could not check the file — please try again." }, { status: 503 })
        if ((count ?? 0) > 0) return NextResponse.json({ error: "This file is listed in the CRM — it can't be changed from a study copy." }, { status: 403 })
      }
      return null
    }
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
