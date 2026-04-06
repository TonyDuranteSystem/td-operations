/**
 * Offer Signed Webhook
 *
 * Called by the contract page after a client signs.
 * Creates a pending_activation record to track the payment wait.
 * If the offer has Whop payment links → await Whop webhook.
 * If bank transfer → cron check-wire-payments will match it.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { autoSaveDocument } from "@/lib/portal/auto-save-document"
import { createTDInvoice } from "@/lib/portal/td-invoice"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { offer_token } = body

    if (!offer_token) {
      return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
    }

    // Get offer details
    const { data: offer, error: offerErr } = await supabase
      .from("offers")
      .select("*")
      .eq("token", offer_token)
      .single()

    if (offerErr || !offer) {
      console.error("[offer-signed] Offer not found:", offer_token, offerErr?.message)
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    // Check if pending_activation already exists
    const { data: existing } = await supabase
      .from("pending_activations")
      .select("id")
      .eq("offer_token", offer_token)
      .limit(1)

    if (existing && existing.length > 0) {
      console.warn("[offer-signed] Pending activation already exists for:", offer_token)
      return NextResponse.json({ ok: true, message: "Already pending" })
    }

    // Determine payment method from offer
    const links = Array.isArray(offer.payment_links) ? offer.payment_links : []
    const hasCheckoutLink = links.length > 0
    const hasBank = !!offer.bank_details
    // Detect gateway from payment_links metadata or URL pattern
    const gatewayType = hasCheckoutLink
      ? (links[0]?.gateway || (links[0]?.url?.includes("stripe.com") ? "stripe" : "whop"))
      : null
    const paymentMethod = hasCheckoutLink ? gatewayType : hasBank ? "bank_transfer" : "unknown"

    // Parse cost_summary for currency detection and fallback amount
    const summaryArr = Array.isArray(offer.cost_summary)
      ? offer.cost_summary
      : typeof offer.cost_summary === "string"
        ? (() => { try { return JSON.parse(offer.cost_summary) } catch { return [] } })()
        : []

    // Calculate total from selected_services (respects client's service selection)
    let totalAmount = 0
    const services = Array.isArray(offer.services) ? offer.services : []
    const selectedServices: string[] = Array.isArray(offer.selected_services) ? offer.selected_services : []

    for (const svc of services) {
      const name = (svc as Record<string, unknown>).name as string || ""
      const isOptional = !!(svc as Record<string, unknown>).optional
      const isSelected = !isOptional || selectedServices.includes(name)
      if (!isSelected) continue

      const priceStr = String((svc as Record<string, unknown>).price || "0")
      if (/\/(year|anno|month|mese)/i.test(priceStr)) continue
      if (/includ|inclus/i.test(priceStr)) continue

      const priceNum = parseFloat(priceStr.replace(/[^0-9.]/g, ""))
      if (!isNaN(priceNum) && priceNum > 0) totalAmount += priceNum
    }

    // Fallback: if no parseable prices from services, use cost_summary[0].total
    if (totalAmount === 0 && summaryArr.length > 0) {
      const raw = summaryArr[0].total || summaryArr[0].total_label || ""
      const numStr = raw.replace(/[^0-9.,]/g, "").trim()
      if (numStr) {
        if (/\.\d{3}$/.test(numStr) && !numStr.includes(",")) {
          totalAmount = parseFloat(numStr.replace(/\./g, ""))
        } else {
          totalAmount = parseFloat(numStr.replace(",", ""))
        }
      }
    }

    // Create pending_activation
    const { data: activation, error: actErr } = await supabase
      .from("pending_activations")
      .insert({
        offer_token,
        lead_id: offer.lead_id || null,
        client_name: offer.client_name,
        client_email: offer.client_email,
        amount: totalAmount || null,
        currency: (() => {
          // Detect from cost_summary first section
          const raw = summaryArr[0]?.total || summaryArr[0]?.total_label || ""
          if (raw.includes("€") || raw.toUpperCase().includes("EUR")) return "EUR"
          return "USD"
        })(),
        payment_method: paymentMethod,
        status: "awaiting_payment",
        signed_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (actErr) {
      console.error("[offer-signed] Failed to create pending_activation:", actErr.message)
      return NextResponse.json({ error: "Failed to create activation" }, { status: 500 })
    }

    console.warn(`[offer-signed] Created pending_activation ${activation.id} for ${offer.client_name} (${paymentMethod})`)

    // ─── CREATE INVOICE AT SIGNING (contact-only, unpaid) ───
    // Invoice is for the PERSON (contact_id). Account doesn't exist yet.
    // When the account is created later (formation/onboarding wizard), account_id gets backfilled.
    let invoiceId: string | null = null
    try {
      // Resolve contact_id from offer's client_email
      let contactId: string | null = null
      if (offer.client_email) {
        const { data: existingContact } = await supabase
          .from("contacts")
          .select("id")
          .ilike("email", offer.client_email)
          .limit(1)
          .maybeSingle()
        contactId = existingContact?.id || null
      }

      if (contactId && totalAmount > 0) {
        const contractType = offer.contract_type || "formation"
        const serviceLabel = contractType === "formation" ? "LLC Formation"
          : contractType === "onboarding" ? "LLC Onboarding"
          : contractType === "tax_return" ? "Tax Return"
          : contractType === "itin" ? "ITIN Application"
          : "Service"

        const currency = (() => {
          const raw = summaryArr[0]?.total || summaryArr[0]?.total_label || ""
          if (raw.includes("€") || raw.toUpperCase().includes("EUR")) return "EUR" as const
          return "USD" as const
        })()

        const invoiceResult = await createTDInvoice({
          contact_id: contactId,
          line_items: [{
            description: `${serviceLabel} Package - ${offer.client_name}`,
            unit_price: totalAmount,
            quantity: 1,
          }],
          currency,
          mark_as_paid: false,
          notes: `Auto-created at contract signing. Offer: ${offer_token}`,
        })

        invoiceId = invoiceResult.paymentId

        // Store payment reference on pending_activation for dedup
        await supabase
          .from("pending_activations")
          .update({ portal_invoice_id: invoiceId })
          .eq("id", activation.id)

        console.warn(`[offer-signed] TD invoice ${invoiceResult.invoiceNumber} created for ${offer.client_name} (contact-only, unpaid)`)
      } else {
        console.warn(`[offer-signed] Skipped invoice: contactId=${contactId}, amount=${totalAmount}`)
      }
    } catch (invErr) {
      console.error("[offer-signed] Invoice creation failed:", invErr instanceof Error ? invErr.message : String(invErr))
    }

    // Update bundled_pipelines based on selected_services (remove deselected optional service pipelines)
    if (offer.selected_services && Array.isArray(offer.selected_services) && offer.bundled_pipelines) {
      const selectedNames = new Set(offer.selected_services)
      const services = Array.isArray(offer.services) ? offer.services : []
      // Find optional services that were deselected
      const deselectedPipelines = new Set<string>()
      for (const svc of services) {
        if ((svc as any).optional && !selectedNames.has(svc.name) && (svc as any).pipeline_type) {
          deselectedPipelines.add((svc as any).pipeline_type)
        }
      }
      if (deselectedPipelines.size > 0) {
        const finalPipelines = (offer.bundled_pipelines as string[]).filter(p => !deselectedPipelines.has(p))
        await supabase.from("offers").update({ bundled_pipelines: finalPipelines }).eq("token", offer_token)
        console.warn(`[offer-signed] Updated bundled_pipelines: removed ${Array.from(deselectedPipelines).join(", ")}`)
      }
    }

    // Log action
    await supabase.from("action_log").insert({
      action_type: "offer_signed",
      entity_type: "pending_activations",
      entity_id: activation.id,
      details: {
        offer_token,
        client_name: offer.client_name,
        payment_method: paymentMethod,
        amount: totalAmount,
      },
    })

    // ─── AUTO-UPLOAD SIGNED PDF TO DRIVE ───
    let driveUploadResult = "skipped"
    try {
      // Get contract record for pdf_path
      const { data: contract } = await supabase
        .from("contracts")
        .select("pdf_path")
        .eq("offer_token", offer_token)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      // Get account for drive_folder_id (via account_id directly, or lead_id → accounts)
      let driveFolderId: string | null = null
      if (offer.account_id) {
        const { data: acct } = await supabase
          .from("accounts")
          .select("drive_folder_id")
          .eq("id", offer.account_id)
          .single()
        driveFolderId = acct?.drive_folder_id || null
      } else if (offer.lead_id) {
        const { data: lead } = await supabase
          .from("leads")
          .select("account_id")
          .eq("id", offer.lead_id)
          .maybeSingle()

        if (lead?.account_id) {
          const { data: acct } = await supabase
            .from("accounts")
            .select("drive_folder_id")
            .eq("id", lead.account_id)
            .single()
          driveFolderId = acct?.drive_folder_id || null
        }
      }

      if (contract?.pdf_path && driveFolderId) {
        const { listFolder, uploadBinaryToDrive } = await import("@/lib/google-drive")

        // Find "1. Company" subfolder
        const folderResult = await listFolder(driveFolderId) as { files?: { id: string; name: string; mimeType: string }[] }
        const companyFolder = folderResult.files?.find(
          (f: { name: string; mimeType: string }) => f.name.includes("Company") && f.mimeType === "application/vnd.google-apps.folder"
        )
        const targetFolderId = companyFolder?.id || driveFolderId

        // Download signed PDF from Storage
        const { data: blob } = await supabase.storage
          .from("signed-contracts")
          .download(contract.pdf_path)

        if (blob) {
          const arrayBuffer = await blob.arrayBuffer()
          const fileData = Buffer.from(arrayBuffer)
          const fileName = `Contract - ${offer.client_name} (Signed).pdf`

          const driveResult = await uploadBinaryToDrive(fileName, fileData, "application/pdf", targetFolderId) as { id: string }
          driveUploadResult = `ok: ${driveResult.id}`
          console.warn(`[offer-signed] Uploaded contract PDF to Drive: ${driveResult.id}`)

          // Auto-save to documents table for portal visibility
          if (offer.lead_id) {
            const { data: leadForDoc } = await supabase.from("leads").select("account_id").eq("id", offer.lead_id).maybeSingle()
            if (leadForDoc?.account_id) {
              await autoSaveDocument({
                accountId: leadForDoc.account_id,
                fileName,
                documentType: 'Signed Contract',
                category: 5, // Correspondence
                driveFileId: driveResult.id,
                portalVisible: true,
              })
            }
          } else if (offer.account_id) {
            await autoSaveDocument({
              accountId: offer.account_id,
              fileName,
              documentType: 'Signed Contract',
              category: 5,
              driveFileId: driveResult.id,
              portalVisible: true,
            })
          }
        } else {
          driveUploadResult = "error: could not download PDF from Storage"
        }
      } else {
        driveUploadResult = `skipped: pdf_path=${!!contract?.pdf_path}, drive=${!!driveFolderId}`
      }
    } catch (e) {
      driveUploadResult = `error: ${e instanceof Error ? e.message : String(e)}`
      console.error("[offer-signed] Drive upload failed:", driveUploadResult)
    }

    return NextResponse.json({ ok: true, activation_id: activation.id, drive_upload: driveUploadResult })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[offer-signed] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
