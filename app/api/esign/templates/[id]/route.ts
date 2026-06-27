/**
 * GET /api/esign/templates/[id] — template detail for instantiation (staff):
 * a short-lived signed PDF URL + the field layout + signer role count.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { getEsignTemplate } from "@/lib/operations/esign"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })

  const { id } = await params
  const tpl = await getEsignTemplate(id)
  if (!tpl) return NextResponse.json({ error: "Template not found" }, { status: 404 })
  return NextResponse.json(tpl)
}
