/**
 * TD Communication — SLA / deadline back-end (server-side, service role).
 *
 * Phase 10. The pure helpers (computeDeadlineAt, slaIndicator, isSlaTracked,
 * slaSummary, daysRemaining) live in ./pipeline and are unit-tested there; this
 * module is the DB-backed side: resolve a package's promised delivery time, set
 * an enrollment's deadline on its first transition out of 'enrolled', and post a
 * one-time overdue notice in the project chat when a deadline passes.
 *
 * Like the rest of td-communication, td_comm_enrollments is RLS ON with NO
 * policy — all access is through supabaseAdmin (RLS bypass) after the API/page
 * layer authorized the caller.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { getCommSettings } from './comm-settings'
import { computeDeadlineAt, slaIndicator, isSlaTracked, daysRemaining } from './pipeline'
import { insertMessage, SYSTEM_STAFF } from './queries'
import type { CommEnrollment } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** Final hard fallback when neither the package nor the settings give a value. */
const FALLBACK_SLA_DAYS = 7

/**
 * Promised delivery time (days) for a package: the package's delivery_days, then
 * the configured default_sla_days, then a literal fallback. Always a positive
 * finite number so a missing package (e.g. 'brand-identity') can't yield NaN.
 */
export async function resolveDeliveryDays(packageSlug: string | null | undefined): Promise<number> {
  if (packageSlug) {
    const { data } = await db
      .from('td_comm_packages')
      .select('delivery_days')
      .eq('slug', packageSlug)
      .maybeSingle()
    const d = data?.delivery_days
    if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d
  }
  const settings = await getCommSettings()
  const fallback = settings.default_sla_days
  return typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0 ? fallback : FALLBACK_SLA_DAYS
}

/**
 * Set deadline_at = base + package.delivery_days, ONCE, on the first transition
 * out of 'enrolled' (whichever path triggers it — wizard submit, manual status
 * change, or deliverable-driven auto-advance). Never overwrites an existing
 * deadline (the `.is('deadline_at', null)` guard makes it TOCTOU-safe) and never
 * throws — a deadline that fails to set must not fail the caller's write.
 */
export async function ensureDeadlineAt(enrollmentId: string, baseISO: string): Promise<void> {
  try {
    const { data: cur } = await db
      .from('td_comm_enrollments')
      .select('deadline_at, package_slug')
      .eq('id', enrollmentId)
      .maybeSingle()
    if (!cur || cur.deadline_at) return
    const days = await resolveDeliveryDays(cur.package_slug ?? null)
    const deadlineAt = computeDeadlineAt(baseISO, days)
    if (!deadlineAt) return
    await db
      .from('td_comm_enrollments')
      .update({ deadline_at: deadlineAt })
      .eq('id', enrollmentId)
      .is('deadline_at', null)
  } catch (err) {
    console.warn('[td-comm sla] ensureDeadlineAt failed:', err)
  }
}

/** The one-time overdue notice posted in the project chat. */
export function overdueAlertMessage(name: string, daysOverdue: number): string {
  const n = Math.max(1, daysOverdue)
  return `⚠️ Project ${name} is overdue by ${n} ${n === 1 ? 'day' : 'days'}`
}

/**
 * On board render: for each SLA-tracked enrollment that is now overdue, has a
 * linked conversation, and hasn't been alerted yet, post a single overdue notice
 * in its project chat and stamp metadata.sla_alert_sent. No cron — this runs
 * fire-and-forget from the board server components.
 *
 * Idempotency: the UPDATE that sets the flag is guarded so only one of two
 * near-simultaneous renders can claim a given enrollment (the loser's update
 * matches 0 rows), and the chat post only happens after a successful claim.
 * Wrapped in try/catch per row + overall so alerting never breaks a render.
 */
export async function postOverdueAlerts(enrollments: CommEnrollment[], now: Date = new Date()): Promise<void> {
  try {
    for (const e of enrollments) {
      try {
        if (!isSlaTracked(e.status)) continue
        if (!e.conversation_id) continue
        if (slaIndicator(e.deadline, now) !== 'red') continue
        if ((e.metadata as Record<string, unknown>)?.sla_alert_sent === true) continue

        // Claim: set the flag only if not already set. The .or() filter handles
        // the JSONB-null case correctly (a plain .neq('…','true') would drop
        // never-alerted rows, where the key is NULL).
        const nextMeta = { ...(e.metadata ?? {}), sla_alert_sent: true }
        const { data: claimed } = await db
          .from('td_comm_enrollments')
          .update({ metadata: nextMeta, updated_at: new Date().toISOString() })
          .eq('id', e.id)
          .or('metadata->>sla_alert_sent.is.null,metadata->>sla_alert_sent.neq.true')
          .select('id')
          .maybeSingle()
        if (!claimed) continue // lost the race / already alerted

        const overdue = Math.abs(daysRemaining(e.deadline, now) ?? 0)
        await insertMessage({
          conversationId: e.conversation_id,
          sender: SYSTEM_STAFF,
          body: overdueAlertMessage(e.subject.name, overdue),
        })
      } catch (err) {
        console.warn('[td-comm sla] overdue alert failed for enrollment', e.id, err)
      }
    }
  } catch (err) {
    console.warn('[td-comm sla] postOverdueAlerts failed:', err)
  }
}
