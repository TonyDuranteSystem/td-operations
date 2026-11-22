/**
 * GET /api/finance/bill-to-options?payment_id=…&q=…
 *
 * Everything the Finance "Bill to" dialog needs for ONE invoice (dev job e62bc2b6):
 * where it is billed now, the person's saved payers, the companies the person is
 * linked to, and (when `q` has 2+ letters) any company in the CRM by name — the
 * "payer is a company that is already our client" case. Also says whether the
 * invoice may move to another company. Staff only. Read-only.
 */
import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { companyMoveBlockedReason, lastBillToChangeWasByClient, BILL_TO_EDITABLE_STATUSES } from "@/lib/invoices/bill-to-change"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: Request) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const url = new URL(req.url)
  const paymentId = url.searchParams.get("payment_id") ?? ""
  if (!UUID.test(paymentId)) return NextResponse.json({ error: "Invalid payment_id" }, { status: 400 })
  // Typed text goes into an ilike pattern: keep letters (incl. accents), numbers, spaces and a few name marks only.
  const q = (url.searchParams.get("q") ?? "").replace(/[^A-Za-z0-9\u00C0-\u024F .&'-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60)

  const { data: pay } = await supabaseAdmin
    .from("payments")
    .select("id, invoice_number, invoice_status, total, account_id, contact_id, billing_entity_id, payment_category, installment, notes")
    .eq("id", paymentId)
    .maybeSingle()
  if (!pay) return NextResponse.json({ error: "Invoice not found" }, { status: 404 })

  const { data: creditNoteRows } = await supabaseAdmin
    .from("payments")
    .select("id")
    .eq("credit_for_payment_id", pay.id)
    .limit(1)
  const creditNotes = creditNoteRows?.length ?? 0

  // The person the payers hang on: the invoice's own contact, else its company's owner.
  let personId = pay.contact_id
  if (!personId && pay.account_id) {
    const { data: links } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id, role")
      .eq("account_id", pay.account_id)
      .is("access_revoked_at", null)
      .limit(10)
    const rows = (links ?? []) as Array<{ contact_id: string; role: string | null }>
    personId = (rows.find((l) => l.role?.toLowerCase().includes("owner")) ?? rows[0])?.contact_id ?? null
  }

  const companies = new Map<string, string>()
  let entities: Array<{ id: string; name: string }> = []
  let personName: string | null = null
  if (personId) {
    const { data: c } = await supabaseAdmin.from("contacts").select("full_name").eq("id", personId).maybeSingle()
    personName = (c?.full_name as string | null) ?? null
    const { data: links } = await supabaseAdmin.from("account_contacts").select("account_id, accounts(company_name)").eq("contact_id", personId)
    for (const l of (links ?? []) as Array<{ account_id: string; accounts: { company_name: string | null } | null }>) {
      companies.set(l.account_id, l.accounts?.company_name ?? "Company")
    }
    const { data: be } = await supabaseAdmin.from("billing_entities").select("id, entity_name").eq("contact_id", personId).order("entity_name")
    entities = (be ?? []).map((r) => ({ id: r.id, name: r.entity_name }))
  }

  let matches: Array<{ id: string; name: string }> = []
  if (q.length >= 2) {
    const { data: found } = await supabaseAdmin
      .from("accounts")
      .select("id, company_name")
      .ilike("company_name", `%${q}%`)
      .order("company_name")
      .limit(8)
    matches = (found ?? []).map((a) => ({ id: a.id, name: a.company_name ?? "Company" }))
  }

  // Current Bill To, for display.
  let currentLabel = personName ?? "—"
  let currentKind: "person" | "company" | "payer" = "person"
  if (pay.billing_entity_id) {
    const { data: be } = await supabaseAdmin.from("billing_entities").select("entity_name").eq("id", pay.billing_entity_id).maybeSingle()
    if (be?.entity_name) { currentLabel = be.entity_name; currentKind = "payer" }
  } else if (pay.account_id) {
    const { data: a } = await supabaseAdmin.from("accounts").select("company_name").eq("id", pay.account_id).maybeSingle()
    if (a?.company_name) { currentLabel = a.company_name; currentKind = "company" }
  }

  const status = pay.invoice_status
  const editable = Boolean(status && (BILL_TO_EDITABLE_STATUSES as readonly string[]).includes(status)) && Number(pay.total ?? 0) >= 0
  const moveBlocked = companyMoveBlockedReason(
    {
      invoice_status: pay.invoice_status,
      total: pay.total === null ? null : Number(pay.total),
      account_id: pay.account_id,
      contact_id: pay.contact_id,
      billing_entity_id: pay.billing_entity_id,
      payment_category: pay.payment_category,
      installment: pay.installment,
    },
    creditNotes,
  )

  return NextResponse.json({
    invoiceNumber: pay.invoice_number,
    status,
    editable,
    current: { label: currentLabel, kind: currentKind, accountId: pay.account_id, billingEntityId: pay.billing_entity_id },
    clientNamedPayer: lastBillToChangeWasByClient(pay.notes),
    personName,
    hasPerson: Boolean(pay.contact_id),
    canAttachPayer: Boolean(personId),
    companyMoveBlockedReason: moveBlocked,
    companies: Array.from(companies, ([id, name]) => ({ id, name })),
    entities,
    matches,
  })
}
