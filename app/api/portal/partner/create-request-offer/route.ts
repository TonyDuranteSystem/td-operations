/**
 * POST /api/portal/partner/create-request-offer
 *
 * Phase 3A — Partner-driven offer creation.
 *
 * Called when a partner submits a service request via /portal/partner/new-request.
 * Creates a DRAFT offer wired with partner_id + per-transaction overrides
 * (invoice_target / agreed_price / payout_model / payout_rate).
 *
 * The offer is NOT auto-sent — Antonio/Luca review in the CRM and click
 * "Send" via existing offer admin actions. Returns offer_url so the new
 * CRM task description can deep-link to it.
 *
 * Authorization: any authenticated client user can call, but the body must
 * carry a partner_id whose contact_id matches the authenticated user.
 */
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isClient, getClientContactId } from "@/lib/portal-auth"
import { createOffer, type CreateOfferParams } from "@/lib/operations/offers"

export const dynamic = "force-dynamic"

type ServiceSlug =
  | "llc_formation" | "tax_return" | "itin" | "ein"
  | "banking" | "shipping" | "notary" | "closure" | "consulting"

type ContractType = "formation" | "onboarding" | "tax_return" | "itin" | "closure"

// Map service slug → (contract_type, bundled_pipelines).
// Defaults are best-effort for the draft offer; Antonio/Luca can adjust in
// the CRM before sending. Unknown service types fall back to formation +
// empty pipelines so the offer still creates.
const SLUG_DEFAULTS: Record<ServiceSlug, { contract_type: ContractType; bundled_pipelines: string[] }> = {
  llc_formation: { contract_type: "formation",   bundled_pipelines: ["Company Formation"] },
  tax_return:    { contract_type: "tax_return",  bundled_pipelines: ["Tax Return"] },
  itin:          { contract_type: "itin",        bundled_pipelines: ["ITIN"] },
  ein:           { contract_type: "formation",   bundled_pipelines: ["EIN"] },
  banking:       { contract_type: "formation",   bundled_pipelines: ["Banking Fintech"] },
  shipping:      { contract_type: "formation",   bundled_pipelines: [] },
  notary:        { contract_type: "formation",   bundled_pipelines: [] },
  closure:       { contract_type: "closure",     bundled_pipelines: ["Company Closure"] },
  consulting:    { contract_type: "formation",   bundled_pipelines: [] },
}

