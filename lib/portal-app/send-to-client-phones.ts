/**
 * Client iPhone app — the client phone leg: one alert to the registered iPhones of clients and the team members they added (server; dev job 056a70d0, Step 4).
 *
 * ORDER OF WORK (each step ends the leg quietly if its answer is "no"):
 *   key present → client app switch on → this server knows its own client bundle id → whose phones (the SAME people the browser alert reaches, re-checked
 *   against the live links) → their phones (not revoked, seen within 45 days, bundle matches THIS server) → fixed words in the person's language
 *   (lib/portal-app/phone-wording.ts: who and what kind, never what) → the icon number (honest or absent) → send, one connection per Apple address, a few at a
 *   time → remove only phones Apple says are gone.
 * Same discipline as TD Social's leg (lib/app/send-to-phones.ts, not touched): bounded, never throws, a 403 or 429 from Apple stops that address and removes
 * NOTHING, logs hold only a phone's row id and Apple's short reason.
 *
 * WHO (the rule): `contact` scope = the phones whose owner is that contact. `account` scope = the phones of the client contacts linked to the company RIGHT NOW
 * (account_contacts) plus the team members of that company who are active AND may see chat (the browser alert's own rule, lib/portal/team/push-scope.ts).
 * The phone's saved owner is only a pointer; a contact that was unlinked or a team member that was removed gets nothing. Any doubt = nobody (fail closed).
 *
 * `sendToClientPhones` is pure orchestration over injected dependencies (tests use a fake Apple); `sendToClientPhonesLive` wires the real ones.
 */
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isClientAppEnabled } from '@/lib/portal-app/enabled'
import { allowedClientBundleId, currentAppServerEnv } from '@/lib/app/environment'
import { DEVICE_STALE_DAYS } from '@/lib/app/devices'
import { readApnsKey, type ApnsKey } from '@/lib/app/apns-key'
import { APNS_HOSTS, buildApnsRequest, classifyApnsAnswer, connectToApple, providerToken, type ApnsConnect, type ApnsSession } from '@/lib/app/apns'
import { clientAlertKind, clientPhoneWording } from '@/lib/portal-app/phone-wording'
import type { ClientPhoneAlert } from '@/lib/portal-app/client-phone-leg'
import { localeFromLanguage } from '@/lib/locale'
import { hasCapability, normalizeCapabilities } from '@/lib/portal/team/capabilities'

export const MAX_PHONES = 60
export const SEND_TIMEOUT_MS = 5000
export const LEG_DEADLINE_MS = 9000
export const CONCURRENCY = 8
/** A side lookup (the icon number) gets this long; slower than that it is treated as "unknown" and the alert goes without it. */
export const SIDE_LOOKUP_MS = 2500
export const BADGE_CAP = 99

/** A saved phone as the database holds it, with the owner pointers the client app writes at registration. */
export interface OwnedDevice { id: string; user_id: string; token: string; bundle_id: string; apns_env: string; contact_id: string | null; team_account_id: string | null }
export interface ClientPhoneRow extends OwnedDevice { locale: 'en' | 'it' }

/**
 * PURE. Which of these saved phones may be told about this alert, given the live links.
 *  - contact scope: the phones whose owner is that contact.
 *  - account scope: phones of a contact that is linked to the company right now, and phones of a team member of that company who is still active with chat.
 */
export function selectRecipientPhones(
  devices: readonly OwnedDevice[],
  rule: { scope: 'contact' | 'account'; id: string; linkedContactIds: ReadonlySet<string>; activeTeamUserIds: ReadonlySet<string> },
): OwnedDevice[] {
  return devices.filter(d => {
    if (rule.scope === 'contact') return d.contact_id === rule.id && d.team_account_id === null
    if (d.contact_id !== null) return rule.linkedContactIds.has(d.contact_id)
    return d.team_account_id === rule.id && rule.activeTeamUserIds.has(d.user_id)
  })
}

