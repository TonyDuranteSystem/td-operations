/**
 * An e-sign document that belongs to a service delivery moves the delivery on by itself — when the document is SENT and when the client has SIGNED.
 * The e-sign engine (lib/operations/esign.ts) stores `esign_envelopes.service_delivery_id`; the envelope carries it only when it was prepared from the
 * job's own workspace panel (a document sent from Tools > E-Sign on its own moves nothing). Per service, ONE rule per event: the steps the delivery must
 * be at, and where it goes.
 *
 * Company Change Name — signed: "Client signs the name-change form" → "File the form with the state". Staff can send the form
 * from "Check names and client confirms" and press nothing else — the client's signature carries the job through
 * from either step, so a signature is never left stranded just because the job was not moved by hand first.
 *
 * Tax Return (plan item 5, 2026-11-06) — sent: "Preparation" → "Sent for Signature" (NO client notice: the e-sign invite is the one message the client
 * gets); signed: "Sent for Signature" → "Signed" (also from "Preparation" / "TR Completed", so a signature is never stranded if the send did not move the
 * job). Filing with the IRS stays a human step: nothing here faxes or files.
 *
 * Idempotent (a delivery no longer at a "from" step is left alone, so a repeated send/completion call or a reminder-cron re-run does nothing) and
 * best-effort (never throws — the staff's send / the signer's submit must not fail because of this). A refusal is reported to the error dashboard:
 * the document is out (or signed) but the job did not move, and staff must see it.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { CHANGE_NAME_STAGES } from '@/lib/flows/change-name-stages'
import { TAX_RETURN_SIGN_STAGES } from '@/lib/flows/tax-return-sign-stages'

interface EsignMoveRule {
  fromStages: readonly string[]
  toStage: string
}

/** When the client has signed (envelope completed). */
export const ESIGN_COMPLETION_ADVANCE: Readonly<Record<string, EsignMoveRule>> = {
  'Company Change Name': { fromStages: [CHANGE_NAME_STAGES.check, CHANGE_NAME_STAGES.sign], toStage: CHANGE_NAME_STAGES.file },
  'Tax Return': {
    fromStages: [TAX_RETURN_SIGN_STAGES.sent, TAX_RETURN_SIGN_STAGES.preparation, TAX_RETURN_SIGN_STAGES.returnCompleted],
    toStage: TAX_RETURN_SIGN_STAGES.signed,
  },
}

/** When staff SEND the document to the client (envelope marked sent). */
export const ESIGN_SEND_ADVANCE: Readonly<Record<string, EsignMoveRule>> = {
  'Tax Return': {
    fromStages: [TAX_RETURN_SIGN_STAGES.preparation, TAX_RETURN_SIGN_STAGES.returnCompleted],
    toStage: TAX_RETURN_SIGN_STAGES.sent,
  },
}

function targetFor(table: Readonly<Record<string, EsignMoveRule>>, serviceType: string | null | undefined, currentStage: string | null | undefined): string | null {
  if (!serviceType || !currentStage) return null
  const rule = table[serviceType]
  return rule && rule.fromStages.includes(currentStage) ? rule.toStage : null
}

/** The stage a delivery moves to after its form is signed, or null when this delivery is not waiting on a signature. Pure. */
export function esignAdvanceTarget(serviceType: string | null | undefined, currentStage: string | null | undefined): string | null {
  return targetFor(ESIGN_COMPLETION_ADVANCE, serviceType, currentStage)
}

/** The stage a delivery moves to once its document is SENT to the client, or null when sending moves nothing for this delivery. Pure. */
export function esignSendTarget(serviceType: string | null | undefined, currentStage: string | null | undefined): string | null {
  return targetFor(ESIGN_SEND_ADVANCE, serviceType, currentStage)
}

export interface DeliveryAdvanceResult {
  advanced: boolean
  reason?: string
}

/**
 * Shared body of the two moves. `statusOk` says which envelope statuses count (sent: just sent / partly signed; signed: completed). `advanceOpts`
 * carries what differs: who acted, the audit note, and whether the client is told (a send is NOT announced by the stage — the e-sign invite is).
 */
