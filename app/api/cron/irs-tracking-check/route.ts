/**
 * CRON: IRS shipment tracking check.
 *
 * Daily. For every service delivery currently sitting in a stage that has
 * pipeline_stages.tracking_check_enabled=true and a tracking number on file with no
 * confirmed delivery yet, asks ShipStation for the label's current status:
 *
 *   - No match at all for 5 consecutive days -> one alert email (deduped).
 *   - Matched, not delivered -> just cache the status, reset both streak counters.
 *   - Matched, delivered, for the 2nd consecutive check -> stamp delivered_at (guarded —
 *     the notification only fires if this exact write is the one that set it) and post
 *     the same kind of portal-chat message the "Submitted to IRS" milestone already uses.
 *   - Independent of the above: a case open past 150 days with nothing confirmed and no
 *     prior stuck-alert -> a second, separate alert email.
 *
 * Every step is isolated per case (try/catch) so one bad tracking number can't stop the
 * rest of the batch. This cron is NOT yet registered on the schedule (vercel.json /
 * lib/cron-coverage.ts) or invoked with a real ShipStation key — both are a deliberate,
 * separate go/no-go from building this code, per the approved plan.
 *
 * Auth: Bearer CRON_SECRET — the same strict pattern as app/api/cron/itin-processing-check
 * (a missing env var refuses, it does not fail open).
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { logCron } from '@/lib/cron-log'
import { lookupTrackingStatus } from '@/lib/shipstation'
import { decideCheckOutcome, isStuck, buildTrackingAlertEmail, type TrackingRow } from '@/lib/operations/irs-tracking'
import { gmailPost } from '@/lib/gmail'

const ADMIN_SENDER_ID = 'b0da5d9c-acf6-4761-9cae-2c3b14dbc631'
const FALLBACK_DELIVERED_MESSAGE = 'Good news — the IRS has received your application.'

// irs_shipment_tracking + pipeline_stages.tracking_check_enabled/tracking_delivered_message
// aren't in the generated types until Antonio promotes the migration to production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

interface PendingRow extends TrackingRow {
  service_delivery_id: string
}

async function resolveCompanyName(accountId: string | null, contactId: string | null): Promise<string | null> {
  if (accountId) {
    const { data } = await supabaseAdmin.from('accounts').select('company_name').eq('id', accountId).maybeSingle()
    return data?.company_name ?? null
  }
  if (contactId) {
    const { data } = await supabaseAdmin.from('contacts').select('full_name').eq('id', contactId).maybeSingle()
    return data?.full_name ?? null
  }
  return null
}

async function sendAlert(reason: 'no_match' | 'stuck', sd: { id: string; account_id: string | null; contact_id: string | null }, trackingNumber: string) {
  const companyName = (await resolveCompanyName(sd.account_id, sd.contact_id)) ?? 'Unknown'
  const { raw } = buildTrackingAlertEmail({ reason, companyName, trackingNumber, serviceDeliveryId: sd.id })
  await gmailPost('/messages/send', { raw })
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const now = new Date()
  const results = {
    scanned: 0,
    checked: 0,
    confirmed_delivered: 0,
    no_match_alerts: 0,
    stuck_alerts: 0,
    errors: [] as { service_delivery_id: string; error: string }[],
  }

  try {
    // 1. Which (service_type, stage_name) pairs are enabled, and what to say on delivery.
    const { data: enabledStages, error: stagesErr } = await db
      .from('pipeline_stages')
      .select('service_type, stage_name, tracking_delivered_message, client_chat_topic')
      .eq('tracking_check_enabled', true)
    if (stagesErr) throw new Error(`Could not read pipeline_stages: ${stagesErr.message}`)
    if (!enabledStages?.length) {
      logCron({ endpoint: 'irs-tracking-check', status: 'success', duration_ms: Date.now() - startTime, details: { ...results, note: 'no stage has tracking_check_enabled' } })
      return NextResponse.json({ success: true, ...results })
    }
    const enabledKey = (serviceType: string, stageName: string) => `${serviceType}::${stageName}`
    const stageConfig = new Map(enabledStages.map((s: Record<string, unknown>) => [enabledKey(s.service_type as string, s.stage_name as string), s]))

    // 2. Every pending tracking row (not yet confirmed delivered) — low volume, no batching.
    const { data: pending, error: pendingErr } = await db
      .from('irs_shipment_tracking')
      .select('service_delivery_id, tracking_number, status, consecutive_delivered_checks, consecutive_unmatched_checks, delivered_at, no_match_alerted_at, stuck_alerted_at, created_at')
      .is('delivered_at', null)
    if (pendingErr) throw new Error(`Could not read irs_shipment_tracking: ${pendingErr.message}`)
    results.scanned = pending?.length ?? 0
    if (!pending?.length) {
      logCron({ endpoint: 'irs-tracking-check', status: 'success', duration_ms: Date.now() - startTime, details: results })
      return NextResponse.json({ success: true, ...results })
    }

    // 3. Resolve each row's current stage, filter to only the enabled stages.
    const sdIds = pending.map((p: PendingRow) => p.service_delivery_id)
    const { data: sds } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, stage, account_id, contact_id')
      .in('id', sdIds)
    const sdById = new Map((sds ?? []).map((s) => [s.id, s]))

    for (const row of pending as PendingRow[]) {
      const sd = sdById.get(row.service_delivery_id)
      if (!sd || !stageConfig.has(enabledKey(sd.service_type, sd.stage || ''))) continue
      results.checked++

      let justConfirmed = false
      try {
        const lookup = await lookupTrackingStatus(row.tracking_number)
        const decision = decideCheckOutcome(row, lookup, now)

        const { error: patchErr } = await db
          .from('irs_shipment_tracking')
          .update(decision.patch)
          .eq('service_delivery_id', row.service_delivery_id)
          .eq('tracking_number', row.tracking_number)
        if (patchErr) throw new Error(`patch write failed: ${patchErr.message}`)

        if (decision.confirmDelivered) {
          const { data: confirmed, error: confirmErr } = await db
            .from('irs_shipment_tracking')
            .update({ delivered_at: now.toISOString() })
            .eq('service_delivery_id', row.service_delivery_id)
            .eq('tracking_number', row.tracking_number)
            .is('delivered_at', null)
            .select()
          if (confirmErr) throw new Error(`delivered-confirm write failed: ${confirmErr.message}`)
          if (confirmed?.length) {
            justConfirmed = true
            results.confirmed_delivered++
            const cfg = stageConfig.get(enabledKey(sd.service_type, sd.stage || '')) as Record<string, unknown> | undefined
            const message = (cfg?.tracking_delivered_message as string | null) || FALLBACK_DELIVERED_MESSAGE
            const topic = (cfg?.client_chat_topic as string | null) || sd.service_type
            try {
              const { error: chatErr } = await supabaseAdmin.from('portal_messages').insert({
                account_id: sd.account_id ?? null,
                contact_id: sd.contact_id ?? null,
                service_delivery_id: sd.id,
                sender_type: 'admin',
                sender_id: ADMIN_SENDER_ID,
                message,
                topic,
                attachments: [],
              })
              if (chatErr) throw new Error(chatErr.message)
            } catch (notifyErr) {
              results.errors.push({ service_delivery_id: sd.id, error: `notification failed: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}` })
            }
          }
        }

        if (decision.raiseNoMatchAlert) {
          const { data: alerted, error: alertErr } = await db
            .from('irs_shipment_tracking')
            .update({ no_match_alerted_at: now.toISOString() })
            .eq('service_delivery_id', row.service_delivery_id)
            .is('no_match_alerted_at', null)
            .select()
          if (alertErr) throw new Error(`no-match alert flag write failed: ${alertErr.message}`)
          if (alerted?.length) {
            results.no_match_alerts++
            await sendAlert('no_match', sd, row.tracking_number)
          }
        }
      } catch (err) {
        // ShipStation network/HTTP failure, or a DB write in this block genuinely
        // erroring (not just "0 rows guarded out") — either way, skip this case and
        // retry tomorrow rather than trusting a half-applied state.
        results.errors.push({ service_delivery_id: row.service_delivery_id, error: err instanceof Error ? err.message : String(err) })
      }

      // Runs regardless of the ShipStation call's outcome this cycle — a transient
      // network hiccup today must not suppress a real 150-day safety net. Its own
      // try/catch (not a bare throw) — this sits OUTSIDE the block above, so an
      // uncaught error here would abort the whole run instead of just this case.
      try {
        if (!justConfirmed && isStuck(row, now)) {
          const { data: stuckAlerted, error: stuckErr } = await db
            .from('irs_shipment_tracking')
            .update({ stuck_alerted_at: now.toISOString() })
            .eq('service_delivery_id', row.service_delivery_id)
            .is('stuck_alerted_at', null)
            .select()
          if (stuckErr) throw new Error(`stuck alert flag write failed: ${stuckErr.message}`)
          if (stuckAlerted?.length) {
            results.stuck_alerts++
            await sendAlert('stuck', sd, row.tracking_number)
          }
        }
      } catch (stuckCheckErr) {
        results.errors.push({
          service_delivery_id: row.service_delivery_id,
          error: `stuck check failed: ${stuckCheckErr instanceof Error ? stuckCheckErr.message : String(stuckCheckErr)}`,
        })
      }
    }

    logCron({ endpoint: 'irs-tracking-check', status: 'success', duration_ms: Date.now() - startTime, details: results })
    return NextResponse.json({ success: true, ...results })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logCron({ endpoint: 'irs-tracking-check', status: 'error', duration_ms: Date.now() - startTime, error_message: error, details: results })
    return NextResponse.json({ success: false, error, ...results }, { status: 500 })
  }
}
