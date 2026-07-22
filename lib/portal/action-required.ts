/**
 * Client "Action Required" notifications — the single dispatch point for
 * telling a client they must DO something (sign a document, fill a form,
 * mail a package), as opposed to the passive "status updated" notices.
 *
 * Born from the Michele Cotti SS-4 case (2026-07-02): his formation reached
 * "SS-4 Prepared" (portal label "Sign your SS-4") and the only signal he got
 * was a generic "Status updated to: SS-4 Prepared" — he had to ask for a
 * follow-up. Audit found EVERY SS-4 send path was silent.
 *
 * One call dispatches, best-effort per channel (a failure in one channel
 * never blocks the others, and the helper NEVER throws — the staff action
 * that triggered it must not fail because Gmail hiccupped):
 *
 *   1. Portal chat message — clickable deep link (portal-chat.tsx
 *      auto-linkifies URLs; internal links navigate in-app). Inserted
 *      directly into portal_messages (NOT via the chat route) so the R103
 *      "new chat message" email does NOT also fire — the helper sends its
 *      own email below. Stamped with service_delivery_id when available so
 *      staff see the exact message in the workspace flow chat.
 *      VISIBLE-THREAD RULE: if the account's status hides it from the portal
 *      (getPortalAccounts shows only Active/Suspended), the message is tagged
 *      to the client's PERSONAL thread (account_id NULL) instead — a message
 *      in an invisible thread is as bad as no message.
 *   2. IMMEDIATE email — branded, bilingual (canonical locale normalizer),
 *      deep-link CTA. Antonio's decision 2026-07-02: action-required moments
 *      email immediately, not via the 5-minute digest.
 *   3. Portal bell + web push — createPortalNotification with
 *      suppressDigestEmail so the digest cron can never send a SECOND email
 *      (the row is born with email_sent_at set).
 *
 * Dedup: a second call with the same dedup scope (type+link+recipient)
 * within DEDUP_WINDOW_MS is skipped entirely — guards double-clicked staff
 * buttons and concurrent webhook retries. A genuine later re-send (e.g.
 * resend-ss4 after a bad signature) is outside the window and notifies again.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { PORTAL_BASE_URL } from '@/lib/config'
import { localeFromLanguage, type Locale } from '@/lib/locale'
import { createPortalNotification } from './notifications'
import { logAction } from '@/lib/mcp/action-log'

/** Same stable system-admin sender the ITIN advance + activation welcome use
 * (portal_messages.sender_id is NOT NULL, no FK). */
const SYSTEM_ADMIN_SENDER_ID = 'b0da5d9c-acf6-4761-9cae-2c3b14dbc631'

/** Notification type — one value for every action-required dispatch so the
 * dedup check, dashboards and future reminder cron can key off it. */
export const ACTION_REQUIRED_TYPE = 'action_required'

/** Double-fire guard window. Deliberately short: it protects against
 * double-clicks/races, NOT against deliberate same-day re-sends. */
const DEDUP_WINDOW_MS = 10 * 60 * 1000

export interface LocalizedText {
  en: string
  it: string
}

export interface ActionRequiredParams {
  /** Recipient contact (preferred — the person who must act, e.g. the SS-4
   * signer). At least one of contact_id / account_id is required. */
  contact_id?: string | null
  /** Account context. Used for the chat thread tag (subject to the
   * visible-thread rule) and as recipient fallback when no contact_id. */
  account_id?: string | null
  /** Stamped on the chat message so it threads into the workspace flow chat. */
  service_delivery_id?: string | null
  /** Chat topic (e.g. the flow name). Optional. */
  topic?: string | null
  /** Short title, per locale — bell notification title + email subject. */
  title: LocalizedText
  /** Full message, per locale — chat body + email body. The deep link is
   * appended automatically; don't include the URL in the text. */
  message: LocalizedText
  /** Portal-relative action path (e.g. "/portal/sign/ss4"). Rendered as an
   * absolute PORTAL_BASE_URL link in chat/email; stored relative on the
   * bell notification (the portal navigates internally). Also the dedup
   * scope — give per-entity actions a unique link (e.g.
   * "/portal/invoices?inv=<id>") so two different invoices both notify.
   *
   * An ALREADY-ABSOLUTE url (http/https) is passed through untouched. That is
   * for recipients who may not be able to use the portal at all: an operating-
   * agreement co-signer is identified by a row in the members table and need
   * not be linked to the company as a portal user, so a portal-relative link
   * can resolve to the wrong company — or to nothing — for them. Their
   * token+code signing link works with no login. Use this sparingly; the
   * portal-relative form is right for anyone who does have portal access. */
  link: string
  /** Skip the email channel — for callers that already send their own richer
   * email (e.g. the invoice mailer attaches the PDF). Chat + bell/push still
   * dispatch. */
  skipEmail?: boolean
  /** Email CTA button label, per locale. Defaults to the generic
   * "Take action" / "Vai all'azione" — override for informational dispatches
   * (e.g. "View document" when delivering an ITIN letter). */
  ctaLabel?: LocalizedText
}