export interface ClientPhoneDeps {
  key: ApnsKey | null
  isOn: () => Promise<boolean>
  bundleId: string | null
  /** the phones to tell, already checked against the live links (any failure should be []) */
  phones: (alert: ClientPhoneAlert, bundleId: string, sinceIso: string) => Promise<ClientPhoneRow[]>
  /** the icon number for one phone's person; null = unknown (the phone keeps the number it has) */
  badge: (phone: ClientPhoneRow) => Promise<number | null>
  connect: ApnsConnect
  revoke: (phoneId: string, reason: string) => Promise<void>
  now: () => number
  /** only a phone row id and Apple's short reason, never a token or key */
  log: (message: string) => void
}

export interface ClientPhoneResult {
  skipped?: string
  attempted: number
  sent: number
  gone: number
  failed: number
  stopped: boolean
}

const empty = (skipped: string): ClientPhoneResult => ({ skipped, attempted: 0, sent: 0, gone: 0, failed: 0, stopped: false })

function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work.then(v => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

export async function sendToClientPhones(alert: ClientPhoneAlert, deps: ClientPhoneDeps): Promise<ClientPhoneResult> {
  // 1. the key; 2. the runtime switch; 3. this server's own client bundle id
  if (!deps.key) return empty('no key')
  if (!(await deps.isOn())) return empty('switched off')
  if (!deps.bundleId) return empty('unknown server')
  const bundleId = deps.bundleId
  const kind = clientAlertKind(alert.kind)

  // 4. their phones (the same people as the browser alert, re-checked against the live links)
  const since = new Date(deps.now() - DEVICE_STALE_DAYS * 86_400_000).toISOString()
  const phones = (await deps.phones(alert, bundleId, since)).filter(p => p.bundle_id === bundleId).slice(0, MAX_PHONES)
  if (phones.length === 0) return empty('no phones')

  // 5. the icon number per person (null = leave the phone's number as it is)
  const people = Array.from(new Set(phones.map(p => p.user_id)))
  const badges = new Map<string, number | null>(await Promise.all(people.map(async id => {
    const phone = phones.find(p => p.user_id === id) as ClientPhoneRow
    return [id, await withDeadline(deps.badge(phone), SIDE_LOOKUP_MS, null)] as const
  })))

  // 6. send
  let jwt: string
  try {
    jwt = providerToken(deps.key, deps.now())
  } catch {
    deps.log('could not sign the provider token (key unreadable)')
    return empty('signing failed')
  }
  const result: ClientPhoneResult = { attempted: 0, sent: 0, gone: 0, failed: 0, stopped: false }
  const sessions = new Map<string, ApnsSession>()
  const hostOf = (env: string): string | null => (env === 'development' ? APNS_HOSTS.development : env === 'production' ? APNS_HOSTS.production : null)
  const sessionFor = (env: string): ApnsSession | null => {
    const host = hostOf(env)
    if (!host) return null
    let s = sessions.get(host)
    if (!s) { s = deps.connect(host); sessions.set(host, s) }
    return s
  }
  // the leg's own deadline: past it nothing more is sent (a late alert is worse than none)
  const deadline = deps.now() + LEG_DEADLINE_MS
  // Apple's refusal of the key or its "slow down" stops only THAT address (a key scoped to one environment fails there and works on the other)
  const stoppedHosts = new Set<string>()
  const queue = phones.slice()
  const worker = async () => {
    for (;;) {
      const phone = queue.shift()
      if (!phone) return
      if (deps.now() > deadline) { result.stopped = true; return }
      const host = hostOf(phone.apns_env)
      if (host && stoppedHosts.has(host)) continue
      const session = sessionFor(phone.apns_env)
      const words = clientPhoneWording(kind, phone.locale)
      const req = session ? buildApnsRequest({
        deviceToken: phone.token, bundleId, jwt, nowMs: deps.now(),
        notification: { title: words.title, body: words.body, url: alert.url, tag: alert.tag, badge: badges.get(phone.user_id) ?? null },
      }) : null
      if (!session || !req) { result.failed++; continue }
      result.attempted++
      let outcome
      try {
        outcome = classifyApnsAnswer(await session.send(req, SEND_TIMEOUT_MS))
      } catch {
        outcome = { kind: 'retry_later' as const, reason: 'connection' }
      }
      if (outcome.kind === 'sent') { result.sent++; continue }
      deps.log(`phone ${phone.id}: ${outcome.kind} (${outcome.reason})`)
      if (outcome.kind === 'gone') {
        result.gone++
        await deps.revoke(phone.id, `apple_${outcome.reason}`).catch(() => undefined)
      } else {
        result.failed++
        // a refused key or a "slow down" must never turn into removals: stop sending to that address, keep every phone
        if ((outcome.kind === 'key_problem' || outcome.kind === 'slow_down') && host) { stoppedHosts.add(host); result.stopped = true }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, phones.length) }, worker))
  } finally {
    sessions.forEach(s => s.close())
  }
  return result
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer table columns than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

