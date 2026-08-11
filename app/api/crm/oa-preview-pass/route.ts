/**
 * GET /api/crm/oa-preview-pass?token=<oaToken>
 *
 * Mints a short-lived staff-preview pass so CRM staff can open the client OA page
 * on the client-facing host (where their dashboard session cookie does not exist)
 * without hitting the email gate — and without the bare `?preview=td` flag, which
 * no longer authenticates. A staff-preview pass also suppresses view tracking, so
 * a staff preview never looks like the client opened the document.
 *
 * Runs on the CRM host, where the staff session IS present — so it can prove staff
 * identity here (isDashboardUser) and hand back a 2-minute pass bound to this
 * agreement. The pass never authorizes signing (the pages still gate that on the
 * preview flag / !isAdmin).
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { signOaPass } from "@/lib/oa/portal-pass"

export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !isDashboardUser(data?.user ?? null)) {
    return NextResponse.json({ error: "Staff only" }, { status: 403 })
  }

  const token = new URL(req.url).searchParams.get("token")
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 })

  const { data: oa } = await supabaseAdmin
    .from("oa_agreements")
    .select("id, access_code")
    .eq("token", token)
    .maybeSingle()
  if (!oa) return NextResponse.json({ error: "Operating Agreement not found" }, { status: 404 })

  const pass = await signOaPass({ oaId: oa.id, kind: "staff_preview", sub: data!.user!.id })
  return NextResponse.json({ pass })
}