async function advanceDeliveryForEnvelope(
  envelopeId: string,
  opts: {
    table: Readonly<Record<string, EsignMoveRule>>
    statusOk: (status: string) => boolean
    notYet: string
    actor: string
    note: (documentName: string | null) => string
    skipNotify: boolean
    failure: string
  },
): Promise<DeliveryAdvanceResult> {
  try {
    // esign_* tables are not in the generated DB types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const { data: env } = await db.from('esign_envelopes').select('id, status, service_delivery_id, document_name').eq('id', envelopeId).maybeSingle()
    if (!env || !env.service_delivery_id) return { advanced: false, reason: 'not linked to a service delivery' }
    if (!opts.statusOk(String(env.status))) return { advanced: false, reason: opts.notYet }

    const { data: sd } = await supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, stage, status')
      .eq('id', env.service_delivery_id as string)
      .maybeSingle()
    if (!sd) return { advanced: false, reason: 'service delivery not found' }
    const target = targetFor(opts.table, sd.service_type, sd.stage)
    if (!target) return { advanced: false, reason: 'the delivery is not waiting for this document' }

    const { advanceServiceDelivery } = await import('@/lib/service-delivery')
    const result = await advanceServiceDelivery({
      delivery_id: sd.id as string,
      target_stage: target,
      skip_tasks: true,
      ...(opts.skipNotify ? { skip_notify: true } : {}),
      actor: opts.actor,
      notes: opts.note((env.document_name as string | null) ?? null),
    })
    if (result && result.success === false) {
      await reportNotAdvanced(sd.id as string, envelopeId, result.error ?? 'refused', opts.failure)
      return { advanced: false, reason: result.error ?? 'refused' }
    }
    return { advanced: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await reportNotAdvanced(null, envelopeId, message, opts.failure)
    return { advanced: false, reason: message }
  }
}

/** The client has signed (envelope completed): move the delivery on. */
export async function advanceDeliveryAfterEsign(envelopeId: string): Promise<DeliveryAdvanceResult> {
  return advanceDeliveryForEnvelope(envelopeId, {
    table: ESIGN_COMPLETION_ADVANCE,
    statusOk: (s) => s === 'completed',
    notYet: 'not fully signed yet',
    actor: 'esign-completed',
    note: (name) => `Form signed by the client (e-sign envelope ${envelopeId}: ${name ?? 'form'})`,
    skipNotify: false,
    failure: 'The client signed the form but the job did not move to the next step',
  })
}

/** Staff have SENT the document to the client (envelope marked sent): move the delivery to its "sent for signature" step. The client is not told by the move. */
export async function advanceDeliveryAfterEsignSent(envelopeId: string): Promise<DeliveryAdvanceResult> {
  return advanceDeliveryForEnvelope(envelopeId, {
    table: ESIGN_SEND_ADVANCE,
    statusOk: (s) => s === 'sent' || s === 'in_progress',
    notYet: 'the document has not been sent yet',
    actor: 'esign-sent',
    note: (name) => `Document sent to the client for signature (e-sign envelope ${envelopeId}: ${name ?? 'document'})`,
    skipNotify: true,
    failure: 'The document was sent to the client for signature but the job did not move to "Sent for Signature"',
  })
}

async function reportNotAdvanced(sdId: string | null, envelopeId: string, reason: string, failure: string): Promise<void> {
  console.error(`advanceDeliveryForEnvelope: envelope ${envelopeId}: ${failure}: ${reason}`)
  try {
    const { reportSystemError } = await import('@/lib/system-errors')
    await reportSystemError({
      source: 'server',
      route: 'lib/esign/delivery-advance.ts',
      message: `${failure}${sdId ? ` (SD ${sdId})` : ''}: ${reason}. Move it by hand.`,
      context: { envelopeId, service_delivery_id: sdId },
    })
  } catch {
    /* best-effort */
  }
}