export interface ActionRequiredResult {
  dispatched: boolean
  /** 'ok' | 'skipped: …' | 'failed: …' per channel */
  chat: string
  notification: string
  email: string
}

type Recipient = { contactId: string | null; email: string | null; firstName: string | null; locale: Locale }

/** Resolve who receives the email + which locale the copy uses. */
async function resolveRecipients(params: ActionRequiredParams): Promise<Recipient[]> {
  if (params.contact_id) {
    const { data: c } = await supabaseAdmin
      .from('contacts')
      .select('id, email, full_name, language')
      .eq('id', params.contact_id)
      .maybeSingle()
    if (c) {
      return [{
        contactId: c.id,
        email: c.email ?? null,
        firstName: c.full_name?.split(/\s+/)[0] ?? null,
        locale: localeFromLanguage(c.language),
      }]
    }
    return []
  }
  if (params.account_id) {
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('contacts(id, email, full_name, language)')
      .eq('account_id', params.account_id)
    return (links ?? [])
      .map((l) => {
        const c = l.contacts as { id: string; email: string | null; full_name: string | null; language: string | null } | null
        if (!c) return null
        return {
          contactId: c.id,
          email: c.email ?? null,
          firstName: c.full_name?.split(/\s+/)[0] ?? null,
          locale: localeFromLanguage(c.language),
        }
      })
      .filter((r): r is Recipient => r !== null)
  }
  return []
}

/** VISIBLE-THREAD RULE: an account whose status hides it from the client
 * portal (getPortalAccounts shows only Active/Suspended) must not carry the
 * chat message — tag the personal thread instead. */
async function resolveChatAccountTag(accountId: string | null | undefined): Promise<string | null> {
  if (!accountId) return null
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('status')
    .eq('id', accountId)
    .maybeSingle()
  const visible = account?.status === 'Active' || account?.status === 'Suspended'
  return visible ? accountId : null
}

