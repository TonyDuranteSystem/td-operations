/**
 * Phase B of the Client Action-Required system (Phase A: action-required.ts):
 * the safety nets. Backed by the daily /api/cron/action-required-reminders.
 *
 *  1. CLIENT REMINDERS — an SS-4 sitting at 'awaiting_signature' with no
 *     recent action-required notification gets a reminder (max MAX_REMINDERS
 *     after the initial), through the same three channels as Phase A (chat +
 *     immediate email + bell/push). Resolution-aware: the moment the client
 *     signs, the SS-4 leaves 'awaiting_signature' and drops out of the sweep.
 *     State is the portal_notifications rows themselves (type='action_required',
 *     link='/portal/sign/ss4') — no new tables/columns.
 *
 *  2. STAFF STALE-DRAFT ALERT — a Company Formation SD parked at
 *     "SS-4 Prepared" whose SS-4 is still 'draft' (or was never generated)
 *     after STAFF_ALERT_AFTER_DAYS means the CLIENT-FACING send never
 *     happened: the portal used to show "Sign your SS-4" while nothing was
 *     signable (the Michele Cotti / AI Venture Labs failure, 2026-07-02).
 *     Emails support@ with the workspace link; throttled via an action_log
 *     marker row (kind='ss4_stale_draft_alert') — again no new tables.
 *
 * Decision logic is in PURE functions taking an explicit `now` (the
 * established time-travel cron-testing pattern — see decideSlaTier).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { INTERNAL_BASE_URL } from '@/lib/config'
import { logAction } from '@/lib/mcp/action-log'
import { notifyClientActionRequired, ACTION_REQUIRED_TYPE } from './action-required'

/** Days of silence before a client reminder fires. */
export const REMIND_AFTER_DAYS = 3
/** Reminders after the initial notification (initial + 2 = 3 total messages). */
export const MAX_REMINDERS = 2
/** Days an SS-4 may sit in draft at "SS-4 Prepared" before staff are alerted. */
export const STAFF_ALERT_AFTER_DAYS = 3
/** Same-alert throttle for the staff email. */
export const STAFF_ALERT_REPEAT_DAYS = 3
/** Where staff alerts go. */
const STAFF_ALERT_EMAIL = 'support@tonydurante.us'
/** Bound each sweep so a backlog can never blow the cron budget. */
const SWEEP_LIMIT = 50

const DAY_MS = 24 * 60 * 60 * 1000

export type ReminderDecision =
  | { action: 'initial'; reason: string }
  | { action: 'reminder'; reminderNumber: number; reason: string }
  | { action: 'skip'; reason: string }

/**
 * PURE — decide what (if anything) to send for an awaiting-signature SS-4.
 *
 * notifCount / lastNotifAt describe the existing action_required notifications
 * for this signer+link (the initial Phase-A dispatch counts as #1).
 * awaitingSince = ss4.updated_at (stamped when the row flipped to awaiting).
 */
export function decideSs4ClientReminder(opts: {
  ss4Status: string
  awaitingSince: string | null
  notifCount: number
  lastNotifAt: string | null
  now: Date
}): ReminderDecision {
  const { ss4Status, awaitingSince, notifCount, lastNotifAt, now } = opts

  if (ss4Status !== 'awaiting_signature') {
    return { action: 'skip', reason: `not awaiting_signature (${ss4Status})` }
  }

  const threshold = REMIND_AFTER_DAYS * DAY_MS

  // Straggler: awaiting but never notified (pre-Phase-A sends, or a dispatch
  // that failed). Send the INITIAL notification once it's been quietly
  // awaiting past the threshold — a fresh transition is the trigger sites'
  // job, not the cron's.
  if (notifCount === 0) {
    if (!awaitingSince) return { action: 'skip', reason: 'no awaiting timestamp' }
    if (now.getTime() - new Date(awaitingSince).getTime() < threshold) {
      return { action: 'skip', reason: 'recently became awaiting — trigger-site dispatch owns this window' }
    }
    return { action: 'initial', reason: `awaiting since ${awaitingSince} with zero notifications` }
  }

  const remindersSent = notifCount - 1
  if (remindersSent >= MAX_REMINDERS) {
    return { action: 'skip', reason: `max reminders reached (${remindersSent}/${MAX_REMINDERS})` }
  }
  if (!lastNotifAt) {
    return { action: 'skip', reason: 'notification rows lack timestamps' }
  }
  if (now.getTime() - new Date(lastNotifAt).getTime() < threshold) {
    return { action: 'skip', reason: `last notification ${lastNotifAt} within ${REMIND_AFTER_DAYS}d window` }
  }
  return { action: 'reminder', reminderNumber: remindersSent + 1, reason: `silent for ${REMIND_AFTER_DAYS}+ days` }
}

export type StaleDraftDecision = { alert: true; reason: string } | { alert: false; reason: string }

