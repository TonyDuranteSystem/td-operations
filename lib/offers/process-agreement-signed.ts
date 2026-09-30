/**
 * What happens after a client signs their annual renewal agreement: flips the
 * agreement to signed and creates + sends the 1st-installment invoice. Moved out of
 * the /api/webhooks/agreement-signed route (N0, dev job f907220c) so the server-side
 * signing route runs it IN-PROCESS; the webhook route is a thin wrapper.
 *
 * Idempotent on renewal-1st:{account_id}:{agreement_year}.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { PORTAL_INSTALLMENT_PAYMENT_INSTRUCTION } from "@/lib/billing/installment-message"
import { PORTAL_AUDIENCE_TIERS } from "@/lib/portal/pay-token"

export interface AgreementSignedOutcome {
  status: number
  body: Record<string, unknown>
}

export async function processAgreementSigned(agreement_token: string): Promise<AgreementSignedOutcome> {
  try {

    if (!agreement_token) {
      return { status: 400, body: { error: "Missing agreement_token" } }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: agreement, error: agErr } = await (supabaseAdmin as any)
      .from("annual_agreements")
      .select("id, token, account_id, status, client_name, agreement_year")
      .eq("token", agreement_token)
      .single() as { data: { id: string; token: string; account_id: string | null; status: string; client_name: string | null; agreement_year: number } | null; error: unknown }

    if (agErr || !agreement) {
      return { status: 404, body: { error: "Agreement not found" } }
    }

    if (!agreement.account_id) {
      return { status: 400, body: { error: "Agreement has no account_id" } }
    }

    // Precondition: a `contracts` row must already exist for this token. The
    // renewal-agreement client component inserts the signed PDF + contracts
    // row BEFORE calling this webhook, so the contracts row is the
    // signature-of-record.
    //
    // Why not check `annual_agreements.status === 'signed'` (the prior
    // precondition)? Production RLS on `annual_agreements` allows reads but
    // NOT writes from the public anon role used by the contract page. So
    // the client-side `update({status:'signed'})` silently fails (RLS
    // filters the row), the agreement stays at 'draft', and the prior
    // precondition rejected every legitimate signing. Switching to the
    // contracts-existence check matches the actual signature-of-record
    // and works regardless of who can write annual_agreements.
    const { count: contractCount } = await supabaseAdmin
      .from("contracts")
      .select("id", { count: "exact", head: true })
      .eq("offer_token", agreement.token)
    if (!contractCount || contractCount === 0) {
      return { status: 403, body: { error: "No signed contract found for this agreement token" } }
    }

    // Flip annual_agreements to signed via service_role (bypasses RLS).
    // Idempotent — no-op if already signed/completed.
    if (agreement.status !== "signed" && agreement.status !== "completed") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any)
        .from("annual_agreements")
        .update({ status: "signed", signed_at: new Date().toISOString() })
        .eq("token", agreement_token)
    }

    const year: number = agreement.agreement_year
    const idempotencyKey = `renewal-1st:${agreement.account_id}:${year}`

    // Idempotency — skip if 1st installment already created for this year
    const { data: existingInvoice } = await supabaseAdmin
      .from("payments")
      .select("id, invoice_number")
      .eq("idempotency_key", idempotencyKey)
      .limit(1)
      .maybeSingle()

    if (existingInvoice) {
      return { status: 200, body: {
        ok: true,
        renewal: true,
        invoice_number: existingInvoice.invoice_number,
        idempotent: true,
      } }
    }

    // Get installment amounts from account
    const { data: account } = await supabaseAdmin
      .from("accounts")
      .select("id, company_name, installment_1_amount, entity_type, portal_tier")
      .eq("id", agreement.account_id as string)
      .single()

    if (!account) {
      return { status: 404, body: { error: "Account not found" } }
    }

    const isPortalAudience = !!(account.portal_tier && PORTAL_AUDIENCE_TIERS.has(account.portal_tier))
    const paymentInstruction = isPortalAudience
      ? PORTAL_INSTALLMENT_PAYMENT_INSTRUCTION
      : "Please remit payment by wire transfer."

    const entityUpper = (account.entity_type || "").toUpperCase()
    const amount: number =
      account.installment_1_amount ||
      (entityUpper.includes("MULTI") || entityUpper.includes("MMLLC") ? 1250 : 1000)

    // Get primary contact for the invoice
    const { data: contactLink } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id")
      .eq("account_id", account.id)
      .limit(1)
      .maybeSingle()

    const invoiceResult = await createTDInvoice({
      account_id: account.id,
      contact_id: contactLink?.contact_id || null,
      line_items: [
        {
          description: `1st Installment ${year} — LLC Annual Management`,
          unit_price: amount,
          quantity: 1,
        },
      ],
      currency: "USD",
      due_date: `${year}-01-31`,
      message: `First installment ${year} — LLC Annual Management.\n${paymentInstruction}`,
      idempotency_key: idempotencyKey,
      installment: "Installment 1 (Jan)",
      payment_category: "installment_1",
      year,
    })

    // Auto-send so "Pay Invoice" action item appears in portal immediately
    let sent = false
    try {
      const { autoSendInvoices } = await import("@/lib/invoice-auto-send")
      const results = await autoSendInvoices([invoiceResult.paymentId])
      sent = results[0]?.success ?? false
    } catch { /* non-blocking */ }

    await supabaseAdmin.from("action_log").insert({
      action_type: "agreement_signed",
      table_name: "payments",
      record_id: invoiceResult.paymentId,
      account_id: account.id,
      summary: `Annual agreement signed: ${agreement.client_name} — 1st installment ${year} invoice ${invoiceResult.invoiceNumber} created ($${amount})${sent ? " and sent" : " (send pending)"}`,
      details: {
        agreement_token,
        year,
        invoice_number: invoiceResult.invoiceNumber,
        amount,
        idempotency_key: idempotencyKey,
        sent,
      },
    })

    return { status: 200, body: {
      ok: true,
      renewal: true,
      invoice_number: invoiceResult.invoiceNumber,
      payment_id: invoiceResult.paymentId,
      amount,
      year,
      sent,
    } }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[agreement-signed]", msg)
    return { status: 500, body: { error: msg } }
  }
}
