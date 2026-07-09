import { supabaseAdmin } from "@/lib/supabase-admin"
import { isItalian } from "@/lib/locale"
import { escapeHtml } from "@/lib/html-escape"
import { PORTAL_BASE_URL } from "@/lib/config"

// The shared "TD support" sender used for admin-authored portal chat messages.
const ADMIN_SENDER_ID = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"

/**
 * Bilingual copy for the "you've been linked as a referrer" notice. Pure —
 * unit tested. The referred person is deliberately NOT named (privacy).
 */
export function buildReferrerLinkedCopy(
  locale: "en" | "it",
  firstName: string | null,
): { subject: string; chat: string; greeting: string; body: string; ctaLabel: string; footer: string } {
  const isIt = locale === "it"
  const greeting = firstName
    ? (isIt ? `Ciao ${firstName},` : `Hi ${firstName},`)
    : (isIt ? "Ciao," : "Hi,")
  if (isIt) {
    return {
      subject: "Grazie per il tuo referral",
      chat: "Grazie per il tuo referral! L'abbiamo registrato. Quando la persona che hai segnalato diventerà nostro cliente, riceverai la tua ricompensa. Puoi seguire i tuoi referral e trovare il tuo link da condividere nella sezione Referral del portale. Ti aggiorneremo.",
      greeting,
      body: "Abbiamo registrato il tuo referral. Quando la persona che hai segnalato diventerà nostro cliente, riceverai la tua ricompensa. Puoi seguire i tuoi referral e trovare il tuo link da condividere nella sezione Referral del portale. Ti terremo aggiornato.",
      ctaLabel: "Vai al Portale",
      footer: "Tony Durante LLC — Portale Clienti",
    }
  }
  return {
    subject: "Thank you for your referral",
    chat: "Thank you for your referral! We've registered it. When the person you referred becomes our client, you'll receive your reward. You can track your referrals and find your link to share in the Referral section of your portal. We'll keep you posted.",
    greeting,
    body: "We've registered your referral. When the person you referred becomes our client, you'll receive your reward. You can track your referrals and find your link to share in the Referral section of your portal. We'll keep you posted.",
    ctaLabel: "Go to Portal",
    footer: "Tony Durante LLC — Client Portal",
  }
}

/**
 * Notify a referrer (a client) that a referral has been linked to them — sends
 * BOTH a portal chat message and a dedicated bilingual email, once per
 * (referrer, referred lead). Fires from every path that ASSOCIATES a referral:
 * the lead-detail referrer picker and the Calendly / intake referral-link
 * booking. NOT the staff manual back-fill (that issues the credit directly).
 *
 * Fully best-effort: never throws, never blocks the caller. Idempotent per
 * (referrer, lead) — a clear-and-relink (which leaves a cancelled row) does not
 * re-notify.
 */
export async function notifyReferrerLinked(params: {
  referralId: string
  referrerContactId?: string | null
  referrerAccountId?: string | null
  referredLeadId: string
}): Promise<void> {
  try {
    const { referralId, referredLeadId } = params
    const referrerContactId = params.referrerContactId ?? null
    let referrerAccountId = params.referrerAccountId ?? null
    if (!referrerContactId && !referrerAccountId) return

    // Dedupe: notify once per (referrer, lead). Any OTHER referral row for this
    // pair (e.g. a cancelled one from a re-link) means we already notified.
    let prior = supabaseAdmin
      .from("referrals")
      .select("id")
      .eq("referred_lead_id", referredLeadId)
      .neq("id", referralId)
      .limit(1)
    prior = referrerContactId
      ? prior.eq("referrer_contact_id", referrerContactId)
      : prior.eq("referrer_account_id", referrerAccountId as string)
    const { data: priorRows } = await prior
    if (priorRows && priorRows.length > 0) return

    // Resolve the referrer's email / name / language, and an account for the
    // chat thread (portal chat is account-scoped).
    let email: string | null = null
    let fullName: string | null = null
    let language = "en"
    if (referrerContactId) {
      const { data: c } = await supabaseAdmin
        .from("contacts")
        .select("email, full_name, language")
        .eq("id", referrerContactId)
        .single()
      email = c?.email ?? null
      fullName = c?.full_name ?? null
      language = c?.language ?? "en"
      if (!referrerAccountId) {
        const { data: link } = await supabaseAdmin
          .from("account_contacts")
          .select("account_id")
          .eq("contact_id", referrerContactId)
          .limit(1)
          .maybeSingle()
        referrerAccountId = (link as { account_id: string } | null)?.account_id ?? null
      }
    } else if (referrerAccountId) {
      const { data: link } = await supabaseAdmin
        .from("account_contacts")
        .select("contacts(email, full_name, language)")
        .eq("account_id", referrerAccountId)
        .limit(1)
        .maybeSingle()
      const c = (link as { contacts: { email: string; full_name: string; language: string } | null } | null)?.contacts ?? null
      email = c?.email ?? null
      fullName = c?.full_name ?? null
      language = c?.language ?? "en"
    }

    const locale: "en" | "it" = isItalian(language) ? "it" : "en"
    const copy = buildReferrerLinkedCopy(locale, fullName?.split(" ")[0] ?? null)

    // 1) Portal chat message (best-effort). Threads hang on account_id.
    if (referrerAccountId) {
      try {
        await supabaseAdmin.from("portal_messages").insert({
          account_id: referrerAccountId,
          contact_id: referrerContactId,
          sender_type: "admin",
          sender_id: ADMIN_SENDER_ID,
          message: copy.chat,
        })
      } catch (chatErr) {
        console.warn("[notifyReferrerLinked] chat message failed:", chatErr instanceof Error ? chatErr.message : String(chatErr))
      }
    }

    // 2) Dedicated bilingual email (best-effort).
    if (email) {
      try {
        const { gmailPost } = await import("@/lib/gmail")
        const portalUrl = `${PORTAL_BASE_URL}/portal`
        const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#0A3161;padding:20px;border-radius:12px 12px 0 0;">
          <img src="https://app.tonydurante.us/images/logo.jpg" alt="Tony Durante LLC" style="height:40px;" />
        </div>
        <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 16px;">${escapeHtml(copy.greeting)}</p>
          <p style="margin:0 0 24px;color:#27272a;">${escapeHtml(copy.body)}</p>
          <a href="${portalUrl}" style="display:inline-block;padding:12px 28px;background:#0A3161;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;font-family:Georgia,serif;">
            ${copy.ctaLabel}
          </a>
          <p style="color:#9ca3af;font-size:12px;margin-top:24px;">${copy.footer}</p>
        </div>
      </div>
    `
        const encodedSubject = `=?utf-8?B?${Buffer.from(copy.subject).toString("base64")}?=`
        const boundary = `boundary_ref_${referralId}`
        const raw = [
          `From: Tony Durante LLC <support@tonydurante.us>`,
          `To: ${email}`,
          `Subject: ${encodedSubject}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          "",
          `--${boundary}`,
          `Content-Type: text/html; charset=UTF-8`,
          `Content-Transfer-Encoding: base64`,
          "",
          Buffer.from(html).toString("base64"),
          `--${boundary}--`,
        ].join("\r\n")
        await gmailPost("/messages/send", { raw: Buffer.from(raw).toString("base64url") })
      } catch (emailErr) {
        console.error("[notifyReferrerLinked] email failed:", emailErr instanceof Error ? emailErr.message : String(emailErr))
      }
    }
  } catch (e) {
    console.error("[notifyReferrerLinked] failed:", e instanceof Error ? e.message : String(e))
  }
}