interface Body {
  service_slug: string
  service_label: string
  // Partner-side context
  partner_id: string
  // Client (one of these is required)
  account_id?: string | null
  end_client_name?: string | null
  end_client_email?: string | null
  // Per-transaction overrides (optional — fall back to partner defaults)
  override_invoice_target?: "partner" | "end_client" | null
  override_agreed_price?: number | null
  override_payout_model?: "none" | "price_difference" | "percentage" | "flat_fee" | "credit_note" | null
  override_payout_rate?: number | null
  // Free-form context for the draft
  details?: string | null
  urgency?: "normal" | "urgent" | null
  language?: "en" | "it"
}

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !isClient(user)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const callerContactId = getClientContactId(user)
    if (!callerContactId) {
      return NextResponse.json({ error: "No contact linked to user" }, { status: 401 })
    }

    const body = (await req.json()) as Body
    if (!body.service_slug || !body.partner_id) {
      return NextResponse.json({ error: "service_slug and partner_id are required" }, { status: 400 })
    }

    // Authorize: caller must be the partner's primary contact.
    const { data: partner, error: pErr } = await supabaseAdmin
      .from("client_partners")
      .select("id, partner_name, contact_id, default_invoice_target, default_payout_model, default_payout_rate, status")
      .eq("id", body.partner_id)
      .single()

    if (pErr || !partner) {
      return NextResponse.json({ error: "Partner not found" }, { status: 404 })
    }
    if (partner.contact_id !== callerContactId) {
      return NextResponse.json({ error: "Caller is not this partner's primary contact" }, { status: 403 })
    }
    if (partner.status === "inactive" || partner.status === "suspended") {
      return NextResponse.json({ error: `Partner is ${partner.status}` }, { status: 403 })
    }

    // Resolve invoice_target (per-txn override → partner default).
    const invoiceTarget = (body.override_invoice_target ?? partner.default_invoice_target ?? "partner") as
      "partner" | "end_client"

    // Resolve payout config (per-txn override → partner default).
    const payoutModel = (body.override_payout_model ?? partner.default_payout_model ?? "none") as
      "none" | "price_difference" | "percentage" | "flat_fee" | "credit_note"
    const payoutRate = body.override_payout_rate ?? partner.default_payout_rate ?? null

    // Resolve the offer's billable contact:
    //  - invoice_target='partner'    → partner's contact_id (the partner pays TD)
    //  - invoice_target='end_client' → end client's contact_id (TD invoices the end client directly)
    let billableContactId: string | null = null
    let billableName = ""
    let billableEmail: string | null = null
    const resolvedAccountId: string | null = body.account_id ?? null

    if (invoiceTarget === "partner") {
      billableContactId = partner.contact_id
      const { data: pc } = await supabaseAdmin
        .from("contacts")
        .select("full_name, email")
        .eq("id", partner.contact_id)
        .single()
      billableName = pc?.full_name || partner.partner_name || "Partner"
      billableEmail = pc?.email ?? null
    } else {
      // end_client: prefer existing account → its primary contact; else use end_client_name/email
      if (body.account_id) {
        // Verify the account is managed by this partner (defense-in-depth).
        const { data: acct } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, partner_id")
          .eq("id", body.account_id)
          .single()
        if (!acct || acct.partner_id !== partner.id) {
          return NextResponse.json({ error: "Account not managed by this partner" }, { status: 403 })
        }
        billableName = acct.company_name || body.end_client_name || "End Client"

        const { data: link } = await supabaseAdmin
          .from("account_contacts")
          .select("contact_id, contacts(full_name, email)")
          .eq("account_id", body.account_id)
          .limit(1)
          .maybeSingle()
        if (link?.contact_id) {
          billableContactId = link.contact_id
          const c = (link as unknown as { contacts: { full_name: string; email: string } | null }).contacts
          billableEmail = c?.email ?? null
        }
      } else {
        // New end client: create a minimal contact (mirrors service-request/route.ts pattern).
        const newName = body.end_client_name?.trim()
        if (!newName) {
          return NextResponse.json({ error: "end_client_name is required for new clients with invoice_target='end_client'" }, { status: 400 })
        }
        billableName = newName
        billableEmail = body.end_client_email?.trim() || null

        if (billableEmail) {
          const { data: existing } = await supabaseAdmin
            .from("contacts")
            .select("id")
            .ilike("email", billableEmail)
            .limit(1)
            .maybeSingle()
          if (existing?.id) {
            billableContactId = existing.id
          }
        }

        if (!billableContactId) {
          // Minimal contact insert. R093: every column verified — full_name + email + language
          // are confirmed-present on contacts schema. is_partner left default (false).
          // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.insert; extract to lib/operations/ per dev_task fda76fd3
          const { data: newContact, error: cErr } = await supabaseAdmin
            .from("contacts")
            .insert({
              full_name: newName,
              email: billableEmail,
              language: body.language === "it" ? "it" : "en",
            })
            .select("id")
            .single()
          if (cErr || !newContact) {
            return NextResponse.json({ error: `Failed to create end-client contact: ${cErr?.message}` }, { status: 500 })
          }
          billableContactId = newContact.id
        }
      }
    }

    // Defaults map for service slug → contract_type + bundled_pipelines.
    const slugDefaults = SLUG_DEFAULTS[body.service_slug as ServiceSlug] ?? {
      contract_type: "formation" as ContractType,
      bundled_pipelines: [] as string[],
    }

    // Build a minimal services + cost_summary payload. Antonio fills in real
    // pricing in the CRM before sending — agreed_price (if provided) seeds the
    // total so the draft is not blank.
    const seedPrice = body.override_agreed_price ?? null
    const currency: "EUR" | "USD" = "EUR"
    const seedTotal = seedPrice != null ? `€${seedPrice}` : ""
    const services = [{
      name: body.service_label,
      pipeline_type: slugDefaults.bundled_pipelines[0] || null,
      price: seedTotal,
      slug: body.service_slug,
      contract_type: slugDefaults.contract_type,
    }]
    const cost_summary = [{
      title: body.service_label,
      total: seedTotal,
      currency,
    }]

    const adminNotes = [
      `Partner request: ${partner.partner_name}`,
      `Invoice target: ${invoiceTarget}`,
      `Payout model: ${payoutModel}${payoutRate != null ? ` (rate: ${payoutRate})` : ""}`,
      body.urgency === "urgent" ? "Urgency: URGENT" : null,
      body.details ? `\nPartner notes:\n${body.details}` : null,
    ].filter(Boolean).join("\n")

    const params: CreateOfferParams = {
      client_name: billableName,
      client_email: billableEmail,
      language: body.language || "en",
      contract_type: slugDefaults.contract_type,
      payment_type: "bank_transfer",
      currency,
      services,
      cost_summary,
      bundled_pipelines: slugDefaults.bundled_pipelines,
      contact_id: billableContactId,
      account_id: resolvedAccountId,
      partner_id: partner.id,
      partner_invoice_target: invoiceTarget,
      partner_agreed_price: body.override_agreed_price ?? null,
      partner_payout_model: payoutModel,
      partner_payout_rate: payoutRate,
      admin_notes: adminNotes,
      source: "partner-portal",
      actor: `partner:${partner.id}`,
    }

    const result = await createOffer(params)

    if (result.outcome === "duplicate_blocked") {
      // Surface the existing token so the CRM task can link to it instead
      // of erroring out the partner's request submission.
      return NextResponse.json({
        success: true,
        deduped: true,
        token: result.duplicate?.token,
        message: `Existing active offer ${result.duplicate?.token}; new draft not created.`,
      })
    }
    if (!result.success) {
      return NextResponse.json({ error: result.error || "Offer creation failed" }, { status: 500 })
    }

    // A partner-sourced offer goes to a real end client, so a credit they are
    // owed matters exactly as much here as on the CRM path. This route used to
    // discard the warnings — the third consumer of a contract written for two.
    if ((result.warnings ?? []).length > 0) {
      try {
        const { reportSystemError } = await import('@/lib/system-errors')
        await reportSystemError({
          source: 'server',
          route: '/api/portal/partner/create-request-offer',
          message: `Partner-requested offer created with unresolved credit warnings — ${(result.warnings ?? []).join(' | ')}`,
          context: { token: result.token, partner_id: partner.id },
        })
      } catch { /* a notice must never fail the request */ }
    }

    return NextResponse.json({
      success: true,
      token: result.token,
      offer_url: result.offer_url,
      partner_id: partner.id,
      invoice_target: invoiceTarget,
      payout_model: payoutModel,
      warnings: result.warnings ?? [],
    })
  } catch (err) {
    console.error("[create-request-offer] Error:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    )
  }
}
