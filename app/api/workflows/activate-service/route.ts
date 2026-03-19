/**
 * Activate Service — Universal Post-Payment Automation
 *
 * Triggered when payment is confirmed (Whop webhook or wire cron).
 * Handles ALL contract types: formation, onboarding, tax_return, itin.
 *
 * Steps:
 *   1. Lead → Contact (AUTO)
 *   2. Create service deliveries from bundled_pipelines (AUTO)
 *   3. QB invoice (SUPERVISED — prepared, awaits confirmation)
 *   4. Send appropriate data collection form based on contract_type (SUPERVISED)
 *
 * Supervised steps saved in prepared_steps JSONB.
 * Claude confirms via MCP before execution.
 * After 5 successful confirmations → auto mode.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"

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

      // Resolve account_id
      let accountId = offer?.account_id || null
      if (!accountId && leadId) {
        const { data: lead } = await supabase.from("leads").select("account_id").eq("id", leadId).maybeSingle()
        accountId = lead?.account_id || null
      }

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

    // ─── STEP 3: QB Invoice (SUPERVISED) ────────────────────
    preparedSteps.push({
      step: "qb_invoice",
      action: "qb_create_invoice",
      description: `Create QB invoice for ${activation.client_name}: ${activation.amount} ${activation.currency} (${activation.payment_method}). Mark as paid and send to ${activation.client_email}.`,
      params: {
        client_name: activation.client_name,
        client_email: activation.client_email,
        amount: activation.amount,
        currency: activation.currency,
        payment_method: activation.payment_method,
        offer_token: activation.offer_token,
        mark_as_paid: true,
        send_to_client: true,
      },
      status: "pending",
    })

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
