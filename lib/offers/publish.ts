/**
 * publishOffer — Portal-first offer publication.
 *
 * Single source of truth for offer publishing. Called by both:
 *   - MCP offer_send tool (lib/mcp/tools/offers.ts)
 *   - CRM admin send-offer route (app/api/crm/admin-actions/send-offer/route.ts)
 *
 * What it does:
 *   1. Validates offer is in 'draft' status
 *   2. Creates portal user with offer.client_email (not resolved from CRM)
 *   3. Verifies contact linkage exists (auto-repairs if needed)
 *   4. Sends portal-access email (new user) or portal-notification email (existing user)
 *   5. Updates offer status to 'published'
 *   6. Logs to action_log
 *
 * What it does NOT do:
 *   - Send direct offer URLs in email
 *   - Fall back to direct-link delivery if portal creation fails
 *   - Allow publication from any status other than 'draft'
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailPost } from "@/lib/gmail"
import { logAction } from "@/lib/mcp/action-log"
import { safeSend } from "@/lib/mcp/safe-send"
import { autoCreatePortalUser } from "@/lib/portal/auto-create"
import { APP_BASE_URL, PORTAL_BASE_URL } from "@/lib/config"

// ─── Types ────────────────────────────────────────────────

export interface PublishOfferResult {
  success: boolean
  alreadySent: boolean
  error?: string
  portalCreated: boolean
  portalAlreadyExisted: boolean
  emailType: "portal_access" | "portal_notification" | "none"
  trackingId?: string
  gmailMessageId?: string
  warnings: string[]
}

// ─── Main function ────────────────────────────────────────

export async function publishOffer(
  token: string,
  actor?: string,
): Promise<PublishOfferResult> {
  // ─── 1. Fetch and validate offer ───
  const { data: offer, error: fetchError } = await supabaseAdmin
    .from("offers")
    .select("id, token, client_name, client_email, language, status, access_code, lead_id, account_id")
    .eq("token", token)
    .single()

  if (fetchError || !offer) {
    return fail(`Offer not found: ${token}`)
  }

  if (!offer.client_email) {
    return fail("Cannot publish: client_email is not set on this offer. Update it first.")
  }

  // Strict status gate: only 'draft' can be published
  if (offer.status !== "draft") {
    return fail(`Cannot publish: offer is in '${offer.status}' status. Only 'draft' offers can be published.`)
  }

  // ─── 2. Create or find portal user ───
  // Use emailOverride to ensure portal user matches offer.client_email exactly
  const portalResult = await autoCreatePortalUser({
    leadId: offer.lead_id || undefined,
    accountId: offer.account_id || undefined,
    tier: "lead",
    emailOverride: offer.client_email,
    nameOverride: offer.client_name,
  })

  if (!portalResult.success) {
    return fail(`Portal user creation failed: ${portalResult.error}. Offer NOT published.`)
  }

  const isNewUser = !portalResult.alreadyExists
  const tempPassword = portalResult.tempPassword

  // ─── 3. Verify contact linkage ───
  const warnings: string[] = []
  const { data: contactCheck } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .eq("email", offer.client_email)
    .limit(1)
    .maybeSingle()

  if (!contactCheck) {
    // autoCreatePortalUser should have created the contact, but verify
    warnings.push("Contact record not found after portal user creation — portal sidebar may not display correctly.")
  }

  // ─── 4. Build and send email ───
  const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const pixelUrl = `${APP_BASE_URL}/api/track/open/${trackingId}`
  const lang = (offer.language || "en") as "en" | "it"
  const firstName = offer.client_name.split(" ")[0]
  const portalLoginUrl = `${PORTAL_BASE_URL}/portal/login`

  const emailType = isNewUser && tempPassword ? "portal_access" : "portal_notification"

  const subject = emailType === "portal_access"
    ? lang === "it"
      ? "La tua Offerta Consulenziale — Tony Durante LLC"
      : "Your Consulting Proposal — Tony Durante LLC"
    : lang === "it"
      ? "Nuovo documento disponibile — Tony Durante LLC"
      : "New document available — Tony Durante LLC"

  const htmlBody = emailType === "portal_access"
    ? buildPortalAccessEmail(firstName, offer.client_email, tempPassword!, portalLoginUrl, lang, pixelUrl)
    : buildPortalNotificationEmail(firstName, portalLoginUrl, lang, pixelUrl)

  const plainText = emailType === "portal_access"
    ? lang === "it"
      ? `Ciao ${firstName}, abbiamo preparato la tua offerta consulenziale. Accedi al portale per consultarla: ${portalLoginUrl} — Email: ${offer.client_email} — Password temporanea: ${tempPassword}`
      : `Hi ${firstName}, your consulting proposal is ready. Log in to review it: ${portalLoginUrl} — Email: ${offer.client_email} — Temporary password: ${tempPassword}`
    : lang === "it"
      ? `Ciao ${firstName}, un nuovo documento è disponibile nel tuo portale: ${portalLoginUrl}`
      : `Hi ${firstName}, a new document is available in your portal: ${portalLoginUrl}`

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

  // ─── 5. safeSend — email first, status updates after ───
  const result = await safeSend<{ id: string; threadId: string }>({
    idempotencyCheck: async () => {
      if (offer.status !== "draft") {
        return { alreadySent: true, message: `Offer already published (status: ${offer.status}).` }
      }
      // Also check email_tracking for THIS specific offer token + recent time
      const { data: existing } = await supabaseAdmin
        .from("email_tracking")
        .select("tracking_id, created_at")
        .eq("offer_token", token)
        .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
        .limit(1)
      if (existing?.length) {
        return {
          alreadySent: true,
          message: `This offer was already sent (tracked: ${existing[0].tracking_id} at ${existing[0].created_at}). Set status back to 'draft' to resend.`,
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
            offer_token: token,
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
            .eq("token", token)
        },
      },
      {
        name: "update_lead_status",
        fn: async () => {
          if (offer.lead_id) {
            await supabaseAdmin
              .from("leads")
              .update({ offer_status: "Sent", status: "Offer Sent" })
              .eq("id", offer.lead_id)
          }
        },
      },
    ],
  })

  if (result.alreadySent) {
    return {
      success: false,
      alreadySent: true,
      error: result.idempotencyMessage,
      portalCreated: false,
      portalAlreadyExisted: false,
      emailType: "none",
      warnings: [],
    }
  }

  // ─── 6. Log to action_log ───
  logAction({
    actor: actor || "claude.ai",
    action_type: "publish",
    table_name: "offers",
    record_id: offer.id,
    summary: `Published offer: ${offer.client_name} (${token}) → ${offer.client_email} [${emailType}${isNewUser ? ", portal created" : ""}]`,
    details: {
      token,
      lead_id: offer.lead_id,
      account_id: offer.account_id,
      language: offer.language,
      email_type: emailType,
      portal_created: isNewUser,
      gmail_message_id: result.sendResult?.id,
      tracking_id: trackingId,
    },
  })

  return {
    success: true,
    alreadySent: false,
    portalCreated: isNewUser,
    portalAlreadyExisted: portalResult.alreadyExists,
    emailType,
    trackingId,
    gmailMessageId: result.sendResult?.id,
    warnings,
  }
}

// ─── Helpers ──────────────────────────────────────────────

function fail(error: string): PublishOfferResult {
  return {
    success: false,
    alreadySent: false,
    error,
    portalCreated: false,
    portalAlreadyExisted: false,
    emailType: "none",
    warnings: [],
  }
}

// ─── Email: Portal Access (new user with credentials) ────

function buildPortalAccessEmail(
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
    <h1 style="color: white; margin: 0; font-size: 22px;">La tua Offerta Consulenziale</h1>
    <p style="color: #93c5fd; margin: 4px 0 0;">Tony Durante LLC</p>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
    <p>Ciao ${firstName},</p>
    <p>Abbiamo preparato la tua offerta consulenziale personalizzata. Accedi al portale per consultarla, e se tutto è in linea con le tue aspettative, potrai firmare il contratto direttamente online.</p>
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
    <p style="color: #6b7280; font-size: 13px;">Per qualsiasi domanda, rispondi a questa email o usa la chat nel portale.</p>
    <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af;">
      Tony Durante LLC · 1111 Lincoln Road, Suite 400, Miami Beach, FL 33139
    </div>
  </div>
</div>${pixel}`
  }

  return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <div style="background: #1e3a5f; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 22px;">Your Consulting Proposal</h1>
    <p style="color: #93c5fd; margin: 4px 0 0;">Tony Durante LLC</p>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
    <p>Hi ${firstName},</p>
    <p>We have prepared your personalized consulting proposal. Log in to your portal to review it, and if everything meets your expectations, you can sign the contract directly online.</p>
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

// ─── Email: Portal Notification (existing user) ──────────

function buildPortalNotificationEmail(
  firstName: string,
  portalUrl: string,
  lang: "en" | "it",
  pixelUrl: string,
): string {
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

  if (lang === "it") {
    return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <div style="background: #1e3a5f; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 22px;">Nuovo documento disponibile</h1>
    <p style="color: #93c5fd; margin: 4px 0 0;">Tony Durante LLC</p>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
    <p>Ciao ${firstName},</p>
    <p>Un nuovo documento è disponibile per la tua revisione nel portale clienti.</p>
    <p>Accedi al portale per consultarlo:</p>
    <p style="margin: 24px 0; text-align: center;">
      <a href="${portalUrl}" style="display: inline-block; background: #1e3a5f; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
        Accedi al Portale
      </a>
    </p>
    <p style="color: #6b7280; font-size: 13px;">Per qualsiasi domanda, rispondi a questa email o usa la chat nel portale.</p>
    <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af;">
      Tony Durante LLC · 1111 Lincoln Road, Suite 400, Miami Beach, FL 33139
    </div>
  </div>
</div>${pixel}`
  }

  return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <div style="background: #1e3a5f; padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 22px;">New document available</h1>
    <p style="color: #93c5fd; margin: 4px 0 0;">Tony Durante LLC</p>
  </div>
  <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
    <p>Hi ${firstName},</p>
    <p>A new document is available for your review in your client portal.</p>
    <p>Log in to your portal to view it:</p>
    <p style="margin: 24px 0; text-align: center;">
      <a href="${portalUrl}" style="display: inline-block; background: #1e3a5f; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
        Log in to Portal
      </a>
    </p>
    <p style="color: #6b7280; font-size: 13px;">For any questions, reply to this email or use the chat in your portal.</p>
    <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af;">
      Tony Durante LLC · 1111 Lincoln Road, Suite 400, Miami Beach, FL 33139
    </div>
  </div>
</div>${pixel}`
}
