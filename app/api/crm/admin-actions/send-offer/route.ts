/**
 * POST /api/crm/admin-actions/send-offer
 *
 * Admin-only. Mirrors the offer_send MCP tool:
 *   1. Creates portal user (tier='lead') with temp password
 *   2. Sends email via Gmail with portal credentials
 *   3. Updates offer status to 'sent' + lead offer_status
 *   4. Tracks email open with pixel
 *
 * Uses safeSend for idempotency (won't double-send).
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { autoCreatePortalUser } from "@/lib/portal/auto-create"
import { gmailPost } from "@/lib/gmail"
import { safeSend } from "@/lib/mcp/safe-send"
import { APP_BASE_URL, PORTAL_BASE_URL } from "@/lib/config"

// ─── Email Templates (same as MCP offer_send) ───

function buildPortalWelcomeEmail(
  firstName: string,
  email: string,
  tempPassword: string,
  portalUrl: string,
  lang: "en" | "it",
  pixelUrl: string,
): string {
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

  if (lang === "it") {
    return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <div style="background: #1e3a5f; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 22px;">La tua proposta è pronta</h1>
    <p style="color: #93c5fd; margin: 4px 0 0;">Tony Durante LLC</p>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
    <p>Ciao ${firstName},</p>
    <p>Grazie per la nostra consulenza. La tua proposta personalizzata è pronta per la revisione.</p>
    <p>Accedi al tuo <strong>portale clienti</strong> per visualizzarla:</p>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Portale</td><td style="padding: 4px 8px; font-weight: bold;"><a href="${portalUrl}" style="color: #2563eb;">${portalUrl}</a></td></tr>
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Email</td><td style="padding: 4px 8px; font-weight: bold;">${email}</td></tr>
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Password</td><td style="padding: 4px 8px; font-weight: bold; font-family: monospace; letter-spacing: 1px;">${tempPassword}</td></tr>
      </table>
    </div>
    <p style="margin: 24px 0; text-align: center;">
      <a href="${portalUrl}" style="display: inline-block; background: #1e3a5f; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
        Accedi al Portale
      </a>
    </p>
    <p style="color: #6b7280; font-size: 13px;">Al primo accesso ti verrà chiesto di cambiare la password.</p>
    <p style="color: #6b7280; font-size: 13px;">Per qualsiasi domanda, rispondi direttamente a questa email o usa la chat nel portale.</p>
    <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af;">
      Tony Durante LLC · 1111 Lincoln Road, Suite 400, Miami Beach, FL 33139
    </div>
  </div>
</div>${pixel}`
  }

  return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <div style="background: #1e3a5f; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 22px;">Your proposal is ready</h1>
    <p style="color: #93c5fd; margin: 4px 0 0;">Tony Durante LLC</p>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
    <p>Hi ${firstName},</p>
    <p>Thank you for our consultation. Your personalized proposal is ready for review.</p>
    <p>Log in to your <strong>client portal</strong> to view it:</p>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Portal</td><td style="padding: 4px 8px; font-weight: bold;"><a href="${portalUrl}" style="color: #2563eb;">${portalUrl}</a></td></tr>
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Email</td><td style="padding: 4px 8px; font-weight: bold;">${email}</td></tr>
        <tr><td style="padding: 4px 8px; color: #6b7280; font-size: 13px;">Password</td><td style="padding: 4px 8px; font-weight: bold; font-family: monospace; letter-spacing: 1px;">${tempPassword}</td></tr>
      </table>
    </div>
    <p style="margin: 24px 0; text-align: center;">
      <a href="${portalUrl}" style="display: inline-block; background: #1e3a5f; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
        Log in to Portal
      </a>
    </p>
    <p style="color: #6b7280; font-size: 13px;">On your first login, you'll be asked to change your password.</p>
    <p style="color: #6b7280; font-size: 13px;">For any questions, reply to this email or use the chat in your portal.</p>
    <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af;">
      Tony Durante LLC · 1111 Lincoln Road, Suite 400, Miami Beach, FL 33139
    </div>
  </div>
</div>${pixel}`
}

function buildOfferLinkFallbackEmail(
  firstName: string,
  offerUrl: string,
  lang: "en" | "it",
  pixelUrl: string,
): string {
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

  if (lang === "it") {
    return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <p>Ciao ${firstName},</p>
  <p>La tua proposta personalizzata è pronta. Puoi consultarla al seguente link:</p>
  <p style="margin: 24px 0;"><a href="${offerUrl}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Visualizza la Proposta</a></p>
  <p>Per qualsiasi domanda, non esitare a contattarci.</p>
  <p style="margin-top: 24px;">Cordiali saluti,<br/><strong>Tony Durante LLC</strong></p>
</div>${pixel}`
  }

  return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <p>Hi ${firstName},</p>
  <p>Your personalized proposal is ready. View it at the following link:</p>
  <p style="margin: 24px 0;"><a href="${offerUrl}" style="display: inline-block; background: #1a1a1a; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">View Your Proposal</a></p>
  <p>For any questions, don't hesitate to reach out.</p>
  <p style="margin-top: 24px;">Best regards,<br/><strong>Tony Durante LLC</strong></p>
</div>${pixel}`
}

// ─── Route Handler ───

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "send_document")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  try {
    const { offer_token } = await request.json()

    if (!offer_token) {
      return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
    }

    // Get offer
    const { data: offer, error: fetchError } = await supabaseAdmin
      .from("offers")
      .select("token, client_name, client_email, language, status, access_code, lead_id, account_id")
      .eq("token", offer_token)
      .single()

    if (fetchError || !offer) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    if (!offer.client_email) {
      return NextResponse.json({ error: "Offer has no client_email" }, { status: 400 })
    }

    // Step 1: Create portal user
    const portalResult = await autoCreatePortalUser({
      leadId: offer.lead_id || undefined,
      accountId: offer.account_id || undefined,
      tier: "lead",
    })

    const isNewUser = portalResult.success && !portalResult.alreadyExists
    const tempPassword = portalResult.tempPassword
    const portalLoginUrl = `${PORTAL_BASE_URL}/portal/login`

    // Step 2: Build email
    const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const pixelUrl = `${APP_BASE_URL}/api/track/open/${trackingId}`
    const lang = (offer.language || "en") as "en" | "it"
    const firstName = offer.client_name.split(" ")[0]

    const hasPortalCredentials = isNewUser && tempPassword
    const offerDirectUrl = `${APP_BASE_URL}/offer/${offer_token}/${offer.access_code || ""}`

    const subject = lang === "it"
      ? "La tua proposta è pronta — Tony Durante LLC"
      : "Your proposal is ready — Tony Durante LLC"

    const htmlBody = hasPortalCredentials
      ? buildPortalWelcomeEmail(firstName, offer.client_email, tempPassword!, portalLoginUrl, lang, pixelUrl)
      : buildOfferLinkFallbackEmail(firstName, offerDirectUrl, lang, pixelUrl)

    const plainText = hasPortalCredentials
      ? lang === "it"
        ? `Ciao ${firstName}, la tua proposta è pronta. Accedi al portale: ${portalLoginUrl} — Email: ${offer.client_email} — Password temporanea: ${tempPassword}`
        : `Hi ${firstName}, your proposal is ready. Log in to your portal: ${portalLoginUrl} — Email: ${offer.client_email} — Temporary password: ${tempPassword}`
      : lang === "it"
        ? `Ciao ${firstName}, la tua proposta è pronta: ${offerDirectUrl}`
        : `Hi ${firstName}, your proposal is ready: ${offerDirectUrl}`

    // Build MIME
    const fromEmail = "support@tonydurante.us"
    const boundary = `boundary_${Date.now()}`
    const hasNonAscii = /[^\x00-\x7F]/.test(subject)
    const encodedSubject = hasNonAscii
      ? `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`
      : subject

    const mimeParts = [
      [
        `From: Tony Durante LLC <${fromEmail}>`,
        `To: ${offer.client_email}`,
        `Subject: ${encodedSubject}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ].join("\r\n"),
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(plainText).toString("base64"),
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(htmlBody).toString("base64"),
      "",
      `--${boundary}--`,
    ]
    const encodedRaw = Buffer.from(mimeParts.join("\r\n")).toString("base64url")

    // Step 3: safeSend — email first, status updates after
    const result = await safeSend<{ id: string; threadId: string }>({
      idempotencyCheck: async () => {
        if (offer.status === "sent") {
          const { data: existing } = await supabaseAdmin
            .from("email_tracking")
            .select("tracking_id, created_at")
            .eq("recipient", offer.client_email!)
            .ilike("subject", "%Tony Durante%")
            .limit(1)
          if (existing?.length) {
            return {
              alreadySent: true,
              message: `Offer already sent (tracked: ${existing[0].tracking_id} at ${existing[0].created_at}). Set status back to 'draft' to resend.`,
            }
          }
        }
        return null
      },

      sendFn: async () => {
        return await gmailPost("/messages/send", {
          raw: encodedRaw,
        }) as { id: string; threadId: string }
      },

      postSendSteps: [
        {
          name: "save_tracking",
          fn: async () => {
            await supabaseAdmin.from("email_tracking").insert({
              tracking_id: trackingId,
              recipient: offer.client_email,
              subject,
              from_email: fromEmail,
            })
          },
        },
        {
          name: "update_offer_status",
          fn: async () => {
            await supabaseAdmin
              .from("offers")
              .update({ status: "sent" })
              .eq("token", offer_token)
          },
        },
        {
          name: "update_lead_status",
          fn: async () => {
            if (offer.lead_id) {
              await supabaseAdmin
                .from("leads")
                .update({ offer_status: "Sent" })
                .eq("id", offer.lead_id)
            }
          },
        },
      ],
    })

    if (result.alreadySent) {
      return NextResponse.json(
        { error: result.idempotencyMessage },
        { status: 409 }
      )
    }

    logAction({
      actor: "crm-admin",
      action_type: "send",
      table_name: "offers",
      record_id: offer_token,
      summary: `Sent offer: ${offer.client_name} (${offer_token}) to ${offer.client_email}${hasPortalCredentials ? " [portal created]" : ""}`,
      details: {
        lead_id: offer.lead_id,
        language: offer.language,
        gmail_message_id: result.sendResult?.id,
        tracking_id: trackingId,
        portal_created: isNewUser,
        admin_email: user?.email,
      },
    })

    return NextResponse.json({
      ok: true,
      message: `Offer sent to ${offer.client_email}`,
      portal_created: isNewUser,
      portal_already_existed: portalResult.alreadyExists,
      tracking_id: trackingId,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
