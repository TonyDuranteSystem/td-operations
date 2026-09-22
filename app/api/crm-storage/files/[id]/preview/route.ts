export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { CRM_STORAGE_BUCKET } from "@/lib/crm-storage/constants"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/**
 * GET /api/crm-storage/files/[id]/preview
 *
 * Same signed-URL lookup as .../download, deliberately WITHOUT the
 * `download` option — that option forces Content-Disposition: attachment,
 * which makes a browser save the file instead of rendering it inline. This
 * route is for the "click a file to view it" case; .../download stays the
 * one route that forces a save.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const { id } = await params

  const { data: row } = await db
    .from("crm_storage_files")
    .select("storage_path, storage_bucket, file_name, mime_type, file_size")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: "File not found" }, { status: 404 })

  const { data: signed, error } = await db.storage
    .from(row.storage_bucket || CRM_STORAGE_BUCKET)
    .createSignedUrl(row.storage_path, 300)
  if (error || !signed) return NextResponse.json({ error: "Failed to get a link" }, { status: 500 })

  return NextResponse.json({
    url: signed.signedUrl,
    file_name: row.file_name,
    mime_type: row.mime_type,
    file_size: row.file_size,
  })
}
