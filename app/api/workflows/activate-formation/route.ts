/**
 * Activate Formation — Stage 0 Automation
 *
 * Triggered when payment is confirmed (Whop webhook or cron wire check).
 * Executes the full Stage 0 sequence:
 *   0.3 → QB invoice (SUPERVISED — prepared, awaits confirmation)
 *   0.4 → Lead → Contact (AUTO)
 *   0.5 → Service delivery (DEFERRED — created in Stage 2)
 *   0.6 → Formation form + send email (SUPERVISED — prepared, awaits confirmation)
 *
 * Supervised steps are saved in prepared_steps JSONB.
 * Claude confirms via MCP before execution.
 * After 5 successful confirmations → auto mode.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"

// How many successful supervised runs before switching to auto
const AUTO_THRESHOLD = 5

interface PreparedStep {
  step: string
  action: string
  description: string
  params: Record<string, unknown>
  status: "pending" | "confirmed" | "executed" | "skipped"
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

    // Check if we should run in auto mode
    const { count: successCount } = await supabase
      .from("action_log")
      .select("*", { count: "exact", head: true })
      .eq("action_type", "formation_confirmed")

    const isAutoMode = (successCount || 0) >= AUTO_THRESHOLD

    const steps: Array<{ step: string; status: string; detail?: string }> = []
    const preparedSteps: PreparedStep[] = []

    // ─── STEP 0.4: Lead → Contact (AUTOMATIC) ─────────────────
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
          steps.push({ step: "0.4", status: "existing", detail: `Contact already exists: ${contactId}` })
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
            steps.push({ step: "0.4", status: "created", detail: `Contact created: ${contactId}` })
          } else {
            steps.push({ step: "0.4", status: "error", detail: cErr?.message })
          }
        }
      }
    } else {
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
        steps.push({ step: "0.4", status: "ok", detail: `Lead found by email, contact: ${contactId}` })
      } else {
        steps.push({ step: "0.4", status: "skipped", detail: "No lead found" })
      }
    }

    // ─── STEP 0.5: Service Delivery (DEFERRED) ─────────────────
    steps.push({ step: "0.5", status: "deferred", detail: "Service delivery will be created in Stage 2 when account exists" })

    // ─── STEP 0.3: QB Invoice (SUPERVISED) ────────────────────
    preparedSteps.push({
      step: "0.3",
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

    // ─── STEP 0.6: Formation Form (SUPERVISED) ────────────────
    if (leadId) {
      const { data: lead } = await supabase
        .from("leads")
        .select("language, full_name, email")
        .eq("id", leadId)
        .single()

      if (lead) {
        // Check if formation form already exists
        const { data: existingForm } = await supabase
          .from("formation_submissions")
          .select("token")
          .eq("lead_id", leadId)
          .limit(1)

        if (existingForm && existingForm.length > 0) {
          steps.push({ step: "0.6", status: "existing", detail: `Form already exists: ${existingForm[0].token}` })
        } else {
          const formLang = lead.language === "Italian" || lead.language === "it" ? "it" : "en"

          preparedSteps.push({
            step: "0.6",
            action: "formation_form_create + gmail_send",
            description: `Create formation form for ${lead.full_name} (${formLang}) and send link to ${lead.email}.`,
            params: {
              lead_id: leadId,
              entity_type: "SMLLC",
              state: "NM",
              language: formLang,
              client_name: lead.full_name,
              client_email: lead.email,
            },
            status: "pending",
          })
        }
      }
    } else {
      steps.push({ step: "0.6", status: "skipped", detail: "No lead_id available" })
    }

    // ─── Decide: supervised or auto ──────────────────────────
    if (isAutoMode && preparedSteps.length > 0) {
      // AUTO MODE: Execute prepared steps immediately
      for (const ps of preparedSteps) {
        steps.push({ step: ps.step, status: "auto_queued", detail: `Auto mode: ${ps.description}` })
        ps.status = "confirmed"
      }

      // Save and mark as activated
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
      // SUPERVISED MODE: Save prepared steps, wait for confirmation
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
      // No supervised steps needed — mark as activated
      await supabase
        .from("pending_activations")
        .update({
          status: "activated",
          activated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", pending_activation_id)
    }

    // ─── CREATE SERVICE DELIVERIES FROM BUNDLED PIPELINES ─────
    const sdResults: Array<{ pipeline: string; status: string; id?: string }> = []
    try {
      // Get the offer to read bundled_pipelines
      const { data: offerData } = await supabase
        .from("offers")
        .select("bundled_pipelines, account_id")
        .eq("token", activation.offer_token)
        .single()

      const pipelines: string[] = Array.isArray(offerData?.bundled_pipelines) ? offerData.bundled_pipelines : []

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

        // Resolve account_id (from offer or lead)
        let accountId = offerData?.account_id || null
        if (!accountId && leadId) {
          const { data: lead } = await supabase.from("leads").select("account_id").eq("id", leadId).maybeSingle()
          accountId = lead?.account_id || null
        }

        for (const pipeline of pipelines) {
          try {
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
        steps.push({ step: "pipelines", status: "done", detail: `Created ${sdResults.filter(r => r.status === "created").length}/${pipelines.length} service deliveries` })
      }
    } catch (e) {
      steps.push({ step: "pipelines", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // Log action
    await supabase.from("action_log").insert({
      action_type: "formation_activated",
      entity_type: "pending_activations",
      entity_id: pending_activation_id,
      details: {
        steps,
        prepared_steps: preparedSteps.length,
        mode: isAutoMode ? "auto" : "supervised",
        lead_id: leadId,
        contact_id: contactId,
      },
    })

    console.log(`[activate-formation] ${isAutoMode ? "AUTO" : "SUPERVISED"} for ${activation.client_name}. Steps:`, steps)

    return NextResponse.json({
      ok: true,
      mode: isAutoMode ? "auto" : "supervised",
      steps,
      prepared_steps: preparedSteps.length,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[activate-formation] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
