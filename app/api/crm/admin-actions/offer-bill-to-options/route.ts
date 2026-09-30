/**
 * GET /api/crm/admin-actions/offer-bill-to-options?contact_id=…&account_id=…
 *
 * Options for "Invoice to" on the Create Offer dialog (workspace-only plan S1,
 * 2026-09-27): the companies this person is linked to, plus their saved
 * billing entities. Staff only. Read-only.
 */
import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: Request) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const url = new URL(req.url)
  const contactId = url.searchParams.get("contact_id")
  const accountId = url.searchParams.get("account_id")
  if (contactId && !UUID.test(contactId)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 })
  if (accountId && !UUID.test(accountId)) return NextResponse.json({ error: "Invalid account_id" }, { status: 400 })

  const companies = new Map<string, string>()
  if (accountId) {
    const { data } = await supabaseAdmin.from("accounts").select("id, company_name").eq("id", accountId).maybeSingle()
    if (data) companies.set(data.id, data.company_name ?? "Company")
  }
  let entities: Array<{ id: string; name: string }> = []
  // The person's own name — the "(person)" choice must never be labelled with a
  // company's name (on a company page the client name defaults to the company).
  let personName: string | null = null
  if (contactId) {
    const { data: c } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contactId).maybeSingle()
    personName = (c?.full_name as string | null) ?? null
  }
  if (contactId) {
    const { data: links } = await supabaseAdmin
      .from("account_contacts")
      .select("account_id, accounts(company_name)")
      .eq("contact_id", contactId)
    for (const l of (links ?? []) as Array<{ account_id: string; accounts: { company_name: string | null } | null }>) {
      if (!companies.has(l.account_id)) companies.set(l.account_id, l.accounts?.company_name ?? "Company")
    }
    const { data: be } = await supabaseAdmin
      .from("billing_entities")
      .select("id, entity_name")
      .eq("contact_id", contactId)
      .order("entity_name")
    entities = (be ?? []).map((r) => ({ id: r.id, name: r.entity_name }))
  }

  return NextResponse.json({
    companies: Array.from(companies, ([id, name]) => ({ id, name })),
    entities,
    personName,
  })
}
