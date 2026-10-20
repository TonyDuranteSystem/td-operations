/**
 * S3 of the workspace-only plan (dev job 0a07e0cd, Antonio approved the wording 2026-10-20):
 * when a service where WE act first is created, the client gets ONE short message in that service's own chat topic
 * and ONE bell row. The bell row is NOT kept out of the email digest on purpose: the portal digest (app/api/cron/portal-digest)
 * already batches everything unsent for a client into a single email, so a contract that starts several services
 * produces one grouped email — the "grouped email" of the plan — with no second email path.
 *
 * Services covered: Public Notary, Shipping, Certificate of Incumbency, EIN Change Name. Company Change Name already asks
 * for its names at creation, and Company Closure keeps its welcome and its home-page card (a second pointer would repeat the card).
 *
 * ⛔ NEW SERVICES ONLY. Nothing here runs until the go-live switch (app_settings `service_start_notices_go_live`, an ISO timestamp)
 * is set, and then only for services created at or after that moment. Unset or unreadable = OFF (fails closed): a settings read
 * error must never make the system message every open service.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { getAppSetting } from '@/lib/settings'
import { localeFromLanguage, type Locale } from '@/lib/locale'
import { renderTemplate } from '@/lib/portal/welcome-message'
import { createPortalNotification } from '@/lib/portal/notifications'
import { buildPortalChatLink } from '@/lib/portal/chat-link'
import { SERVICE_STARTED_NOTIFICATION_TYPE } from '@/lib/portal/digest-render'
import { buildFlowTopic, deriveFlowYear } from '@/lib/flows/resolve-flows'
import { wantsServiceStartNotice } from '@/lib/operations/service-start-types'
import { getEntryByServiceType } from '@/lib/services'

export const SERVICE_START_GO_LIVE_KEY = 'service_start_notices_go_live' as const
export { SERVICE_STARTED_NOTIFICATION_TYPE }
const SERVICE_STARTED_CATALOG_SLUG = 'service_started'

/** Same stable system-admin sender the activation welcome and the action-required messages use (portal_messages.sender_id is NOT NULL, no FK). */
const SYSTEM_ADMIN_SENDER_ID = 'b0da5d9c-acf6-4761-9cae-2c3b14dbc631'

/** Used only when the catalog row is missing (migration not applied yet). The catalog row is the editable source. */
export const SERVICE_STARTED_FALLBACK = {
  en: {
    title: '{{serviceName}} — nothing needed from you for now',
    body: 'Hi {{firstName}}, your {{serviceName}} for {{companyName}} has started. Nothing is needed from you right now. We will write to you here as soon as we need something, or when it is done.',
  },
  it: {
    title: '{{serviceName}} — per ora non devi fare nulla',
    body: 'Ciao {{firstName}}, il servizio {{serviceName}} per {{companyName}} è partito. Per ora non devi fare nulla. Ti scriviamo qui appena ci serve qualcosa, oppure quando è completato.',
  },
} as const

/** Earliest moment the switch may name. A typo such as "1" or "2026" parses as an old date and would switch the Action Items lines on for every
 *  service that already exists, so anything before S3 existed is refused (= switch off). */
export const SERVICE_START_GO_LIVE_FLOOR = new Date('2026-10-01T00:00:00.000Z')
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

/** Pure: the stored go-live value as a Date, or null when it is unset, not a full ISO timestamp, or before the floor. */
export function parseGoLive(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!STRICT_ISO.test(v)) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime()) || d.getTime() < SERVICE_START_GO_LIVE_FLOOR.getTime()) return null
  return d
}

/** Pure: was a service created at or after go-live? No go-live (null) = never. */
export function createdAfterGoLive(goLive: Date | null, createdAt: string | Date | null | undefined): boolean {
  if (!goLive || !createdAt) return false
  const t = (createdAt instanceof Date ? createdAt : new Date(createdAt)).getTime()
  return Number.isFinite(t) && t >= goLive.getTime()
}

/** The go-live moment, or null (switch off). Fails closed. */
export async function getServiceStartGoLive(): Promise<Date | null> {
  try {
    return parseGoLive(await getAppSetting<unknown>(SERVICE_START_GO_LIVE_KEY, null))
  } catch {
    return null
  }
}

/**
 * Pure: render the message. Without a company (a person-level service such as a notary job for an individual) the
 * " for {{companyName}}" / " per {{companyName}}" part is dropped instead of printing a placeholder.
 */
