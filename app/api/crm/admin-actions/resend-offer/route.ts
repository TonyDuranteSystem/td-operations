/**
 * POST /api/crm/admin-actions/resend-offer
 *
 * Re-sends the portal access email for an already-published offer.
 * EMAIL-ONLY — does NOT change offer status, does NOT republish,
 * does NOT create new versions, does NOT have any destructive effect.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { canPerform } from "@/lib/permissions"
import { logAction } from "@/lib/mcp/action-log"
import { gmailPost } from "@/lib/gmail"
import { PORTAL_BASE_URL, APP_BASE_URL } from "@/lib/config"

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, "add_note")) {
    return NextResponse.json({ error: "Access required" }, { status: 403 })
  }

  try {
    const { offer_token } = await request.json()

    if (!offer_token) {
      return NextResponse.json({ error: "Missing offer_token" }, { status: 400 })
    }

    const { data: offer, error: fetchErr } = await supabaseAdmin
      .from("offers")
      .select("token, client_name, client_email, language, status, lead_id")
      .eq("token", offer_token)
      .single()

    if (fetchErr || !offer) {
      return NextResponse.json({ error: "Offer not found" }, { status: 404 })
    }

    if (offer.status === "draft") {
      return NextResponse.json(
        { error: "Offer is still a draft — use 'Send Offer' to publish it first." },
        { status: 400 }
      )
    }

    if (!offer.client_email) {
      return NextResponse.json({ error: "No client email on this offer" }, { status: 400 })
    }

    // Build resend email — portal notification (not credentials, since user already exists)
    const lang = (offer.language || "en") as "en" | "it"
    const firstName = offer.client_name.split(" ")[0]
    const portalLoginUrl = `${PORTAL_BASE_URL}/portal/login`
    const trackingId = `et_resend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const pixelUrl = `${APP_BASE_URL}/api/track/open/${trackingId}`

    const subject = lang === "it"
      ? "Promemoria: documenti disponibili nel portale — Tony Durante LLC"
      : "Reminder: documents available in your portal — Tony Durante LLC"

    const htmlBody = lang === "it"
      ? `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px"><p>Ciao ${firstName},</p><p>Ti ricordiamo che hai documenti disponibili nel tuo portale clienti.</p><p><a href="${portalLoginUrl}" style="display:inline-block;padding:12px 24px;background:#1e40af;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Accedi al Portale</a></p><p>Se hai domande, rispondi a questa email.</p><p>— Tony Durante LLC</p><img src="${pixelUrl}" width="1" height="1" style="display:none" /></div>`
      : `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px"><p>Hi ${firstName},</p><p>This is a reminder that you have documents available in your client portal.</p><p><a href="${portalLoginUrl}" style="display:inline-block;padding:12px 24px;background:#1e40af;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Access Portal</a></p><p>If you have any questions, reply to this email.</p><p>— Tony Durante LLC</p><img src="${pixelUrl}" width="1" height="1" style="display:none" /></div>`

    const plainText = lang === "it"
      ? `Ciao ${firstName}, hai documenti disponibili nel tuo portale: ${portalLoginUrl}`
      : `Hi ${firstName}, you have documents available in your portal: ${portalLoginUrl}`

    // Build MIME (RFC 2047 encoded subject)
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

    // Send email via Gmail
    const gmailResult = await gmailPost("/messages/send", { raw: encodedRaw })

    if (!gmailResult?.id) {
      return NextResponse.json({ error: "Failed to send email" }, { status: 500 })
    }

    // Log to email_tracking (for audit, NOT for idempotency blocking)
    await supabaseAdmin.from("email_tracking").insert({
      tracking_id: trackingId,
      offer_token: offer.token,
      recipient: offer.client_email,
      subject: "resend_reminder",
      gmail_message_id: gmailResult.id,
    })

    logAction({
      actor: "crm-admin",
      action_type: "email",
      table_name: "offers",
      record_id: offer.token,
      summary: `Resent portal reminder email for offer "${offer.token}" to ${offer.client_email}`,
      details: {
        offer_token: offer.token,
        recipient: offer.client_email,
        email_type: "resend_reminder",
        admin_email: user?.email,
        tracking_id: trackingId,
      },
    })

    return NextResponse.json({
      ok: true,
      message: `Reminder email sent to ${offer.client_email}`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[resend-offer] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
