/**
 * Activate Formation — Stage 0 Automation
 *
 * Triggered when payment is confirmed (Whop webhook or cron wire check).
 * Executes the full Stage 0 sequence:
 *   0.3 → Create QB invoice (paid) + send
 *   0.4 → Lead → Contact
 *   0.5 → Create service_delivery "Company Formation"
 *   0.6 → Create formation form + send email
 *
 * Then marks pending_activation as "activated".
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"

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

    const steps: Array<{ step: string; status: string; detail?: string }> = []

    // ─── STEP 0.3: Create QB Invoice (paid) ────────────────────
    // This will be done via MCP tools by the cron/manual trigger
    // For now, create a task for Antonio to create + send the QB invoice
    await supabase.from("tasks").insert({
      task_title: `Crea fattura QB per ${activation.client_name}`,
      description: `Offerta: ${activation.offer_token}\nImporto: ${activation.amount} ${activation.currency}\nMetodo: ${activation.payment_method}\n\nCreare fattura su QuickBooks, segnare come pagata, e inviare al cliente.`,
      assigned_to: "Antonio",
      priority: "High",
      category: "Payment",
      status: "todo",
    })
    steps.push({ step: "0.3", status: "task_created", detail: "QB invoice task created" })

    // ─── STEP 0.4: Lead → Contact ──────────────────────────────
    let contactId: string | null = null
    let leadId = activation.lead_id

    // Get lead data if we have lead_id
    if (leadId) {
      const { data: lead } = await supabase
        .from("leads")
        .select("*")
        .eq("id", leadId)
        .single()

      if (lead) {
        // Check if contact already exists with this email
        const { data: existingContact } = await supabase
          .from("contacts")
          .select("id")
          .ilike("email", lead.email || "")
          .limit(1)

        if (existingContact && existingContact.length > 0) {
          contactId = existingContact[0].id
          steps.push({ step: "0.4", status: "existing", detail: `Contact already exists: ${contactId}` })
        } else {
          // Create new contact from lead
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
      // Try to find lead by email from offer
      const { data: leads } = await supabase
        .from("leads")
        .select("*")
        .ilike("email", activation.client_email)
        .limit(1)

      if (leads && leads.length > 0) {
        leadId = leads[0].id
        // Same contact creation logic
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

    // ─── STEP 0.5: Create Service Delivery ─────────────────────
    // We don't have account_id yet (account is created in Stage 2 after Articles)
    // Create a placeholder service delivery linked to the lead
    // It will be linked to the account later in Stage 2
    steps.push({ step: "0.5", status: "deferred", detail: "Service delivery will be created in Stage 2 when account exists" })

    // ─── STEP 0.6: Create formation form + send email ──────────
    if (leadId) {
      // Get lead language for form
      const { data: lead } = await supabase
        .from("leads")
        .select("language, full_name, email")
        .eq("id", leadId)
        .single()

      if (lead) {
        // Check if formation form already exists
        const { data: existingForm } = await supabase
          .from("formation_forms")
          .select("token")
          .eq("lead_id", leadId)
          .limit(1)

        if (existingForm && existingForm.length > 0) {
          steps.push({ step: "0.6", status: "existing", detail: `Form already exists: ${existingForm[0].token}` })
        } else {
          // Create task to send formation form (will be done via MCP)
          await supabase.from("tasks").insert({
            task_title: `Invia formation form a ${activation.client_name}`,
            description: `Lead ID: ${leadId}\nEmail: ${lead.email}\nLingua: ${lead.language}\n\nCreare formation form (formation_form_create) e inviare link via email al cliente.`,
            assigned_to: "Luca",
            priority: "High",
            category: "Formation",
            status: "todo",
          })
          steps.push({ step: "0.6", status: "task_created", detail: "Formation form task created for Luca" })
        }
      }
    } else {
      steps.push({ step: "0.6", status: "skipped", detail: "No lead_id available" })
    }

    // ─── Mark activation as activated ──────────────────────────
    await supabase
      .from("pending_activations")
      .update({
        status: "activated",
        activated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", pending_activation_id)

    // Log action
    await supabase.from("action_log").insert({
      action_type: "formation_activated",
      entity_type: "pending_activations",
      entity_id: pending_activation_id,
      details: { steps, lead_id: leadId, contact_id: contactId },
    })

    console.log(`[activate-formation] Completed for ${activation.client_name}. Steps:`, steps)

    return NextResponse.json({ ok: true, steps })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[activate-formation] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
