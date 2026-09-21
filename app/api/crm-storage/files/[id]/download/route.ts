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
    .select("storage_path, storage_bucket")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: "File not found" }, { status: 404 })

  const { data: signed, error } = await db.storage
    .from(row.storage_bucket || CRM_STORAGE_BUCKET)
    .createSignedUrl(row.storage_path, 300)
  if (error || !signed) return NextResponse.json({ error: "Failed to get a link" }, { status: 500 })

  return NextResponse.json({ url: signed.signedUrl })
}
