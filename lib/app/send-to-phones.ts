/**
 * TD Social — the phone leg: one alert to the registered iPhones (server; dev job 2072bc3e, Step 2 pull request C2; Council-reviewed plan of 5 Nov 2026).
 *
 * ORDER OF WORK (each step ends the leg quietly if its answer is "no"):
 *   key present → TD Social switch on → this server knows its own bundle id → wording (does this kind go to phones at all?) → who may be told (re-checked)
 *   → who has not muted this tab → their phones (not revoked, seen within 45 days, bundle matches THIS server) → the icon number (capped, omitted on failure)
 *   → send, one connection per Apple address, a few at a time → remove only phones Apple says are gone.
 * The leg is bounded (recipients, phones, per-request time, whole-leg time) and never throws. A 403 or 429 from Apple stops the rest of the batch and removes
 * NOTHING. Logging holds only a phone's row id and Apple's short reason.
 *
 * `sendToPhones` is pure orchestration over injected dependencies (tests use a fake Apple); `sendToPhonesLive` wires the real ones.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isSocialAppEnabled } from "@/lib/app/enabled"
import { allowedBundleId, currentAppServerEnv } from "@/lib/app/environment"
import { DEVICE_STALE_DAYS } from "@/lib/app/devices"
import { readState } from "@/lib/app/state"
import { readApnsKey, type ApnsKey } from "@/lib/app/apns-key"
import { APNS_HOSTS, buildApnsRequest, classifyApnsAnswer, connectToApple, providerToken, type ApnsConnect, type ApnsSession } from "@/lib/app/apns"
import { phoneTabFor, phoneWording } from "@/lib/app/phone-wording"
import { marketingRecipients, staffRecipients } from "@/lib/app/phone-recipients"
import { badgeForUser } from "@/lib/app/phone-badge"
import { isAlertKind } from "@/lib/push/alert-kinds"
import type { PhoneAlert } from "@/lib/app/phone-leg"

export const MAX_RECIPIENTS = 25
export const MAX_PHONES = 60
export const SEND_TIMEOUT_MS = 5000
export const LEG_DEADLINE_MS = 9000
export const CONCURRENCY = 8
/** A side lookup (a person's mutes, their icon number) gets this long; slower than that it is treated as "unknown" and the alert goes without it. */
export const SIDE_LOOKUP_MS = 1500

export interface PhoneRow { id: string; user_id: string; token: string; bundle_id: string; apns_env: string }

export interface PhoneDeps {
  key: ApnsKey | null
  isOn: () => Promise<boolean>
  bundleId: string | null
  recipients: (alert: PhoneAlert) => Promise<string[]>
  /** the tabs this person muted; any failure should be [] (a mute is a convenience, never a reason to stay silent on error) */
  mutedTabs: (userId: string) => Promise<string[]>
  phones: (userIds: string[], bundleId: string, sinceIso: string) => Promise<PhoneRow[]>
  badge: (userId: string) => Promise<number | null>
  connect: ApnsConnect
  revoke: (phoneId: string, reason: string) => Promise<void>
  now: () => number
  /** only a phone row id and Apple's short reason, never a token or key */
  log: (message: string) => void
}

export interface PhoneResult {
  /** why the leg ended before sending, when it did */
  skipped?: string
  attempted: number
  sent: number
  gone: number
  failed: number
  /** true when Apple's 403 / 429 made the leg stop early */
  stopped: boolean
}

const empty = (skipped: string): PhoneResult => ({ skipped, attempted: 0, sent: 0, gone: 0, failed: 0, stopped: false })

