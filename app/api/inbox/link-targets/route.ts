import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

export interface LinkTarget {
  type: "account" | "contact" | "lead" | "partner"
  id: string
  name: string
  detail?: string
}

/**
 * GET /api/inbox/link-targets?q=… — search every linkable role for the
 * inbox "Link to client" dialog: accounts, contacts, leads, partners.
 */
export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const q = req.nextUrl.searchParams.get("q")?.trim()
  if (!q || q.length < 2) return NextResponse.json({ targets: [] })
  const like = `%${q}%`

  try {
    const [accounts, contacts, leads, partners] = await Promise.all([
      supabaseAdmin
        .from("accounts")
        .select("id, company_name")
        .ilike("company_name", like)
        .limit(6),
      supabaseAdmin
        .from("contacts")
        .select("id, full_name, email")
        .or(`full_name.ilike.${like},email.ilike.${like}`)
        .limit(6),
      supabaseAdmin
        .from("leads")
        .select("id, full_name, email")
        .or(`full_name.ilike.${like},email.ilike.${like}`)
        .limit(6),
      supabaseAdmin
        .from("client_partners")
        .select("id, partner_name")
        .ilike("partner_name", like)
        .limit(6),
    ])

    const targets: LinkTarget[] = [
      ...(accounts.data ?? []).map((a) => ({
        type: "account" as const,
        id: a.id,
        name: a.company_name,
      })),
      ...(contacts.data ?? []).map((c) => ({
        type: "contact" as const,
        id: c.id,
        name: c.full_name ?? c.email ?? c.id,
        detail: c.email ?? undefined,
      })),
      ...(leads.data ?? []).map((l) => ({
        type: "lead" as const,
        id: l.id,
        name: l.full_name ?? l.email ?? l.id,
        detail: l.email ?? undefined,
      })),
      ...(partners.data ?? []).map((p) => ({
        type: "partner" as const,
        id: p.id,
        name: p.partner_name,
      })),
    ]

    return NextResponse.json({ targets: targets.slice(0, 16) })
  } catch (error) {
    console.error("link-targets search error:", error)
    return NextResponse.json({ error: "Search failed" }, { status: 500 })
  }
}