export function renderServiceStartedText(
  template: { title: string; body: string },
  vars: { firstName?: string | null; serviceName: string; companyName?: string | null },
): { title: string; body: string } {
  const company = vars.companyName?.trim() || ''
  const prep = (s: string) => (company ? s : s.replace(/\s+(?:for|per)\s+\{\{companyName\}\}/g, ''))
  const v: Record<string, string | undefined> = {
    firstName: vars.firstName?.trim() || undefined,
    serviceName: vars.serviceName,
    companyName: company || undefined,
  }
  // No first name on file: "Hi ," would look broken — greet without it.
  const greetFix = (s: string) => (v.firstName ? s : s.replace(/^(Hi|Ciao) \{\{firstName\}\},/, '$1,'))
  return {
    title: renderTemplate(prep(template.title), v),
    body: renderTemplate(greetFix(prep(template.body)), v),
  }
}

async function loadTemplate(lang: Locale): Promise<{ title: string; body: string }> {
  try {
    const { data } = await supabaseAdmin
      .from('catalog_entries')
      .select('display_name, display_name_translations, description, description_translations, status')
      .eq('catalog_id', 'welcome_messages')
      .eq('slug', SERVICE_STARTED_CATALOG_SLUG)
      .neq('status', 'deprecated')
      .maybeSingle()
    if (data) {
      const titleIt = (data.display_name_translations as Record<string, string> | null)?.it
      const bodyIt = (data.description_translations as Record<string, string> | null)?.it
      const title = lang === 'it' && titleIt ? titleIt : data.display_name
      const body = lang === 'it' && bodyIt ? bodyIt : data.description ?? ''
      if (title && body) return { title, body }
    }
  } catch {
    /* fall through to the built-in text */
  }
  return SERVICE_STARTED_FALLBACK[lang]
}

export interface ServiceStartNoticeResult {
  ok: boolean
  skipped?: string
  error?: string
}

/**
 * Announce a freshly created service to the client. Idempotent per service (the exact message is looked up first) and
 * best-effort: it NEVER throws, because the staff action or the payment that created the service must not fail over a message.
 */