function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work.then(v => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

export async function sendToPhones(alert: PhoneAlert, deps: PhoneDeps): Promise<PhoneResult> {
  // 1. the key; 2. the runtime switch; 3. this server's own bundle id
  if (!deps.key) return empty("no key")
  if (!(await deps.isOn())) return empty("switched off")
  if (!deps.bundleId) return empty("unknown server")
  const bundleId = deps.bundleId

  // 4. what the lock screen shows (null = this kind does not go to phones)
  const wording = phoneWording({ kind: alert.kind, title: alert.title, body: alert.body, name: alert.name, dm: alert.dm, place: alert.place })
  if (!wording) return empty("kind not for phones")
  const tab = isAlertKind(alert.kind) ? phoneTabFor(alert.kind) : null

  // 5. who may be told (checked again here), who has not muted this tab
  const allowed = (await deps.recipients(alert)).slice(0, MAX_RECIPIENTS)
  if (allowed.length === 0) return empty("no recipients")
  const wanted = tab
    ? (await Promise.all(allowed.map(async id => ((await withDeadline(deps.mutedTabs(id), SIDE_LOOKUP_MS, [] as string[])).includes(tab) ? null : id)))).filter((id): id is string => id !== null)
    : allowed
  if (wanted.length === 0) return empty("all muted")

  // 6. their phones
  const since = new Date(deps.now() - DEVICE_STALE_DAYS * 86_400_000).toISOString()
  const phones = (await deps.phones(wanted, bundleId, since)).filter(p => p.bundle_id === bundleId).slice(0, MAX_PHONES)
  if (phones.length === 0) return empty("no phones")

  // 7. the icon number per person (each capped inside; null = leave the phone's number as it is)
  const people = Array.from(new Set(phones.map(p => p.user_id)))
  const badges = new Map<string, number | null>(await Promise.all(people.map(async id => [id, await withDeadline(deps.badge(id), SIDE_LOOKUP_MS, null)] as const)))

  // 8. send
  let jwt: string
  try {
    jwt = providerToken(deps.key, deps.now())
  } catch {
    deps.log("could not sign the provider token (key unreadable)")
    return empty("signing failed")
  }
  const result: PhoneResult = { attempted: 0, sent: 0, gone: 0, failed: 0, stopped: false }
  const sessions = new Map<string, ApnsSession>()
  const sessionFor = (env: string): ApnsSession | null => {
    const host = env === "development" ? APNS_HOSTS.development : env === "production" ? APNS_HOSTS.production : null
    if (!host) return null
    let s = sessions.get(host)
    if (!s) { s = deps.connect(host); sessions.set(host, s) }
    return s
  }
  // the leg's own deadline: past it nothing more is sent (a late alert is worse than none, and the 9 s wrapper cannot cancel work that already started)
  const deadline = deps.now() + LEG_DEADLINE_MS
  // Apple's refusal of the key or its "slow down" stops only THAT address (a key scoped to one environment fails there and works on the other)
  const stoppedHosts = new Set<string>()
  const hostOf = (env: string): string | null => (env === "development" ? APNS_HOSTS.development : env === "production" ? APNS_HOSTS.production : null)
  const queue = phones.slice()
  const worker = async () => {
    for (;;) {
      const phone = queue.shift()
      if (!phone) return
      if (deps.now() > deadline) { result.stopped = true; return }
      const host = hostOf(phone.apns_env)
      if (host && stoppedHosts.has(host)) continue
      const session = sessionFor(phone.apns_env)
      const req = session ? buildApnsRequest({
        deviceToken: phone.token, bundleId, jwt, nowMs: deps.now(),
        notification: { title: wording.title, body: wording.body, url: alert.url, tag: alert.tag, badge: badges.get(phone.user_id) ?? null },
      }) : null
      if (!session || !req) { result.failed++; continue }
      result.attempted++
      let outcome
      try {
        outcome = classifyApnsAnswer(await session.send(req, SEND_TIMEOUT_MS))
      } catch {
        outcome = { kind: "retry_later" as const, reason: "connection" }
      }
      if (outcome.kind === "sent") { result.sent++; continue }
      deps.log(`phone ${phone.id}: ${outcome.kind} (${outcome.reason})`)
      if (outcome.kind === "gone") {
        result.gone++
        await deps.revoke(phone.id, `apple_${outcome.reason}`).catch(() => undefined)
      } else {
        result.failed++
        // a refused key or a "slow down" must never turn into removals: stop sending to that address, keep every phone
        if ((outcome.kind === "key_problem" || outcome.kind === "slow_down") && host) { stoppedHosts.add(host); result.stopped = true }
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

/** One system alert per hour per server when Apple refuses the key (a 403 means the key or team is wrong; every phone would fail the same way). */
let lastKeyAlertAt = 0
let lastBadKeyLogAt = 0

export function liveDeps(): PhoneDeps {
  return {
    key: readApnsKey(),
    isOn: isSocialAppEnabled,
    bundleId: allowedBundleId(currentAppServerEnv()),
    recipients: a => (a.source === "marketing" ? marketingRecipients(a.teamId ?? "", a.userIds, { kind: a.kind, leadId: a.leadId }) : staffRecipients(a.userIds)),
    mutedTabs: async id => { try { return (await readState(id))?.muted_tabs ?? [] } catch { return [] } },
    phones: async (userIds, bundleId, sinceIso) => {
      const { data, error } = await db().from("social_app_devices").select("id, user_id, token, bundle_id, apns_env")
        .in("user_id", userIds).eq("bundle_id", bundleId).is("revoked_at", null).gte("last_seen_at", sinceIso)
      return error ? [] : ((data ?? []) as PhoneRow[])
    },
    badge: badgeForUser,
    connect: connectToApple,
    revoke: async (id, reason) => {
      await db().from("social_app_devices").update({ revoked_at: new Date().toISOString(), revoked_reason: reason }).eq("id", id)
    },
    now: () => Date.now(),
    log: message => {
      if (message.includes("key_problem")) {
        if (Date.now() - lastKeyAlertAt < 3_600_000) return
        lastKeyAlertAt = Date.now()
      }
      console.error(`[social-app] ${message}`)
    },
  }
}

/** The real thing, under one overall deadline. Never throws. */
export async function sendToPhonesLive(alert: PhoneAlert): Promise<PhoneResult> {
  const deps = liveDeps()
  // the three values are set but not usable (a pasted key with quotes, a wrong id): say so once an hour, never print any of them
  if (!deps.key && Date.now() - lastBadKeyLogAt > 3_600_000) {
    lastBadKeyLogAt = Date.now()
    console.error("[social-app] the Apple key values are set but cannot be used (check the key id, the team id and the key text); no phone alerts are sent")
  }
  return withDeadline(sendToPhones(alert, deps), LEG_DEADLINE_MS, empty("deadline"))
}
