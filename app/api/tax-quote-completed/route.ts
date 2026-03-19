/**
 * POST /api/tax-quote-completed
 *
 * Called by the tax quote form frontend after the client submits.
 * 1. Creates a lead in the leads table
 * 2. Creates a draft offer with correct pricing/services based on LLC type
 * 3. Updates the submission with lead_id and offer_token
 * 4. Updates the lead with offer_link
 * 5. Sends notification email to support@
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint — only triggers internal notifications)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import {
  PRICING,
  LLC_TYPE_OPTIONS,
  FORM_DESCRIPTIONS,
  type LLCType,
} from "@/lib/types/tax-quote-form"

// Generic Whop plans (pre-created)
const WHOP_PLANS: Record<string, { url: string; amount: string }> = {
  single_member: { url: "https://whop.com/checkout/plan_LUcZX8dYn78m9", amount: "$1,050" },
  multi_member: { url: "https://whop.com/checkout/plan_LBegAh3B2Ex1R", amount: "$1,575" },
  c_corp: { url: "https://whop.com/checkout/plan_LBegAh3B2Ex1R", amount: "$1,575" },
}

function buildServiceIncludes(llcType: LLCType, lang: string): string[] {
  const base = lang === "it"
    ? [
        "Preparazione dichiarazione fiscale federale",
        "Filing di estensione (Aprile → Ottobre)",
        "Invio elettronico all'IRS",
        "Firma del consulente fiscale certificato",
        "Supporto raccolta dati",
      ]
    : [
        "Federal tax return preparation",
        "Extension filing (April → October)",
        "IRS e-filing",
        "Certified Tax Preparer signature",
        "Data gathering support",
      ]

  if (llcType === "multi_member") {
    base.push(lang === "it" ? "Schedule K-1 per ogni socio" : "Schedule K-1 distribution to all members")
  }

  return base
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { submission_id, token } = body as { submission_id?: string; token?: string }

    if (!submission_id || !token) {
      return NextResponse.json({ error: "submission_id and token required" }, { status: 400 })
    }

    // 1. Fetch completed submission
    const { data: sub, error: subErr } = await supabaseAdmin
      .from("tax_quote_submissions")
      .select("*")
      .eq("id", submission_id)
      .eq("token", token)
      .single()

    if (subErr || !sub) {
      return NextResponse.json({ error: "Submission not found" }, { status: 404 })
    }

    if (sub.status !== "completed") {
      return NextResponse.json({ error: "Form not completed" }, { status: 400 })
    }

    const results: { step: string; status: string; detail?: string }[] = []
    const llcType = sub.llc_type as LLCType
    const price = PRICING[llcType]
    const llcTypeLabel = LLC_TYPE_OPTIONS.find(o => o.value === llcType)?.[sub.language === "it" ? "it" : "en"] || llcType
    const formDesc = FORM_DESCRIPTIONS[llcType][sub.language === "it" ? "it" : "en"]

    // 2. Create lead
    let leadId: string | null = null
    try {
      const nameParts = (sub.client_name || "").split(/\s+/)
      const { data: lead, error: leadErr } = await supabaseAdmin
        .from("leads")
        .insert({
          full_name: sub.client_name,
          first_name: nameParts[0] || "",
          last_name: nameParts.slice(1).join(" ") || null,
          email: sub.client_email,
          phone: sub.client_phone || null,
          source: "Tax Quote Form",
          reason: `Tax Return ${sub.tax_year} - ${llcTypeLabel}`,
          channel: "Website",
          language: sub.language === "it" ? "Italian" : "English",
          status: "New",
          notes: `Auto-created from tax quote form.\nLLC: ${sub.llc_name}\nState: ${sub.llc_state}\nType: ${llcTypeLabel}\nTax Year: ${sub.tax_year}`,
        })
        .select("id")
        .single()

      if (leadErr) throw leadErr
      leadId = lead.id
      results.push({ step: "lead_created", status: "ok", detail: `Lead: ${leadId}` })
    } catch (e) {
      results.push({ step: "lead_created", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // 3. Create draft offer
    let offerToken: string | null = null
    let offerAccessCode: string | null = null
    try {
      const llcSlug = (sub.llc_name || "unknown")
        .toLowerCase()
        .replace(/\s*(llc|l\.l\.c\.?)\s*$/i, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+$/, "")
        .slice(0, 30)
      offerToken = `tax-${llcSlug}-${sub.tax_year}`

      // Check for existing offer with same token
      const { data: existingOffer } = await supabaseAdmin
        .from("offers")
        .select("token")
        .eq("token", offerToken)
        .maybeSingle()

      if (existingOffer) {
        // Append random suffix
        offerToken = `${offerToken}-${Math.random().toString(36).slice(2, 6)}`
      }

      const accessCode = crypto.randomUUID()
      const whopPlan = WHOP_PLANS[llcType] || WHOP_PLANS.single_member

      const introField = sub.language === "it" ? "intro_it" : "intro_en"
      const introText = sub.language === "it"
        ? `Gentile ${sub.client_name}, a seguito della tua richiesta, ecco la nostra proposta per il Tax Return ${sub.tax_year} della tua ${llcTypeLabel}, ${sub.llc_name}.`
        : `Hi ${sub.client_name}, following your request, here is our proposal for the ${sub.tax_year} Tax Return filing for your ${llcTypeLabel}, ${sub.llc_name}.`

      const serviceName = `Tax Return ${sub.tax_year}`
      const serviceDesc = sub.language === "it"
        ? `Preparazione e invio della dichiarazione fiscale per ${sub.llc_name} (${sub.llc_state}) — ${formDesc}`
        : `Tax return preparation and filing for ${sub.llc_name} (${sub.llc_state}) — ${formDesc}`

      const { error: offerErr } = await supabaseAdmin
        .from("offers")
        .insert({
          token: offerToken,
          access_code: accessCode,
          client_name: sub.client_name,
          client_email: sub.client_email,
          language: sub.language,
          offer_date: new Date().toISOString().split("T")[0],
          status: "draft",
          payment_type: "checkout",
          [introField]: introText,
          services: [{
            name: serviceName,
            price: `$${price.toLocaleString()}`,
            price_label: "one-time",
            description: serviceDesc,
            includes: buildServiceIncludes(llcType, sub.language),
            recommended: true,
          }],
          cost_summary: [{
            label: serviceName,
            items: [{ name: `${serviceName} (${formDesc})`, price: `$${price.toLocaleString()}` }],
            total: `$${price.toLocaleString()}`,
            total_label: "Total",
          }],
          immediate_actions: sub.language === "it"
            ? [
                { title: "Accetta e Paga", description: `Firma il contratto e procedi con il pagamento di $${price.toLocaleString()} tramite carta o bonifico.` },
                { title: "Compila il Modulo Tax", description: "Ti invieremo un modulo per raccogliere i dati della LLC e le informazioni finanziarie." },
                { title: "Pensiamo a Tutto Noi", description: "Presentiamo l'estensione e prepariamo il tuo tax return. Firmato dal nostro consulente fiscale certificato." },
              ]
            : [
                { title: "Accept & Pay", description: `Sign the contract and complete the payment of $${price.toLocaleString()} via card or bank transfer.` },
                { title: "Fill Tax Intake Form", description: "We will send you an online form to collect your LLC details and financial data for the tax year." },
                { title: "We Handle the Rest", description: "We file the extension and prepare your tax return. Signed by our Certified Tax Preparer." },
              ],
          next_steps: sub.language === "it"
            ? [
                { step_number: 1, title: "Rivedi e Accetta", description: "Rivedi questa proposta e firma il contratto in fondo alla pagina." },
                { step_number: 2, title: "Pagamento", description: `Paga $${price.toLocaleString()} con carta (link sotto) o bonifico. Iniziamo appena ricevuto il pagamento.` },
                { step_number: 3, title: "Compila il Modulo", description: "Ti inviamo il modulo per raccogliere tutte le informazioni sulla tua LLC." },
                { step_number: 4, title: "Estensione + Filing", description: "Presentiamo l'estensione e prepariamo il tuo tax return. Sei coperto e in regola con l'IRS." },
              ]
            : [
                { step_number: 1, title: "Review & Accept", description: "Review this proposal and sign the contract at the bottom of the page." },
                { step_number: 2, title: "Payment", description: `Pay $${price.toLocaleString()} via card (link below) or bank transfer. We start as soon as payment is received.` },
                { step_number: 3, title: "Fill Intake Form", description: "We send you the tax intake form to collect all necessary information about your LLC." },
                { step_number: 4, title: "Extension + Filing", description: "We file the extension and prepare your tax return. You are covered and compliant with the IRS." },
              ],
          payment_links: [{
            url: whopPlan.url,
            label: sub.language === "it" ? "Paga con Carta (+5%)" : "Pay with Card (+5%)",
            amount: whopPlan.amount,
          }],
          bank_details: {
            beneficiary: "TONY DURANTE L.L.C.",
            account_number: "200000306770",
            routing_number: "064209588",
            bank_name: "Relay Financial (Thread Bank)",
            amount: `$${price.toLocaleString()}`,
            reference: `Tax Return ${sub.tax_year} - ${sub.llc_name}`,
            beneficiary_address: "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
          },
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          lead_id: leadId,
          contract_type: "tax_return",
        })

      if (offerErr) throw offerErr
      offerAccessCode = accessCode
      results.push({ step: "offer_created", status: "ok", detail: `Offer: ${offerToken}` })
    } catch (e) {
      results.push({ step: "offer_created", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // 4. Update submission with lead_id and offer_token
    try {
      await supabaseAdmin
        .from("tax_quote_submissions")
        .update({
          lead_id: leadId,
          offer_token: offerToken,
          status: "processed",
          processed_at: new Date().toISOString(),
        })
        .eq("id", submission_id)
      results.push({ step: "submission_updated", status: "ok" })
    } catch (e) {
      results.push({ step: "submission_updated", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // 5. Update lead with offer link
    if (leadId && offerToken && offerAccessCode) {
      try {
        const offerUrl = `${APP_BASE_URL}/offer/${offerToken}/${offerAccessCode}`
        await supabaseAdmin
          .from("leads")
          .update({ offer_link: offerUrl, offer_status: "Draft" })
          .eq("id", leadId)
        results.push({ step: "lead_updated", status: "ok" })
      } catch (e) {
        results.push({ step: "lead_updated", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // 6. Email notification to support@
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const offerUrl = offerToken && offerAccessCode
        ? `${APP_BASE_URL}/offer/${offerToken}/${offerAccessCode}`
        : "N/A"

      const subject = `New Tax Quote: ${sub.llc_name} - ${llcTypeLabel} ($${price.toLocaleString()})`
      const emailBody = [
        `New tax return quote request received and processed:`,
        ``,
        `Client: ${sub.client_name} (${sub.client_email})`,
        `LLC: ${sub.llc_name} (${sub.llc_state})`,
        `Type: ${llcTypeLabel}`,
        `Tax Year: ${sub.tax_year}`,
        `Price: $${price.toLocaleString()}`,
        ``,
        `Auto-created:`,
        `- Lead: ${leadId || "FAILED"}`,
        `- Draft Offer: ${offerToken || "FAILED"}`,
        `- Offer URL: ${offerUrl}`,
        ``,
        `Next: Review offer with offer_get("${offerToken}"), adjust if needed, then offer_send("${offerToken}")`,
      ].join("\n")

      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
      const mimeHeaders = [
        `From: Tony Durante LLC <support@tonydurante.us>`,
        `To: support@tonydurante.us`,
        `Subject: ${encodedSubject}`,
        "MIME-Version: 1.0",
        `Content-Type: text/plain; charset=utf-8`,
        "Content-Transfer-Encoding: base64",
      ]
      const rawEmail = [...mimeHeaders, "", Buffer.from(emailBody).toString("base64")].join("\r\n")
      const encodedRaw = Buffer.from(rawEmail).toString("base64url")

      await gmailPost("/messages/send", { raw: encodedRaw })
      results.push({ step: "email_notification", status: "ok", detail: "Notified support@" })
    } catch (e) {
      results.push({ step: "email_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[tax-quote-completed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
