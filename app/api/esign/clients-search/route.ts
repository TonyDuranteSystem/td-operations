/**
 * GET /api/esign/clients-search?q=term — staff-only typeahead for picking a CRM
 * client as an e-sign signer. Matches contacts by NAME or by their COMPANY name
 * and returns the contact plus its primary filing account, so the editor can
 * link `contact_id` and auto-file the signed document into the client's records.
 *
 * Portal-vs-email delivery is NOT decided here — it's resolved at send time from
 * contact_id + a live portal-login check (see the send route). This endpoint just
 * surfaces candidates.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"

type ContactRow = { id: string; full_name: string | null; email: string | null }

export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? ""
  if (q.length < 2) return NextResponse.json({ clients: [] })
  const pattern = `%${q}%`

  // 1) Contacts matched directly by name or email. Two separate ilike queries
  //    (NOT a single `.or(...)`) so a comma/parenthesis in the search term can't
  //    break the PostgREST logic-tree parser — `.ilike` keeps the term as a
  //    parameterized value, not part of the filter grammar.
  const [{ data: byFullName }, { data: byEmail }] = await Promise.all([
    supabaseAdmin.from("contacts").select("id, full_name, email").ilike("full_name", pattern).limit(20),
    supabaseAdmin.from("contacts").select("id, full_name, email").ilike("email", pattern).limit(20),
  ])
  const byName = [...((byFullName ?? []) as ContactRow[]), ...((byEmail ?? []) as ContactRow[])]

  // 2) Contacts reached via a company-name match (accounts → account_contacts).
  let byCompany: ContactRow[] = []
  const { data: accts } = await supabaseAdmin
    .from("accounts")
    .select("id")
    .ilike("company_name", pattern)
    .limit(20)
  const acctIds = (accts ?? []).map((a: { id: string }) => a.id)
  if (acctIds.length) {
    const { data: links } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .in("account_id", acctIds)
    const cids = Array.from(new Set((links ?? []).map((l: { contact_id: string }) => l.contact_id)))
    if (cids.length) {
      const { data: cs } = await supabaseAdmin.from("contacts").select("id, full_name, email").in("id", cids)
      byCompany = (cs ?? []) as ContactRow[]
    }
  }

  // Union by contact id (cap the candidate set).
  const byId = new Map<string, ContactRow>()
  for (const c of [...((byName ?? []) as ContactRow[]), ...byCompany]) byId.set(c.id, c)
  const contactIds = Array.from(byId.keys()).slice(0, 25)
  if (!contactIds.length) return NextResponse.json({ clients: [] })

  // Enrich each contact with its primary (else first) account for filing/display.
  const { data: links2 } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, account_id, is_primary")
    .in("contact_id", contactIds)
  const allAcctIds = Array.from(new Set((links2 ?? []).map((l: { account_id: string }) => l.account_id)))
  const { data: acctNames } = allAcctIds.length
    ? await supabaseAdmin.from("accounts").select("id, company_name").in("id", allAcctIds)
    : { data: [] as Array<{ id: string; company_name: string | null }> }
  const acctName = new Map((acctNames ?? []).map((a: { id: string; company_name: string | null }) => [a.id, a.company_name]))

  const linkByContact = new Map<string, { account_id: string; is_primary: boolean }>()
  for (const l of (links2 ?? []) as Array<{ contact_id: string; account_id: string; is_primary: boolean | null }>) {
    const cur = linkByContact.get(l.contact_id)
    if (!cur || (l.is_primary && !cur.is_primary)) {
      linkByContact.set(l.contact_id, { account_id: l.account_id, is_primary: !!l.is_primary })
    }
  }

  const clients = contactIds.map(id => {
    const c = byId.get(id)!
    const link = linkByContact.get(id)
    return {
      contact_id: id,
      full_name: c.full_name ?? "",
      email: c.email ?? null,
      account_id: link?.account_id ?? null,
      company_name: link ? (acctName.get(link.account_id) ?? null) : null,
    }
  })

  // Sort: contacts with a name first, then alphabetically — stable for the combobox.
  clients.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""))
  return NextResponse.json({ clients })
}