const DEVICE_COLUMNS = 'id, user_id, token, bundle_id, apns_env, contact_id, team_account_id'

/** The phones to tell, from the live database. Any failure = []. */
export async function livePhones(alert: ClientPhoneAlert, bundleId: string, sinceIso: string): Promise<ClientPhoneRow[]> {
  try {
    const base = () => db().from('social_app_devices').select(DEVICE_COLUMNS).eq('bundle_id', bundleId).is('revoked_at', null).gte('last_seen_at', sinceIso)
    if (alert.scope === 'contact') {
      const { data: contact, error: cErr } = await db().from('contacts').select('id, language').eq('id', alert.id).maybeSingle()
      if (cErr || !contact) return []
      const { data, error } = await base().eq('contact_id', alert.id).limit(MAX_PHONES)
      if (error) return []
      const rows = selectRecipientPhones((data ?? []) as OwnedDevice[], { scope: 'contact', id: alert.id, linkedContactIds: new Set(), activeTeamUserIds: new Set() })
      const locale = localeFromLanguage((contact as { language?: string | null }).language)
      return rows.map(r => ({ ...r, locale }))
    }
    // account scope: the contacts linked to the company right now, and the team members of the company
    const { data: links, error: lErr } = await db().from('account_contacts').select('contact_id').eq('account_id', alert.id)
    if (lErr) return []
    const contactIds = Array.from(new Set(((links ?? []) as Array<{ contact_id: string | null }>).map(l => l.contact_id).filter((x): x is string => !!x)))
    const orParts = [`team_account_id.eq.${alert.id}`]
    if (contactIds.length > 0) orParts.push(`contact_id.in.(${contactIds.join(',')})`)
    const { data, error } = await base().or(orParts.join(',')).limit(MAX_PHONES)
    if (error) return []
    const devices = (data ?? []) as OwnedDevice[]
    const teamUserIds = Array.from(new Set(devices.filter(d => d.contact_id === null && d.team_account_id === alert.id).map(d => d.user_id)))
    const activeTeam = new Set<string>()
    if (teamUserIds.length > 0) {
      const { data: members, error: tErr } = await db().from('portal_team_members').select('auth_user_id, capabilities, status').eq('account_id', alert.id).in('auth_user_id', teamUserIds)
      if (tErr) return []
      for (const m of (members ?? []) as Array<{ auth_user_id: string; capabilities: unknown; status: string }>) {
        if (m.status === 'active' && hasCapability(normalizeCapabilities(m.capabilities), 'chat')) activeTeam.add(m.auth_user_id)
      }
    }
    const rows = selectRecipientPhones(devices, { scope: 'account', id: alert.id, linkedContactIds: new Set(contactIds), activeTeamUserIds: activeTeam })
    // wording language: a client's own language; a team member's portal language
    const localeByContact = new Map<string, 'en' | 'it'>()
    const wantContacts = Array.from(new Set(rows.map(r => r.contact_id).filter((x): x is string => !!x)))
    if (wantContacts.length > 0) {
      const { data: cs } = await db().from('contacts').select('id, language').in('id', wantContacts)
      for (const c of (cs ?? []) as Array<{ id: string; language?: string | null }>) localeByContact.set(c.id, localeFromLanguage(c.language))
    }
    const out: ClientPhoneRow[] = []
    for (const r of rows) {
      let locale: 'en' | 'it' = 'en'
      if (r.contact_id) locale = localeByContact.get(r.contact_id) ?? 'en'
      else {
        try { locale = localeFromLanguage(String((await supabaseAdmin.auth.admin.getUserById(r.user_id)).data?.user?.user_metadata?.portal_language ?? '')) } catch { /* English */ }
      }
      out.push({ ...r, locale })
    }
    return out
  } catch {
    return []
  }
}