/**
 * PURE — decide whether staff should be alerted for an SD parked at
 * "SS-4 Prepared". `ss4Status`/`ss4UpdatedAt` are null when NO SS-4 row exists
 * (generation failed and staff never generated one) — in that case the age
 * gate falls back to when the SD entered the stage.
 */
export function decideStaleDraftAlert(opts: {
  sdStage: string
  ss4Status: string | null
  ss4UpdatedAt: string | null
  stageEnteredAt: string | null
  lastAlertAt: string | null
  now: Date
}): StaleDraftDecision {
  const { sdStage, ss4Status, ss4UpdatedAt, stageEnteredAt, lastAlertAt, now } = opts

  if (sdStage !== 'SS-4 Prepared') return { alert: false, reason: `not at SS-4 Prepared (${sdStage})` }
  // awaiting_signature = client's turn (reminder sweep's job); signed+ = done.
  if (ss4Status !== null && ss4Status !== 'draft') {
    return { alert: false, reason: `SS-4 is ${ss4Status} — not stuck in staff review` }
  }

  const ageAnchor = ss4Status === 'draft' ? (ss4UpdatedAt ?? stageEnteredAt) : stageEnteredAt
  if (!ageAnchor) return { alert: false, reason: 'no age anchor available' }
  if (now.getTime() - new Date(ageAnchor).getTime() < STAFF_ALERT_AFTER_DAYS * DAY_MS) {
    return { alert: false, reason: `within the ${STAFF_ALERT_AFTER_DAYS}d grace window` }
  }
  if (lastAlertAt && now.getTime() - new Date(lastAlertAt).getTime() < STAFF_ALERT_REPEAT_DAYS * DAY_MS) {
    return { alert: false, reason: `already alerted at ${lastAlertAt}` }
  }
  const what = ss4Status === 'draft' ? 'SS-4 stuck in draft' : 'no SS-4 generated'
  return { alert: true, reason: `${what} past ${STAFF_ALERT_AFTER_DAYS}d` }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweeps (DB + dispatch). Both are best-effort per candidate: one bad row
// never aborts the rest.
// ─────────────────────────────────────────────────────────────────────────────

export interface SweepResult {
  scanned: number
  dispatched: number
  skipped: number
  errors: string[]
}

/** Client-reminder sweep over awaiting-signature SS-4s. */
export async function runSs4ClientReminderSweep(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, dispatched: 0, skipped: 0, errors: [] }

  const { data: candidates, error } = await supabaseAdmin
    .from('ss4_applications')
    .select('id, account_id, contact_id, company_name, status, updated_at')
    .eq('status', 'awaiting_signature')
    .limit(SWEEP_LIMIT)
  if (error) {
    result.errors.push(`candidate query: ${error.message}`)
    return result
  }

  for (const ss4 of candidates ?? []) {
    result.scanned++
    try {
      // Skip test data (is_test lives on the account, not the ss4 row).
      if (ss4.account_id) {
        const { data: acct } = await supabaseAdmin
          .from('accounts')
          .select('is_test')
          .eq('id', ss4.account_id)
          .maybeSingle()
        if (acct?.is_test === true) {
          result.skipped++
          continue
        }
      }

      // Prior action-required notifications for this signer+link = the state.
      let notifQuery = supabaseAdmin
        .from('portal_notifications')
        .select('created_at')
        .eq('type', ACTION_REQUIRED_TYPE)
        .eq('link', '/portal/sign/ss4')
        .order('created_at', { ascending: false })
      if (ss4.contact_id && ss4.account_id) {
        notifQuery = notifQuery.or(`contact_id.eq.${ss4.contact_id},account_id.eq.${ss4.account_id}`)
      } else if (ss4.contact_id) {
        notifQuery = notifQuery.eq('contact_id', ss4.contact_id)
      } else if (ss4.account_id) {
        notifQuery = notifQuery.eq('account_id', ss4.account_id)
      } else {
        result.skipped++
        continue
      }
      const { data: notifs, error: notifErr } = await notifQuery
      if (notifErr) {
        result.errors.push(`ss4 ${ss4.id} notif query: ${notifErr.message}`)
        continue
      }

      const decision = decideSs4ClientReminder({
        ss4Status: ss4.status,
        awaitingSince: ss4.updated_at,
        notifCount: notifs?.length ?? 0,
        lastNotifAt: notifs?.[0]?.created_at ?? null,
        now,
      })
      if (decision.action === 'skip') {
        result.skipped++
        continue
      }

      const company = ss4.company_name || 'your company'
      const isReminder = decision.action === 'reminder'
      const dispatch = await notifyClientActionRequired({
        contact_id: ss4.contact_id ?? null,
        account_id: ss4.account_id ?? null,
        title: isReminder
          ? { en: `Reminder: sign your SS-4 — ${company}`, it: `Promemoria: firma il tuo SS-4 — ${company}` }
          : { en: `Sign your SS-4 — ${company}`, it: `Firma il tuo SS-4 — ${company}` },
        message: isReminder
          ? {
              en: `A quick reminder — your SS-4 (the EIN application for ${company}) is still waiting for your signature. It only takes a minute in your portal.`,
              it: `Un breve promemoria — il tuo modulo SS-4 (la richiesta EIN per ${company}) è ancora in attesa della tua firma. Bastano pochi secondi nel portale.`,
            }
          : {
              en: `Your SS-4 (the EIN application for ${company}) is ready for your signature. Please open your portal and sign it — it only takes a minute.`,
              it: `Il tuo modulo SS-4 (la richiesta EIN per ${company}) è pronto per la firma. Accedi al portale e firmalo — bastano pochi secondi.`,
            },
        link: '/portal/sign/ss4',
      })
      if (dispatch.dispatched) result.dispatched++
      else result.skipped++
    } catch (err) {
      result.errors.push(`ss4 ${ss4.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}

/** Staff stale-draft sweep over formation SDs parked at "SS-4 Prepared". */
export async function runSs4StaleDraftSweep(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, dispatched: 0, skipped: 0, errors: [] }

  const { data: sds, error } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, account_id, stage, stage_entered_at, is_test')
    .eq('service_type', 'Company Formation')
    .eq('status', 'active')
    .eq('stage', 'SS-4 Prepared')
    .limit(SWEEP_LIMIT)
  if (error) {
    result.errors.push(`candidate query: ${error.message}`)
    return result
  }

  for (const sd of sds ?? []) {
    result.scanned++
    try {
      if (sd.is_test === true || !sd.account_id) {
        result.skipped++
        continue
      }

      const { data: ss4 } = await supabaseAdmin
        .from('ss4_applications')
        .select('id, status, updated_at, company_name')
        .eq('account_id', sd.account_id)
        .maybeSingle()

      // Throttle marker: last stale-draft alert for this SD (action_log is the
      // state — insert-only, queried by our marker kind).
      const { data: priorAlerts } = await supabaseAdmin
        .from('action_log')
        .select('created_at')
        .eq('table_name', 'service_deliveries')
        .eq('record_id', sd.id)
        .eq('details->>kind', 'ss4_stale_draft_alert')
        .order('created_at', { ascending: false })
        .limit(1)

      const decision = decideStaleDraftAlert({
        sdStage: sd.stage ?? '',
        ss4Status: ss4?.status ?? null,
        ss4UpdatedAt: ss4?.updated_at ?? null,
        stageEnteredAt: sd.stage_entered_at ?? null,
        lastAlertAt: priorAlerts?.[0]?.created_at ?? null,
        now,
      })
      if (!decision.alert) {
        result.skipped++
        continue
      }

      const { data: acct } = await supabaseAdmin
        .from('accounts')
        .select('company_name')
        .eq('id', sd.account_id)
        .maybeSingle()
      const company = acct?.company_name || ss4?.company_name || sd.account_id
      const workspaceUrl = `${INTERNAL_BASE_URL}/flows/${sd.id}`
      const problem = ss4
        ? `The SS-4 has been sitting in DRAFT — the client has NOT been sent anything to sign.`
        : `NO SS-4 exists yet for this account — auto-generation likely failed (missing Registered Agent or signer flag).`

      const subject = `⚠️ SS-4 not sent — ${company} stuck at "SS-4 Prepared"`
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <p><strong>${company}</strong> has been at the formation stage "SS-4 Prepared" past the ${STAFF_ALERT_AFTER_DAYS}-day window.</p>
          <p>${problem}</p>
          <p>The client sees "Sign your SS-4" as their current step, so from their side WE are the ones holding things up.</p>
          <p><a href="${workspaceUrl}">Open the formation workspace</a> → review the SS-4 and click "Send to Client for Signature" (the client is notified automatically).</p>
          <p style="color:#9ca3af;font-size:12px;">Automated staff alert — action-required-reminders cron. Repeats every ${STAFF_ALERT_REPEAT_DAYS} days until resolved.</p>
        </div>
      `
      const { gmailPost } = await import('@/lib/gmail')
      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
      const boundary = `boundary_${sd.id.slice(0, 8)}`
      const raw = [
        `From: TD Operations <support@tonydurante.us>`,
        `To: ${STAFF_ALERT_EMAIL}`,
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

      // The throttle marker — MUST carry details.kind for the lookup above.
      logAction({
        actor: 'system',
        action_type: 'create',
        table_name: 'service_deliveries',
        record_id: sd.id,
        account_id: sd.account_id,
        summary: `Staff alert: SS-4 not sent for ${company} (stuck at SS-4 Prepared)`,
        details: { kind: 'ss4_stale_draft_alert', ss4_status: ss4?.status ?? 'missing', reason: decision.reason },
      })
      result.dispatched++
    } catch (err) {
      result.errors.push(`sd ${sd.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}
