/**
 * Pure decision logic for the daily IRS-shipment tracking check (irs_shipment_tracking +
 * app/api/cron/irs-tracking-check). Kept separate from the cron route — like
 * lib/tasks/itin-processing-reminder.ts and lib/portal/stage-chat-notification.ts — so the
 * branching can be unit-tested without mocking Supabase or ShipStation.
 *
 * The route applies `patch` as a plain update pinned to (service_delivery_id,
 * tracking_number) — pinning to the number just queried means a staff correction that
 * lands mid-check can never have a stale answer stamped onto the now-corrected row, since
 * the WHERE clause simply won't match afterward.
 *
 * `confirmDelivered` and `alert` must each be applied by the CALLER as their own guarded
 * write (`.is(<flag>, null)`, `.select()`, only act if a row actually came back) — not
 * here — because a real fire-once guard needs to be checked against the live row at
 * write time (Postgres's own row locking), not against what this function read a moment
 * earlier.
 */

import type { ShipStationLookupResult } from '@/lib/shipstation'

export const NO_MATCH_ALERT_THRESHOLD = 5
export const DELIVERED_CONFIRM_THRESHOLD = 2
export const STUCK_ALERT_THRESHOLD_DAYS = 150

export interface TrackingRow {
  tracking_number: string
  consecutive_delivered_checks: number
  consecutive_unmatched_checks: number
  delivered_at: string | null
  no_match_alerted_at: string | null
  stuck_alerted_at: string | null
  created_at: string
}

export interface CheckPatch {
  status: string
  checked_at: string
  matched_ship_date: string | null
  consecutive_delivered_checks: number
  consecutive_unmatched_checks: number
}

export interface CheckDecision {
  patch: CheckPatch
  /** Set only when THIS check just reached the confirm threshold. Caller applies via a
   *  write guarded on `delivered_at IS NULL` and only notifies if a row was returned. */
  confirmDelivered: boolean
  /** Set only when THIS check just crossed the no-match threshold for the first time. */
  raiseNoMatchAlert: boolean
}

/** Decide what to do with one ShipStation lookup result. Pure — no I/O, no Date.now(). */
export function decideCheckOutcome(row: TrackingRow, lookup: ShipStationLookupResult, now: Date): CheckDecision {
  const checkedAt = now.toISOString()

  if (!lookup.found) {
    const newUnmatched = row.consecutive_unmatched_checks + 1
    return {
      patch: {
        status: 'not_found',
        checked_at: checkedAt,
        matched_ship_date: null,
        consecutive_delivered_checks: 0,
        consecutive_unmatched_checks: newUnmatched,
      },
      confirmDelivered: false,
      raiseNoMatchAlert: newUnmatched >= NO_MATCH_ALERT_THRESHOLD && !row.no_match_alerted_at,
    }
  }

  if (lookup.status !== 'delivered') {
    return {
      patch: {
        status: lookup.status,
        checked_at: checkedAt,
        matched_ship_date: lookup.shipDate,
        consecutive_delivered_checks: 0,
        consecutive_unmatched_checks: 0,
      },
      confirmDelivered: false,
      raiseNoMatchAlert: false,
    }
  }

  const newDeliveredCount = row.consecutive_delivered_checks + 1
  return {
    patch: {
      status: 'delivered',
      checked_at: checkedAt,
      matched_ship_date: lookup.shipDate,
      consecutive_delivered_checks: newDeliveredCount,
      consecutive_unmatched_checks: 0,
    },
    confirmDelivered: newDeliveredCount >= DELIVERED_CONFIRM_THRESHOLD && !row.delivered_at,
    raiseNoMatchAlert: false,
  }
}

/**
 * Has this case been open far longer than the typical 7-11 week wait, with no delivery
 * confirmed and no stuck-alert sent yet? Anchored on `created_at` (immutable — never
 * touched by a later correction or the backfill save) so fixing a typo, or backfilling one
 * of the already-in-flight cases, can never quietly restart this safety net's clock.
 */
export function isStuck(
  row: { created_at: string; delivered_at: string | null; stuck_alerted_at: string | null },
  now: Date,
  thresholdDays: number = STUCK_ALERT_THRESHOLD_DAYS,
): boolean {
  if (row.delivered_at || row.stuck_alerted_at) return false
  const ageMs = now.getTime() - new Date(row.created_at).getTime()
  return ageMs > thresholdDays * 24 * 60 * 60 * 1000
}

/** Strip characters that could smuggle an extra header into a raw RFC 2822 message. */
function sanitizeForEmailHeader(value: string): string {
  return value.replace(/[\r\n]/g, ' ').trim()
}

const SUPPORT_EMAIL = 'support@tonydurante.us'

/**
 * Build the raw RFC 2822 message for a staff alert email — properly RFC 2047-encoded
 * subject (R041; the fax-confirmation cron this alert is modeled on does NOT do this and
 * should not be copied literally here) and every interpolated value sanitized against
 * header injection.
 */
export function buildTrackingAlertEmail(params: {
  reason: 'no_match' | 'stuck'
  companyName: string
  trackingNumber: string
  serviceDeliveryId: string
}): { raw: string } {
  const company = sanitizeForEmailHeader(params.companyName)
  const tracking = sanitizeForEmailHeader(params.trackingNumber)
  const subjectText =
    params.reason === 'no_match'
      ? `Alert: IRS tracking number not found — ${company}`
      : `Alert: IRS tracking stuck 150+ days — ${company}`
  const encodedSubject = `=?utf-8?B?${Buffer.from(subjectText).toString('base64')}?=`

  const bodyLines =
    params.reason === 'no_match'
      ? [
          'IRS shipment tracking — no match found',
          '',
          `Company: ${company}`,
          `Tracking number: ${tracking}`,
          `Service delivery: ${params.serviceDeliveryId}`,
          '',
          `ShipStation has not matched this tracking number for ${NO_MATCH_ALERT_THRESHOLD} consecutive daily checks.`,
          'This can mean a typo, or a label bought outside ShipStation.',
          '',
          'Action: verify the tracking number and correct it in the case workspace if needed.',
        ]
      : [
          'IRS shipment tracking — stuck far longer than the typical wait',
          '',
          `Company: ${company}`,
          `Tracking number: ${tracking}`,
          `Service delivery: ${params.serviceDeliveryId}`,
          '',
          `This case has been tracked for over ${STUCK_ALERT_THRESHOLD_DAYS} days without a confirmed delivery.`,
          '',
          'Action: check the tracking number directly on the carrier site.',
        ]

  const rawEmail = [
    `From: Tony Durante LLC <${SUPPORT_EMAIL}>`,
    `To: ${SUPPORT_EMAIL}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    bodyLines.join('\n'),
  ].join('\r\n')

  return { raw: Buffer.from(rawEmail).toString('base64url') }
}