function buildActionEmailHtml(opts: {
  greeting: string
  message: string
  ctaLabel: string
  ctaUrl: string
  footerText: string
}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#0A3161;padding:20px;border-radius:12px 12px 0 0;">
        <img src="https://app.tonydurante.us/images/logo.jpg" alt="Tony Durante LLC" style="height:40px;" />
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
        <p style="margin:0 0 16px;">${esc(opts.greeting)}</p>
        <p style="margin:0 0 24px;color:#27272a;">${esc(opts.message)}</p>
        <a href="${opts.ctaUrl}" style="display:inline-block;padding:12px 28px;background:#0A3161;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;font-family:Georgia,serif;">
          ${esc(opts.ctaLabel)}
        </a>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px;">${esc(opts.footerText)}</p>
      </div>
    </div>
  `
}

/**
 * Dispatch an action-required notification to the client across all three
 * channels. Never throws; returns per-channel results for auto_triggers /
 * route responses.
 */
export async function notifyClientActionRequired(params: ActionRequiredParams): Promise<ActionRequiredResult> {
  const result: ActionRequiredResult = {
    dispatched: false,
    chat: 'skipped: not attempted',
    notification: 'skipped: not attempted',
    email: 'skipped: not attempted',
  }

  try {
    if (!params.contact_id && !params.account_id) {
      const msg = 'skipped: no recipient (contact_id or account_id required)'
      result.chat = result.notification = result.email = msg
      return result
    }

    // ── Dedup guard ─────────────────────────────────────────────────────
    const windowStart = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString()
    let dedupQuery = supabaseAdmin
      .from('portal_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('type', ACTION_REQUIRED_TYPE)
      .eq('link', params.link)
      .gt('created_at', windowStart)
    dedupQuery = params.contact_id
      ? dedupQuery.eq('contact_id', params.contact_id)
      : dedupQuery.eq('account_id', params.account_id as string)
    const { count: recent } = await dedupQuery
    if (recent && recent > 0) {
      const msg = 'skipped: duplicate within dedup window'
      result.chat = result.notification = result.email = msg
      return result
    }

    const recipients = await resolveRecipients(params)
    // Chat + bell fall back to the primary target's locale; English when the
    // recipient couldn't be resolved (message still delivered — a wrong-locale
    // message beats silence).
    const primaryLocale: Locale = recipients[0]?.locale ?? 'en'
    // Absolute links pass through; relative ones hang off the portal.
    const absoluteUrl = /^https?:\/\//i.test(params.link)
      ? params.link
      : `${PORTAL_BASE_URL}${params.link}`

    // ── 1. Portal chat message (clickable) ──────────────────────────────
    try {
      const chatAccountTag = await resolveChatAccountTag(params.account_id)
      const chatBody = `${params.message[primaryLocale]}\n\n${absoluteUrl}`
      // service_delivery_id is not in the generated portal_messages Insert
      // type until the column is in production types; cast keeps build green
      // (same pattern as the ITIN advance message in lib/service-delivery.ts).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: chatErr } = await (supabaseAdmin as any).from('portal_messages').insert({
        account_id: chatAccountTag,
        contact_id: params.contact_id ?? null,
        service_delivery_id: params.service_delivery_id ?? null,
        topic: params.topic ?? null,
        sender_type: 'admin',
        sender_id: SYSTEM_ADMIN_SENDER_ID,
        message: chatBody,
      })
      result.chat = chatErr ? `failed: ${chatErr.message}` : 'ok'
    } catch (err) {
      result.chat = `failed: ${err instanceof Error ? err.message : String(err)}`
    }

    // ── 2. Bell + push (digest email suppressed — we email directly) ────
    try {
      await createPortalNotification({
        account_id: params.account_id ?? undefined,
        contact_id: params.contact_id ?? undefined,
        type: ACTION_REQUIRED_TYPE,
        title: params.title[primaryLocale],
        body: params.message[primaryLocale],
        link: params.link,
        suppressDigestEmail: true,
      })
      result.notification = 'ok'
    } catch (err) {
      result.notification = `failed: ${err instanceof Error ? err.message : String(err)}`
    }

    // ── 3. Immediate email ──────────────────────────────────────────────
    try {
      const emailable = params.skipEmail ? [] : recipients.filter((r) => !!r.email)
      if (params.skipEmail) {
        result.email = 'skipped: caller sends its own email'
      } else if (emailable.length === 0) {
        result.email = 'skipped: no recipient email'
      } else {
        const { gmailPost } = await import('@/lib/gmail')
        let sent = 0
        let failed = 0
        for (const r of emailable) {
          const isIt = r.locale === 'it'
          const greeting = r.firstName ? (isIt ? `Ciao ${r.firstName},` : `Hi ${r.firstName},`) : (isIt ? 'Ciao,' : 'Hi,')
          const subject = params.title[r.locale]
          const html = buildActionEmailHtml({
            greeting,
            message: params.message[r.locale],
            ctaLabel: params.ctaLabel ? params.ctaLabel[r.locale] : (isIt ? 'Vai all’azione' : 'Take action'),
            ctaUrl: absoluteUrl,
            footerText: isIt ? 'Tony Durante LLC — Portale Clienti' : 'Tony Durante LLC — Client Portal',
          })
          try {
            // RFC 2047 subject encoding (R041)
            const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
            const boundary = `boundary_${Date.now()}_${sent + failed}`
            const raw = [
              `From: Tony Durante LLC <support@tonydurante.us>`,
              `To: ${r.email}`,
              `Subject: ${encodedSubject}`,
              `MIME-Version: 1.0`,
              `Content-Type: multipart/alternative; boundary="${boundary}"`,
              '',
              `--${boundary}`,
              `Content-Type: text/html; charset=UTF-8`,
              `Content-Transfer-Encoding: base64`,
              '',
              Buffer.from(html).toString('base64'),
              `--${boundary}--`,
            ].join('\r\n')
            await gmailPost('/messages/send', { raw: Buffer.from(raw).toString('base64url') })
            sent++
          } catch (err) {
            console.error(`[notifyClientActionRequired] Email failed for ${r.email}:`, err)
            failed++
          }
        }
        result.email = failed === 0 ? `ok (${sent} sent)` : `partial: ${sent} sent, ${failed} failed`
      }
    } catch (err) {
      result.email = `failed: ${err instanceof Error ? err.message : String(err)}`
    }

    result.dispatched = true

    // Audit trail — when a client says "I got nothing", this row proves what
    // was dispatched, when, and on which channels.
    logAction({
      actor: 'system',
      action_type: 'create',
      table_name: 'portal_notifications',
      record_id: null,
      account_id: params.account_id ?? undefined,
      summary: `Action-required notification: ${params.title.en}`,
      details: {
        link: params.link,
        contact_id: params.contact_id ?? null,
        service_delivery_id: params.service_delivery_id ?? null,
        channels: { chat: result.chat, notification: result.notification, email: result.email },
      },
    })

    return result
  } catch (err) {
    // Absolute backstop — the calling staff action must never fail.
    const msg = `failed: ${err instanceof Error ? err.message : String(err)}`
    if (result.chat === 'skipped: not attempted') result.chat = msg
    if (result.notification === 'skipped: not attempted') result.notification = msg
    if (result.email === 'skipped: not attempted') result.email = msg
    return result
  }
}

/**
 * SS-4 domain wrapper — call whenever an ss4_applications row transitions to
 * 'awaiting_signature' (all four sites: createSS4 ready_to_sign, flow
 * send-ss4, flow resend-ss4, ss4_update explicit promotion).
 *
 * Recipient = the SIGNER (ss4.contact_id — the responsible party), NOT every
 * LLC member: on an MMLLC exactly one member signs, and messaging the others
 * invites the wrong signature (the AI Venture Labs Gaia/Michele precedent).
 * Falls back to account-wide recipients when the row carries no contact_id
 * (legacy rows).
 */
export async function notifySs4ReadyToSign(opts: {
  ss4Id: string
  serviceDeliveryId?: string | null
}): Promise<ActionRequiredResult> {
  try {
    const { data: ss4 } = await supabaseAdmin
      .from('ss4_applications')
      .select('id, account_id, contact_id, company_name, status')
      .eq('id', opts.ss4Id)
      .maybeSingle()

    if (!ss4 || ss4.status !== 'awaiting_signature') {
      return {
        dispatched: false,
        chat: 'skipped: SS-4 not awaiting_signature',
        notification: 'skipped: SS-4 not awaiting_signature',
        email: 'skipped: SS-4 not awaiting_signature',
      }
    }

    const company = ss4.company_name || 'your company'
    return await notifyClientActionRequired({
      contact_id: ss4.contact_id ?? null,
      account_id: ss4.account_id ?? null,
      service_delivery_id: opts.serviceDeliveryId ?? null,
      topic: null,
      title: {
        en: `Sign your SS-4 — ${company}`,
        it: `Firma il tuo SS-4 — ${company}`,
      },
      message: {
        en: `Your SS-4 (the EIN application for ${company}) is ready for your signature. Please open your portal and sign it — it only takes a minute.`,
        it: `Il tuo modulo SS-4 (la richiesta EIN per ${company}) è pronto per la firma. Accedi al portale e firmalo — bastano pochi secondi.`,
      },
      link: '/portal/sign/ss4',
    })
  } catch (err) {
    const msg = `failed: ${err instanceof Error ? err.message : String(err)}`
    return { dispatched: false, chat: msg, notification: msg, email: msg }
  }
}
