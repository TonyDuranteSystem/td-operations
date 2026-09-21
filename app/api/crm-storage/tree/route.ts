/**
 * GET /api/crm-storage/tree
 *
 * Returns every live folder (id, parent_id, name) so the client can build
 * the persistent left-hand folder tree in one request instead of walking
 * it level by level. Files are NOT included here — the right-hand pane
 * fetches a single folder's contents separately (see .../folders/[id]).
 *
 * Staff-only, end to end.
 */

export const dynamic = "force-dynamic"

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET() {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const { data, error } = await db
    .from("crm_storage_folders")
    .select("id, parent_id, name")
    .is("deleted_at", null)
    .order("name", { ascending: true })

  if (error) return NextResponse.json({ error: "Failed to load the folder tree" }, { status: 500 })
  return NextResponse.json({ folders: data ?? [] })
}