/**
 * The icon number for a client's phone: unread chat + documents to sign + unpaid Tony Durante invoices, across their companies, capped. HONEST OR ABSENT: any
 * failure returns null and the alert goes without a number (the app corrects it when opened). A team member's phone gets none (null).
 */
export async function liveClientBadge(phone: ClientPhoneRow): Promise<number | null> {
  if (!phone.contact_id) return null
  try {
    const contactId = phone.contact_id
    const [{ getUnreadChatCount, getPortalAccounts, getUnpaidInvoiceCount }, { getToSignCount }] = await Promise.all([import('@/lib/portal/queries'), import('@/lib/portal/signable-documents')])
    const userEmail = (await supabaseAdmin.auth.admin.getUserById(phone.user_id)).data?.user?.email ?? null
    const [chat, accounts] = await Promise.all([getUnreadChatCount(contactId), getPortalAccounts(contactId)])
    const perCompany = await Promise.all(accounts.map(async a => (await getUnpaidInvoiceCount(a.id)) + (await getToSignCount({ selectedAccountId: a.id, contactId, userEmail, skipLegacyDrive: true }))))
    const total = chat + perCompany.reduce((a, b) => a + b, 0)
    return Number.isFinite(total) && total >= 0 ? Math.min(BADGE_CAP, total) : null
  } catch {
    return null
  }
}

/** One system alert per hour per server when Apple refuses the key (a 403 means the key or team is wrong; every phone would fail the same way). */
let lastKeyAlertAt = 0
let lastBadKeyLogAt = 0

export function liveClientDeps(): ClientPhoneDeps {
  return {
    key: readApnsKey(),
    isOn: isClientAppEnabled,
    bundleId: allowedClientBundleId(currentAppServerEnv()),
    phones: livePhones,
    badge: liveClientBadge,
    connect: connectToApple,
    revoke: async (id, reason) => {
      await db().from('social_app_devices').update({ revoked_at: new Date().toISOString(), revoked_reason: reason }).eq('id', id)
    },
    now: () => Date.now(),
    log: message => {
      if (message.includes('key_problem')) {
        if (Date.now() - lastKeyAlertAt < 3_600_000) return
        lastKeyAlertAt = Date.now()
      }
      console.error(`[client-app] ${message}`)
    },
  }
}

/** The real thing, under one overall deadline. Never throws. */
export async function sendToClientPhonesLive(alert: ClientPhoneAlert): Promise<ClientPhoneResult> {
  const deps = liveClientDeps()
  if (!deps.key && Date.now() - lastBadKeyLogAt > 3_600_000) {
    lastBadKeyLogAt = Date.now()
    console.error('[client-app] the Apple key values are set but cannot be used (check the key id, the team id and the key text); no phone alerts are sent')
  }
  return withDeadline(sendToClientPhones(alert, deps), LEG_DEADLINE_MS, empty('deadline'))
}
