export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { CRM_STORAGE_BUCKET } from "@/lib/crm-storage/constants"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const { id } = await params

  const { data: row } = await db
    .from("crm_storage_files")
    .select("storage_path, storage_bucket, file_name")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: "File not found" }, { status: 404 })

  // The signed URL points at a different origin than the CRM, and a
  // browser only honors an <a download> attribute for a same-origin link
  // — a cross-origin one is silently ignored, so without this the file
  // just opens in a new tab under its random storage id instead of
  // actually saving. Passing `download` here makes Supabase Storage set
  // Content-Disposition: attachment with the real filename, which a
  // browser does honor regardless of origin.
  const { data: signed, error } = await db.storage
    .from(row.storage_bucket || CRM_STORAGE_BUCKET)
    .createSignedUrl(row.storage_path, 300, { download: row.file_name })
  if (error || !signed) return NextResponse.json({ error: "Failed to get a link" }, { status: 500 })

  return NextResponse.json({ url: signed.signedUrl })
}
