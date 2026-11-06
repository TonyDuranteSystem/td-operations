/**
 * Shared "just confirmed delivered" write + client notification, used by BOTH the daily
 * cron (app/api/cron/irs-tracking-check) and the staff "Check now" action
 * (app/api/flows/[id]/irs-tracking/check-now) — so the confirm/notify contract can never
 * drift between the two triggers, the same way this codebase's toast/push/alert
 * predicates elsewhere always share one function rather than two copies.
 *
 * The guarded write (`.is('delivered_at', null)`, only notify if a row actually came
 * back) is what makes this safe to call from two different triggers that could in
 * principle race — only whichever call's write actually flips the flag gets to notify.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

const ADMIN_SENDER_ID = 'b0da5d9c-acf6-4761-9cae-2c3b14dbc631'
const FALLBACK_DELIVERED_MESSAGE = 'Good news — the IRS has received your application.'

// irs_shipment_tracking + pipeline_stages.tracking_delivered_message aren't in the
// generated types until Antonio promotes the migration to production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export interface ConfirmDeliveryResult {
  /** True only if THIS call's write is the one that actually flipped delivered_at. */
  justConfirmed: boolean
  /** Set if the write succeeded but the client-chat notification itself failed. */
  notifyError?: string
}

/**
 * Apply a just-decided delivery confirmation to one tracking row and, if this call is
 * genuinely the one that confirms it, post the client-facing portal-chat message.
 * `sd.stage` is used AS-IS to look up that stage's configured message/topic — not
 * filtered by `tracking_check_enabled`, since that flag scopes the automated sweep's
 * cost, not whether a stage has a delivery message worth sending.
 */
export async function applyDeliveryConfirmation(
  sd: { id: string; service_type: string; stage: string | null; account_id: string | null; contact_id: string | null },
  row: { service_delivery_id: string; tracking_number: string },
  deliveredAt: string,
): Promise<ConfirmDeliveryResult> {
  // Read what this step says to the client BEFORE recording the delivery. If that read fails we stop here, with nothing written: the daily check
  // (or "Check now") simply tries again. Reading it afterwards used to swallow the error and fall through to the standard "Good news" message —
  // wrong for a step that deliberately tells the client nothing (bug-hunter 2026-11-05).
  const { data: stageCfg, error: stageCfgErr } = await db
    .from('pipeline_stages')
    .select('tracking_delivered_message, client_chat_topic')
    .eq('service_type', sd.service_type)
    .eq('stage_name', sd.stage || '')
    .maybeSingle()
  if (stageCfgErr) throw new Error(`stage settings read failed: ${stageCfgErr.message}`)

  const { data: confirmed, error: confirmErr } = await db
    .from('irs_shipment_tracking')
    .update({ delivered_at: deliveredAt })
    .eq('service_delivery_id', row.service_delivery_id)
    .eq('tracking_number', row.tracking_number)
    .is('delivered_at', null)
    .select()
  if (confirmErr) throw new Error(`delivered-confirm write failed: ${confirmErr.message}`)
  if (!confirmed?.length) return { justConfirmed: false }

  const configured = stageCfg?.tracking_delivered_message as string | null | undefined
  // An EMPTY message (not null) is a deliberate "tell the client nothing" for that step — Company Closure's "Waiting for the IRS" (Antonio
  // 2026-11-05: staff decide what the client hears). The delivery itself is already recorded above and shows on the staff screen.
  if (configured === '') return { justConfirmed: true }
  const message = configured || FALLBACK_DELIVERED_MESSAGE
  const topic = (stageCfg?.client_chat_topic as string | null) || sd.service_type

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
    return { justConfirmed: true, notifyError: notifyErr instanceof Error ? notifyErr.message : String(notifyErr) }
  }
  return { justConfirmed: true }
}
