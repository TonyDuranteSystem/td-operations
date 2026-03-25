/**
 * Activate Service — Universal Post-Payment Automation
 *
 * Triggered when payment is confirmed (Whop webhook or wire cron).
 * Handles ALL contract types: formation, onboarding, tax_return, itin.
 *
 * Steps:
 *   1.   Lead → Contact (AUTO)
 *   1.5  Ensure minimal account for formation/onboarding (AUTO)
 *   2.   Create service deliveries from bundled_pipelines (AUTO)
 *   2b.  Portal tier upgrade: lead → onboarding (AUTO)
 *   2c.  Auto-create portal user + welcome email (AUTO)
 *   3.   CRM Invoice + QB sync (AUTO — replaces old direct QB creation)
 *   4.   Send appropriate data collection form based on contract_type (SUPERVISED)
 *
 * Supervised steps saved in prepared_steps JSONB.
 * Claude confirms via MCP before execution.
 * After 5 successful confirmations → auto mode.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { ensureMinimalAccount, autoCreatePortalUser, sendPortalWelcomeEmail } from "@/lib/portal/auto-create"
import { generateInvoiceNumber } from "@/lib/invoice-number"
import { syncInvoiceToQB, syncPaymentToQB } from "@/lib/qb-sync"
import { createPortalNotification } from "@/lib/portal/notifications"

const AUTO_THRESHOLD = 5

interface PreparedStep {
  step: string
  action: string
  description: string
  params: Record<string, unknown>
  status: "pending" | "confirmed" | "executed" | "skipped"
}

// Map contract_type → form table + form action
const FORM_CONFIG: Record<string, {
  table: string
  leadIdField: string
  action: string
  formName: string
}> = {
  formation: {
    table: "formation_submissions",
    leadIdField: "lead_id",
    action: "formation_form_create + gmail_send",
    formName: "formation data collection form",
  },
  onboarding: {
    table: "onboarding_submissions",
    leadIdField: "lead_id",
    action: "onboarding_form_create + gmail_send",
    formName: "onboarding data collection form",
  },
  tax_return: {
    table: "tax_return_submissions",
    leadIdField: "lead_id",
    action: "tax_form_create + gmail_send",
    formName: "tax data collection form",
  },
  itin: {
    table: "itin_submissions",
    leadIdField: "lead_id",
    action: "itin_form_create + gmail_send",
    formName: "ITIN data collection form",
  },
}

export async function POST(req: NextRequest) {
  try {
    // Auth check
    const authHeader = req.headers.get("authorization")
    const token = authHeader?.replace("Bearer ", "")
    if (token !== process.env.API_SECRET_TOKEN) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await req.json()
    const { pending_activation_id } = body

    if (!pending_activation_id) {
      return NextResponse.json({ error: "Missing pending_activation_id" }, { status: 400 })
    }

    // Get pending activation
    const { data: activation, error: actErr } = await supabase
      .from("pending_activations")
      .select("*")
      .eq("id", pending_activation_id)
      .single()

    if (actErr || !activation) {
      return NextResponse.json({ error: "Activation not found" }, { status: 404 })
    }

    if (activation.status === "activated") {
      return NextResponse.json({ ok: true, message: "Already activated" })
    }

    // Get the offer to determine contract_type and bundled_pipelines
    const { data: offer } = await supabase
      .from("offers")
      .select("contract_type, bundled_pipelines, account_id, selected_services, services")
      .eq("token", activation.offer_token)
      .single()

    const contractType = offer?.contract_type || "formation"

    // Check auto mode threshold
    const { count: successCount } = await supabase
      .from("action_log")
      .select("*", { count: "exact", head: true })
      .eq("action_type", "service_activation_confirmed")

    const isAutoMode = (successCount || 0) >= AUTO_THRESHOLD

    const steps: Array<{ step: string; status: string; detail?: string }> = []
    const preparedSteps: PreparedStep[] = []

    // ─── STEP 1: Lead → Contact (AUTOMATIC) ─────────────────
    let contactId: string | null = null
    let leadId = activation.lead_id

    if (leadId) {
      const { data: lead } = await supabase
        .from("leads")
        .select("*")
        .eq("id", leadId)
        .single()

      if (lead) {
        const { data: existingContact } = await supabase
          .from("contacts")
          .select("id")
          .ilike("email", lead.email || "")
          .limit(1)

        if (existingContact && existingContact.length > 0) {
          contactId = existingContact[0].id
          steps.push({ step: "lead_to_contact", status: "existing", detail: `Contact exists: ${contactId}` })
        } else {
          const { data: newContact, error: cErr } = await supabase
            .from("contacts")
            .insert({
              full_name: lead.full_name,
              email: lead.email,
              phone: lead.phone,
              language: lead.language === "Italian" ? "it" : "en",
              role: "Owner",
            })
            .select()
            .single()

          if (newContact) {
            contactId = newContact.id
            steps.push({ step: "lead_to_contact", status: "created", detail: `Contact created: ${contactId}` })
          } else {
            steps.push({ step: "lead_to_contact", status: "error", detail: cErr?.message })
          }
        }
      }
    } else if (activation.client_email) {
      // Try to find lead by email
      const { data: leads } = await supabase
        .from("leads")
        .select("*")
        .ilike("email", activation.client_email)
        .limit(1)

      if (leads && leads.length > 0) {
        leadId = leads[0].id
        const { data: existingContact } = await supabase
          .from("contacts")
          .select("id")
          .ilike("email", leads[0].email || "")
          .limit(1)

        if (existingContact && existingContact.length > 0) {
          contactId = existingContact[0].id
        } else {
          const { data: newContact } = await supabase
            .from("contacts")
            .insert({
              full_name: leads[0].full_name,
              email: leads[0].email,
              phone: leads[0].phone,
              language: leads[0].language === "Italian" ? "it" : "en",
              role: "Owner",
            })
            .select()
            .single()
          if (newContact) contactId = newContact.id
        }
        steps.push({ step: "lead_to_contact", status: "ok", detail: `Lead found by email, contact: ${contactId}` })
      } else {
        steps.push({ step: "lead_to_contact", status: "skipped", detail: "No lead found" })
      }
    }

    // ─── STEP 1.5: Ensure Minimal Account (AUTO, formation/onboarding) ──
    let autoAccountId: string | null = offer?.account_id || null

    if (!autoAccountId && contactId && (contractType === "formation" || contractType === "onboarding")) {
      const accountResult = await ensureMinimalAccount({
        contactId,
        clientName: activation.client_name,
        contractType,
        offerToken: activation.offer_token,
        leadId: leadId || undefined,
      })
      if (accountResult.accountId) {
        autoAccountId = accountResult.accountId
        steps.push({
          step: "ensure_account",
          status: accountResult.created ? "created" : "existing",
          detail: `Account ${accountResult.accountId.slice(0, 8)} (${accountResult.created ? "auto-created" : "already linked"})`,
        })
      } else {
        steps.push({ step: "ensure_account", status: "error", detail: accountResult.error })
      }
    } else if (!autoAccountId && leadId) {
      // For other contract types, try to resolve from lead
      const { data: lead } = await supabase.from("leads").select("account_id").eq("id", leadId).maybeSingle()
      autoAccountId = lead?.account_id || null
    }

    // ─── STEP 2: Service Deliveries from bundled_pipelines (AUTO) ─────
    const sdResults: Array<{ pipeline: string; status: string; id?: string }> = []
    const pipelines: string[] = Array.isArray(offer?.bundled_pipelines) ? offer.bundled_pipelines : []

    if (pipelines.length > 0) {
      // Get first pipeline stage for each type
      const { data: allStages } = await supabase
        .from("pipeline_stages")
        .select("service_type, stage_name, stage_order")
        .in("service_type", pipelines)
        .order("stage_order", { ascending: true })

      const firstStage = new Map<string, string>()
      if (allStages) {
        for (const s of allStages) {
          if (!firstStage.has(s.service_type)) firstStage.set(s.service_type, s.stage_name)
        }
      }

      // Use autoAccountId (may have been created in Step 1.5)
      const accountId = autoAccountId

      for (const pipeline of pipelines) {
        try {
          // Check if service delivery already exists for this offer + pipeline
          const { data: existingSd } = await supabase
            .from("service_deliveries")
            .select("id")
            .eq("service_type", pipeline)
            .ilike("notes", `%${activation.offer_token}%`)
            .limit(1)

          if (existingSd && existingSd.length > 0) {
            sdResults.push({ pipeline, status: "existing", id: existingSd[0].id })
            continue
          }

          const stage = firstStage.get(pipeline) || "Pending"
          const { data: sd, error: sdErr } = await supabase
            .from("service_deliveries")
            .insert({
              service_type: pipeline,
              service_name: `${pipeline} - ${activation.client_name}`,
              account_id: accountId,
              contact_id: contactId,
              current_stage: stage,
              status: "active",
              assigned_to: "Luca",
              notes: `Auto-created from offer ${activation.offer_token}`,
            })
            .select("id")
            .single()

          if (sdErr) {
            sdResults.push({ pipeline, status: "error", id: sdErr.message })
          } else {
            sdResults.push({ pipeline, status: "created", id: sd?.id })
          }
        } catch (e) {
          sdResults.push({ pipeline, status: "error", id: e instanceof Error ? e.message : String(e) })
        }
      }

      const created = sdResults.filter(r => r.status === "created").length
      const existing = sdResults.filter(r => r.status === "existing").length
      steps.push({
        step: "service_deliveries",
        status: "done",
        detail: `${created} created, ${existing} existing, ${sdResults.length} total from bundled_pipelines`,
      })
    } else {
      steps.push({ step: "service_deliveries", status: "skipped", detail: "No bundled_pipelines on offer" })
    }

    // ─── STEP 2b: Portal tier upgrade (AUTO) ─────────────────
    // Upgrade portal tier from lead → onboarding after payment
    if (autoAccountId) {
      await supabase
        .from("accounts")
        .update({ portal_tier: "onboarding", updated_at: new Date().toISOString() })
        .eq("id", autoAccountId)
        .in("portal_tier", ["lead"])
      steps.push({ step: "portal_tier_upgrade", status: "done", detail: `lead → onboarding` })
    } else {
      steps.push({ step: "portal_tier_upgrade", status: "skipped", detail: "No account linked" })
    }

    // ─── STEP 2c: Auto-create portal user + welcome email (AUTO) ──────
    if (contactId) {
      const portalResult = await autoCreatePortalUser({
        contactId,
        accountId: autoAccountId || undefined,
        tier: "onboarding",
      })

      if (portalResult.success && !portalResult.alreadyExists && portalResult.tempPassword && portalResult.email) {
        // New user created — send welcome email
        const { data: contact } = await supabase
          .from("contacts")
          .select("language")
          .eq("id", contactId)
          .single()

        const lang = contact?.language === "Italian" || contact?.language === "it" ? "it" : "en"
        const emailResult = await sendPortalWelcomeEmail({
          email: portalResult.email,
          fullName: activation.client_name,
          tempPassword: portalResult.tempPassword,
          language: lang,
        })

        steps.push({
          step: "portal_user",
          status: "created",
          detail: `Auth user created for ${portalResult.email}. Welcome email: ${emailResult.success ? "sent" : emailResult.error}`,
        })
      } else if (portalResult.alreadyExists) {
        steps.push({ step: "portal_user", status: "existing", detail: `Portal user already exists: ${portalResult.email}` })
      } else if (!portalResult.success) {
        steps.push({ step: "portal_user", status: "error", detail: portalResult.error })
      }

      // Push notification: new service ready
      if (autoAccountId && pipelines.length > 0) {
        createPortalNotification({
          account_id: autoAccountId,
          contact_id: contactId || undefined,
          type: "service",
          title: "Welcome! Your service is being set up",
          body: `We're preparing your ${pipelines[0]} service. Check the portal for next steps.`,
          link: "/portal",
        }).catch(() => {})
      }
    } else {
      steps.push({ step: "portal_user", status: "skipped", detail: "No contact_id available" })
    }

    // ─── STEP 3: CRM Invoice + QB Sync (AUTO) ──────────────
    // Create invoice in CRM (SOT), mark as paid, sync to QB
    if (autoAccountId && activation.amount) {
      try {
        const invoiceNumber = await generateInvoiceNumber()
        const today = new Date().toISOString().split("T")[0]
        const amount = Number(activation.amount)

        // Create CRM invoice (directly via supabase, not server action which needs browser session)
        const { data: invoice, error: invErr } = await supabase
          .from("payments")
          .insert({
            account_id: autoAccountId,
            description: `${contractType === "formation" ? "LLC Formation" : contractType === "onboarding" ? "LLC Onboarding" : contractType === "tax_return" ? "Tax Return" : contractType === "itin" ? "ITIN Application" : "Service"} - ${activation.client_name}`,
            amount,
            amount_currency: activation.currency || "USD",
            status: "Paid",
            invoice_number: invoiceNumber,
            invoice_status: "Paid",
            issue_date: today,
            paid_date: today,
            subtotal: amount,
            discount: 0,
            total: amount,
            payment_method: activation.payment_method || "Whop",
            whop_payment_id: activation.whop_payment_id || null,
            qb_sync_status: "pending",
            message: `Payment received via ${activation.payment_method || "card"}`,
          })
          .select("id")
          .single()

        if (invErr || !invoice) {
          steps.push({ step: "crm_invoice", status: "error", detail: invErr?.message || "Failed to create" })
        } else {
          // Add line item
          await supabase.from("payment_items").insert({
            payment_id: invoice.id,
            description: `${contractType === "formation" ? "LLC Formation" : contractType === "onboarding" ? "LLC Onboarding" : contractType === "tax_return" ? "Tax Return" : "Service"} Package`,
            quantity: 1,
            unit_price: amount,
            amount,
            sort_order: 0,
          })

          steps.push({
            step: "crm_invoice",
            status: "created",
            detail: `${invoiceNumber} — ${activation.currency} ${amount} (Paid)`,
          })

          // QB sync (best-effort, non-blocking)
          syncInvoiceToQB(invoice.id)
            .then((r) => {
              if (r.success && r.qb_invoice_id) {
                // Invoice synced — now record payment in QB too
                syncPaymentToQB(invoice.id, {
                  paymentDate: today,
                  paymentMethod: activation.payment_method || "Whop",
                }).catch(() => {})
              }
            })
            .catch(() => {})
        }
      } catch (e) {
        steps.push({ step: "crm_invoice", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    } else if (!autoAccountId) {
      steps.push({ step: "crm_invoice", status: "skipped", detail: "No account to link invoice to" })
    } else {
      steps.push({ step: "crm_invoice", status: "skipped", detail: "No amount on activation" })
    }

    // ─── STEP 4: Data Collection Form (SUPERVISED) ──────────
    const formConfig = FORM_CONFIG[contractType]
    if (formConfig && leadId) {
      const { data: lead } = await supabase
        .from("leads")
        .select("language, full_name, email")
        .eq("id", leadId)
        .single()

      if (lead) {
        // Check if form already exists
        const { data: existingForm } = await supabase
          .from(formConfig.table)
          .select("token")
          .eq(formConfig.leadIdField, leadId)
          .limit(1)

        if (existingForm && existingForm.length > 0) {
          steps.push({ step: "data_form", status: "existing", detail: `${formConfig.formName} already exists: ${existingForm[0].token}` })
        } else {
          const formLang = lead.language === "Italian" || lead.language === "it" ? "it" : "en"

          preparedSteps.push({
            step: "data_form",
            action: formConfig.action,
            description: `Create ${formConfig.formName} for ${lead.full_name} (${formLang}) and send link to ${lead.email}.`,
            params: {
              lead_id: leadId,
              contract_type: contractType,
              entity_type: contractType === "formation" ? "SMLLC" : undefined,
              state: contractType === "formation" ? "NM" : undefined,
              language: formLang,
              client_name: lead.full_name,
              client_email: lead.email,
            },
            status: "pending",
          })
        }
      }
    } else if (!formConfig) {
      steps.push({ step: "data_form", status: "skipped", detail: `No form config for contract_type: ${contractType}` })
    } else {
      steps.push({ step: "data_form", status: "skipped", detail: "No lead_id available" })
    }

    // ─── Decide: supervised or auto ──────────────────────────
    if (isAutoMode && preparedSteps.length > 0) {
      for (const ps of preparedSteps) {
        steps.push({ step: ps.step, status: "auto_queued", detail: `Auto mode: ${ps.description}` })
        ps.status = "confirmed"
      }

      await supabase
        .from("pending_activations")
        .update({
          status: "activated",
          prepared_steps: preparedSteps,
          confirmation_mode: "auto",
          activated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", pending_activation_id)
    } else if (preparedSteps.length > 0) {
      await supabase
        .from("pending_activations")
        .update({
          status: "pending_confirmation",
          prepared_steps: preparedSteps,
          confirmation_mode: "supervised",
          updated_at: new Date().toISOString(),
        })
        .eq("id", pending_activation_id)

      steps.push({
        step: "supervision",
        status: "awaiting_confirmation",
        detail: `${preparedSteps.length} step(s) prepared. Use formation_confirm(activation_id) via MCP to review and execute.`,
      })
    } else {
      await supabase
        .from("pending_activations")
        .update({
          status: "activated",
          activated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", pending_activation_id)
    }

    // ─── STEP 5: Notify Luca + Antonio via email ──────────
    try {
      const { gmailPost } = await import("@/lib/gmail")
      const sdList = sdResults.map(r => `- ${r.pipeline}: ${r.status}${r.id ? ` (${r.id.slice(0,8)})` : ""}`).join("\n")
      const supervisedList = preparedSteps.map(p => `- ${p.description}`).join("\n")

      const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<h2>[NEW CLIENT] ${activation.client_name} -- Payment Confirmed</h2>
<table style="border-collapse:collapse">
<tr><td style="padding:4px 8px;font-weight:bold">Contract type:</td><td style="padding:4px 8px">${contractType}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Amount:</td><td style="padding:4px 8px">${activation.currency} ${activation.amount}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Payment:</td><td style="padding:4px 8px">${activation.payment_method}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Email:</td><td style="padding:4px 8px">${activation.client_email}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Contact ID:</td><td style="padding:4px 8px">${contactId || "N/A"}</td></tr>
</table>

<h3>Service Deliveries Created</h3>
<pre style="background:#f3f4f6;padding:12px;border-radius:6px">${sdList || "None"}</pre>

${preparedSteps.length > 0 ? `<h3>Supervised Steps (awaiting confirmation)</h3>
<pre style="background:#fef3c7;padding:12px;border-radius:6px">${supervisedList}</pre>
<p>Use <code>formation_confirm(activation_id)</code> in Claude to review and execute these steps.</p>` : ""}

<p style="font-size:12px;color:#6b7280">Activation ID: ${pending_activation_id} | Offer: ${activation.offer_token}</p>
</div>`

      const raw = Buffer.from(
        `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
        `To: support@tonydurante.us\r\n` +
        `Cc: antonio.durante@tonydurante.us\r\n` +
        `Subject: [NEW CLIENT] ${activation.client_name} -- ${contractType} -- Payment Confirmed\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n\r\n` +
        emailBody
      ).toString("base64url")

      await gmailPost("/messages/send", { raw })
      steps.push({ step: "team_notification", status: "ok", detail: "Email sent to support@ + antonio@" })
    } catch (e) {
      steps.push({ step: "team_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // Log action
    await supabase.from("action_log").insert({
      action_type: "service_activated",
      entity_type: "pending_activations",
      entity_id: pending_activation_id,
      details: {
        steps,
        contract_type: contractType,
        bundled_pipelines: pipelines,
        service_deliveries: sdResults,
        prepared_steps: preparedSteps.length,
        mode: isAutoMode ? "auto" : "supervised",
        lead_id: leadId,
        contact_id: contactId,
      },
    })

    // eslint-disable-next-line no-console -- API route log for observability
    console.log(`[activate-service] ${contractType.toUpperCase()} | ${isAutoMode ? "AUTO" : "SUPERVISED"} | ${activation.client_name} | ${pipelines.length} pipelines`)

    return NextResponse.json({
      ok: true,
      contract_type: contractType,
      mode: isAutoMode ? "auto" : "supervised",
      steps,
      service_deliveries: sdResults,
      prepared_steps: preparedSteps.length,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[activate-service] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