export async function announceServiceStarted(sdId: string): Promise<ServiceStartNoticeResult> {
  try {
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, service_name, status, account_id, contact_id, created_at, stage_entered_at, due_date')
      .eq('id', sdId)
      .maybeSingle()
    if (sdErr) throw new Error(`could not read the service: ${sdErr.message}`)
    if (!sd) return { ok: false, error: 'Service delivery not found.' }
    if (!wantsServiceStartNotice(sd.service_type)) return { ok: true, skipped: 'this service sends no start message' }
    if (sd.status !== 'active') return { ok: true, skipped: `service is ${sd.status}` }

    const goLive = await getServiceStartGoLive()
    if (!createdAfterGoLive(goLive, sd.created_at)) return { ok: true, skipped: 'S3 is off, or this service started before go-live' }

    // Who to tell, in their language.
    let contactId: string | null = sd.contact_id ?? null
    if (!contactId && sd.account_id) {
      const { data: link } = await supabaseAdmin
        .from('account_contacts')
        .select('contact_id')
        .eq('account_id', sd.account_id)
        .order('contact_id', { ascending: true })
        .limit(1)
      contactId = link?.[0]?.contact_id ?? null
    }
    if (!contactId && !sd.account_id) return { ok: true, skipped: 'nobody to tell (no contact, no company)' }

    let language: string | null = null
    let firstName: string | null = null
    if (contactId) {
      const { data: c, error: cErr } = await supabaseAdmin.from('contacts').select('language, full_name, first_name').eq('id', contactId).maybeSingle()
      // A failed read must not quietly become an English message to an Italian client.
      if (cErr) throw new Error(`could not read the client: ${cErr.message}`)
      language = c?.language ?? null
      firstName = c?.first_name || (c?.full_name ? c.full_name.split(/\s+/)[0] : null) || null
    }
    const lang: Locale = localeFromLanguage(language)

    let companyName: string | null = null
    let accountStatus: string | null = null
    if (sd.account_id) {
      const { data: a, error: aErr } = await supabaseAdmin.from('accounts').select('company_name, status').eq('id', sd.account_id).maybeSingle()
      // A failed read must not quietly move the message to the personal thread and drop the company name.
      if (aErr || !a) throw new Error(`could not read the company: ${aErr?.message ?? 'not found'}`)
      companyName = a?.company_name ?? null
      accountStatus = a?.status ?? null
    }

    // What the client reads is the catalog's name for the service ("Shipping Service", not the stored type "Shipping"). The stored
    // service_name is never used: every creator fills it with an internal label ("Shipping - Mario Rossi", "Public Notary — Acme LLC #2").
    let serviceName = ''
    try {
      serviceName = (await getEntryByServiceType(sd.service_type))?.display_name ?? ''
    } catch {
      /* the stored type is still readable */
    }
    const template = await loadTemplate(lang)
    const { title, body } = renderServiceStartedText(template, {
      firstName,
      serviceName: serviceName || sd.service_type,
      companyName,
    })

    // The service's own chat topic — the same label the workspace chat of this service uses.
    const topic = buildFlowTopic(sd.service_type, deriveFlowYear(sd)) || null
    // VISIBLE-THREAD RULE (same as lib/portal/action-required.ts): a company the portal hides carries nothing; tag the personal thread.
    const chatAccountTag = sd.account_id && (accountStatus === 'Active' || accountStatus === 'Suspended') ? sd.account_id : null

    // Idempotency: this exact message already sits in this service's thread (retry, double click, replayed webhook).
    const { data: already } = await supabaseAdmin
      .from('portal_messages')
      .select('id')
      .eq('service_delivery_id', sd.id)
      .eq('sender_id', SYSTEM_ADMIN_SENDER_ID)
      .eq('message', body)
      .limit(1)
    if (already && already.length > 0) return { ok: true, skipped: 'already announced' }

    // Inserted directly (NOT through the chat route) so the R103 "new chat message" email does not fire on top of the digest.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_id is not in the generated portal_messages types
    const { error: chatErr } = await (supabaseAdmin as any).from('portal_messages').insert({
      account_id: chatAccountTag,
      contact_id: contactId,
      service_delivery_id: sd.id,
      topic,
      sender_type: 'admin',
      sender_id: SYSTEM_ADMIN_SENDER_ID,
      message: body,
    })
    if (chatErr) throw new Error(`chat message: ${chatErr.message}`)

    // Bell + push + (via the 5-minute digest) the one grouped email. Failure here must not undo the chat message.
    const bell = await createPortalNotification({
      account_id: sd.account_id ?? undefined,
      contact_id: contactId ?? undefined,
      type: SERVICE_STARTED_NOTIFICATION_TYPE,
      title,
      body,
      link: buildPortalChatLink({ accountId: chatAccountTag, topic }),
    })
    if (bell?.error) {
      // The chat message is already there (a retry would stop at "already announced"), so say so loudly instead of leaving no trace.
      console.error(`[service-start-notice] bell failed for SD ${sd.id}: ${bell.error}`)
      try {
        const { reportSystemError } = await import('@/lib/system-errors')
        await reportSystemError({
          source: 'server',
          route: 'lib/operations/service-start-notice.ts:announceServiceStarted',
          message: `The "service started" message was posted but its bell notification / email entry failed (SD ${sd.id}): ${bell.error}. The client has the chat message only.`,
          context: { service_delivery_id: sd.id },
        })
      } catch {
        /* never mask the original failure */
      }
    }

    try {
      const { logAction } = await import('@/lib/mcp/action-log')
      logAction({
        actor: 'system',
        action_type: 'create',
        table_name: 'portal_messages',
        record_id: null,
        account_id: sd.account_id ?? undefined,
        summary: `Service start message: ${sd.service_type}`,
        details: { service_delivery_id: sd.id, topic, contact_id: contactId, bell: bell?.error ? `failed: ${bell.error}` : 'ok' },
      })
    } catch {
      /* audit is best-effort */
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[service-start-notice] failed for SD ${sdId}: ${message}`)
    try {
      const { reportSystemError } = await import('@/lib/system-errors')
      await reportSystemError({
        source: 'server',
        route: 'lib/operations/service-start-notice.ts:announceServiceStarted',
        message: `The client could not be told that their service started (SD ${sdId}): ${message}. Write to them in the portal chat yourself.`,
        context: { service_delivery_id: sdId },
      })
    } catch {
      /* never mask the original failure */
    }
    return { ok: false, error: message }
  }
}
