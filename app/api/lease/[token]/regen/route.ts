/**
 * POST /api/lease/[token]/regen  { pdf_path }
 *
 * Replaces the client-side `supabasePublic.from('lease_agreements').update(...)`
 * that the admin "regenerate a clean copy" action used to write with the anon
 * key. STAFF-ONLY: this is an internal correction tool (re-render a signed
 * lease's PDF without the confirmation banner), never a client-facing action —
 * the caller must be a real staff session, not the bare `?preview=td` flag.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffPreview } from "@/lib/auth/staff-preview"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const body = await req.json().catch(() => ({}))
  const pdfPath = typeof body.pdf_path === "string" ? body.pdf_path : ""

  if (!pdfPath) {
    return NextResponse.json({ error: "pdf_path required" }, { status: 400 })
  }
  if (!pdfPath.startsWith(`${token}/`)) {
    return NextResponse.json({ error: "pdf_path does not match this lease" }, { status: 400 })
  }

  const isStaff = await isStaffPreview(true)
  if (!isStaff) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }

  const { data: lease } = await db
    .from("lease_agreements")
    .select("id")
    .eq("token", token)
    .maybeSingle()
  if (!lease) {
    return NextResponse.json({ error: "Lease not found." }, { status: 404 })
  }

  const { error } = await db
    .from("lease_agreements")
    .update({ pdf_storage_path: pdfPath })
    .eq("id", lease.id)
  if (error) return NextResponse.json({ error: "Failed to update lease" }, { status: 500 })

  return NextResponse.json({ ok: true })
}
